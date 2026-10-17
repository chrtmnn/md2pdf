/**
 * The registry of table-of-contents markers md2pdf recognises (#83), and the
 * pure rules that keep a ToC run from destroying content (#44).
 *
 * A marker is a pair of HTML comment lines that encloses a ToC block. md2pdf
 * has a tool-neutral marker of its own (`<!-- toc START -->` /
 * `<!-- toc END -->`) and also recognises the markers other ToC tools write,
 * so a document prepared for one of them gets a ToC without being edited. Every
 * entry is treated alike: the first genuine block in a document, whatever its
 * entry, is the one the active ToC backend fills (see `run-toc.ts`).
 *
 * Only a *genuine* marker counts: a line that opens an HTML comment block with
 * the marker, outside fenced code blocks and other comment blocks. A marker a
 * document merely shows — in a fence, in inline code, in an indented code block
 * or inside a comment — is documentation and stays byte-identical. A START
 * marker without its END is reported rather than handed to a backend, which
 * might replace everything after it.
 *
 * Adding an entry to {@link TOC_MARKERS} is all it takes to recognise another
 * tool's markers: detection, `--toc` / `--no-toc`, `-u`, `--merge` and the
 * backend all go through this module and need no change.
 */

import { classifyLines } from './markdown-scan';

/** Byte order mark, stripped from the first line before scanning. */
const BOM = String.fromCharCode(0xfeff);

/**
 * One entry of the marker registry: how a ToC tool delimits its block.
 *
 * `start` and `end` are tested against the text of a genuine marker line with
 * its leading indentation removed. Anchor them (`^`), and anchor the end of an
 * exact marker as well (`\s*$`), so one entry's pattern cannot match another
 * entry's marker — `<!-- toc START -->` must never pass for `<!-- toc -->`.
 */
export type TocMarkerEntry = {
  /** Short name used in messages, e.g. `doctoc`. */
  name: string;
  /** The tool that writes this marker, for the documentation. */
  tool?: string;
  /** Recognises the START marker line. */
  start: RegExp;
  /** Recognises the END marker line. */
  end: RegExp;
};

/** md2pdf's own, tool-neutral marker lines. */
export const OWN_TOC_MARKER = {
  start: '<!-- toc START -->',
  end: '<!-- toc END -->',
} as const;

/** The registry entry for md2pdf's own marker. */
export const OWN_MARKER_ENTRY: TocMarkerEntry = {
  name: 'md2pdf',
  start: /^<!-- toc START -->\s*$/,
  end: /^<!-- toc END -->\s*$/,
};

/** The registry entry for doctoc's markers (`<!-- START doctoc generated TOC … -->`). */
export const DOCTOC_MARKER_ENTRY: TocMarkerEntry = {
  name: 'doctoc',
  tool: 'doctoc',
  start: /^<!-- START doctoc /,
  end: /^<!-- END doctoc /,
};

/**
 * Every marker md2pdf recognises, in no particular priority: the first genuine
 * START line in a document decides the block, whichever entry it belongs to.
 */
export const TOC_MARKERS: readonly TocMarkerEntry[] = [OWN_MARKER_ENTRY, DOCTOC_MARKER_ENTRY];

/**
 * Where a document's first genuine ToC block is, as {@link scanTocMarkers}
 * reports it. Line indexes are 0-based and count lines split on `\n`.
 */
export type TocMarkers =
  | { kind: 'none' }
  | { kind: 'pair'; startIndex: number; endIndex: number; entry: TocMarkerEntry }
  | { kind: 'broken'; message: string };

/** A genuine marker line: which entry it belongs to and which end it is. */
type MarkerHit = { entry: TocMarkerEntry; role: 'start' | 'end' };

/**
 * Splits a document into lines on `\n` only, so indexes and byte-for-byte
 * comparisons line up with what a backend writes back. A `\r` from a CRLF
 * document therefore stays on its line; see {@link bareLines}.
 *
 * @param raw - Full Markdown document contents.
 * @returns The document's lines, each still carrying a trailing `\r` if any.
 */
function splitLines(raw: string): string[] {
  return raw.split('\n');
}

/**
 * Strips what the scanning primitives in `markdown-scan.ts` do not expect: the
 * trailing `\r` a CRLF document leaves on each line, and a byte order mark in
 * front of the first line (which would hide a marker on line 1).
 *
 * @param lines - Lines from {@link splitLines}.
 * @returns The same lines without line terminators or BOM.
 */
function bareLines(lines: string[]): string[] {
  return lines.map((line, i) => {
    const bare = line.replace(/\r$/, '');
    return i === 0 && bare.startsWith(BOM) ? bare.slice(BOM.length) : bare;
  });
}

/**
 * Marks which lines carry a *genuine* marker of any registry entry: the line
 * opens an HTML comment block with the marker (`<!--` indented at most 3
 * spaces), outside any fenced code block or other comment block.
 *
 * @param lines - Document lines, without line terminators.
 * @param registry - Marker entries to recognise.
 * @returns An array parallel to `lines`: the hit, or `null`.
 */
function genuineMarkers(lines: string[], registry: readonly TocMarkerEntry[]): (MarkerHit | null)[] {
  const kinds = classifyLines(lines);

  return lines.map((line, i) => {
    if (kinds[i] !== 'comment-start') {
      return null;
    }
    // A comment-start line is indented at most 3 spaces, so trimming cannot
    // turn an indented code line into a marker.
    const text = line.trimStart();
    for (const entry of registry) {
      if (entry.start.test(text)) {
        return { entry, role: 'start' };
      }
      if (entry.end.test(text)) {
        return { entry, role: 'end' };
      }
    }
    return null;
  });
}

/**
 * Locates the first genuine ToC block in a document.
 *
 * - `none`: no genuine START marker of any entry. A document that only
 *   documents a marker has no ToC, and a lone END marker is harmless.
 * - `pair`: the first genuine START marker is followed by a genuine END marker
 *   of the same entry. Markers after it are ignored: only the first block is
 *   ever filled.
 * - `broken`: the first genuine START marker has no END marker of its entry
 *   after it, where a backend would replace everything to the end of the file
 *   (or, with the END first, splice the ToC in without removing the old one).
 *   The caller must not run the backend at all.
 *
 * @param raw - Full Markdown document contents.
 * @param registry - Marker entries to recognise; {@link TOC_MARKERS} by default.
 * @returns The marker situation, with a user-facing message when broken.
 */
export function scanTocMarkers(raw: string, registry: readonly TocMarkerEntry[] = TOC_MARKERS): TocMarkers {
  const markers = genuineMarkers(bareLines(splitLines(raw)), registry);
  const startIndex = markers.findIndex((hit) => hit?.role === 'start');

  if (startIndex === -1) {
    return { kind: 'none' };
  }

  const { entry } = markers[startIndex] as MarkerHit;
  const endIndex = markers.findIndex((hit) => hit?.role === 'end' && hit.entry === entry);
  if (endIndex === -1) {
    return {
      kind: 'broken',
      message: `${entry.name} START marker on line ${startIndex + 1} has no END marker, so the table of contents would replace everything after it`,
    };
  }
  if (endIndex < startIndex) {
    return {
      kind: 'broken',
      message: `${entry.name} END marker on line ${endIndex + 1} comes before the START marker on line ${startIndex + 1}`,
    };
  }

  return { kind: 'pair', startIndex, endIndex, entry };
}

/**
 * Returns the text of a block's two marker lines, without line terminator or
 * byte order mark, so they can be written back exactly as the author wrote
 * them.
 *
 * @param raw - Full Markdown document contents.
 * @param startIndex - Index of the START marker line.
 * @param endIndex - Index of the END marker line.
 * @returns The START and END marker lines.
 */
export function markerLines(raw: string, startIndex: number, endIndex: number): { start: string; end: string } {
  const lines = bareLines(splitLines(raw));
  return { start: lines[startIndex], end: lines[endIndex] };
}

/**
 * Removes every genuine ToC block of every registry entry — the START and END
 * marker lines and everything between them — from a document. `--merge` with
 * `--toc` puts one table of contents in front of all merged documents, so the
 * documents' own blocks have to go before the backend runs over the merged
 * file.
 *
 * Documented markers (in fences, inline code or comments) are left alone. A
 * block closes only on the END marker of the entry that opened it. A genuine
 * END marker without a START before it is dropped as well, so it cannot pair
 * up with anything later.
 *
 * @param raw - Full Markdown document contents.
 * @param registry - Marker entries to recognise; {@link TOC_MARKERS} by default.
 * @returns The document without its ToC blocks, and how many were removed.
 * @throws When a genuine START marker has no END marker after it, because the
 *   extent of that block is unknown.
 */
export function removeTocBlocks(
  raw: string,
  registry: readonly TocMarkerEntry[] = TOC_MARKERS,
): { body: string; removed: number } {
  const lines = splitLines(raw);
  const markers = genuineMarkers(bareLines(lines), registry);
  const kept: string[] = [];
  let open: { at: number; entry: TocMarkerEntry } | undefined;
  let removed = 0;

  lines.forEach((line, i) => {
    const hit = markers[i];
    if (hit?.role === 'start') {
      open ??= { at: i, entry: hit.entry };
    } else if (hit?.role === 'end') {
      if (open?.entry === hit.entry) {
        open = undefined;
        removed++;
      }
    } else if (!open) {
      kept.push(line);
    }
  });

  if (open) {
    throw new Error(`${open.entry.name} START marker on line ${open.at + 1} has no END marker`);
  }

  return { body: kept.join('\n'), removed };
}

/**
 * Formats the warning for `-u` on a document whose marker scan is `none`:
 * `-u` only refreshes an existing block and never adds one to the source, so
 * the flag has no effect on that file (#60).
 *
 * @param sourceFile - Path of the source Markdown file.
 * @param forceToc - Whether `--toc` was given, which already puts a ToC into
 *   the PDF and makes the `--toc` hint pointless.
 * @returns The warning text, naming the file.
 */
export function describeMissingMarkerBlock(sourceFile: string, forceToc: boolean): string {
  const advice = forceToc
    ? 'Add the marker block to keep a TOC in it (see README, "Table of Contents Markers"); -f alone only adds one to the PDF.'
    : 'Add the marker block (see README, "Table of Contents Markers") or use -f for a TOC in the PDF only.';

  return `${sourceFile} has no table of contents marker block; the source file was not updated. ${advice}`;
}

/**
 * Checks whether `after` differs from `before` only inside the first genuine
 * ToC block — the safety net before a refreshed ToC is written back to the
 * user's source file. Both documents must have a valid pair, and everything
 * before the START marker and after the END marker must be byte-identical.
 *
 * @param before - Source document contents before the refresh.
 * @param after - Document contents after the backend refreshed the ToC.
 * @param registry - Marker entries to recognise; {@link TOC_MARKERS} by default.
 * @returns `true` when writing `after` over `before` changes only the ToC block.
 */
export function isTocOnlyRefresh(
  before: string,
  after: string,
  registry: readonly TocMarkerEntry[] = TOC_MARKERS,
): boolean {
  const old = scanTocMarkers(before, registry);
  const refreshed = scanTocMarkers(after, registry);

  if (old.kind !== 'pair' || refreshed.kind !== 'pair') {
    return false;
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const head = (lines: string[], index: number) => lines.slice(0, index).join('\n');
  const tail = (lines: string[], index: number) => lines.slice(index + 1).join('\n');

  return (
    head(beforeLines, old.startIndex) === head(afterLines, refreshed.startIndex) &&
    tail(beforeLines, old.endIndex) === tail(afterLines, refreshed.endIndex)
  );
}
