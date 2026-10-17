/**
 * Behaviour of the doctoc backend (#83) and the doctoc half of #44: every
 * doctoc marker outside the requested block is hidden from doctoc, the block
 * itself is translated into doctoc's markers and back, and doctoc's output is
 * read back byte-identically outside the block.
 *
 * Most tests run doctoc's real `transform` in-process — the code `npx doctoc`
 * executes, minus the file I/O — so they show what doctoc actually does with
 * the prepared text, without spawning `npx`.
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCTOC_BACKEND,
  DOCTOC_END_LINE,
  DOCTOC_NOTE_LINE,
  DOCTOC_START_LINE,
  prepareDoctocInput,
  readDoctocOutput,
} from '../steps/doctoc-backend';
import { isTocOnlyRefresh, OWN_TOC_MARKER, scanTocMarkers, TocMarkers } from '../steps/toc-markers';
import {
  createFakeTools,
  doctocTransform,
  EXAMPLE_BEFORE_REAL_TOC,
  INLINE_EXAMPLE_DOC,
  inProcessDoctoc,
  makeOptions,
  markdownDoc as doc,
  tempDir,
} from './helpers';

const START = DOCTOC_START_LINE;
const END = DOCTOC_END_LINE;
const OWN_START = OWN_TOC_MARKER.start;
const OWN_END = OWN_TOC_MARKER.end;

/**
 * Narrows a scan result to its block, failing the test when there is none.
 *
 * @param markers - A scan result.
 * @returns The block's line range.
 */
function blockOf(markers: TocMarkers): { startIndex: number; endIndex: number } {
  assert.equal(markers.kind, 'pair');
  return markers.kind === 'pair' ? { startIndex: markers.startIndex, endIndex: markers.endIndex } : { startIndex: -1, endIndex: -1 };
}

/**
 * Runs the whole backend round trip in memory with the real doctoc transform.
 *
 * @param markdown - The document to fill.
 * @param markers - The marker lines to request; absent for doctoc's own.
 * @returns What the backend returns.
 */
function roundTrip(markdown: string, markers?: { start: string; end: string }) {
  const found = scanTocMarkers(markdown);
  const block = found.kind === 'pair' ? { startIndex: found.startIndex, endIndex: found.endIndex } : undefined;
  const prepared = prepareDoctocInput(markdown, block);
  const result = doctocTransform(prepared);
  return readDoctocOutput(result.transformed ? (result.data ?? '') : prepared, markers);
}

test('masking round-trips byte-identically and leaves the block alone', () => {
  const input = doc(
    ['# Title', '', 'See `<!-- START doctoc generated TOC`.', '', START, '- x', END, '', '```', START, END, '```'],
    '\r\n',
  );
  const block = blockOf(scanTocMarkers(input));

  const masked = prepareDoctocInput(input, block);

  assert.notEqual(masked, input);
  assert.equal(masked.split('\n').length, input.split('\n').length);
  assert.deepEqual(scanTocMarkers(masked), scanTocMarkers(input));
  assert.equal(masked.split('\r\n')[4], START);
  assert.equal(masked.split('\r\n')[6], END);
  assert.deepEqual(readDoctocOutput(masked), { markdown: input, block });
});

test('masking refuses a document that already contains a masked marker', () => {
  const masked = `<!--${String.fromCharCode(0xe000)} START doctoc example\n`;

  assert.throws(() => prepareDoctocInput(masked), /already contains a masked doctoc marker/);
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
  const output = roundTrip(INLINE_EXAMPLE_DOC).markdown;

  for (const line of INLINE_EXAMPLE_DOC.split('\n')) {
    assert.equal(output.includes(line), true, `lost line: ${line}`);
  }
  assert.equal(scanTocMarkers(output).kind, 'pair');
});

test('with masking, doctoc refreshes only the real TOC behind a fenced example', () => {
  const output = roundTrip(EXAMPLE_BEFORE_REAL_TOC).markdown;

  assert.equal(output.includes('- stale entry'), false);
  assert.match(output, /\[First\]\(#first\)/);
  assert.equal(isTocOnlyRefresh(EXAMPLE_BEFORE_REAL_TOC, output), true);
});

test('a new block gets the requested markers and loses the doctoc note (#83)', () => {
  const input = doc(['# Title', '', '## First', '', '## Second']);

  const { markdown, block } = roundTrip(input, OWN_TOC_MARKER);
  const lines = markdown.split('\n');

  assert.ok(block, 'doctoc wrote a block');
  assert.equal(lines[block.startIndex], OWN_START);
  assert.equal(lines[block.endIndex], OWN_END);
  assert.equal(markdown.includes('doctoc generated TOC'), false, 'no doctoc marker is left');
  assert.equal(markdown.includes(DOCTOC_NOTE_LINE), false, "doctoc's note is gone");
  assert.match(markdown, /\[Second\]\(#second\)/);
});

test('an own-marker block is filled in place and keeps its marker lines (#83)', () => {
  const input = doc(['# Title', '', '  <!-- toc START -->', '- [stale](#stale)', OWN_END, '', '## First', '', 'Body.']);

  const { markdown, block } = roundTrip(input, { start: '  <!-- toc START -->', end: OWN_END });

  assert.deepEqual(block, { startIndex: 2, endIndex: block?.endIndex });
  assert.equal(markdown.split('\n')[2], '  <!-- toc START -->', 'the author’s indentation is kept');
  assert.equal(markdown.includes('[stale]'), false);
  assert.match(markdown, /\[First\]\(#first\)/);
  assert.equal(isTocOnlyRefresh(input, markdown), true, 'nothing outside the block changed');
});

test('a refreshed own-marker block refreshes again without growing (#83)', () => {
  const input = doc(['# Title', '', OWN_START, OWN_END, '', '## First', '', '## Second']);

  const once = roundTrip(input, OWN_TOC_MARKER).markdown;
  const twice = roundTrip(once, OWN_TOC_MARKER).markdown;

  assert.equal(twice, once, 'a second run is a no-op');
});

test('a CRLF document keeps its line endings on the replaced marker lines', () => {
  const input = doc(['# Title', '', OWN_START, OWN_END, '', '## First'], '\r\n');

  const { markdown, block } = roundTrip(input, OWN_TOC_MARKER);
  const lines = markdown.split('\n');

  assert.ok(block);
  assert.equal(lines[block.startIndex], `${OWN_START}\r`);
  assert.equal(lines[block.endIndex], `${OWN_END}\r`);
});

test('every doctoc marker outside the block survives byte for byte (#83)', () => {
  const later = [START, '- [kept](#kept)', END];
  const input = doc([END, '# Title', '', OWN_START, OWN_END, '', '## First', '', ...later]);

  const { markdown } = roundTrip(input, OWN_TOC_MARKER);

  assert.ok(markdown.startsWith(`${END}\n# Title\n`), 'the stray END line is untouched');
  assert.ok(markdown.includes(later.join('\n')), 'the ignored second block is untouched');
  assert.match(markdown, /\[First\]\(#first\)/);
});

test('a document without headings gets an empty block, or keeps its own unchanged', () => {
  const withoutBlock = doc(['Just prose.']);
  const withBlock = doc(['Just prose.', '', OWN_START, OWN_END]);

  assert.deepEqual(roundTrip(withoutBlock, OWN_TOC_MARKER), {
    markdown: doc([OWN_START, OWN_END, '', 'Just prose.']),
    block: { startIndex: 0, endIndex: 1 },
  });
  assert.equal(roundTrip(withBlock, OWN_TOC_MARKER).markdown, withBlock);
});

test('the backend runs doctoc on the scratch file it is given', (t) => {
  const file = path.join(tempDir(t), 'doc.md');
  const tools = createFakeTools({ doctoc: inProcessDoctoc });
  const markdown = doc(['# Title', '', OWN_START, OWN_END, '', '## First']);

  const result = DOCTOC_BACKEND.generate({
    markdown,
    block: { startIndex: 2, endIndex: 3 },
    markers: OWN_TOC_MARKER,
    file,
    options: makeOptions(),
    run: tools.run,
  });

  assert.deepEqual(
    tools.calls.map((call) => [call.tool, call.args]),
    [['doctoc', [file]]],
  );
  assert.equal(result.markdown.split('\n')[2], OWN_START);
  assert.match(result.markdown, /\[First\]\(#first\)/);
  assert.ok(fs.existsSync(file));
});
