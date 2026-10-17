/**
 * Behaviour of the TOC relocation rules from #10: the block moves directly
 * before the first second-order heading, with exactly one blank line on each
 * side, without disturbing line endings, trailing-newline state, frontmatter,
 * or documents that are already correct.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCTOC_END_LINE, DOCTOC_START_LINE } from '../steps/doctoc-backend';
import { relocateTocBeforeFirstH2 } from '../steps/toc-placement';

/** A minimal but realistic doctoc block, as three lines. */
const TOC_BLOCK = [
  DOCTOC_START_LINE,
  '- [Second](#second)',
  DOCTOC_END_LINE,
];

/**
 * Joins fixture lines into a document with the requested line ending.
 *
 * @param documentLines - Lines without terminators.
 * @param eol - Line ending to use.
 * @param trailingNewline - Whether the document ends with a terminator.
 * @returns The assembled document.
 */
function doc(documentLines: string[], eol = '\n', trailingNewline = true): string {
  return documentLines.join(eol) + (trailingNewline ? eol : '');
}

test('moves a freshly created TOC directly before the first h2', () => {
  const input = doc(['# Title', '', ...TOC_BLOCK, '', 'Intro paragraph.', '', '## Second', '', 'Body.']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(
    output,
    doc(['# Title', '', 'Intro paragraph.', '', ...TOC_BLOCK, '', '## Second', '', 'Body.']),
  );
});

test('leaves an already correctly placed TOC byte-identical', () => {
  const input = doc(['# Title', '', 'Intro paragraph.', '', ...TOC_BLOCK, '', '## Second', '', 'Body.']);

  assert.equal(relocateTocBeforeFirstH2(input), input);
});

test('leaves the document untouched when it has no h2-equivalent heading', () => {
  const input = doc(['# Title', '', ...TOC_BLOCK, '', 'Only body text, no second-order heading.']);

  assert.equal(relocateTocBeforeFirstH2(input), input);
});

test('leaves the document untouched when there is no TOC block', () => {
  const input = doc(['# Title', '', 'Intro.', '', '## Second']);

  assert.equal(relocateTocBeforeFirstH2(input), input);
});

test('leaves the document untouched when the closing marker is missing', () => {
  const input = doc(['# Title', '', TOC_BLOCK[0], '- [Second](#second)', '', '## Second']);

  assert.equal(relocateTocBeforeFirstH2(input), input);
});

test('preserves CRLF line endings', () => {
  const input = doc(['# Title', '', ...TOC_BLOCK, '', 'Intro.', '', '## Second'], '\r\n');

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc(['# Title', '', 'Intro.', '', ...TOC_BLOCK, '', '## Second'], '\r\n'));
  assert.equal(output.includes('\n\n'), false, 'no bare LF should survive in a CRLF document');
});

test('preserves a missing trailing newline', () => {
  const input = doc(['# Title', '', ...TOC_BLOCK, '', 'Intro.', '', '## Second'], '\n', false);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output.endsWith('## Second'), true);
  assert.equal(output.endsWith('\n'), false);
});

test('collapses the seam left behind instead of doubling blank lines', () => {
  const input = doc(['# Title', '', ...TOC_BLOCK, '', 'Intro.', '', '## Second']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(/\n\n\n/.test(output), false, 'no doubled blank line anywhere');
});

test('normalises missing blank lines around the relocated block', () => {
  const input = doc(['# Title', ...TOC_BLOCK, 'Intro.', '## Second']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc(['# Title', 'Intro.', '', ...TOC_BLOCK, '', '## Second']));
});

test('collapses multiple blank lines around the block into one', () => {
  const input = doc(['# Title', '', '', ...TOC_BLOCK, '', '', 'Intro.', '', '## Second']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc(['# Title', '', 'Intro.', '', ...TOC_BLOCK, '', '## Second']));
});

test('omits the leading blank line when the block lands at the top of the file', () => {
  // The h2 is the very first content line, so the relocated block has nothing
  // to be separated from and must not start the file with a blank line.
  const input = doc(['', ...TOC_BLOCK, '', '## Second', '', 'Body.']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc([...TOC_BLOCK, '', '## Second', '', 'Body.']));
  assert.equal(output.startsWith(DOCTOC_START_LINE), true);
});

test('targets a setext second-order heading', () => {
  const input = doc(['# Title', '', ...TOC_BLOCK, '', 'Intro.', '', 'Second', '---', '', 'Body.']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc(['# Title', '', 'Intro.', '', ...TOC_BLOCK, '', 'Second', '---', '', 'Body.']));
});

test('ignores h2 headings inside fenced code blocks', () => {
  const input = doc([
    '# Title',
    '',
    ...TOC_BLOCK,
    '',
    '```bash',
    '## not a heading',
    '```',
    '',
    '## real heading',
  ]);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(
    output,
    doc(['# Title', '', '```bash', '## not a heading', '```', '', ...TOC_BLOCK, '', '## real heading']),
  );
});

test('never inserts the block into or before a YAML frontmatter block', () => {
  const input = doc(['---', 'title: Doc', '---', '', ...TOC_BLOCK, '', 'Intro.', '', '## Second']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc(['---', 'title: Doc', '---', '', 'Intro.', '', ...TOC_BLOCK, '', '## Second']));
  assert.equal(output.startsWith('---\ntitle: Doc\n---'), true, 'frontmatter stays first and intact');
});

test('does not mistake a frontmatter delimiter for a setext underline', () => {
  // `title: Doc` followed by `---` would look exactly like a setext h2 to a
  // scanner that did not skip the frontmatter block first.
  const input = doc(['---', 'title: Doc', '---', '', ...TOC_BLOCK, '', 'Intro.']);

  // No real h2 exists past the frontmatter, so doctoc's own placement stands.
  assert.equal(relocateTocBeforeFirstH2(input), input);
});

test('handles a TOC block that doctoc placed inside the frontmatter region', () => {
  const input = doc(['---', 'title: Doc', ...TOC_BLOCK, '---', '', 'Intro.', '', '## Second']);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(output, doc(['---', 'title: Doc', '---', '', 'Intro.', '', ...TOC_BLOCK, '', '## Second']));
});

test('a leading BOM neither hides the frontmatter nor is lost (#48)', () => {
  const body = doc(['---', 'title: Doc', '---', '', ...TOC_BLOCK, '', 'Intro.', '', '## Second']);
  const expected = doc(['---', 'title: Doc', '---', '', 'Intro.', '', ...TOC_BLOCK, '', '## Second']);

  const output = relocateTocBeforeFirstH2(`﻿${body}`);

  assert.equal(output, `﻿${expected}`);
});

test('a leading BOM does not hide a setext h2 from the placement scan (#48)', () => {
  const body = doc(['Title', '=====', '', ...TOC_BLOCK, '', 'Intro.', '', 'Second', '------']);
  const expected = doc(['Title', '=====', '', 'Intro.', '', ...TOC_BLOCK, '', 'Second', '------']);

  assert.equal(relocateTocBeforeFirstH2(`﻿${body}`), `﻿${expected}`);
});

test('a documented marker pair inside a fence is not mistaken for the TOC (#47)', () => {
  const input = doc([
    '# Title',
    '',
    '```markdown',
    ...TOC_BLOCK,
    '```',
    '',
    ...TOC_BLOCK,
    '',
    'Intro.',
    '',
    '## Second',
  ]);

  const output = relocateTocBeforeFirstH2(input);

  assert.equal(
    output,
    doc(['# Title', '', '```markdown', ...TOC_BLOCK, '```', '', 'Intro.', '', ...TOC_BLOCK, '', '## Second']),
  );
});
