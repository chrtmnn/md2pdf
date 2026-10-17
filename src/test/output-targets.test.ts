/**
 * Output path rules added for #45: where a conversion writes, which inputs
 * would write the same output, and how md2pdf recognises its own debug HTML.
 */

import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATOR_MARKER,
  deriveOutputPaths,
  describeOutputCollisions,
  findOutputCollisions,
  isGeneratedHtml,
  sanitizeStemForTemp,
  shortenStemForTemp,
  stampGeneratedHtml,
} from '../steps/output-targets';
import { POSIX_PATH_RULES, WINDOWS_PATH_RULES } from '../steps/path-rules';

const root = path.resolve('fixture-root');

test('derives the outputs next to the source without -o', () => {
  const paths = deriveOutputPaths(path.join(root, 'docs', 'My Report.md'), undefined);

  assert.equal(paths.stem, 'My Report');
  assert.equal(paths.targetDir, path.join(root, 'docs'));
  assert.equal(paths.outputPdf, path.join(root, 'docs', 'My Report.pdf'));
  assert.equal(paths.outputHtml, path.join(root, 'docs', 'My Report.html'));
});

test('derives the outputs inside the -o directory', () => {
  const paths = deriveOutputPaths(path.join(root, 'docs', 'guide.MD'), path.join(root, 'out'));

  assert.equal(paths.stem, 'guide');
  assert.equal(paths.outputPdf, path.join(root, 'out', 'guide.pdf'));
  assert.equal(paths.outputHtml, path.join(root, 'out', 'guide.html'));
});

test('same-named files from different directories collide with -o', () => {
  const a = path.join(root, 'a', 'README.md');
  const b = path.join(root, 'b', 'README.md');
  const other = path.join(root, 'b', 'other.md');

  const collisions = findOutputCollisions([a, other, b], path.join(root, 'out'), 'linux');

  assert.deepEqual(collisions, [{ outputPdf: path.join(root, 'out', 'README.pdf'), sources: [a, b] }]);
});

test('same-named files from different directories do not collide without -o', () => {
  const files = [path.join(root, 'a', 'README.md'), path.join(root, 'b', 'README.md')];

  assert.deepEqual(findOutputCollisions(files, undefined, 'linux'), []);
});

test('two extension spellings of one stem collide in the same directory', () => {
  const files = [path.join(root, 'doc.md'), path.join(root, 'doc.MD')];

  assert.equal(findOutputCollisions(files, undefined, 'linux').length, 1);
});

test('letter case only separates outputs off Windows', () => {
  const files = [path.join(root, 'a', 'README.md'), path.join(root, 'b', 'readme.md')];
  const out = path.join(root, 'out');

  assert.deepEqual(findOutputCollisions(files, out, 'linux'), []);
  assert.deepEqual(findOutputCollisions(files, out, 'win32'), [
    { outputPdf: path.join(out, 'README.pdf'), sources: files },
  ]);
});

test('reports every contested output with its sources', () => {
  const message = describeOutputCollisions([
    { outputPdf: path.join(root, 'out', 'README.pdf'), sources: ['a/README.md', 'b/README.md', 'c/README.md'] },
  ]);

  assert.match(message, /nothing was converted/);
  assert.ok(message.includes(path.join(root, 'out', 'README.pdf')));
  for (const source of ['a/README.md', 'b/README.md', 'c/README.md']) {
    assert.ok(message.includes(`<- ${source}`), source);
  }
});

test('stamps the marker directly after the opening head tag', () => {
  const html = '<!DOCTYPE html><html><head><title>T</title></head><body></body></html>';

  assert.equal(
    stampGeneratedHtml(html),
    `<!DOCTYPE html><html><head>${GENERATOR_MARKER}<title>T</title></head><body></body></html>`,
  );
});

test('a head tag with attributes is found, a header element is not a head', () => {
  assert.equal(stampGeneratedHtml('<HEAD lang="en"><x>'), `<HEAD lang="en">${GENERATOR_MARKER}<x>`);
  assert.equal(stampGeneratedHtml('<html><header>h</header>'), `<html>${GENERATOR_MARKER}<header>h</header>`);
});

test('without head or html tag the marker is prepended', () => {
  assert.equal(stampGeneratedHtml('<p>x</p>'), `${GENERATOR_MARKER}<p>x</p>`);
});

test('stamping is idempotent and recognised', () => {
  const once = stampGeneratedHtml('<html><head></head></html>');

  assert.equal(stampGeneratedHtml(once), once);
  assert.equal(isGeneratedHtml(once), true);
  assert.equal(isGeneratedHtml('<html><head><meta name="generator" content="other"></head></html>'), false);
});

test('sanitizeStemForTemp replaces what would break a bare link destination (#84)', () => {
  assert.equal(sanitizeStemForTemp('my first doc'), 'my_first_doc');
  assert.equal(sanitizeStemForTemp('tab\there'), 'tab_here');
  assert.equal(sanitizeStemForTemp('a#b?c%d'), 'a_b_c_d');
  assert.equal(sanitizeStemForTemp('draft (v2) <x> [y] \\z'), 'draft__v2___x___y___z');
});

test('sanitizeStemForTemp keeps letters in any script, digits and ._- (#84)', () => {
  assert.equal(sanitizeStemForTemp('Bericht_Größe-2.v1'), 'Bericht_Größe-2.v1');
  assert.equal(sanitizeStemForTemp('résumé'.normalize('NFD')), 'résumé'.normalize('NFD'), 'combining marks stay');
  assert.equal(sanitizeStemForTemp('日本語'), '日本語');
});

test('shortenStemForTemp leaves an ordinary stem alone (#55)', () => {
  assert.equal(shortenStemForTemp('My Report'), 'My Report');
  assert.equal(shortenStemForTemp('a'.repeat(240)), 'a'.repeat(240));
});

test('shortenStemForTemp keeps the longest temp name inside NAME_MAX (#55)', () => {
  const shortened = shortenStemForTemp('a'.repeat(250));

  assert.equal(shortened, 'a'.repeat(240));
  assert.equal(Buffer.byteLength(`${shortened}_converted.html`), 255);
  assert.equal(Buffer.byteLength(`${shortened}_XXXXXX`), 247);
});

test('shortenStemForTemp counts bytes and never splits a code point (#55)', () => {
  const shortened = shortenStemForTemp('ä'.repeat(200));

  assert.equal(shortened, 'ä'.repeat(120));
  assert.equal(Buffer.byteLength(shortened, 'utf8'), 240);
});

test('shortenStemForTemp halves the budget for the whole path on Windows (#55)', () => {
  const base = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\md-scripts-test-RVDWhk\\scratch';
  const shortened = shortenStemForTemp('a'.repeat(250), base, WINDOWS_PATH_RULES);

  // <base>\<stem>_XXXXXX\<stem>_converted.html has to fit MAX_PATH, and the
  // stem appears in it twice.
  const longestPath = `${base}\\${shortened}_XXXXXX\\${shortened}_converted.html`;
  assert.ok(shortened.length < 250, 'the stem is shortened for the path budget, not just the name');
  assert.ok(longestPath.length <= 260, `${longestPath.length} characters is past MAX_PATH`);
});

test('shortenStemForTemp ignores the path budget on POSIX (#55)', () => {
  const base = `/tmp/${'deep/'.repeat(40)}`;

  assert.equal(shortenStemForTemp('a'.repeat(250), base, POSIX_PATH_RULES), 'a'.repeat(240));
});

test('shortenStemForTemp fails readably when the base directory leaves no room (#55)', () => {
  const base = `C:\\${'d'.repeat(240)}`;

  assert.throws(
    () => shortenStemForTemp('doc', base, WINDOWS_PATH_RULES),
    /Temp directory path too long.*Use --temp-root with a shorter path/s,
  );
});
