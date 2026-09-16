/**
 * Behaviour of the doctoc step itself (#71).
 *
 * doctoc is replaced by the fake runner from `helpers.ts`, which rewrites the
 * file the way the real tool does: an existing marker block is refreshed in
 * place, a file without one gets a fresh block at the very top. What is under
 * test is everything `run-doctoc.ts` does around that — the broken-pair guard,
 * the masking round trip, the relocation of a *new* block only, and the `-u`
 * write-back with its TOC-only check (#44).
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctoc, shouldRunDoctoc } from '../steps/run-doctoc';
import { ConversionContext } from '../types';
import { createFakeTools, FAKE_TOC_LINES, FakeToolBehaviour, makeContext, makeOptions, tempDir, writeFile } from './helpers';

/** The Private Use Area character `doctoc-markers.ts` masks a marker with. */
const MASK = String.fromCharCode(0xe000);

const START_MARKER = '<!-- START doctoc generated TOC please keep comment here to allow auto update -->';
const END_MARKER = '<!-- END doctoc generated TOC please keep comment here to allow auto update -->';

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
  runDoctoc(context, tools.run);
  return tools;
}

test('shouldRunDoctoc follows the markers and the TOC mode', (t) => {
  const dir = tempDir(t);
  const marked = writeFile(dir, 'marked.md', `# Doc\n\n${START_MARKER}\n${END_MARKER}\n`);
  const plain = writeFile(dir, 'plain.md', '# Doc\n');
  const documented = writeFile(dir, 'documented.md', ['# Doc', '', '```md', START_MARKER, '```', ''].join('\n'));

  assert.equal(shouldRunDoctoc(makeOptions(), marked), true);
  assert.equal(shouldRunDoctoc(makeOptions(), plain), false);
  assert.equal(shouldRunDoctoc(makeOptions(), documented), false, 'a documented marker is not a marker');
  assert.equal(shouldRunDoctoc(makeOptions({ toc: 'always' }), plain), true);
  assert.equal(shouldRunDoctoc(makeOptions({ toc: 'never' }), marked), false);
});

test('a genuine START marker without an END marker fails before doctoc runs (#44)', (t) => {
  const { context, sourceFile } = fixture(t, ['# Doc', '', START_MARKER, '', '## Section']);
  const before = fs.readFileSync(sourceFile, 'utf8');
  const tools = createFakeTools();

  assert.throws(() => runDoctoc(context, tools.run), /was left unchanged/);
  assert.equal(tools.calls.length, 0, 'doctoc never saw the file');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before, 'the source file is untouched');
});

test('a brand-new TOC is relocated before the first second-order heading', (t) => {
  const { context, sourceFile } = fixture(t, ['# Title', '', 'Intro.', '', '## Section', '', 'Body.']);

  const tools = run(context);
  const refreshed = fs.readFileSync(context.inputMarkdown, 'utf8').split('\n');

  assert.equal(tools.callsTo('doctoc').length, 1);
  assert.notEqual(context.inputMarkdown, sourceFile, 'doctoc only ever touches the temp copy');
  assert.equal(refreshed[0], '# Title', 'the title keeps the top of the file');
  assert.equal(
    refreshed.indexOf(START_MARKER) + FAKE_TOC_LINES.length + 1,
    refreshed.indexOf('## Section'),
    'the block sits directly before the first ## heading, with one blank line',
  );
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
  assert.ok(fs.readFileSync(context.inputMarkdown, 'utf8').includes(START_MARKER));
});
