/**
 * Shared fixture helpers for the `node:test` suite.
 *
 * Everything the tests write goes into a per-test directory under the OS temp
 * directory that is removed again when the test finishes, so a test run never
 * leaves files behind in the repository.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TestContext } from 'node:test';
import type { PipelineReporter } from '../pipeline';
import { ConversionContext, ConverterOptions, ToolName, ToolRunner } from '../types';

/**
 * Creates an isolated temporary directory that is removed when the test ends.
 *
 * The returned path is passed through `realpathSync` because `os.tmpdir()` can
 * be an 8.3 short path on Windows (`C:\Users\RUNNER~1\...`), which would not
 * compare equal to the paths the production code produces via `path.resolve`.
 *
 * @param t - Active test context, used to register the cleanup hook.
 * @param prefix - Optional name prefix, useful when reading a failing run's leftovers.
 * @returns Absolute path of the created directory.
 */
export function tempDir(t: TestContext, prefix = 'md-scripts-test-'): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  t.after(() => {
    fs.rmSync(created, { recursive: true, force: true });
  });

  return fs.realpathSync(created);
}

/**
 * Registers a directory the production code created for removal when the test
 * ends.
 *
 * Steps that place their temp directory outside the fixture (the default
 * placement of `prepareWorkdir` and `mergeMarkdown` is `os.tmpdir()`) would
 * otherwise leave it behind: nothing in the test owns it, and the pipeline's
 * own cleanup never runs in a unit test. Registering the directory keeps the
 * default-placement path genuinely exercised instead of side-stepping it with
 * `-r`/`-p`.
 *
 * @param t - Active test context, used to register the cleanup hook.
 * @param directory - Absolute path of the directory to remove afterwards.
 * @returns The directory, so the call can wrap an expression.
 */
export function removeAfter(t: TestContext, directory: string): string {
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return directory;
}

/**
 * Writes a file inside a fixture directory, creating parent directories.
 *
 * @param dir - Fixture root directory.
 * @param relativePath - Path relative to `dir`, may contain `/` separators.
 * @param contents - File contents to write, verbatim (no newline is appended).
 * @returns The absolute path of the written file.
 */
export function writeFile(dir: string, relativePath: string, contents: string): string {
  const target = path.join(dir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

/**
 * Writes a small but structurally valid binary PNG, for asset-embedding tests.
 *
 * @param dir - Fixture root directory.
 * @param relativePath - Path relative to `dir`.
 * @returns The absolute path of the written file.
 */
export function writePng(dir: string, relativePath: string): string {
  const target = path.join(dir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return target;
}

/**
 * Builds a complete {@link ConverterOptions} value with harmless defaults.
 *
 * No npx override is set. The pipeline tests do reach the steps that start a
 * tool, but those get the fake runner from {@link createFakeTools}, so nothing
 * is ever spawned (#71).
 *
 * @param overrides - Fields to override.
 * @returns Converter options usable by any step under test.
 */
export function makeOptions(overrides: Partial<ConverterOptions> = {}): ConverterOptions {
  return {
    stylesheet: undefined,
    stylesheetOrigin: 'bundled',
    cssVars: [],
    cssVarWarnings: [],
    outputDir: undefined,
    tempRoot: undefined,
    tempInOutput: false,
    toc: 'auto',
    writeToc: false,
    keepTemp: false,
    verbose: false,
    html: false,
    png: false,
    recursive: false,
    merge: undefined,
    packageOverrides: {},
    ...overrides,
  };
}

/**
 * Builds a {@link ConversionContext} for the steps that only read a couple of
 * its fields, without going through `prepareWorkdir` (which would create a
 * temp directory of its own).
 *
 * @param overrides - Fields to override; `sourceFile` drives the derived defaults.
 * @returns A fully populated conversion context.
 */
export function makeContext({
  sourceFile: rawSourceFile,
  ...overrides
}: Partial<ConversionContext> & { sourceFile: string }): ConversionContext {
  const sourceFile = path.resolve(rawSourceFile);
  const baseName = path.basename(sourceFile);
  const stem = path.parse(baseName).name;
  const sourceDir = path.dirname(sourceFile);
  const workdir = overrides.workdir ?? sourceDir;
  const targetDir = overrides.targetDir ?? sourceDir;

  return {
    options: makeOptions(),
    sourceFile,
    sourceDir,
    baseName,
    stem,
    workdir,
    inputMarkdown: sourceFile,
    convertedMarkdown: path.join(workdir, `${stem}_converted.md`),
    targetDir,
    outputPdf: path.join(targetDir, `${stem}.pdf`),
    tempPdf: path.join(workdir, `${stem}_converted.pdf`),
    outputHtml: path.join(targetDir, `${stem}.html`),
    tempHtml: path.join(workdir, `${stem}_converted.html`),
    docTitle: stem,
    ...overrides,
  };
}

/**
 * Creates a symbolic link, reporting whether the platform allowed it.
 *
 * Creating symlinks on Windows requires either Developer Mode or elevation,
 * so the symlink-related tests skip themselves instead of failing when this
 * returns `false`.
 *
 * @param target - Link target path.
 * @param linkPath - Path of the link to create.
 * @param type - Link type; `'dir'` is required for directory links on Windows.
 * @returns `true` when the link was created.
 */
export function trySymlink(target: string, linkPath: string, type: 'file' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a Windows directory junction, reporting whether it worked.
 *
 * Junctions need no special privileges on Windows, which makes them the case
 * users actually hit. On other platforms this always returns `false`.
 *
 * @param target - Directory the junction should point at.
 * @param linkPath - Path of the junction to create.
 * @returns `true` when the junction was created.
 */
export function tryJunction(target: string, linkPath: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    fs.symlinkSync(target, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalises a path for comparison in assertions: forward slashes everywhere,
 * and lowercased on Windows, where the filesystem is case-insensitive.
 *
 * @param value - Path to normalise.
 * @returns The comparable form of the path.
 */
export function comparablePath(value: string): string {
  const slashed = value.split(path.sep).join('/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Maps a list of absolute paths to their file names, for order assertions.
 *
 * @param files - Absolute file paths.
 * @returns The base names in the same order.
 */
export function names(files: string[]): string[] {
  return files.map((file) => path.basename(file));
}

/**
 * One call the run made on its reporter, in order. `clear` is a
 * `clearStatus()` and carries no text.
 */
export type ReportedLine = {
  /** Which reporter method was called. */
  kind: 'intro' | 'outro' | 'info' | 'success' | 'warn' | 'error' | 'status' | 'clear';
  /** The message, or the transient line's text for `status`. */
  text: string;
};

/** A {@link PipelineReporter} that keeps everything it was told. */
export type RecordingReporter = {
  /** The reporter to hand to `runPipeline`. */
  reporter: PipelineReporter;
  /** Every call, in order. */
  lines: ReportedLine[];
  /** The messages of the given kinds, in order. */
  of: (...kinds: ReportedLine['kind'][]) => string[];
  /** Whether any message of the given kind contains `needle`. */
  has: (kind: ReportedLine['kind'], needle: string) => boolean;
  /** The closing summary, or `undefined` when the run never got that far. */
  outro: () => string | undefined;
};

/**
 * Creates a reporter that records instead of printing (#71).
 *
 * @param interactive - What the run should see as `reporter.interactive`; the
 *   default `false` is the non-TTY case, where a failing step prints its own
 *   `… failed` line.
 * @returns The reporter and the recorded lines.
 */
export function createRecordingReporter(interactive = false): RecordingReporter {
  const lines: ReportedLine[] = [];
  const record =
    (kind: ReportedLine['kind']) =>
    (text: string): void => {
      lines.push({ kind, text });
    };

  const reporter: PipelineReporter = {
    intro: record('intro'),
    outro: record('outro'),
    info: record('info'),
    success: record('success'),
    warn: record('warn'),
    error: record('error'),
    status: record('status'),
    clearStatus: () => record('clear')(''),
    interactive,
  };

  return {
    reporter,
    lines,
    of: (...kinds) => lines.filter((line) => kinds.includes(line.kind)).map((line) => line.text),
    has: (kind, needle) => lines.some((line) => line.kind === kind && line.text.includes(needle)),
    outro: () => lines.find((line) => line.kind === 'outro')?.text,
  };
}

/** One recorded invocation of an external tool. */
export type ToolCall = {
  /** Which tool the step asked for. */
  tool: ToolName;
  /** The argument list, exactly as the step built it. */
  args: string[];
  /** The options the step passed along. */
  options: ConverterOptions;
};

/**
 * Side effects that replace a tool's default fake behaviour, per tool. A hook
 * that throws is how a test makes one step of the pipeline fail.
 */
export type FakeToolBehaviour = Partial<Record<ToolName, (args: string[], options: ConverterOptions) => void>>;

/** The fake runner and what it has been asked to do. */
export type FakeTools = {
  /** The runner to pass into a step or into `runPipeline`. */
  run: ToolRunner;
  /** Every invocation, in order. */
  calls: ToolCall[];
  /** The invocations of one tool, in order. */
  callsTo: (tool: ToolName) => ToolCall[];
};

/** The table of contents the fake doctoc writes. */
export const FAKE_TOC_LINES = [
  '<!-- START doctoc generated TOC please keep comment here to allow auto update -->',
  "<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->",
  '',
  '- [Generated](#generated)',
  '',
  '<!-- END doctoc generated TOC please keep comment here to allow auto update -->',
];

/** The bytes the fake md-to-pdf writes as a PDF. */
export const FAKE_PDF_CONTENT = '%PDF-1.4 fake\n';

/** The document the fake md-to-pdf writes for `--as-html`, before stamping. */
export const FAKE_HTML_CONTENT = '<html><head><title>fake</title></head><body>fake</body></html>';

/**
 * Creates a tool runner that does what doctoc, mermaid-cli and md-to-pdf would
 * have done, without spawning anything (#71).
 *
 * The defaults are deliberately close to the real tools in the ways the
 * pipeline depends on: doctoc replaces an existing marker block in place and
 * otherwise puts a fresh one at the very top of the file (which is what
 * `relocateTocBeforeFirstH2` then moves), mermaid-cli writes its `-o` file
 * from its `-i` file, and md-to-pdf writes `<input>.pdf`, or `<input>.html`
 * under `--as-html`.
 *
 * @param behaviour - Per-tool replacements for those defaults.
 * @returns The runner and the recorded calls.
 */
export function createFakeTools(behaviour: FakeToolBehaviour = {}): FakeTools {
  const calls: ToolCall[] = [];

  const defaults: Required<FakeToolBehaviour> = {
    doctoc: (args) => fakeDoctoc(args[0]),
    mermaidCli: (args) => {
      const input = args[args.indexOf('-i') + 1];
      const output = args[args.indexOf('-o') + 1];
      fs.copyFileSync(input, output);
    },
    mdToPdf: (args) => {
      const asHtml = args.includes('--as-html');
      const target = args[0].replace(/\.md$/, asHtml ? '.html' : '.pdf');
      fs.writeFileSync(target, asHtml ? FAKE_HTML_CONTENT : FAKE_PDF_CONTENT, 'utf8');
    },
  };

  return {
    run: (tool, args, options) => {
      calls.push({ tool, args, options });
      (behaviour[tool] ?? defaults[tool])(args, options);
    },
    calls,
    callsTo: (tool) => calls.filter((call) => call.tool === tool),
  };
}

/**
 * Rewrites a Markdown file the way doctoc would: an existing marker pair has
 * its contents replaced, a file without one gets a fresh block prepended.
 *
 * Masked markers (`<!--\u{E000} START doctoc `) are not recognised, exactly as
 * the real tool's regex does not recognise them.
 *
 * @param file - Markdown file doctoc was pointed at.
 */
function fakeDoctoc(file: string): void {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith('<!-- START doctoc '));
  const end = lines.findIndex((line) => line.startsWith('<!-- END doctoc '));

  const updated =
    start >= 0 && end > start
      ? [...lines.slice(0, start), ...FAKE_TOC_LINES, ...lines.slice(end + 1)]
      : [...FAKE_TOC_LINES, '', ...lines];

  fs.writeFileSync(file, updated.join('\n'), 'utf8');
}
