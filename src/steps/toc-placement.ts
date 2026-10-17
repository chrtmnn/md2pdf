/**
 * Pure text transformation behind the TOC relocation performed by
 * `run-toc.ts`. Kept separate from that file so the placement rules —
 * blank-line hygiene, line-ending preservation and the byte-identical no-op —
 * can be exercised as plain string in / string out, without a ToC backend,
 * `npx`, or a temp directory. `run-toc.ts` owns the file I/O; this module owns
 * the rules.
 */

import { BOM, findFirstH2Index, findFrontmatterEnd, isBlank } from './markdown-scan';
import { TocBlock } from './toc-backend';
import { scanTocMarkers } from './toc-markers';

/**
 * Removes the TOC block `[startIdx, endIdx]` from `lines`, collapsing
 * the blank-line seam left behind so the removal doesn't produce a doubled
 * blank line.
 *
 * @param lines - Full document lines, without line terminators.
 * @param startIdx - Index of the start-marker line.
 * @param endIdx - Index of the end-marker line.
 * @returns The document lines with the block removed, and the removed
 *   block itself.
 */
function removeBlockCollapsingSeam(
  lines: string[],
  startIdx: number,
  endIdx: number,
): { withoutBlock: string[]; block: string[] } {
  const block = lines.slice(startIdx, endIdx + 1);
  let before = lines.slice(0, startIdx);
  let after = lines.slice(endIdx + 1);

  const hadBlankBefore = before.length > 0 && isBlank(before[before.length - 1]);
  const hadBlankAfter = after.length > 0 && isBlank(after[0]);

  while (before.length > 0 && isBlank(before[before.length - 1])) {
    before.pop();
  }
  while (after.length > 0 && isBlank(after[0])) {
    after.shift();
  }

  if (before.length > 0 && after.length > 0 && (hadBlankBefore || hadBlankAfter)) {
    before = before.concat(['']);
  }

  return { withoutBlock: before.concat(after), block };
}

/**
 * Re-inserts the TOC block directly before `lines[h2Idx]`, ensuring
 * exactly one blank line on each side of the block (no leading blank when
 * the block lands at the very top of the file).
 *
 * @param lines - Document lines with the TOC block already removed.
 * @param block - The TOC block lines to re-insert.
 * @param h2Idx - Index (within `lines`) of the first `##`-equivalent heading.
 * @returns The document lines with the block re-inserted.
 */
function insertBlockBeforeIndex(lines: string[], block: string[], h2Idx: number): string[] {
  const before = lines.slice(0, h2Idx);
  const after = lines.slice(h2Idx);

  while (before.length > 0 && isBlank(before[before.length - 1])) {
    before.pop();
  }

  const result = [...before];
  if (before.length > 0) {
    result.push('');
  }
  result.push(...block);
  result.push('');
  result.push(...after);
  return result;
}

/**
 * Relocates a freshly created TOC block so it sits directly before the
 * first second-order (`##`) heading in the document, instead of wherever
 * the backend's own default placement chose (doctoc: near the top of the
 * file). Returns the input unchanged when the document has no TOC block,
 * when no `##`-equivalent heading exists anywhere (the backend's placement is
 * left untouched), or when the block already sits directly before the first
 * `##` heading — in which case the returned string is byte-identical to the
 * input.
 *
 * The document's dominant line ending (`\r\n` when the input contains one,
 * `\n` otherwise) and the presence or absence of a trailing newline are
 * preserved.
 *
 * A leading YAML frontmatter block (see {@link findFrontmatterEnd}) is
 * treated as opaque: it is excluded from the heading scan and the TOC block
 * is never inserted at or before its closing delimiter, even if a frontmatter
 * value line is immediately followed by a line of dashes that would otherwise
 * look like a setext heading underline.
 *
 * @param raw - Full Markdown document contents.
 * @param block - Where the block is, as a backend reports it. Without it the
 *   first genuine block of any registry marker is relocated (see
 *   {@link scanTocMarkers}).
 * @returns The document with the TOC block relocated, or `raw` unchanged.
 */
export function relocateTocBeforeFirstH2(raw: string, block?: TocBlock): string {
  // A BOM sits before the first character of line 1, where it would hide a
  // frontmatter delimiter or a setext heading from the scan below. It is
  // detached for the duration and put back verbatim, so a document that
  // carries one keeps it (#48).
  const bom = raw.startsWith(BOM) ? BOM : '';
  return bom + relocateInBody(bom ? raw.slice(BOM.length) : raw, block);
}

/**
 * The relocation itself, on a document guaranteed to start without a BOM.
 *
 * @param raw - Document contents without a leading BOM.
 * @param block - Where the block is, if known.
 * @returns The document with the TOC block relocated, or `raw` unchanged.
 */
function relocateInBody(raw: string, block?: TocBlock): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith('\n');

  const lines = raw.split(/\r\n|\n/);
  if (hadTrailingNewline) {
    lines.pop();
  }

  // A marker is an HTML comment, so only a line that genuinely opens one
  // counts. A plain `includes` would also find the markers a document merely
  // *shows* inside a fenced example and relocate those lines instead of the
  // real TOC (#47). Line indexes are the same with or without the BOM.
  const found = block ?? scanTocMarkers(raw);
  if (!('startIndex' in found) || found.endIndex >= lines.length) {
    return raw;
  }
  const { startIndex: startIdx, endIndex: endIdx } = found;

  const { withoutBlock, block: blockLines } = removeBlockCollapsingSeam(lines, startIdx, endIdx);

  // Frontmatter detection runs on `withoutBlock` (post-removal), so it
  // stays correct even if the backend's block had ended up inside or right
  // after the frontmatter: removal never shifts the leading lines, so the
  // frontmatter's own indices are unaffected either way.
  const frontmatterEnd = findFrontmatterEnd(withoutBlock);
  const searchStart = frontmatterEnd === -1 ? 0 : frontmatterEnd + 1;

  const relativeH2Idx = findFirstH2Index(withoutBlock.slice(searchStart));
  if (relativeH2Idx === -1) {
    // No `##`-equivalent heading anywhere in the searchable region (either
    // no such heading exists, or the document is frontmatter-only): leave
    // the backend's own placement untouched.
    return raw;
  }
  const h2Idx = searchStart + relativeH2Idx;

  const finalLines = insertBlockBeforeIndex(withoutBlock, blockLines, h2Idx);
  return finalLines.join(eol) + (hadTrailingNewline ? eol : '');
}
