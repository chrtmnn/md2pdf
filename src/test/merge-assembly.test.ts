/**
 * Behaviour of the pure parts of `--merge` (#6): the common ancestor
 * directory the merged PDF defaults to, and how document bodies are glued
 * together. BOM stripping moved to `markdown-scan.test.ts` with the function
 * itself (#48).
 */

import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_BREAK_HTML,
  commonAncestorDirectory,
  joinDocuments,
  prependTocMarkers,
  removeFrontmatter,
} from '../steps/merge-assembly';
import { POSIX_PATH_RULES, WINDOWS_PATH_RULES } from '../steps/path-rules';
import { DOCTOC_END_MARKER, DOCTOC_MARKER } from '../steps/toc-placement';

/** doctoc's in-process TOC transform; only the field the tests read is typed. */
const doctocTransform = require('doctoc/lib/transform') as (content: string) => { data?: string };

/** A genuine START marker line, as doctoc writes it. */
const START = `${DOCTOC_MARKER} please keep comment here to allow auto update -->`;

/**
 * Builds an absolute path from segments in a platform-correct way, so the same
 * expectations hold on Windows and POSIX.
 *
 * @param segments - Path segments below the current working directory's root.
 * @returns The absolute path.
 */
function absolute(...segments: string[]): string {
  return path.join(path.parse(process.cwd()).root, ...segments);
}

test('commonAncestorDirectory returns the shared directory of the inputs', () => {
  const files = [absolute('docs', 'a.md'), absolute('docs', 'b.md')];

  assert.equal(commonAncestorDirectory(files), absolute('docs'));
});

test('commonAncestorDirectory climbs to the deepest shared parent', () => {
  const files = [
    absolute('docs', 'guide', 'a.md'),
    absolute('docs', 'reference', 'b.md'),
    absolute('docs', 'reference', 'deep', 'c.md'),
  ];

  assert.equal(commonAncestorDirectory(files), absolute('docs'));
});

test('commonAncestorDirectory is that file own directory for a single input', () => {
  assert.equal(commonAncestorDirectory([absolute('docs', 'only.md')]), absolute('docs'));
});

test('commonAncestorDirectory compares segments case-insensitively under Windows rules (#50)', () => {
  assert.equal(
    commonAncestorDirectory(['C:\\Docs\\a.md', 'C:\\docs\\b.md'], WINDOWS_PATH_RULES).toLowerCase(),
    'c:\\docs',
  );
});

test('commonAncestorDirectory compares segments case-sensitively under POSIX rules (#50)', () => {
  assert.equal(commonAncestorDirectory(['/Docs/a.md', '/docs/b.md'], POSIX_PATH_RULES), '/');
});

test('commonAncestorDirectory falls back to the working directory across drives (#50)', () => {
  assert.equal(commonAncestorDirectory(['C:\\docs\\a.md', 'D:\\docs\\b.md'], WINDOWS_PATH_RULES), process.cwd());
});

test('commonAncestorDirectory returns an absolute path at the drive root (#50)', () => {
  // `C:` alone is drive-*relative*: path.win32.resolve('C:') is the current
  // directory of drive C:, so the merged PDF landed in the working directory.
  assert.equal(commonAncestorDirectory(['C:\\a\\x.md', 'C:\\b\\y.md'], WINDOWS_PATH_RULES), 'C:\\');
  assert.equal(commonAncestorDirectory(['C:\\x.md', 'C:\\a\\y.md'], WINDOWS_PATH_RULES), 'C:\\');
  assert.equal(commonAncestorDirectory(['C:\\x.md', 'C:\\y.md'], WINDOWS_PATH_RULES), 'C:\\');
});

test('commonAncestorDirectory keeps a UNC share and rejects a bare server (#50)', () => {
  assert.equal(
    commonAncestorDirectory(['\\\\srv\\share\\a\\x.md', '\\\\srv\\share\\b\\y.md'], WINDOWS_PATH_RULES),
    '\\\\srv\\share',
  );
  assert.equal(
    commonAncestorDirectory(['\\\\srv\\one\\x.md', '\\\\srv\\two\\y.md'], WINDOWS_PATH_RULES),
    process.cwd(),
    'a server without a share is no directory',
  );
});

test('commonAncestorDirectory returns the POSIX root when only it is shared (#50)', () => {
  assert.equal(commonAncestorDirectory(['/a/x.md', '/b/y.md'], POSIX_PATH_RULES), '/');
});

test('joinDocuments separates documents with a blank-line-wrapped break block', () => {
  const merged = joinDocuments(['# One\n\nBody one.', '# Two\n\nBody two.']);

  assert.equal(merged, `# One\n\nBody one.\n\n${DOCUMENT_BREAK_HTML}\n\n# Two\n\nBody two.\n`);
});

test('joinDocuments adds no separator for a single document', () => {
  assert.equal(joinDocuments(['# Only']), '# Only\n');
  assert.equal(joinDocuments(['# Only']).includes(DOCUMENT_BREAK_HTML), false);
});

test('joinDocuments always terminates the merged file with exactly one newline', () => {
  assert.equal(joinDocuments(['a', 'b']).endsWith('b\n'), true);
  assert.equal(joinDocuments(['a', 'b']).endsWith('\n\n'), false);
});

test('removeFrontmatter drops a leading block and reports it (#49)', () => {
  assert.deepEqual(removeFrontmatter('---\ntitle: B\n---\n\n# B\n'), { body: '# B\n', removed: true });
  assert.deepEqual(removeFrontmatter('# B\n'), { body: '# B\n', removed: false });
  assert.deepEqual(removeFrontmatter('text\n\n---\ntitle: not frontmatter\n---\n'), {
    body: 'text\n\n---\ntitle: not frontmatter\n---\n',
    removed: false,
  });
});

test('joinDocuments skips an empty document instead of emitting two breaks (#49)', () => {
  const merged = joinDocuments(['# A', '', '# C']);

  assert.equal(merged, `# A\n\n${DOCUMENT_BREAK_HTML}\n\n# C\n`);
  assert.equal(merged.split(DOCUMENT_BREAK_HTML).length - 1, 1);
});

test('prependTocMarkers puts a marker pair and a break in front of the first document', () => {
  const merged = joinDocuments(['# A', '# B']);

  assert.equal(prependTocMarkers(merged), `${START}\n${DOCTOC_END_MARKER}\n\n${DOCUMENT_BREAK_HTML}\n\n${merged}`);
});

test('prependTocMarkers keeps the first document frontmatter at the very top', () => {
  const merged = joinDocuments(['---\ntitle: A\n---\n\n# A', '# B']);

  assert.equal(
    prependTocMarkers(merged),
    `---\ntitle: A\n---\n\n${START}\n${DOCTOC_END_MARKER}\n\n${DOCUMENT_BREAK_HTML}\n\n# A\n\n${DOCUMENT_BREAK_HTML}\n\n# B\n`,
  );
});

test('doctoc fills the prepended pair with one TOC spanning every document', () => {
  const merged = prependTocMarkers(joinDocuments(['# A\n\n## A1', '# B\n\n## B1']));
  const output = doctocTransform(merged).data ?? '';

  assert.equal(output.split(START).length - 1, 1);
  assert.equal(output.startsWith(START), true);
  assert.match(output, /- \[A\]\(#a\)\n {2}- \[A1\]\(#a1\)\n- \[B\]\(#b\)\n {2}- \[B1\]\(#b1\)/);
  assert.equal(output.indexOf(DOCTOC_END_MARKER) < output.indexOf('# A\n'), true);
});
