/**
 * The conversion run itself: everything `md2pdf` does once the command line is
 * parsed.
 *
 * Split out of `md2pdf.ts` for #71. That file parses `process.argv` as soon as
 * it is imported and ends the process through `process.exit`, so no test could
 * ever load it — and with it the orchestration went untested, which is where
 * most of the recent bugs lived (#51, #59, #64, #65). Here the run takes its
 * output sink, its temp-directory registry and its tool runner as parameters
 * and **returns** an exit code, so a test can drive a whole conversion with a
 * recording reporter and a fake tool runner, offline and without Chromium.
 *
 * `md2pdf.ts` keeps what genuinely belongs to the process: argument parsing,
 * the `@clack/prompts` reporter, the signal handlers and the exit code.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanup } from './steps/cleanup';
import { assertOutputReplaceable, copyOutput } from './steps/copy-output';
import { describeUnusedCssVar, findUnusedCssVars } from './steps/css-var-usage';
import { describeMissingMarkerBlock, scanDoctocMarkers } from './steps/doctoc-markers';
import { MergedInput, mergeMarkdown } from './steps/merge-markdown';
import { describeOutputCollisions, findOutputCollisions } from './steps/output-targets';
import { resolveInputs } from './steps/resolve-inputs';
import { resolveStylesheet } from './steps/resolve-stylesheet';
import { extractTitle } from './steps/extract-title';
import { inlineAssets } from './steps/inline-assets';
import { prepareWorkdir } from './steps/prepare-workdir';
import { hasMermaidFences, renderMermaid } from './steps/render-mermaid';
import { renderHtml } from './steps/render-html';
import { renderPdf } from './steps/render-pdf';
import { TempRegistry } from './steps/temp-registry';
import { runDoctoc, shouldRunDoctoc } from './steps/run-doctoc';
import { describeStylesheet } from './steps/stylesheet-lookup';
import { ConversionContext, ConverterOptions, ToolRunner } from './types';

/**
 * Everything the run prints.
 *
 * The four message methods mirror `@clack/prompts`' `log.*`; `status` and
 * `clearStatus` drive the transient line that names the step in progress
 * (#65). The run blanks the line itself wherever a message follows a live one,
 * and an implementation is expected to blank it before printing anyway, so a
 * warning can never collide with it.
 */
export type PipelineReporter = {
  /** Opens the run. */
  intro: (message: string) => void;
  /** Closes the run with its summary. */
  outro: (message: string) => void;
  /** A step-by-step note, only printed under `--verbose`. */
  info: (message: string) => void;
  /** A finished piece of work. */
  success: (message: string) => void;
  /** A non-fatal problem. */
  warn: (message: string) => void;
  /** A failure, of one file or of the whole run. */
  error: (message: string) => void;
  /** Replaces the transient line with `text`. */
  status: (text: string) => void;
  /** Blanks the transient line. */
  clearStatus: () => void;
  /**
   * Whether the transient line is actually painted. A failing step prints its
   * own `… failed` line only when it is not, because the per-file line already
   * ends with the failure otherwise.
   */
  interactive: boolean;
};

/** What {@link runPipeline} needs from its caller. */
export type PipelineDependencies = {
  /** Sink for every message and for the transient line. */
  reporter: PipelineReporter;
  /**
   * Registry of the temp directories that are alive right now. It belongs to
   * the caller because the signal handlers that empty it do (#51).
   */
  tempDirs: TempRegistry;
  /**
   * Starts an external tool. Required rather than defaulted: a caller that
   * forgot it would spawn doctoc, mermaid-cli and Chromium for real, which is
   * what #71 exists to prevent for the tests.
   */
  run: ToolRunner;
};

/**
 * Renders an unknown thrown value as a message.
 *
 * @param error - The caught value.
 * @returns The error's message, or the value itself as a string.
 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Converts every resolved input and reports the outcome.
 *
 * @param args - Raw positional arguments, as the CLI received them.
 * @param options - Resolved converter options for the run.
 * @param deps - Reporter, temp-directory registry and tool runner.
 * @returns The process exit code: `0` when everything converted, `1` when any
 *   file failed, was skipped, or the run was aborted before converting.
 */
export function runPipeline(args: string[], options: ConverterOptions, deps: PipelineDependencies): number {
  const { reporter, tempDirs, run } = deps;

  function runStep<T>(label: string, action: () => T): T {
    if (options.verbose) {
      reporter.info(label);
    }
    reporter.status(label);

    try {
      const result = action();
      if (options.verbose) {
        reporter.success(label);
      }
      reporter.clearStatus();
      return result;
    } catch (error) {
      reporter.clearStatus();
      // Without this the output ended on the plain "started" line (#51).
      reporter.error(`${label} failed`);
      throw error;
    }
  }

  /**
   * One live line for a whole file, naming the step in progress.
   *
   * Seven persistent lines per file buried the warnings in a 30-file run
   * (#59), so the steps share a single line that is rewritten in place and
   * ends as `Created <pdf>`; the per-step lines come back with `--verbose`.
   */
  function fileProgress(name: string) {
    reporter.status(name);

    return {
      /** Runs one pipeline step, naming it on this file's line. */
      run<T>(label: string, action: () => T): T {
        if (options.verbose) {
          reporter.info(`${name} · ${label}`);
        }
        reporter.status(`${name} · ${label}`);

        try {
          const result = action();
          if (options.verbose) {
            reporter.success(`${name} · ${label}`);
          }
          return result;
        } catch (error) {
          reporter.clearStatus();
          if (!reporter.interactive) {
            reporter.error(`${name} · ${label} failed`);
          }
          throw error;
        }
      },
      /** Reports a non-fatal problem without disturbing the live line. */
      warn(message: string): void {
        reporter.clearStatus();
        reporter.warn(message);
      },
      /** Ends the file with a success message. */
      done(message: string): void {
        reporter.clearStatus();
        reporter.success(message);
      },
      /** Ends the file with a failure message. */
      failed(message: string): void {
        reporter.clearStatus();
        reporter.error(message);
      },
      /** Ends the file with a neutral message, for a skipped file. */
      skipped(message: string): void {
        reporter.clearStatus();
        reporter.warn(message);
      },
    };
  }

  reporter.intro('md2pdf');

  // A retired `--css-var` name still works but is translated, which the user
  // has to be told about to migrate the command line (#59).
  options.cssVarWarnings.forEach((warning) => reporter.warn(warning));

  // A personal ~/.md2pdf/default.css replaces the bundled stylesheet without
  // any flag, so --verbose says which one is in use and why.
  if (options.verbose) {
    reporter.info(describeStylesheet({ path: options.stylesheet, origin: options.stylesheetOrigin }));
  }

  // Positional arguments may be files or directories; expand them into the
  // concrete list of Markdown files before anything else runs.
  const inputs = runStep('Resolving input files', () => resolveInputs(args, options));
  inputs.warnings.forEach((warning) => reporter.warn(warning));
  inputs.rejected.forEach((file) => reporter.warn(`Skipped non-Markdown file: ${file}`));

  // Every output path is known before anything is written, so a collision
  // aborts the run instead of letting a later file silently replace an
  // earlier one's output. A merged run writes a single output. Missing files
  // write nothing and are reported later.
  if (!options.merge) {
    const collisions = findOutputCollisions(
      inputs.files.filter((file) => fs.existsSync(file)),
      options.outputDir,
    );
    if (collisions.length > 0) {
      reporter.error(describeOutputCollisions(collisions));
      reporter.outro('Conversion aborted');
      return 1;
    }
  }

  // Checked before any temp directory exists, so the early exit cannot leak
  // one: the run returns here without ever creating the CSS temp directory.
  if (options.merge && inputs.files.length === 0) {
    reporter.error('Nothing to merge: no Markdown files were resolved from the given arguments.');
    reporter.outro('Merge failed');
    return 1;
  }

  // `--merge` concatenates the resolved Markdown before rendering and then
  // feeds the pipeline a single file, so every other flag keeps working
  // unchanged and doctoc produces one TOC spanning all documents.
  let merged: MergedInput | undefined;
  let runOptions = options;
  let filesToConvert = inputs.files;
  let skippedCount = 0;
  let convertedCount = 0;
  // Rejected non-Markdown positionals count like missing files; a merged run
  // reports them through skippedCount instead.
  let failedCount = options.merge ? 0 : inputs.rejected.length;

  // Resolve the effective stylesheet once for all files. The temp dir receives
  // the self-contained copy when the stylesheet has local references to
  // inline or overrides to append, and stays empty otherwise.
  const cssTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf_css_'));
  tempDirs.register(cssTempDir);

  try {
    if (options.merge) {
      merged = runStep('Merging Markdown files', () => mergeMarkdown(inputs.files, options));
      tempDirs.register(merged.mergeDir);
      merged.warnings.forEach((warning) => reporter.warn(warning));
      merged.skipped.forEach((file) => reporter.warn(`Skipped missing file: ${file}`));
      skippedCount = merged.skipped.length + inputs.rejected.length;
      filesToConvert = [merged.mergedFile];

      // The merged file lives in a temp directory, so the target directory has
      // to be pinned explicitly instead of being derived from its location:
      // `-o` when given, otherwise the common ancestor of the inputs.
      runOptions = { ...options, outputDir: merged.targetDir };
    }

    const effectiveStylesheet = resolveStylesheet(options, cssTempDir);

    // An override the stylesheet never reads is written out and ignored by
    // the browser, which a typo in the name would otherwise leave invisible.
    if (effectiveStylesheet && options.cssVars.length > 0) {
      const css = fs.readFileSync(effectiveStylesheet, 'utf8');
      findUnusedCssVars(css, options.cssVars).forEach((name) => reporter.warn(describeUnusedCssVar(name)));
    }

    for (const file of filesToConvert) {
      const progress = fileProgress(merged ? `${merged.mergedCount} documents merged` : path.basename(file));

      // Inside the try, so a failure here fails this file like any other step
      // instead of aborting the whole run, leaking the work directory and
      // skipping the summary (#51).
      let context: ConversionContext | undefined;

      try {
        context = progress.run('Preparing workspace', () => prepareWorkdir(file, runOptions));
        if (!context) {
          progress.skipped(`Skipped missing file: ${file}`);
          failedCount++;
          continue;
        }

        tempDirs.register(context.workdir);

        // Narrowed once, so the steps below keep a definitely-defined context
        // after the `continue` above.
        const active = context;
        active.effectiveStylesheet = effectiveStylesheet;

        // Checked before `-u` can write back to the source and before any
        // rendering, so a protected output fails the file without side effects.
        assertOutputReplaceable(active);
        // `-u` only refreshes an existing marker block. A broken pair is
        // reported by runDoctoc, and a merged run cannot carry `-u`.
        if (options.writeToc && scanDoctocMarkers(fs.readFileSync(active.sourceFile, 'utf8')).kind === 'none') {
          progress.warn(describeMissingMarkerBlock(active.sourceFile, options.toc === 'always'));
        }
        if (shouldRunDoctoc(options, active.sourceFile)) {
          progress.run('Table of contents', () => runDoctoc(active, run));
        }
        if (options.title) {
          // An explicit title beats both the first heading and the name a
          // merged run derives from `--merge` (#59).
          active.docTitle = options.title;
        } else if (!merged) {
          // A merged run keeps the `--merge` name as its document title,
          // which prepareWorkdir already derived from the merged file name.
          progress.run('Extracting document title', () => extractTitle(active));
        }
        // `inputMarkdown` rather than the source file: that is what
        // renderMermaid reads, and doctoc may have replaced it with the temp
        // copy in between (#51).
        if (hasMermaidFences(active.inputMarkdown)) {
          progress.run('Rendering Mermaid diagrams', () => renderMermaid(active, run));
        } else {
          // Wrapped like every other step, so it gets the same spinner and
          // failure marker instead of happening silently.
          progress.run('Preparing Markdown', () => fs.copyFileSync(active.inputMarkdown, active.convertedMarkdown));
        }
        // md-to-pdf renders from a server rooted at the work directory, so
        // the document's own assets have to be carried into the converted
        // Markdown before it runs.
        progress.run('Embedding assets', () => inlineAssets(active)).forEach((warning) => progress.warn(warning));
        progress.run('Rendering PDF', () => renderPdf(active, run));
        if (options.html) {
          progress.run('Rendering HTML', () => renderHtml(active, run));
        }
        progress.run('Copying output', () => copyOutput(active));

        progress.done(`Created ${active.outputPdf}`);
        if (options.html) {
          reporter.success(`Created ${active.outputHtml}`);
        }
        convertedCount++;
      } catch (error) {
        progress.failed(formatError(error));
        failedCount++;
      } finally {
        if (context) {
          cleanup(context);
          tempDirs.unregister(context.workdir);
          if (options.keepTemp) {
            reporter.info(`Temp kept at ${context.workdir}`);
          }
        }
      }
    }
  } finally {
    if (options.keepTemp) {
      // `-k` keeps the stylesheet that was actually used, without which the
      // kept work directory cannot reproduce the run (#51).
      reporter.info(`Effective stylesheet kept at ${cssTempDir}`);
      if (merged) {
        reporter.info(`Merged Markdown kept at ${merged.mergedFile}`);
      }
    } else {
      fs.rmSync(cssTempDir, { recursive: true, force: true });
      if (merged) {
        fs.rmSync(merged.mergeDir, { recursive: true, force: true });
      }
    }

    tempDirs.unregister(cssTempDir);
    if (merged) {
      tempDirs.unregister(merged.mergeDir);
    }
  }

  if (merged) {
    if (convertedCount === 0) {
      reporter.outro('Merge failed');
      return 1;
    }

    const mergedPdf = `${options.merge}.pdf`;
    if (skippedCount > 0) {
      reporter.outro(`${merged.mergedCount} merged into ${mergedPdf}, ${skippedCount} skipped`);
      return 1;
    }

    reporter.outro(`${merged.mergedCount} merged into ${mergedPdf}`);
    return 0;
  }

  if (failedCount > 0) {
    reporter.outro(`${convertedCount} converted, ${failedCount} failed`);
    return 1;
  }

  reporter.outro(`${convertedCount} converted`);
  return 0;
}
