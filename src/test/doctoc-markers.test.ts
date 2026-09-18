/**
 * Behaviour of the doctoc marker rules from #44: documented markers (in
 * fences, inline code or comments) never count as a TOC and are hidden from
 * doctoc, a START marker without an END is reported instead of handed to
 * doctoc, and a refresh is only written back when it changes nothing outside
 * the TOC block.
 *
 * The masking tests run doctoc's real `transform` in-process — the code
 * `npx doctoc` executes, minus the file I/O — so they show what doctoc
 * actually does with the masked text, without spawning `npx`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMissingMarkerBlock,
  isTocOnlyRefresh,
  maskDocumentedMarkers,
  removeDoctocBlocks,
  scanDoctocMarkers,
  unmaskDocumentedMarkers,
} from '../steps/doctoc-markers';
import { DOCTOC_END_MARKER, DOCTOC_MARKER } from '../steps/toc-placement';

/** doctoc's in-process TOC transform; only the fields the tests read are typed. */
type DoctocTransform = (content: string) => { transformed: boolean; data?: string };

const doctocTransform = require('doctoc/lib/transform') as DoctocTransform;

/** A genuine START marker line, as doctoc writes it. */
const START = `${DOCTOC_MARKER} please keep comment here to allow auto update -->`;

/** A genuine END marker line, as doctoc writes it. */
const END = DOCTOC_END_MARKER;

/** The line doctoc writes right after the START marker. */
const DONT_EDIT = `<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->`;

/**
 * Joins fixture lines into a document.
 *
 * @param documentLines - Lines without terminators.
 * @param eol - Line ending to use.
 * @returns The assembled document, with a trailing line ending.
 */
function doc(documentLines: string[], eol = '\n'): string {
  return documentLines.join(eol) + eol;
}

/** The shape of this repository's `AGENTS.md` at the time of #44: an inline-code example, no END marker. */
const INLINE_EXAMPLE_DOC = doc([
  '# Agents',
  '',
  '## Doctoc',
  '',
  '`runDoctoc` runs when the file contains `<!-- START doctoc generated TOC`.',
  '',
  '## Later section',
  '',
  'Everything down here must survive.',
]);

/**
 * A real TOC, in the exact shape doctoc writes it (doctoc reads the line two
 * below START as the title), preceded by a fenced example of the marker block.
 */
const EXAMPLE_BEFORE_REAL_TOC = doc([
  '# Guide',
  '',
  '```markdown',
  START,
  END,
  '```',
  '',
  START,
  DONT_EDIT,
  '**Table of Contents**',
  '',
  '- stale entry',
  '',
  END,
  '',
  '## First',
  '',
  '## Second',
]);

test('a document without markers has no TOC', () => {
  assert.deepEqual(scanDoctocMarkers(doc(['# Title', '', '## Section'])), { kind: 'none' });
});

test('a marker in inline code is documentation, not a TOC', () => {
  assert.deepEqual(scanDoctocMarkers(INLINE_EXAMPLE_DOC), { kind: 'none' });
});

test('markers in fenced, indented or commented-out blocks are documentation, not a TOC', () => {
  assert.deepEqual(scanDoctocMarkers(doc(['```markdown', START, '```'])), { kind: 'none' });
  assert.deepEqual(scanDoctocMarkers(doc(['~~~', START, END, '~~~'])), { kind: 'none' });
  assert.deepEqual(scanDoctocMarkers(doc(['Text:', '', `    ${START}`])), { kind: 'none' });
  assert.deepEqual(scanDoctocMarkers(doc(['<!--', START, '-->'])), { kind: 'none' });
});

test('a genuine marker pair is found, also with CRLF line endings and a BOM', () => {
  const lines = ['# Title', '', START, '- [A](#a)', END, '', '## A'];

  assert.deepEqual(scanDoctocMarkers(doc(lines)), { kind: 'pair', startIndex: 2, endIndex: 4 });
  assert.deepEqual(scanDoctocMarkers(doc(lines, '\r\n')), { kind: 'pair', startIndex: 2, endIndex: 4 });
  assert.deepEqual(scanDoctocMarkers(String.fromCharCode(0xfeff) + doc([START, END])), { kind: 'pair', startIndex: 0, endIndex: 1 });
});

test('a fenced example before the real TOC does not shift the pair', () => {
  assert.deepEqual(scanDoctocMarkers(EXAMPLE_BEFORE_REAL_TOC), { kind: 'pair', startIndex: 7, endIndex: 13 });
});

test('a genuine START marker without an END marker is broken', () => {
  const result = scanDoctocMarkers(doc(['# Title', '', START, '', '## Section']));

  assert.equal(result.kind, 'broken');
  assert.match(result.kind === 'broken' ? result.message : '', /line 3 has no END marker/);
});

test('an END marker that only exists in an example does not complete the pair', () => {
  const result = scanDoctocMarkers(doc([START, '', '```', END, '```']));

  assert.equal(result.kind, 'broken');
});

test('an END marker before the START marker is broken', () => {
  const result = scanDoctocMarkers(doc([END, '', START, '', END]));

  assert.equal(result.kind, 'broken');
  assert.match(result.kind === 'broken' ? result.message : '', /line 1 comes before the START marker on line 3/);
});

test('a lone END marker is not a TOC', () => {
  assert.deepEqual(scanDoctocMarkers(doc(['# Title', END])), { kind: 'none' });
});

test('masking round-trips byte-identically and leaves genuine markers alone', () => {
  const input = doc(
    ['# Title', '', 'See `<!-- START doctoc generated TOC`.', '', START, '- x', END, '', '```', START, END, '```'],
    '\r\n',
  );

  const masked = maskDocumentedMarkers(input);

  assert.notEqual(masked, input);
  assert.equal(masked.split('\n').length, input.split('\n').length);
  assert.deepEqual(scanDoctocMarkers(masked), scanDoctocMarkers(input));
  assert.equal(masked.split('\r\n')[4], START);
  assert.equal(masked.split('\r\n')[6], END);
  assert.equal(unmaskDocumentedMarkers(masked), input);
});

test('masking refuses a document that already contains a masked marker', () => {
  const masked = `<!--${String.fromCharCode(0xe000)} START doctoc example\n`;

  assert.throws(() => maskDocumentedMarkers(masked), /already contains a masked doctoc marker/);
});

test('doctoc 2.5 leaves an inline-code marker example alone', () => {
  // doctoc up to 2.3.0 matched its markers on every line and replaced
  // everything from this example to the end of the file (#44). 2.5 only looks
  // at HTML nodes of the parsed document. The masking stays for a DOCTOC_PKG
  // override that selects an older version.
  const result = doctocTransform(INLINE_EXAMPLE_DOC);

  assert.equal(result.data?.includes('Everything down here must survive.'), true);
});

test('with masking, doctoc creates a TOC and keeps the rest of the document', () => {
  const result = doctocTransform(maskDocumentedMarkers(INLINE_EXAMPLE_DOC));
  const output = unmaskDocumentedMarkers(result.data ?? '');

  assert.equal(result.transformed, true);
  for (const line of INLINE_EXAMPLE_DOC.split('\n')) {
    assert.equal(output.includes(line), true, `lost line: ${line}`);
  }
  assert.equal(scanDoctocMarkers(output).kind, 'pair');
});

test('with masking, doctoc refreshes only the real TOC behind a fenced example', () => {
  const result = doctocTransform(maskDocumentedMarkers(EXAMPLE_BEFORE_REAL_TOC));
  const output = unmaskDocumentedMarkers(result.data ?? '');

  assert.equal(result.transformed, true);
  assert.equal(output.includes('- stale entry'), false);
  assert.match(output, /\[First\]\(#first\)/);
  assert.equal(isTocOnlyRefresh(EXAMPLE_BEFORE_REAL_TOC, output), true);
});

test('isTocOnlyRefresh accepts a changed TOC block and rejects any other change', () => {
  const before = doc(['# Title', '', START, '- old', END, '', '## A', '', 'Body.']);
  const refreshed = doc(['# Title', '', START, '- new', '- entries', END, '', '## A', '', 'Body.']);

  assert.equal(isTocOnlyRefresh(before, refreshed), true);
  assert.equal(isTocOnlyRefresh(before, refreshed.replace('Body.', 'Edited.')), false);
  assert.equal(isTocOnlyRefresh(before, refreshed.replace('# Title', '# Retitled')), false);
  assert.equal(isTocOnlyRefresh(before, doc(['# Title', '', START, '- new', END])), false);
  assert.equal(isTocOnlyRefresh(before, doc(['# Title', '', START, '- new'])), false);
  assert.equal(isTocOnlyRefresh(doc(['# Title']), refreshed), false);
});

test('removeDoctocBlocks removes every genuine block and keeps documented markers', () => {
  const input = doc([
    '# Title',
    START,
    DONT_EDIT,
    '- [Old](#old)',
    END,
    '## A',
    '```',
    START,
    END,
    '```',
    START,
    '- second',
    END,
    'Tail.',
  ]);

  const result = removeDoctocBlocks(input);

  assert.equal(result.removed, 2);
  assert.equal(result.body, doc(['# Title', '## A', '```', START, END, '```', 'Tail.']));
});

test('removeDoctocBlocks drops a lone END marker and rejects a START without END', () => {
  assert.deepEqual(removeDoctocBlocks(doc(['# Title', END, 'Body.'])), { body: doc(['# Title', 'Body.']), removed: 0 });
  assert.deepEqual(removeDoctocBlocks(doc(['# Title'])), { body: doc(['# Title']), removed: 0 });
  assert.throws(() => removeDoctocBlocks(doc(['# Title', '', START, '- x'])), /START marker on line 3 has no END marker/);
});

test('removeDoctocBlocks keeps CRLF line endings', () => {
  const result = removeDoctocBlocks(doc(['# Title', START, '- x', END, 'Body.'], '\r\n'));

  assert.equal(result.body, doc(['# Title', 'Body.'], '\r\n'));
});

test('describeMissingMarkerBlock names the file and offers -f only when it is not given (#60)', () => {
  const withoutForce = describeMissingMarkerBlock('docs/plain.md', false);
  const withForce = describeMissingMarkerBlock('docs/plain.md', true);

  assert.match(withoutForce, /^docs\/plain\.md has no doctoc marker block; the source file was not updated\./);
  assert.match(withoutForce, /or use -f for a TOC in the PDF only\.$/);
  assert.match(withForce, /^docs\/plain\.md has no doctoc marker block/);
  assert.match(withForce, /-f alone only adds one to the PDF\.$/);
});
