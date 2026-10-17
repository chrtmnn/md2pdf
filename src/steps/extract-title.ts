import fs from 'fs';
import { ConversionContext } from '../types';
import { findFrontmatterEnd, findFirstHeading, stripBom } from './markdown-scan';

/**
 * Extracts the title from the first Markdown heading and stores it as the
 * document title.
 *
 * The scan is fence-aware (fenced code blocks, ``` and ~~~, are ignored --
 * shared with `run-toc.ts`'s TOC-placement scanner) and skips a leading
 * YAML frontmatter block. A "heading" here is either a genuine ATX heading
 * (`#` through `######`, followed by whitespace or end of line -- `#hashtag`
 * with no space does not count, per CommonMark) or a setext heading (a text
 * line followed by a `===` or `---` underline). Lines indented 4 or more
 * spaces are treated as an indented code block, not a heading.
 *
 * Decision: setext headings count as title candidates at the same priority
 * as ATX headings, and headings of any level (not just h1 / `===`) are
 * considered. This mirrors the pre-fix behaviour, where the *first* heading
 * found anywhere in the document -- regardless of level -- became the
 * title; narrowing the search to ATX-only or to level-1-only would be a
 * behaviour change beyond the scope of this fix. The first heading
 * encountered while scanning top to bottom wins, whether it is ATX or
 * setext.
 *
 * Leaves the existing fallback title unchanged when no heading is present —
 * and when the first heading carries no text (`#`, `## #`), which renders as
 * an empty heading and would otherwise blank out the title (#48).
 *
 * A leading UTF-8 BOM is stripped before the scan. It would otherwise hide
 * both the `---` of a frontmatter block and a `#` on line 1, which together
 * turned a `title:` key into a setext heading and put the raw YAML into the
 * PDF metadata (#48).
 *
 * @param context - Mutable conversion state for the current source file.
 */
export function extractTitle(context: ConversionContext): void {
  const raw = stripBom(fs.readFileSync(context.inputMarkdown, 'utf8'));
  const lines = raw.split(/\r\n|\n/);

  const frontmatterEnd = findFrontmatterEnd(lines);
  const searchStart = frontmatterEnd === -1 ? 0 : frontmatterEnd + 1;

  const heading = findFirstHeading(lines.slice(searchStart));

  const title = heading?.text.trim();

  if (title) {
    context.docTitle = title;
  }
}
