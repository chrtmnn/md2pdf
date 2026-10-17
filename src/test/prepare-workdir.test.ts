/**
 * Behaviour of the context initialisation step.
 *
 * The generated work directory *name* is deliberately not asserted: PR #30
 * changes how it is produced. What the pipeline actually relies on is that the
 * directory exists, is unique per run, and is the one every other path in the
 * context is derived from.
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWorkdir } from '../steps/prepare-workdir';
import { comparablePath, makeOptions, removeAfter, tempDir, writeFile } from './helpers';

test('returns undefined for a missing source file', (t) => {
  const dir = tempDir(t);

  assert.equal(prepareWorkdir(path.join(dir, 'gone.md'), makeOptions()), undefined);
});

test('derives every context path from the source file', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'My Report.md', '# Doc\n');

  // No -r/-p, so the work directory lands in os.tmpdir(): the default
  // placement stays under test, and the directory is removed afterwards
  // instead of piling up one `My Report_*` per run.
  const context = prepareWorkdir(file, makeOptions())!;
  removeAfter(t, context.workdir);

  assert.equal(context.stem, 'My Report');
  assert.equal(context.tempStem, 'My_Report');
  assert.equal(comparablePath(context.sourceDir), comparablePath(dir));
  assert.equal(comparablePath(context.sourceFile), comparablePath(file));
  assert.equal(context.docTitle, 'My Report', 'the stem is the fallback title');
  assert.equal(comparablePath(context.outputPdf), comparablePath(path.join(dir, 'My Report.pdf')));
  assert.equal(comparablePath(context.inputMarkdown), comparablePath(file));
  assert.equal(comparablePath(path.dirname(context.convertedMarkdown)), comparablePath(context.workdir));
  assert.equal(comparablePath(path.dirname(context.tempPdf)), comparablePath(context.workdir));
  assert.equal(comparablePath(path.dirname(context.tempHtml)), comparablePath(context.workdir));
});

test('creates an existing, distinct work directory per call', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');
  const options = makeOptions({ tempRoot: path.join(dir, 'scratch') });

  const first = prepareWorkdir(file, options)!;
  const second = prepareWorkdir(file, options)!;

  for (const context of [first, second]) {
    assert.equal(fs.statSync(context.workdir).isDirectory(), true);
    assert.equal(
      comparablePath(path.dirname(context.workdir)),
      comparablePath(path.join(dir, 'scratch')),
      '--temp-root holds the work directory',
    );
  }
  assert.notEqual(comparablePath(first.workdir), comparablePath(second.workdir));
});

test('places the work directory inside the output directory with --temp-in-output', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');
  const out = path.join(dir, 'out');

  const context = prepareWorkdir(file, makeOptions({ tempInOutput: true, outputDir: out }))!;

  assert.equal(comparablePath(path.dirname(context.workdir)), comparablePath(out));
  assert.equal(comparablePath(context.targetDir), comparablePath(out));
  assert.equal(comparablePath(context.outputPdf), comparablePath(path.join(out, 'doc.pdf')));
});

test('creates the target directory so later steps can write into it', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');
  const out = path.join(dir, 'deep', 'output');

  const context = prepareWorkdir(file, makeOptions({ outputDir: out }))!;
  removeAfter(t, context.workdir);

  assert.equal(fs.statSync(context.targetDir).isDirectory(), true);
});

test('a very long file name does not fail the run with ENAMETOOLONG (#55)', (t) => {
  const dir = tempDir(t);
  const stem = 'a'.repeat(250);
  const file = writeFile(dir, `${stem}.md`, '# Doc\n');
  const options = makeOptions({ tempRoot: path.join(dir, 'scratch') });

  const context = prepareWorkdir(file, options)!;

  assert.equal(fs.statSync(context.workdir).isDirectory(), true);
  for (const generated of [context.workdir, context.convertedMarkdown, context.tempPdf, context.tempHtml]) {
    assert.ok(
      Buffer.byteLength(path.basename(generated)) <= 255,
      `${path.basename(generated).length} bytes is past NAME_MAX`,
    );
  }
  assert.equal(
    comparablePath(context.outputPdf),
    comparablePath(path.join(dir, `${stem}.pdf`)),
    'the output keeps the full stem',
  );
});

test('temp names carry no spaces, the output and the title keep them (#84)', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'my first doc.md', '# Doc\n');

  const context = prepareWorkdir(file, makeOptions({ tempRoot: path.join(dir, 'scratch') }))!;

  // mermaid-cli names its assets after the converted Markdown file and links
  // them without angle brackets, so a space here would end the link.
  for (const generated of [context.workdir, context.convertedMarkdown, context.tempPdf, context.tempHtml]) {
    assert.doesNotMatch(path.basename(generated), /\s/, `${path.basename(generated)} has a space`);
  }
  assert.equal(comparablePath(context.outputPdf), comparablePath(path.join(dir, 'my first doc.pdf')));
  assert.equal(context.docTitle, 'my first doc');
});
