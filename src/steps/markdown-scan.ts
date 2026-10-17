/**
 * Shared Markdown scanning primitives used by both `run-toc.ts` (to locate
 * the first `##`-equivalent heading for TOC placement) and `extract-title.ts`
 * (to locate the first heading of any level for the document title). Keeping
 * this logic in one place avoids two divergent implementations of
 * fence/comment/indentation/setext handling.
 *
 * Both consumers scan through {@link mapLiveContent}, which hides the two
 * containers that make a `#` line look like a heading without rendering as
 * one: fenced code blocks (#18) and HTML comment blocks (#32).
 * `toc-markers.ts` uses the underlying {@link classifyLines} to tell a
 * genuine ToC marker comment from a documented example (#44).
 */

/** Byte order mark, the one character every scan has to look past. */
export const BOM = '\uFEFF';

/**
 * Removes a leading UTF-8 byte order mark.
 *
 * Windows tooling (Notepad, `Out-File`, `Set-Content`) writes UTF-8 with a
 * BOM by default, and the BOM sits *before* the first character of the first
 * line: it hides a `---` frontmatter delimiter, a `#` heading and a doctoc
 * marker from every line-oriented scan in this module. Every scanner that
 * looks at line 1 therefore strips it first (#48).
 *
 * @param value - Raw file contents.
 * @returns The contents without a leading BOM code point.
 */
export function stripBom(value: string): string {
  return value.startsWith(BOM) ? value.slice(BOM.length) : value;
}

/**
 * Line-ending-preserving check for a blank (whitespace-only) line.
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns `true` when the line contains only whitespace.
 */
export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Detects a fenced-code-block delimiter line (``` or ~~~, indented up to 3
 * spaces, 3 or more delimiter characters) and reports the info string that
 * follows the delimiter run.
 *
 * The info string matters because CommonMark allows it only on an *opening*
 * fence: ```` ```js ```` can open a block but never close one (#33). Callers
 * tracking fence state must therefore require an empty `info` before treating
 * a delimiter as the closer.
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns The delimiter character, run length and trimmed info string, or
 *   `null` when the line is not a fence delimiter.
 */
export function matchFenceDelimiter(line: string): { char: string; len: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const delimiter = match[1];
  return { char: delimiter[0], len: delimiter.length, info: match[2].trim() };
}

/**
 * Checks whether a line is an ATX second-order heading (`## ...`).
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns `true` when the line is exactly a `##` heading.
 */
export function isAtxH2(line: string): boolean {
  return /^ {0,3}##(?:[ \t]|$)/.test(line);
}

/**
 * Checks whether a line could plausibly be the text of a setext heading,
 * i.e. it isn't blank and doesn't look like the start of some other block
 * (ATX heading, fence, list item, blockquote). This is a heuristic, not a
 * full CommonMark block-start disambiguation.
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns `true` when the line could be setext heading text.
 */
export function isPotentialSetextText(line: string): boolean {
  if (isBlank(line)) {
    return false;
  }
  if (/^ {0,3}#/.test(line)) {
    return false;
  }
  if (matchFenceDelimiter(line)) {
    return false;
  }
  if (/^ {0,3}[-*+] /.test(line)) {
    return false;
  }
  if (/^ {0,3}\d+[.)] /.test(line)) {
    return false;
  }
  if (/^ {0,3}>/.test(line)) {
    return false;
  }
  return true;
}

/**
 * Checks whether a line is a setext first-order-heading underline (a run of
 * one or more `=` characters, optionally indented and trailed by
 * whitespace).
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns `true` when the line is a setext `=` underline.
 */
export function isSetextH1Underline(line: string): boolean {
  return /^ {0,3}=+[ \t]*$/.test(line);
}

/**
 * Checks whether a line is a setext second-order-heading underline (a run
 * of one or more `-` characters, optionally indented and trailed by
 * whitespace).
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns `true` when the line is a setext `-` underline.
 */
export function isSetextH2Underline(line: string): boolean {
  return /^ {0,3}-+[ \t]*$/.test(line);
}

/** Start of an HTML comment. */
const COMMENT_OPEN = '<!--';

/** End of an HTML comment. */
const COMMENT_CLOSE = '-->';

/**
 * Removes every complete `<!-- ... -->` span from a line, and drops whatever
 * follows an unclosed `<!--`.
 *
 * This handles comments that sit *after* other content on the line, where
 * CommonMark sees inline HTML rather than an HTML block — so
 * `## Heading <!-- omit in toc -->` keeps its heading.
 *
 * A mid-line `<!--` deliberately does **not** open a block for the following
 * lines, only the rest of its own line. Suppressing the following lines would
 * match what an author writing `text <!--` … `-->` means, but it also fires on
 * ordinary prose that merely mentions the delimiter — a `` `<!--` `` inside an
 * inline code span, or an indented code sample — and would then hide every
 * heading after it. That is the failure this module exists to prevent, so the
 * line-oriented reading wins: only a line-start `<!--` opens a block, as in
 * CommonMark.
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns The line's content outside its comment spans.
 */
export function stripInlineComments(line: string): string {
  let text = '';
  let rest = line;

  for (;;) {
    const open = rest.indexOf(COMMENT_OPEN);
    if (open === -1) {
      return text + rest;
    }

    const close = indexOfCommentClose(rest, open);
    if (close === -1) {
      return text + rest.slice(0, open);
    }

    text += rest.slice(0, open);
    rest = rest.slice(close + COMMENT_CLOSE.length);
  }
}

/**
 * Finds the `-->` that closes the comment opened at `open`.
 *
 * The search starts just past the `<!`, not past the whole `<!--`, so that the
 * abbreviated empty comment `<!-->` — whose `-->` overlaps the opener's dashes
 * — is recognised as closed on its own line.
 *
 * @param line - Line to search.
 * @param open - Index of the `<!--` that opened the comment.
 * @returns The index of the closing `-->`, or `-1` when the line has none.
 */
function indexOfCommentClose(line: string, open: number): number {
  return line.indexOf(COMMENT_CLOSE, open + 2);
}

/**
 * Reduces a document to the content that actually renders, so that a `#` line
 * hidden inside a container is never mistaken for a heading.
 *
 * Two containers are tracked, both line-oriented:
 *
 * - **Fenced code blocks** (```` ``` ````/`~~~`): closed only by a run of the
 *   same character that is at least as long *and* carries no info string, per
 *   CommonMark (#33). Delimiter lines themselves are not content.
 * - **HTML comment blocks**: a line whose first non-space characters are
 *   `<!--` is a CommonMark type-2 HTML block and is opaque up to *and
 *   including* the line carrying `-->`, so `<!-- x --> # Real` yields no
 *   heading. A `<!--` appearing after other content affects only its own line
 *   — see {@link stripInlineComments}.
 *
 * This is still a documented heuristic, not a CommonMark parser: indented code
 * blocks are handled by the heading matchers themselves, and other HTML block
 * types, link reference definitions and inline escapes are not modelled.
 * Because a mid-line `<!--` never opens a block, prose that merely mentions
 * the delimiter — in an inline code span, say — cannot hide a later heading.
 *
 * @param lines - Document lines, without line terminators.
 * @returns An array parallel to `lines` holding each line's live content, or
 *   `null` where the line carries none (a fence delimiter, a line inside a
 *   fenced block, or a line belonging to an HTML comment block).
 */
export function mapLiveContent(lines: string[]): (string | null)[] {
  return classifyLines(lines).map((kind, i) => (kind === 'content' ? stripInlineComments(lines[i]) : null));
}

/**
 * What a line is with respect to the containers {@link mapLiveContent}
 * tracks:
 *
 * - `content`: the line renders (subject to its inline comments).
 * - `fence`: a fence delimiter, or a line inside a fenced code block.
 * - `comment-start`: the line whose leading `<!--` opens an HTML comment
 *   block, whether or not the block closes on that same line.
 * - `comment`: a later line of an HTML comment block, up to and including the
 *   one carrying `-->`.
 */
export type LineKind = 'content' | 'fence' | 'comment-start' | 'comment';

/**
 * Classifies every line by the container it belongs to, with the fence and
 * HTML-comment rules described at {@link mapLiveContent}. Exposed separately
 * because a ToC marker *is* an HTML comment: `toc-markers.ts` needs to
 * know which lines open a real comment block, not just which lines render.
 *
 * @param lines - Document lines, without line terminators.
 * @returns An array parallel to `lines` holding each line's {@link LineKind}.
 */
export function classifyLines(lines: string[]): LineKind[] {
  const kinds: LineKind[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let inComment = false;

  for (const line of lines) {
    if (inComment) {
      // The line that closes an HTML block still belongs to it.
      if (line.includes(COMMENT_CLOSE)) {
        inComment = false;
      }
      kinds.push('comment');
      continue;
    }

    const fence = matchFenceDelimiter(line);

    if (fenceChar !== null) {
      if (fence && fence.char === fenceChar && fence.len >= fenceLen && fence.info === '') {
        fenceChar = null;
        fenceLen = 0;
      }
      kinds.push('fence');
      continue;
    }

    if (fence) {
      fenceChar = fence.char;
      fenceLen = fence.len;
      kinds.push('fence');
      continue;
    }

    if (/^ {0,3}<!--/.test(line)) {
      inComment = indexOfCommentClose(line, line.indexOf(COMMENT_OPEN)) === -1;
      kinds.push('comment-start');
      continue;
    }

    kinds.push('content');
  }

  return kinds;
}

/**
 * Finds the first second-order heading in the document's live content,
 * recognising both ATX (`## ...`) and setext (text line followed by a `---`
 * underline) headings. Lines inside fenced code blocks or HTML comment blocks
 * are ignored — see {@link mapLiveContent}. A setext underline must itself be
 * live content, so a heading cannot be formed across the edge of a container.
 *
 * @param lines - Document lines, without line terminators.
 * @returns The index of the first `##`-equivalent heading line, or `-1`
 *   when none exists.
 */
export function findFirstH2Index(lines: string[]): number {
  const live = mapLiveContent(lines);

  for (let i = 0; i < live.length; i++) {
    const line = live[i];
    if (line === null) {
      continue;
    }

    if (isAtxH2(line)) {
      return i;
    }

    const next = i + 1 < live.length ? live[i + 1] : null;
    if (next !== null && isPotentialSetextText(line) && isSetextH2Underline(next)) {
      return i;
    }
  }

  return -1;
}

/**
 * Detects a leading YAML frontmatter block (as supported by md-to-pdf's
 * underlying front-matter parser): the very first line must be exactly
 * `---` (no leading indentation, trailing whitespace allowed), closed by a
 * later line that is exactly `---` or `...`.
 *
 * @param lines - Document lines, without line terminators.
 * @returns The index of the closing delimiter line, or `-1` when the
 *   document has no leading frontmatter block (including the degenerate
 *   case of an unterminated leading `---`, which is treated as no
 *   frontmatter rather than swallowing the rest of the file).
 */
export function findFrontmatterEnd(lines: string[]): number {
  if (lines.length === 0 || !/^---[ \t]*$/.test(lines[0])) {
    return -1;
  }

  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i])) {
      return i;
    }
  }

  return -1;
}

/**
 * A heading found by {@link findFirstHeading}.
 */
export interface HeadingMatch {
  /** Heading level: 1-6 for ATX, 1 for a `===` setext underline, 2 for a `---` setext underline. */
  level: number;
  /** Heading text, trimmed. */
  text: string;
}

/**
 * Checks whether a line is a genuine ATX heading (`#` through `######`,
 * indented up to 3 spaces, followed by whitespace or end of line) per
 * CommonMark. Unlike a naive `/^\s*#+/` match, this rejects `#hashtag`
 * (no space after the `#`) and lines indented 4 or more spaces (which
 * CommonMark treats as an indented code block, not a heading).
 *
 * The optional closing hash sequence CommonMark allows is stripped from the
 * text rather than returned as part of it (#33), so `## Heading ##` is the
 * heading `Heading`. A trailing `#` run only closes the heading when it is
 * preceded by a space or tab, or is the whole remainder — hence
 * `## Heading#` keeps its `#`, while `## #` is an empty heading.
 * Backslash-escaped hashes (`## foo \#\##`, which CommonMark renders as
 * `foo ###`) are out of scope: this module does not model inline escapes.
 *
 * @param line - Single line of Markdown, without its line terminator.
 * @returns The heading level and text, or `null` when the line is not an
 *   ATX heading.
 */
export function matchAtxHeading(line: string): HeadingMatch | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!match) {
    return null;
  }

  const content = (match[2] ?? '').trim();
  const text = /^#+$/.test(content) ? '' : content.replace(/[ \t]+#+$/, '');

  return { level: match[1].length, text };
}

/**
 * Finds the first heading in the document's live content, of any level,
 * recognising both ATX (`#` through `######`) and setext (text line followed
 * by a `===` or `---` underline) headings. Lines inside fenced code blocks or
 * HTML comment blocks are ignored — see {@link mapLiveContent} — as are
 * non-heading `#word` lines and lines indented 4 or more spaces.
 *
 * @param lines - Document lines, without line terminators. Callers should
 *   already have stripped any leading YAML frontmatter block (see
 *   {@link findFrontmatterEnd}) before calling this.
 * @returns The first heading found, or `null` when none exists.
 */
export function findFirstHeading(lines: string[]): HeadingMatch | null {
  const live = mapLiveContent(lines);

  for (let i = 0; i < live.length; i++) {
    const line = live[i];
    if (line === null) {
      continue;
    }

    const atx = matchAtxHeading(line);
    if (atx) {
      return atx;
    }

    const next = i + 1 < live.length ? live[i + 1] : null;
    if (next !== null && isPotentialSetextText(line)) {
      if (isSetextH1Underline(next)) {
        return { level: 1, text: line.trim() };
      }
      if (isSetextH2Underline(next)) {
        return { level: 2, text: line.trim() };
      }
    }
  }

  return null;
}
