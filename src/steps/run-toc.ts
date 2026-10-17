import fs from 'fs';
import path from 'path';
import { ConversionContext, ConverterOptions, ToolRunner } from '../types';
import { DOCTOC_BACKEND } from './doctoc-backend';
import { runTool } from './run-tool';
import { TocBackend } from './toc-backend';
import {
  isTocOnlyRefresh,
  markerLines,
  OWN_TOC_MARKER,
  scanTocMarkers,
  TOC_MARKERS,
  TocMarkerEntry,
} from './toc-markers';
import { relocateTocBeforeFirstH2 } from './toc-placement';

/**
 * Decides whether the table-of-contents step needs to run for a source file.
 *
 * Only a *genuine* marker of a registry entry counts (see
 * {@link scanTocMarkers}): a marker that merely appears as an example in a
 * code fence or inline code does not trigger a run. A broken marker pair does,
 * so that {@link runToc} reports it instead of the ToC silently going missing.
 *
 * @param options - Converter options carrying the ToC mode.
 * @param sourceFile - Absolute path to the source Markdown file.
 * @param registry - Marker entries to recognise.
 * @returns `true` when the step must process the file, `false` otherwise.
 */
export function shouldRunToc(
  options: ConverterOptions,
  sourceFile: string,
  registry: readonly TocMarkerEntry[] = TOC_MARKERS,
): boolean {
  if (options.toc === 'never') {
    return false;
  }

  return options.toc === 'always' || scanTocMarkers(fs.readFileSync(sourceFile, 'utf8'), registry).kind !== 'none';
}

/**
 * Refreshes or creates a table of contents for the conversion input.
 *
 * The backend only ever fills the temp copy (`context.inputMarkdown`), never
 * `context.sourceFile`. The first genuine block of any registry entry is the
 * one it fills; every later block is left as it is. A genuine START marker
 * without its END marker fails the file before the backend runs, because the
 * backend would replace everything after it (#44).
 *
 * A block keeps the marker lines the author wrote. Without any block (the
 * `--toc` case), a new one is created with md2pdf's own marker and relocated
 * to sit directly before the first second-order (`##`) heading, so the copy
 * stays correct if it is ever saved as Markdown. Refreshes of an existing
 * block stay exactly where they are. The placement rules themselves live in
 * {@link relocateTocBeforeFirstH2}.
 *
 * With `--write-toc` and a block in the source, the refreshed copy is written
 * back to `context.sourceFile` — only when it differs, and only when nothing
 * outside the ToC block changed ({@link isTocOnlyRefresh}). Callers should gate
 * this step with {@link shouldRunToc}.
 *
 * @param context - Mutable conversion state for the current source file.
 * @param run - Starts the backend's tool; defaults to the real {@link runTool}
 *   and is replaced by a fake in the tests (#71).
 * @param backend - The library that builds the ToC; doctoc by default.
 * @param registry - Marker entries to recognise.
 * @throws When the source file has a broken marker pair, or when the refresh
 *   would change the source file outside its ToC block. The source file is
 *   left untouched in both cases.
 */
export function runToc(
  context: ConversionContext,
  run: ToolRunner = runTool,
  backend: TocBackend = DOCTOC_BACKEND,
  registry: readonly TocMarkerEntry[] = TOC_MARKERS,
): void {
  const source = fs.readFileSync(context.sourceFile, 'utf8');
  const markers = scanTocMarkers(source, registry);

  if (markers.kind === 'broken') {
    throw new Error(
      `${context.sourceFile}: ${markers.message}. Add the missing marker or remove the stray one; the file was left unchanged.`,
    );
  }

  const block = markers.kind === 'pair' ? { startIndex: markers.startIndex, endIndex: markers.endIndex } : undefined;
  let requested: { start: string; end: string } | undefined = OWN_TOC_MARKER;
  if (markers.kind === 'pair') {
    requested =
      markers.entry.name === backend.nativeMarker.name
        ? undefined
        : markerLines(source, markers.startIndex, markers.endIndex);
  }

  // Named after the temp stem rather than the source file name, which is not
  // shortened and could push the path past MAX_PATH on Windows (#100).
  context.inputMarkdown = path.join(context.workdir, `${context.tempStem}.md`);
  const result = backend.generate({
    markdown: source,
    block,
    markers: requested,
    file: context.inputMarkdown,
    options: context.options,
    run,
  });

  // Only a freshly created block gets relocated; an existing block was
  // refreshed in place and must not move.
  const refreshed =
    markers.kind === 'none' && result.block ? relocateTocBeforeFirstH2(result.markdown, result.block) : result.markdown;
  fs.writeFileSync(context.inputMarkdown, refreshed);

  if (context.options.writeToc && markers.kind === 'pair' && refreshed !== source) {
    if (!isTocOnlyRefresh(source, refreshed, registry)) {
      throw new Error(
        `${context.sourceFile}: ${backend.name} changed content outside the table of contents block; the file was left unchanged.`,
      );
    }
    fs.writeFileSync(context.sourceFile, refreshed);
  }
}
