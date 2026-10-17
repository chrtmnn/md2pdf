/**
 * The doctoc implementation of {@link TocBackend} (#83). Everything that knows
 * doctoc's syntax lives here: its marker lines, the "DON'T EDIT" note it writes
 * into the block, and the masking that keeps doctoc away from every marker but
 * the block it is meant to fill.
 *
 * doctoc up to 2.3.0 found its markers with a plain per-line regex that knew
 * nothing about code fences, inline code or HTML comments, and `update-section`
 * then replaced everything from the first START match to the first END match —
 * or to the end of the file when there was no END (#44). doctoc 2.5, the
 * version md2pdf installs, only matches markers in HTML nodes of the parsed
 * document. The masking stays: `DOCTOC_PKG` can still select an older doctoc,
 * and it is also what makes doctoc ignore every block but the first.
 *
 * A run translates the requested block into doctoc's markers, masks every other
 * doctoc marker in the document, lets doctoc fill the block, then puts the
 * requested markers back and unmasks. A block that already carries doctoc's
 * markers is handed over untouched, so doctoc-marked documents come out exactly
 * as they did before the backend abstraction.
 */

import fs from 'fs';
import { TocBackend, TocBlock, TocRequest, TocResult } from './toc-backend';
import { DOCTOC_MARKER_ENTRY, scanTocMarkers } from './toc-markers';

/** The START marker line doctoc writes. */
export const DOCTOC_START_LINE = '<!-- START doctoc generated TOC please keep comment here to allow auto update -->';

/** The END marker line doctoc writes. */
export const DOCTOC_END_LINE = '<!-- END doctoc generated TOC please keep comment here to allow auto update -->';

/** The note doctoc writes right after its START marker; meaningless under any other marker. */
export const DOCTOC_NOTE_LINE = "<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->";

/**
 * The `<!-- ` in front of every marker occurrence doctoc's own regexes
 * (`/<!-- START doctoc /`, `/<!-- END doctoc /`) would match, for masking.
 */
const MARKER_PREFIX = /<!-- (?=(?:START|END) doctoc )/g;

/**
 * Private Use Area character inserted after `<!--` so doctoc's regexes stop
 * matching a marker. doctoc never produces it and prose does not contain it,
 * which is what makes the unmasking lossless.
 */
const MASK = String.fromCharCode(0xe000);

/** The prefix of a masked marker occurrence, for unmasking. */
const MASKED_PREFIX = new RegExp(`<!--${MASK} (?=(?:START|END) doctoc )`, 'g');

/** A masked marker occurrence, for the collision check before masking. */
const MASKED_MARKER = new RegExp(`<!--${MASK} (?:START|END) doctoc `);

/** Byte order mark, kept in front of line 1 when that line is replaced. */
const BOM = String.fromCharCode(0xfeff);

/**
 * Replaces a line's text and keeps what frames it: a byte order mark in front
 * and the `\r` of a CRLF line ending behind.
 *
 * @param line - The line being replaced, split on `\n`.
 * @param text - The new text, without terminator.
 * @returns The replacement line.
 */
function replaceLine(line: string, text: string): string {
  const bom = line.startsWith(BOM) ? BOM : '';
  const cr = line.endsWith('\r') ? '\r' : '';
  return bom + text + cr;
}

/**
 * Strips a line down to its marker text: no BOM, no `\r`, no indentation.
 *
 * @param line - A line split on `\n`.
 * @returns The bare text.
 */
function bare(line: string): string {
  return (line.startsWith(BOM) ? line.slice(BOM.length) : line).replace(/\r$/, '').trimStart();
}

/**
 * Prepares a document for doctoc: every doctoc marker outside the block is
 * masked, and the block's marker lines become doctoc's unless they already are.
 * Every other byte stays unchanged.
 *
 * A translated START line is followed by doctoc's note line, the one line the
 * prepared document gains. doctoc 2.5 assumes the note is there: it treats the
 * START marker as reaching to the end of the note and only looks for the
 * previous title after it, so without the note a block's title is lost on
 * every refresh. doctoc up to 2.3 reads the line two below START as the title.
 * {@link readDoctocOutput} drops the note again.
 *
 * Masking *every* doctoc marker but the block, rather than only documented
 * ones, also hides a second genuine block and a stray END line, so doctoc can
 * only ever see the block it is asked to fill.
 *
 * @param markdown - Document contents.
 * @param block - The block doctoc should fill; absent to let it create one.
 * @returns The document as doctoc should see it.
 * @throws When the document already contains a masked marker, which would
 *   make the unmasking ambiguous.
 */
export function prepareDoctocInput(markdown: string, block?: TocBlock): string {
  if (MASKED_MARKER.test(markdown)) {
    throw new Error('Document already contains a masked doctoc marker (U+E000 after "<!--"), refusing to run doctoc');
  }

  return markdown
    .split('\n')
    .map((line, i) => {
      if (i === block?.startIndex) {
        if (DOCTOC_MARKER_ENTRY.start.test(bare(line))) {
          return line;
        }
        const cr = line.endsWith('\r') ? '\r' : '';
        return `${replaceLine(line, DOCTOC_START_LINE)}\n${DOCTOC_NOTE_LINE}${cr}`;
      }
      if (i === block?.endIndex) {
        return DOCTOC_MARKER_ENTRY.end.test(bare(line)) ? line : replaceLine(line, DOCTOC_END_LINE);
      }
      return line.replace(MARKER_PREFIX, `<!--${MASK} `);
    })
    .join('\n');
}

/**
 * Reads doctoc's output back: finds the block it filled (the only unmasked
 * doctoc marker pair), gives it the requested marker lines, and unmasks the
 * rest.
 *
 * Under a marker other than doctoc's, the "DON'T EDIT … RE-RUN doctoc" note is
 * dropped: the block no longer belongs to doctoc as far as the document author
 * is concerned, and doctoc does not need the note to refresh it next time.
 *
 * Every doctoc marker but the block's is masked, so the output holds exactly
 * one unmasked START line — unless doctoc did not recognise the translated
 * block (a marker inside another HTML block such as `<details>` is no HTML
 * node of its own) and created a second one. Under a requested marker that
 * fails the file instead of renaming the wrong block; a doctoc-marked block
 * keeps doctoc's pre-#83 behaviour of a new block at the top.
 *
 * @param output - The document as doctoc left it.
 * @param markers - The marker lines the block must carry; absent to keep doctoc's.
 * @returns The finished document and where its block is; no block when doctoc
 *   wrote none (a document without headings, or with `<!-- DOCTOC SKIP -->`).
 * @throws When doctoc left an unfinished block behind, or did not fill the
 *   block it was asked to fill under a requested marker.
 */
export function readDoctocOutput(output: string, markers?: { start: string; end: string }): TocResult {
  const found = scanTocMarkers(output, [DOCTOC_MARKER_ENTRY]);

  if (found.kind === 'broken') {
    throw new Error(`doctoc left an unfinished table of contents block: ${found.message}`);
  }
  if (found.kind === 'none') {
    return { markdown: unmask(output) };
  }

  let { startIndex, endIndex } = found;
  if (markers) {
    const lines = output.split('\n');
    if (lines.filter((line) => DOCTOC_MARKER_ENTRY.start.test(bare(line))).length > 1) {
      throw new Error(
        'doctoc did not recognise the table of contents block (is it inside another HTML block?) and created another one',
      );
    }
    lines[startIndex] = replaceLine(lines[startIndex], markers.start);
    lines[endIndex] = replaceLine(lines[endIndex], markers.end);
    if (startIndex + 1 < endIndex && bare(lines[startIndex + 1]) === DOCTOC_NOTE_LINE) {
      lines.splice(startIndex + 1, 1);
      endIndex--;
    }
    output = lines.join('\n');
  }

  return { markdown: unmask(output), block: { startIndex, endIndex } };
}

/**
 * Restores the markers hidden by {@link prepareDoctocInput}.
 *
 * @param masked - Document contents that went through the mask (and doctoc).
 * @returns The document with every masked marker restored.
 */
function unmask(masked: string): string {
  return masked.replace(MASKED_PREFIX, '<!-- ');
}

/**
 * Records which line breaks of a document are CRLF, so the document can be
 * handed to doctoc with LF only and get its own line endings back.
 *
 * @param markdown - Document contents.
 * @returns One entry per line break, in order: `true` for CRLF.
 */
function lineEndings(markdown: string): boolean[] {
  return markdown
    .split('\n')
    .slice(0, -1)
    .map((line) => line.endsWith('\r'));
}

/**
 * Gives doctoc's LF output the line endings of the document it came from.
 *
 * doctoc only rewrites its block, so the lines before the block line up with
 * the source by index and the lines after it by their distance from the end;
 * both keep their own line ending byte for byte, also in a document that mixes
 * CRLF and LF. The block's lines take the ending of the START line it replaced,
 * or for a new block the ending most of the document uses. A line doctoc added
 * next to a new block that lines up with no source line is treated as part of
 * the block.
 *
 * @param output - doctoc's output, LF only.
 * @param crlf - The source's line endings, from {@link lineEndings}.
 * @param source - The block in the source; absent when doctoc created one.
 * @param block - The block in the output; absent when doctoc wrote none.
 * @returns The output with the source's line endings.
 */
function restoreLineEndings(output: string, crlf: boolean[], source?: TocBlock, block?: TocBlock): string {
  const lines = output.split('\n');
  const shift = lines.length - 1 - crlf.length;
  const blockCrlf = source ? crlf[source.startIndex] : crlf.filter(Boolean).length * 2 > crlf.length;

  return lines
    .map((line, i) => {
      if (i === lines.length - 1) {
        return line;
      }
      let isCrlf: boolean | undefined = blockCrlf;
      if (!block || i < block.startIndex) {
        isCrlf = crlf[i];
      } else if (i >= block.endIndex) {
        isCrlf = crlf[i - shift];
      }
      return line + ((isCrlf ?? blockCrlf) ? '\r\n' : '\n');
    })
    .join('');
}

/** doctoc as md2pdf's ToC backend. */
export const DOCTOC_BACKEND: TocBackend = {
  name: 'doctoc',
  nativeMarker: DOCTOC_MARKER_ENTRY,
  generate({ markdown, block, markers, file, options, run }: TocRequest): TocResult {
    // doctoc 2.5's parser drops a leading BOM and then splices with offsets
    // that are one character off: it eats the line break before the block, or
    // the last character of a heading right above it. The BOM is detached for
    // the run and put back; it changes no line index.
    const bom = markdown.startsWith(BOM) ? BOM : '';
    // doctoc 2.5 refreshes an existing block in a CRLF document by skipping
    // one character after END instead of the whole line break, which leaves a
    // stray `\n` behind the block — and `-u` refusing every such file. doctoc
    // therefore only ever sees LF, and each line gets its own ending back.
    const body = markdown.slice(bom.length);
    const crlf = lineEndings(body);
    fs.writeFileSync(file, prepareDoctocInput(body.replace(/\r\n/g, '\n'), block));
    run('doctoc', [file], options);
    const result = readDoctocOutput(fs.readFileSync(file, 'utf8'), markers);
    return { ...result, markdown: bom + restoreLineEndings(result.markdown, crlf, block, result.block) };
  },
};
