/**
 * Pure rules behind the doctoc step's data-loss protection (#44).
 *
 * doctoc up to 2.3.0 found its markers with a plain per-line regex that knew
 * nothing about code fences, inline code or HTML comments, and
 * `update-section` then replaced everything from the first START match to the
 * first END match — or to the end of the file when there was no END. A
 * document that merely *documented* the marker (in a fence, or in backticks)
 * lost everything after the example. doctoc 2.5, the version md2pdf installs,
 * only matches markers in HTML nodes of the parsed document. These rules stay:
 * `DOCTOC_PKG` can still select an older doctoc, and a broken marker pair
 * deserves an error rather than whatever doctoc makes of it.
 *
 * This module tells genuine markers from documented ones, hides the documented
 * ones from doctoc for the duration of a run, and verifies a refresh before
 * `run-doctoc.ts` writes it back to the user's source file. `run-doctoc.ts`
 * owns the file I/O and the doctoc invocation; this module owns the rules.
 */

import { classifyLines } from './markdown-scan';

/**
 * The `<!-- ` in front of every marker occurrence doctoc's own regexes
 * (`/<!-- START doctoc /`, `/<!-- END doctoc /`) would match, for masking.
 */
const MARKER_PREFIX = /<!-- (?=(?:START|END) doctoc )/g;

/**
 * Private Use Area character inserted after `<!--` so doctoc's regexes stop
 * matching a documented marker. doctoc never produces it and prose does not
 * contain it, which is what makes {@link unmaskDocumentedMarkers} lossless.
 */
const MASK = String.fromCharCode(0xe000);

/** The prefix of a masked marker occurrence, for unmasking. */
const MASKED_PREFIX = new RegExp(`<!--${MASK} (?=(?:START|END) doctoc )`, 'g');

/** A masked marker occurrence, for the collision check before masking. */
const MASKED_MARKER = new RegExp(`<!--${MASK} (?:START|END) doctoc `);

/** Byte order mark, stripped from the first line before scanning. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Where a document's genuine doctoc markers are, as {@link scanDoctocMarkers}
 * reports them. Line indexes are 0-based.
 */
export type DoctocMarkers =
  | { kind: 'none' }
  | { kind: 'pair'; startIndex: number; endIndex: number }
  | { kind: 'broken'; message: string };

/**
 * Splits a document into lines the way doctoc does (on `\n` only), so indexes
 * and byte-for-byte comparisons line up with doctoc's output. A `\r` from a
 * CRLF document therefore stays on its line; see {@link bareLines}.
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
 * Marks which lines carry a *genuine* doctoc marker: the line opens an HTML
 * comment block with the marker (`<!--` indented at most 3 spaces), outside
 * any fenced code block or other comment block. Anything else doctoc's regex
 * would still match — an example in a fence, in inline code, in an indented
 * code block or inside a comment — is documentation, not a marker.
 *
 * @param lines - Document lines, without line terminators.
 * @returns An array parallel to `lines`: `'start'`, `'end'` or `null`.
 */
function genuineMarkers(lines: string[]): ('start' | 'end' | null)[] {
  const kinds = classifyLines(lines);

  return lines.map((line, i) => {
    if (kinds[i] !== 'comment-start') {
      return null;
    }
    // A comment-start line is indented at most 3 spaces, so trimming cannot
    // turn an indented code line into a marker.
    const text = line.trimStart();
    if (text.startsWith('<!-- START doctoc ')) {
      return 'start';
    }
    if (text.startsWith('<!-- END doctoc ')) {
      return 'end';
    }
    return null;
  });
}

/**
 * Locates the genuine doctoc marker pair in a document.
 *
 * - `none`: no genuine START marker. A document that only documents the
 *   marker has no TOC, and a lone END marker is harmless (doctoc then
 *   prepends a fresh TOC and deletes nothing).
 * - `pair`: the first genuine START marker is followed by a genuine END
 *   marker. Once documented markers are masked, this is exactly the range
 *   doctoc replaces.
 * - `broken`: a genuine START marker without an END marker after it, where
 *   doctoc would replace everything to the end of the file (or, with the END
 *   first, splice the TOC in without removing the old one). The caller must
 *   not run doctoc at all.
 *
 * @param raw - Full Markdown document contents.
 * @returns The marker situation, with a user-facing message when broken.
 */
export function scanDoctocMarkers(raw: string): DoctocMarkers {
  const markers = genuineMarkers(bareLines(splitLines(raw)));
  const startIndex = markers.indexOf('start');

  if (startIndex === -1) {
    return { kind: 'none' };
  }

  const endIndex = markers.indexOf('end');
  if (endIndex === -1) {
    return {
      kind: 'broken',
      message: `doctoc START marker on line ${startIndex + 1} has no END marker, so doctoc would replace everything after it`,
    };
  }
  if (endIndex < startIndex) {
    return {
      kind: 'broken',
      message: `doctoc END marker on line ${endIndex + 1} comes before the START marker on line ${startIndex + 1}`,
    };
  }

  return { kind: 'pair', startIndex, endIndex };
}

/**
 * Removes every genuine doctoc block — the START and END marker lines and
 * everything between them — from a document. `--merge` with `--toc` puts one
 * table of contents in front of all merged documents, so the documents' own
 * blocks have to go before doctoc runs over the merged file.
 *
 * Documented markers (in fences, inline code or comments) are left alone. A
 * genuine END marker without a START before it is dropped as well, so it
 * cannot pair up with anything later.
 *
 * @param raw - Full Markdown document contents.
 * @returns The document without its doctoc blocks, and how many were removed.
 * @throws When a genuine START marker has no END marker after it, because the
 *   extent of that block is unknown.
 */
export function removeDoctocBlocks(raw: string): { body: string; removed: number } {
  const lines = splitLines(raw);
  const markers = genuineMarkers(bareLines(lines));
  const kept: string[] = [];
  let openAt = -1;
  let removed = 0;

  lines.forEach((line, i) => {
    if (markers[i] === 'start') {
      openAt = openAt === -1 ? i : openAt;
    } else if (markers[i] === 'end') {
      if (openAt !== -1) {
        openAt = -1;
        removed++;
      }
    } else if (openAt === -1) {
      kept.push(line);
    }
  });

  if (openAt !== -1) {
    throw new Error(`doctoc START marker on line ${openAt + 1} has no END marker`);
  }

  return { body: kept.join('\n'), removed };
}

/**
 * Formats the warning for `-u` on a document whose marker scan is `none`:
 * `-u` only refreshes an existing block and never adds one to the source, so
 * the flag has no effect on that file (#60).
 *
 * @param sourceFile - Path of the source Markdown file.
 * @param forceDoctoc - Whether `--toc` was given, which already puts a TOC
 *   into the PDF and makes the `--toc` hint pointless.
 * @returns The warning text, naming the file.
 */
export function describeMissingMarkerBlock(sourceFile: string, forceDoctoc: boolean): string {
  const advice = forceDoctoc
    ? 'Add the marker block to keep a TOC in it (see README, "Table of Contents Markers"); -f alone only adds one to the PDF.'
    : 'Add the marker block (see README, "Table of Contents Markers") or use -f for a TOC in the PDF only.';

  return `${sourceFile} has no doctoc marker block; the source file was not updated. ${advice}`;
}

/**
 * Hides every documented (non-genuine) doctoc marker from doctoc by inserting
 * {@link MASK} after its `<!--`, so doctoc only ever sees genuine markers.
 * Line count and every other byte stay unchanged; genuine marker lines are
 * left alone.
 *
 * @param raw - Full Markdown document contents.
 * @returns The document with documented markers masked.
 * @throws When the document already contains a masked marker, which would
 *   make {@link unmaskDocumentedMarkers} ambiguous.
 */
export function maskDocumentedMarkers(raw: string): string {
  if (MASKED_MARKER.test(raw)) {
    throw new Error('Document already contains a masked doctoc marker (U+E000 after "<!--"), refusing to run doctoc');
  }

  const lines = splitLines(raw);
  const markers = genuineMarkers(bareLines(lines));

  return lines
    .map((line, i) => (markers[i] === null ? line.replace(MARKER_PREFIX, `<!--${MASK} `) : line))
    .join('\n');
}

/**
 * Restores the markers hidden by {@link maskDocumentedMarkers}.
 *
 * @param masked - Document contents that went through the mask (and doctoc).
 * @returns The document with every documented marker restored.
 */
export function unmaskDocumentedMarkers(masked: string): string {
  return masked.replace(MASKED_PREFIX, '<!-- ');
}

/**
 * Checks whether `after` differs from `before` only inside the genuine doctoc
 * marker pair — the safety net before a refreshed TOC is written back to the
 * user's source file. Both documents must have a valid pair, and everything
 * before the START marker and after the END marker must be byte-identical.
 *
 * @param before - Source document contents before the refresh.
 * @param after - Document contents after doctoc refreshed the TOC.
 * @returns `true` when writing `after` over `before` changes only the TOC block.
 */
export function isTocOnlyRefresh(before: string, after: string): boolean {
  const old = scanDoctocMarkers(before);
  const refreshed = scanDoctocMarkers(after);

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
