/**
 * Behaviour of the table-of-contents step itself (#71, #83).
 *
 * doctoc is replaced by the fake runner from `helpers.ts`, which rewrites the
 * file the way the real tool does: an existing marker block is refreshed in
 * place, a file without one gets a fresh block at the very top. A few tests use
 * doctoc's real transform in-process instead. What is under test is everything
 * `run-toc.ts` does around the backend — the marker registry, the broken-pair
 * guard, the masking round trip, the relocation of a *new* block only, and the
 * `-u` write-back with its TOC-only check (#44).
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runToc, shouldRunToc } from '../steps/run-toc';
import { DOCTOC_BACKEND } from '../steps/doctoc-backend';
import { TocBackend } from '../steps/toc-backend';
import { OWN_TOC_MARKER, TOC_MARKERS, TocMarkerEntry } from '../steps/toc-markers';
import { ConversionContext } from '../types';
import {
  createFakeTools,
  FAKE_TOC_LINES,
  FakeToolBehaviour,
  inProcessDoctoc,
  makeContext,
  makeOptions,
  tempDir,
  writeFile,
} from './helpers';

/** The Private Use Area character `doctoc-backend.ts` masks a marker with. */
const MASK = String.fromCharCode(0xe000);

const START_MARKER = '<!-- START doctoc generated TOC please keep comment here to allow auto update -->';
const END_MARKER = '<!-- END doctoc generated TOC please keep comment here to allow auto update -->';

const OWN_START = OWN_TOC_MARKER.start;
const OWN_END = OWN_TOC_MARKER.end;

/**
 * Writes a source file and builds a context with a work directory of its own,
 * so the step's temp copy never lands next to the source.
 *
 * @param t - Active test context.
 * @param lines - Source document, line by line.
 * @param options - Converter options for the run.
 * @returns The context and the source file's path.
 */
function fixture(
  t: TestContext,
  lines: string[],
  options = makeOptions(),
): { context: ConversionContext; sourceFile: string } {
  const dir = tempDir(t);
  const sourceFile = writeFile(dir, 'doc.md', `${lines.join('\n')}\n`);
  const workdir = path.join(dir, 'work');
  fs.mkdirSync(workdir);

  return { context: makeContext({ sourceFile, workdir, options }), sourceFile };
}

/**
 * Runs the step with the fake doctoc.
 *
 * @param context - Context to run over.
 * @param behaviour - Replacement for the fake doctoc's default rewrite.
 * @returns The fake runner, for the call assertions.
 */
function run(context: ConversionContext, behaviour: FakeToolBehaviour = {}) {
  const tools = createFakeTools(behaviour);
  runToc(context, tools.run);
  return tools;
}

test('shouldRunToc follows the markers and the TOC mode', (t) => {
  const dir = tempDir(t);
  const marked = writeFile(dir, 'marked.md', `# Doc\n\n${START_MARKER}\n${END_MARKER}\n`);
  const plain = writeFile(dir, 'plain.md', '# Doc\n');
  const documented = writeFile(dir, 'documented.md', ['# Doc', '', '```md', START_MARKER, '```', ''].join('\n'));

  assert.equal(shouldRunToc(makeOptions(), marked), true);
  assert.equal(shouldRunToc(makeOptions(), plain), false);
  assert.equal(shouldRunToc(makeOptions(), documented), false, 'a documented marker is not a marker');
  assert.equal(shouldRunToc(makeOptions({ toc: 'always' }), plain), true);
  assert.equal(shouldRunToc(makeOptions({ toc: 'never' }), marked), false);
});

test('a genuine START marker without an END marker fails before doctoc runs (#44)', (t) => {
  const { context, sourceFile } = fixture(t, ['# Doc', '', START_MARKER, '', '## Section']);
  const before = fs.readFileSync(sourceFile, 'utf8');
  const tools = createFakeTools();

  assert.throws(() => runToc(context, tools.run), /was left unchanged/);
  assert.equal(tools.calls.length, 0, 'doctoc never saw the file');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before, 'the source file is untouched');
});

test('the temp copy is named after the temp stem, not the unshortened file name (#100)', (t) => {
  const dir = tempDir(t);
  const longName = `${'very long file name '.repeat(6)}.md`;
  const sourceFile = writeFile(dir, longName, `# Doc

${START_MARKER}
${END_MARKER}
`);
  const workdir = path.join(dir, 'work');
  fs.mkdirSync(workdir);
  const context = makeContext({ sourceFile, workdir, tempStem: 'short' });

  const tools = run(context);

  assert.equal(path.basename(context.inputMarkdown), 'short.md');
  assert.equal(path.dirname(context.inputMarkdown), workdir);
  assert.deepEqual(tools.callsTo('doctoc')[0].args, [context.inputMarkdown]);
});

test('a brand-new TOC gets the own marker and is relocated before the first second-order heading (#83)', (t) => {
  const { context, sourceFile } = fixture(t, ['# Title', '', 'Intro.', '', '## Section', '', 'Body.']);

  const tools = run(context);
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8').split('\n');

  assert.equal(tools.callsTo('doctoc').length, 1);
  assert.notEqual(context.inputMarkdown, sourceFile, 'doctoc only ever touches the temp copy');
  assert.equal(refreshed[0], '# Title', 'the title keeps the top of the file');
  assert.equal(
    refreshed.indexOf(OWN_START) + FAKE_TOC_LINES.length,
    refreshed.indexOf('## Section'),
    "the block, without doctoc's note line, sits directly before the first ## heading, with one blank line",
  );
  assert.equal(refreshed.includes(START_MARKER), false, 'no doctoc marker is left');
});

test('an existing block is refreshed where it stands', (t) => {
  const { context } = fixture(t, ['# Title', '', '## Section', '', START_MARKER, '- [stale](#stale)', END_MARKER]);

  run(context);
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8').split('\n');

  assert.ok(refreshed.indexOf(START_MARKER) > refreshed.indexOf('## Section'), 'the block did not move up');
  assert.ok(refreshed.includes('- [Generated](#generated)'), 'the entries were refreshed');
  assert.equal(refreshed.includes('- [stale](#stale)'), false);
});

test('a documented marker survives the run byte for byte', (t) => {
  const documented = `\`${START_MARKER}\``;
  const { context } = fixture(t, ['# Title', '', START_MARKER, END_MARKER, '', '## Section', '', documented]);

  run(context);
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8');

  assert.ok(refreshed.includes(documented), 'the inline example came back unmasked');
  assert.equal(refreshed.includes(MASK), false, 'no mask character was left behind');
});

test('-u writes a TOC-only refresh back to the source file', (t) => {
  const { context, sourceFile } = fixture(
    t,
    ['# Title', '', START_MARKER, '- [stale](#stale)', END_MARKER, '', '## Section'],
    makeOptions({ writeToc: true }),
  );

  run(context);
  const source = fs.readFileSync(sourceFile, 'utf8');

  assert.ok(source.includes('- [Generated](#generated)'), 'the source carries the refreshed TOC');
  assert.ok(source.endsWith('## Section\n'), 'everything outside the block is unchanged');
});

test('-u refuses a refresh that changed anything outside the block (#44)', (t) => {
  const { context, sourceFile } = fixture(
    t,
    ['# Title', '', START_MARKER, END_MARKER, '', '## Section'],
    makeOptions({ writeToc: true }),
  );
  const before = fs.readFileSync(sourceFile, 'utf8');

  assert.throws(
    () =>
      run(context, {
        doctoc: (args) => {
          fs.writeFileSync(args[0], `${fs.readFileSync(args[0], 'utf8')}\nSwallowed the rest.\n`, 'utf8');
        },
      }),
    /changed content outside the table of contents block/,
  );
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before, 'the source file is left unchanged');
});

test('-u leaves a source without a marker pair alone', (t) => {
  const { context, sourceFile } = fixture(t, ['# Title', '', '## Section'], makeOptions({ writeToc: true }));
  const before = fs.readFileSync(sourceFile, 'utf8');

  run(context);

  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before, 'only the temp copy got a TOC');
  assert.ok(fs.readFileSync(context.inputMarkdown, 'utf8').includes(OWN_START));
});

test('the own marker triggers the step and is filled in place (#83)', (t) => {
  const { context, sourceFile } = fixture(t, ['# Title', '', '## Section', '', OWN_START, OWN_END, '', 'Body.']);

  assert.equal(shouldRunToc(makeOptions(), sourceFile), true);
  const tools = run(context);
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8').split('\n');

  assert.equal(tools.callsTo('doctoc').length, 1);
  assert.deepEqual(refreshed.slice(4, 9), [OWN_START, '', '- [Generated](#generated)', '', OWN_END]);
  assert.ok(refreshed.indexOf(OWN_START) > refreshed.indexOf('## Section'), 'the block did not move');
});

test('the own marker gets a real doctoc TOC of the headings after it (#83)', (t) => {
  const { context } = fixture(t, ['# Title', '', OWN_START, OWN_END, '', '## First', '', '### Nested', '', '## Second']);

  run(context, { doctoc: inProcessDoctoc });
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8');

  // An existing block without a title stays without one, exactly as an empty
  // doctoc pair does; only a brand-new block gets doctoc's default title.
  assert.match(refreshed, /<!-- toc START -->\n\n- \[First\]/);
  assert.match(refreshed, /- \[First\]\(#first\)\n {2}- \[Nested\]\(#nested\)\n- \[Second\]\(#second\)/);
  assert.equal(refreshed.includes('doctoc generated TOC'), false);
});

test('with several blocks only the first is filled, the rest stay byte-identical (#83)', (t) => {
  const laterDoctoc = [START_MARKER, '- [kept](#kept)', END_MARKER];
  const laterOwn = [OWN_START, '- [kept](#kept)', OWN_END];

  const own = fixture(t, ['# T', '', OWN_START, OWN_END, '', '## A', '', ...laterDoctoc]);
  run(own.context);
  const ownResult = fs.readFileSync(own.context.inputMarkdown, 'utf8');
  assert.ok(ownResult.includes(`${OWN_START}\n\n- [Generated](#generated)\n\n${OWN_END}`));
  assert.ok(ownResult.endsWith(`${laterDoctoc.join('\n')}\n`), 'the later doctoc block is untouched');

  const doctoc = fixture(t, ['# T', '', START_MARKER, END_MARKER, '', '## A', '', ...laterOwn]);
  run(doctoc.context);
  const doctocResult = fs.readFileSync(doctoc.context.inputMarkdown, 'utf8');
  assert.ok(doctocResult.includes(FAKE_TOC_LINES.join('\n')), 'the doctoc block is filled as doctoc writes it');
  assert.ok(doctocResult.endsWith(`${laterOwn.join('\n')}\n`), 'the later own block is untouched');
});

test('documented own markers do not trigger the step and survive a forced run (#83)', (t) => {
  const documented = ['```md', OWN_START, OWN_END, '```', '', '`<!-- toc START -->`', '', `    ${OWN_START}`];
  const { context, sourceFile } = fixture(
    t,
    ['# Title', '', ...documented, '', '## Section'],
    makeOptions({ toc: 'always' }),
  );

  assert.equal(shouldRunToc(makeOptions(), sourceFile), false);
  run(context);
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8');

  assert.ok(refreshed.includes(documented.join('\n')), 'every example came back byte for byte');
  assert.ok(
    refreshed.includes(`${OWN_START}\n\n- [Generated](#generated)\n\n${OWN_END}\n\n## Section`),
    'a new block was created',
  );
});

test('an own START marker without an END marker fails before doctoc runs (#83)', (t) => {
  const { context, sourceFile } = fixture(t, ['# Doc', '', OWN_START, '', '## Section']);
  const before = fs.readFileSync(sourceFile, 'utf8');
  const tools = createFakeTools();

  assert.throws(() => runToc(context, tools.run), /md2pdf START marker on line 3 has no END marker.*was left unchanged/);
  assert.equal(tools.calls.length, 0);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before);
});

test('-u writes an own-marker refresh back with the marker lines the author wrote (#83)', (t) => {
  const { context, sourceFile } = fixture(
    t,
    ['# Title', '', OWN_START, '- [stale](#stale)', OWN_END, '', '## Section'],
    makeOptions({ writeToc: true }),
  );

  run(context);

  assert.equal(
    fs.readFileSync(sourceFile, 'utf8'),
    ['# Title', '', OWN_START, '', '- [Generated](#generated)', '', OWN_END, '', '## Section', ''].join('\n'),
  );
});

test('a registry entry added without code is filled like the built-in ones (#83)', (t) => {
  const markdownToc: TocMarkerEntry = { name: 'markdown-toc', start: /^<!-- toc -->\s*$/, end: /^<!-- tocstop -->\s*$/ };
  const registry = [...TOC_MARKERS, markdownToc];
  const { context, sourceFile } = fixture(
    t,
    ['# Title', '', '<!-- toc -->', '- [stale](#stale)', '<!-- tocstop -->', '', '## Section'],
    makeOptions({ writeToc: true }),
  );

  assert.equal(shouldRunToc(makeOptions(), sourceFile), false, 'unknown to the default registry');
  assert.equal(shouldRunToc(makeOptions(), sourceFile, registry), true);
  runToc(context, createFakeTools().run, DOCTOC_BACKEND, registry);

  assert.equal(
    fs.readFileSync(sourceFile, 'utf8'),
    ['# Title', '', '<!-- toc -->', '', '- [Generated](#generated)', '', '<!-- tocstop -->', '', '## Section', ''].join(
      '\n',
    ),
  );
});

test('the backend is swappable: the step hands it the block and the markers (#83)', (t) => {
  const requests: Parameters<TocBackend['generate']>[0][] = [];
  const backend: TocBackend = {
    name: 'fake',
    nativeMarker: { name: 'fake', start: /^<!-- fake START -->$/, end: /^<!-- fake END -->$/ },
    generate(request) {
      requests.push(request);
      const lines = request.markdown.split('\n');
      const { startIndex, endIndex } = request.block ?? { startIndex: 0, endIndex: -1 };
      const block = [
        request.markers?.start ?? '<!-- fake START -->',
        '- entry',
        request.markers?.end ?? '<!-- fake END -->',
      ];
      lines.splice(startIndex, endIndex - startIndex + 1, ...block);
      return { markdown: lines.join('\n'), block: { startIndex, endIndex: startIndex + 2 } };
    },
  };
  const tools = createFakeTools();
  const marked = fixture(t, ['# Title', '', START_MARKER, END_MARKER, '', '## Section']);
  const plain = fixture(t, ['# Title', '', 'Intro.', '', '## Section']);

  runToc(marked.context, tools.run, backend);
  runToc(plain.context, tools.run, backend);

  assert.equal(tools.calls.length, 0, 'doctoc never ran');
  assert.deepEqual(requests[0].block, { startIndex: 2, endIndex: 3 });
  assert.deepEqual(requests[0].markers, { start: START_MARKER, end: END_MARKER }, 'a foreign block keeps its markers');
  assert.equal(requests[1].block, undefined);
  assert.deepEqual(requests[1].markers, OWN_TOC_MARKER, 'a new block gets the own marker');
  assert.equal(
    fs.readFileSync(plain.context.inputMarkdown, 'utf8'),
    ['# Title', '', 'Intro.', '', OWN_START, '- entry', OWN_END, '', '## Section', ''].join('\n'),
    'the step relocated the new block',
  );
});
