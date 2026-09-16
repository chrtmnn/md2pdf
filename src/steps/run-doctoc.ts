import fs from 'fs';
import path from 'path';
import { ConversionContext, ConverterOptions, ToolRunner } from '../types';
import {
  isTocOnlyRefresh,
  maskDocumentedMarkers,
  scanDoctocMarkers,
  unmaskDocumentedMarkers,
} from './doctoc-markers';
import { runTool } from './run-tool';
import { relocateTocBeforeFirstH2 } from './toc-placement';

/**
 * Decides whether the doctoc step needs to run for a given source file.
 *
 * Only a *genuine* doctoc marker counts (see {@link scanDoctocMarkers}): a
 * marker that merely appears as an example in a code fence or inline code
 * does not trigger a run. A broken marker pair does, so that
 * {@link runDoctoc} reports it instead of the TOC silently going missing.
 *
 * @param options - Converter options carrying the `--force-doctoc` flag.
 * @param sourceFile - Absolute path to the source Markdown file.
 * @returns `true` when doctoc must process the file, `false` otherwise.
 */
export function shouldRunDoctoc(options: ConverterOptions, sourceFile: string): boolean {
  if (options.toc === 'never') {
    return false;
  }

  return options.toc === 'always' || scanDoctocMarkers(fs.readFileSync(sourceFile, 'utf8')).kind !== 'none';
}

/**
 * Refreshes or creates a table of contents for the conversion input.
 *
 * doctoc only ever runs on the temp copy (`context.inputMarkdown`), never on
 * `context.sourceFile`. doctoc is not fence-aware, so marker examples it would
 * mistake for real markers are masked for the run and restored afterwards,
 * and a genuine START marker without an END marker fails the file before
 * doctoc runs, because doctoc would replace everything after it (#44).
 *
 * With `--update-md-toc` and a genuine marker pair in the source, the
 * refreshed copy is written back to `context.sourceFile` — only when it
 * differs, and only when nothing outside the TOC block changed
 * ({@link isTocOnlyRefresh}). Callers should gate this step with
 * {@link shouldRunDoctoc}.
 *
 * When doctoc creates a brand-new TOC (no genuine markers in the source file,
 * i.e. the `--force-doctoc` case), the generated block is relocated to sit
 * directly before the first second-order (`##`) heading. Refreshes of an
 * already-existing TOC are left exactly where doctoc put them. The placement
 * rules themselves live in {@link relocateTocBeforeFirstH2}.
 *
 * @param context - Mutable conversion state for the current source file.
 * @param run - Starts doctoc; defaults to the real {@link runTool} and is
 *   replaced by a fake in the tests (#71).
 * @throws When the source file has a broken marker pair, or when the refresh
 *   would change the source file outside its TOC block. The source file is
 *   left untouched in both cases.
 */
export function runDoctoc(context: ConversionContext, run: ToolRunner = runTool): void {
  const source = fs.readFileSync(context.sourceFile, 'utf8');
  const markers = scanDoctocMarkers(source);

  if (markers.kind === 'broken') {
    throw new Error(
      `${context.sourceFile}: ${markers.message}. Add the missing marker or remove the stray one; the file was left unchanged.`,
    );
  }

  context.inputMarkdown = path.join(context.workdir, context.baseName);
  fs.writeFileSync(context.inputMarkdown, maskDocumentedMarkers(source));

  run('doctoc', [context.inputMarkdown], context.options);

  let refreshed = fs.readFileSync(context.inputMarkdown, 'utf8');

  // Only a freshly created TOC gets relocated; an existing block was refreshed
  // in place and must not move. Relocating before unmasking keeps a documented
  // marker from ever being mistaken for the generated block.
  if (markers.kind === 'none') {
    refreshed = relocateTocBeforeFirstH2(refreshed);
  }
  refreshed = unmaskDocumentedMarkers(refreshed);
  fs.writeFileSync(context.inputMarkdown, refreshed);

  if (context.options.writeToc && markers.kind === 'pair' && refreshed !== source) {
    if (!isTocOnlyRefresh(source, refreshed)) {
      throw new Error(
        `${context.sourceFile}: doctoc changed content outside the table of contents block; the file was left unchanged.`,
      );
    }
    fs.writeFileSync(context.sourceFile, refreshed);
  }
}
