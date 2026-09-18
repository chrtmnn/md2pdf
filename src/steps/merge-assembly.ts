/**
 * Pure text and path computations behind `merge-markdown.ts`: how the source
 * documents are normalised and glued together, and where the merged PDF
 * defaults to. Kept separate from that file so these rules can be exercised
 * without creating temp directories, following the same split as
 * `markdown-scan.ts` / `run-doctoc.ts`.
 */

import path from 'path';
import { findFrontmatterEnd } from './markdown-scan';
import { NATIVE_PATH_RULES, PathRules, comparisonKey } from './path-rules';
import { DOCTOC_END_MARKER, DOCTOC_MARKER } from './toc-placement';

/**
 * Separator inserted between two consecutive source documents in a merged
 * Markdown file.
 *
 * A raw HTML block is used instead of relying on headings: PR #12 defaulted
 * `--heading-page-break-before` to `auto`, so headings no longer start a new
 * page on their own. The matching `.document-break` rule lives in
 * `src/css/default.css` and is driven by the `--document-page-break-before` /
 * `--document-break-before` custom properties.
 */
export const DOCUMENT_BREAK_HTML = '<div class="document-break"></div>';

/**
 * Compares two directory paths for equality, case-insensitively on Windows.
 *
 * @param a - First path segment or path.
 * @param b - Second path segment or path.
 * @returns `true` when both refer to the same name.
 */
function pathPartsEqual(a: string, b: string, rules: PathRules): boolean {
  return comparisonKey(a, rules) === comparisonKey(b, rules);
}

/**
 * Computes the longest common directory prefix of two absolute directories.
 *
 * The result must be an *absolute* path, which the plain join is not at two
 * roots: `''` is the POSIX root, and `C:` is a **drive-relative** path on
 * Windows that `path.win32.resolve` turns into the current directory of drive
 * C:. `C:\a\x.md` and `C:\b\y.md` therefore used to merge into the working
 * directory instead of `C:\` (#50). An incomplete UNC prefix (`\\server`
 * without a share) is no directory at all and counts as no common root.
 *
 * @param a - First absolute directory.
 * @param b - Second absolute directory.
 * @param rules - Path rules to apply.
 * @returns The common prefix directory, or `undefined` when the paths share
 *   no root (different Windows drives, for example).
 */
function commonPrefixDirectory(a: string, b: string, rules: PathRules): string | undefined {
  const { sep } = rules.path;
  const aSegments = a.split(sep);
  const bSegments = b.split(sep);
  const shared: string[] = [];

  for (let i = 0; i < Math.min(aSegments.length, bSegments.length); i++) {
    if (!pathPartsEqual(aSegments[i], bSegments[i], rules)) {
      break;
    }
    shared.push(aSegments[i]);
  }

  if (shared.length === 0) {
    return undefined;
  }

  const joined = shared.join(sep);

  if (joined === '') {
    return sep;
  }
  if (/^[A-Za-z]:$/.test(joined)) {
    return joined + sep;
  }
  // `['', '', server]` or less: a UNC path needs both a server and a share.
  if (shared[0] === '' && shared[1] === '' && shared.length < 4) {
    return undefined;
  }

  return joined;
}

/**
 * Determines the directory the merged PDF should default to: the deepest
 * directory that contains every input file.
 *
 * @param files - Absolute paths of the merged source files.
 * @param rules - Path rules to apply; the running platform's by default.
 * @returns The common ancestor directory, falling back to the current
 *   working directory when the inputs share no common root.
 */
export function commonAncestorDirectory(files: string[], rules: PathRules = NATIVE_PATH_RULES): string {
  const directories = files.map((file) => rules.path.dirname(rules.path.resolve(file)));
  let common = directories[0];

  for (const directory of directories.slice(1)) {
    const next = commonPrefixDirectory(common, directory, rules);
    if (!next) {
      return process.cwd();
    }
    common = next;
  }

  return common;
}

/**
 * Removes a leading YAML frontmatter block from a document body.
 *
 * Only the *first* document's frontmatter sits where md-to-pdf parses it; in
 * every later document the same block is ordinary content and renders as a
 * horizontal rule plus an invented heading carrying the raw YAML, which
 * `--force-doctoc` then lists in the table of contents (#49). A `docs/`
 * folder whose files all carry frontmatter is the normal case, so the block
 * is dropped rather than rendered.
 *
 * @param document - Document body, already BOM-stripped.
 * @returns The body without its leading frontmatter block, right-trimmed at
 *   the front, and whether a block was removed.
 */
export function removeFrontmatter(document: string): { body: string; removed: boolean } {
  const lines = document.split(/\r\n|\n/);
  const end = findFrontmatterEnd(lines);

  if (end === -1) {
    return { body: document, removed: false };
  }

  return { body: lines.slice(end + 1).join('\n').replace(/^\s+/, ''), removed: true };
}

/**
 * Joins normalised document bodies into the merged Markdown contents.
 *
 * Blank lines around every section guarantee that a file without a trailing
 * newline cannot glue its last line onto the next document, and that the
 * separator is parsed as its own HTML block. The result always ends in a
 * single newline.
 *
 * A document with no content left — an empty input file, or one holding
 * nothing but frontmatter — contributes no section and therefore no break,
 * which used to produce two consecutive page breaks and a blank page (#49).
 *
 * @param documents - Document bodies, already BOM-stripped and right-trimmed.
 * @returns The merged Markdown contents.
 */
export function joinDocuments(documents: string[]): string {
  const sections: string[] = [];

  documents
    .filter((document) => document.trim() !== '')
    .forEach((document, index) => {
      if (index > 0) {
        sections.push(DOCUMENT_BREAK_HTML);
      }
      sections.push(document);
    });

  return `${sections.join('\n\n')}\n`;
}

/**
 * Puts an empty doctoc marker pair in front of the merged documents, so
 * `--merge` with `--toc` builds one table of contents ahead of all of them
 * instead of relocating it before the first `##` heading of the first
 * document.
 *
 * START and END must be on lines of their own: on one line doctoc does not
 * recognise the pair and prepends a second table of contents. A document
 * break follows the pair, so the first document starts on a page of its own
 * just like every later one.
 *
 * The first document's frontmatter stays at the very top, where md-to-pdf
 * parses it.
 *
 * @param content - Merged Markdown contents, from {@link joinDocuments}.
 * @returns The contents with the marker pair and a document break in front
 *   of the first document.
 */
export function prependTocMarkers(content: string): string {
  const lines = content.split('\n');
  const frontmatterEnd = findFrontmatterEnd(lines.map((line) => line.replace(/\r$/, '')));
  const head = lines.slice(0, frontmatterEnd + 1);
  const rest = lines
    .slice(frontmatterEnd + 1)
    .join('\n')
    .replace(/^\s+/, '');
  const block = [
    `${DOCTOC_MARKER} please keep comment here to allow auto update -->`,
    DOCTOC_END_MARKER,
    '',
    DOCUMENT_BREAK_HTML,
    '',
    rest,
  ];

  return (head.length > 0 ? [...head, '', ...block] : block).join('\n');
}
