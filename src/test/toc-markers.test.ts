/**
 * Behaviour of the marker registry (#83) and the marker rules from #44:
 * documented markers (in fences, inline code or comments) never count as a
 * TOC, a START marker without an END is reported instead of handed to the
 * backend, only the first block of a document counts, and a refresh is only
 * written back when it changes nothing outside the TOC block.
 *
 * The doctoc-specific half of #44 — masking and what doctoc itself does with
 * the masked text — is in `doctoc-backend.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCTOC_END_LINE, DOCTOC_NOTE_LINE as DONT_EDIT, DOCTOC_START_LINE } from '../steps/doctoc-backend';
import {
  describeMissingMarkerBlock,
  DOCTOC_MARKER_ENTRY,
  isTocOnlyRefresh,
  markerLines,
  OWN_MARKER_ENTRY,
  OWN_TOC_MARKER,
  removeTocBlocks,
  scanTocMarkers,
  TOC_MARKERS,
  TocMarkerEntry,
} from '../steps/toc-markers';
import { EXAMPLE_BEFORE_REAL_TOC, INLINE_EXAMPLE_DOC, markdownDoc as doc } from './helpers';

/** A genuine START marker line, as doctoc writes it. */
const START = DOCTOC_START_LINE;

/** A genuine END marker line, as doctoc writes it. */
const END = DOCTOC_END_LINE;

test('a document without markers has no TOC', () => {
  assert.deepEqual(scanTocMarkers(doc(['# Title', '', '## Section'])), { kind: 'none' });
});

test('a marker in inline code is documentation, not a TOC', () => {
  assert.deepEqual(scanTocMarkers(INLINE_EXAMPLE_DOC), { kind: 'none' });
});

test('markers in fenced, indented or commented-out blocks are documentation, not a TOC', () => {
  assert.deepEqual(scanTocMarkers(doc(['```markdown', START, '```'])), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['~~~', START, END, '~~~'])), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['Text:', '', `    ${START}`])), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['<!--', START, '-->'])), { kind: 'none' });
});

test('a genuine marker pair is found, also with CRLF line endings and a BOM', () => {
  const lines = ['# Title', '', START, '- [A](#a)', END, '', '## A'];

  assert.deepEqual(scanTocMarkers(doc(lines)), { kind: 'pair', startIndex: 2, endIndex: 4, entry: DOCTOC_MARKER_ENTRY });
  assert.deepEqual(scanTocMarkers(doc(lines, '\r\n')), { kind: 'pair', startIndex: 2, endIndex: 4, entry: DOCTOC_MARKER_ENTRY });
  assert.deepEqual(scanTocMarkers(String.fromCharCode(0xfeff) + doc([START, END])), { kind: 'pair', startIndex: 0, endIndex: 1, entry: DOCTOC_MARKER_ENTRY });
});

test('a fenced example before the real TOC does not shift the pair', () => {
  assert.deepEqual(scanTocMarkers(EXAMPLE_BEFORE_REAL_TOC), { kind: 'pair', startIndex: 7, endIndex: 13, entry: DOCTOC_MARKER_ENTRY });
});

test('a genuine START marker without an END marker is broken', () => {
  const result = scanTocMarkers(doc(['# Title', '', START, '', '## Section']));

  assert.equal(result.kind, 'broken');
  assert.match(result.kind === 'broken' ? result.message : '', /line 3 has no END marker/);
});

test('an END marker that only exists in an example does not complete the pair', () => {
  const result = scanTocMarkers(doc([START, '', '```', END, '```']));

  assert.equal(result.kind, 'broken');
});

test('an END marker before the START marker is broken', () => {
  const result = scanTocMarkers(doc([END, '', START, '', END]));

  assert.equal(result.kind, 'broken');
  assert.match(result.kind === 'broken' ? result.message : '', /line 1 comes before the START marker on line 3/);
});

test('a lone END marker is not a TOC', () => {
  assert.deepEqual(scanTocMarkers(doc(['# Title', END])), { kind: 'none' });
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

test('removeTocBlocks removes every genuine block and keeps documented markers', () => {
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

  const result = removeTocBlocks(input);

  assert.equal(result.removed, 2);
  assert.equal(result.body, doc(['# Title', '## A', '```', START, END, '```', 'Tail.']));
});

test('removeTocBlocks drops a lone END marker and rejects a START without END', () => {
  assert.deepEqual(removeTocBlocks(doc(['# Title', END, 'Body.'])), { body: doc(['# Title', 'Body.']), removed: 0 });
  assert.deepEqual(removeTocBlocks(doc(['# Title'])), { body: doc(['# Title']), removed: 0 });
  assert.throws(() => removeTocBlocks(doc(['# Title', '', START, '- x'])), /START marker on line 3 has no END marker/);
});

test('removeTocBlocks keeps CRLF line endings', () => {
  const result = removeTocBlocks(doc(['# Title', START, '- x', END, 'Body.'], '\r\n'));

  assert.equal(result.body, doc(['# Title', 'Body.'], '\r\n'));
});

test('describeMissingMarkerBlock names the file and offers --toc only when it is not given (#60, #104)', () => {
  const withoutToc = describeMissingMarkerBlock('docs/plain.md', false);
  const withToc = describeMissingMarkerBlock('docs/plain.md', true);

  assert.match(withoutToc, /^docs\/plain\.md has no table of contents marker block; the source file was not updated\./);
  assert.match(withoutToc, /or use --toc for a TOC in the PDF only\.$/);
  assert.match(withToc, /^docs\/plain\.md has no table of contents marker block/);
  assert.match(withToc, /--toc alone only adds one to the PDF\.$/);
  assert.doesNotMatch(`${withoutToc}\n${withToc}`, /-f\b/, 'the retired -f flag is not recommended');
});

/** markdown-toc's markers, registered only by the tests that show an entry needs no code (#83). */
const MARKDOWN_TOC_ENTRY: TocMarkerEntry = {
  name: 'markdown-toc',
  tool: 'markdown-toc',
  start: /^<!-- toc -->\s*$/,
  end: /^<!-- tocstop -->\s*$/,
};

const OWN_START = OWN_TOC_MARKER.start;
const OWN_END = OWN_TOC_MARKER.end;

test('the registry starts with the own marker and doctoc (#83)', () => {
  assert.deepEqual(TOC_MARKERS, [OWN_MARKER_ENTRY, DOCTOC_MARKER_ENTRY]);
});

test('the own marker is a genuine block, also indented, with CRLF and a BOM (#83)', () => {
  const lines = ['# Title', '', OWN_START, '- [A](#a)', OWN_END, '', '## A'];
  const pair = { kind: 'pair', startIndex: 2, endIndex: 4, entry: OWN_MARKER_ENTRY };

  assert.deepEqual(scanTocMarkers(doc(lines)), pair);
  assert.deepEqual(scanTocMarkers(doc(lines, '\r\n')), pair);
  assert.deepEqual(scanTocMarkers(doc(['# Title', '', `   ${OWN_START}  `, OWN_END])), { ...pair, endIndex: 3 });
  assert.deepEqual(scanTocMarkers(String.fromCharCode(0xfeff) + doc([OWN_START, OWN_END])), {
    ...pair,
    startIndex: 0,
    endIndex: 1,
  });
});

test('documented own markers are documentation, not a TOC (#83)', () => {
  assert.deepEqual(scanTocMarkers(doc(['```markdown', OWN_START, OWN_END, '```'])), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['Put `<!-- toc START -->` where the TOC goes.'])), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['Text:', '', `    ${OWN_START}`, `    ${OWN_END}`])), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['<!--', OWN_START, OWN_END, '-->'])), { kind: 'none' });
});

test('an own START marker without its END is broken, whatever other END follows (#83)', () => {
  const result = scanTocMarkers(doc(['# Title', '', OWN_START, END, '', '## Section']));

  assert.equal(result.kind, 'broken');
  assert.match(result.kind === 'broken' ? result.message : '', /^md2pdf START marker on line 3 has no END marker/);
});

test('only the first block counts, whichever entry comes first (#83)', () => {
  const ownFirst = doc(['# T', OWN_START, OWN_END, START, END, '## A']);
  const doctocFirst = doc(['# T', START, END, OWN_START, OWN_END, '## A']);
  const brokenLater = doc(['# T', OWN_START, OWN_END, START, '## A']);

  assert.deepEqual(scanTocMarkers(ownFirst), { kind: 'pair', startIndex: 1, endIndex: 2, entry: OWN_MARKER_ENTRY });
  assert.deepEqual(scanTocMarkers(doctocFirst), { kind: 'pair', startIndex: 1, endIndex: 2, entry: DOCTOC_MARKER_ENTRY });
  assert.equal(scanTocMarkers(brokenLater).kind, 'pair', 'a later, ignored block cannot break the first');
});

test('the own marker and markdown-toc never mistake each other (#83)', () => {
  const registry = [OWN_MARKER_ENTRY, MARKDOWN_TOC_ENTRY];

  assert.deepEqual(scanTocMarkers(doc(['<!-- toc -->', '<!-- tocstop -->']), [OWN_MARKER_ENTRY]), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc([OWN_START, OWN_END]), [MARKDOWN_TOC_ENTRY]), { kind: 'none' });
  assert.deepEqual(scanTocMarkers(doc(['<!-- toc -->', '<!-- tocstop -->']), registry), {
    kind: 'pair',
    startIndex: 0,
    endIndex: 1,
    entry: MARKDOWN_TOC_ENTRY,
  });
  assert.deepEqual(scanTocMarkers(doc([OWN_START, '<!-- tocstop -->', OWN_END]), registry), {
    kind: 'pair',
    startIndex: 0,
    endIndex: 2,
    entry: OWN_MARKER_ENTRY,
  });
  assert.equal(scanTocMarkers(doc(['<!-- toc START', OWN_END])).kind, 'none', 'only the exact line is a marker');
});

test('a new registry entry is recognised everywhere without further code (#83)', () => {
  const registry = [...TOC_MARKERS, MARKDOWN_TOC_ENTRY];
  const input = doc(['# Title', '<!-- toc -->', '- [Old](#old)', '<!-- tocstop -->', '## A']);

  assert.deepEqual(scanTocMarkers(input), { kind: 'none' }, 'unknown to the default registry');
  assert.deepEqual(scanTocMarkers(input, registry), { kind: 'pair', startIndex: 1, endIndex: 3, entry: MARKDOWN_TOC_ENTRY });
  assert.deepEqual(removeTocBlocks(input, registry), { body: doc(['# Title', '## A']), removed: 1 });
  assert.equal(
    isTocOnlyRefresh(input, input.replace('- [Old](#old)', '- [New](#new)'), registry),
    true,
    'the -u guard works on the new entry too',
  );
});

test('removeTocBlocks removes the blocks of every entry and closes each on its own END (#83)', () => {
  const input = doc(['# Title', OWN_START, '- own', END, OWN_END, START, '- doctoc', END, 'Tail.', OWN_END]);

  assert.deepEqual(removeTocBlocks(input), { body: doc(['# Title', 'Tail.']), removed: 2 });
  assert.throws(() => removeTocBlocks(doc(['# T', OWN_START, END])), /^Error: md2pdf START marker on line 2 has no END marker$/);
});

test('markerLines returns the marker lines as the author wrote them', () => {
  const input = `${String.fromCharCode(0xfeff)}  ${OWN_START}\r\n- x\r\n${OWN_END}\r\n`;

  assert.deepEqual(markerLines(input, 0, 2), { start: `  ${OWN_START}`, end: OWN_END });
});
