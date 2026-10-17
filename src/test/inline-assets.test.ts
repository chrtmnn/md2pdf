/**
 * Behaviour of the asset embedding added by #28 for the relative-image
 * problem reported in #17: which targets are rewritten, which are left alone,
 * and what is reported when an asset cannot be embedded.
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutizeImageTargets, inlineAssets, transformImageTargets } from '../steps/inline-assets';
import { makeContext, tempDir, writeFile, writePng } from './helpers';

/** Base64 of the byte sequence written by {@link writePng}. */
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

/**
 * Prepares a work directory holding a converted Markdown file, as the
 * pipeline would have left it just before `inlineAssets` runs.
 *
 * @param dir - Fixture root directory.
 * @param markdown - Contents of the converted Markdown file.
 * @returns The conversion context to hand to `inlineAssets`.
 */
function contextFor(dir: string, markdown: string) {
  const sourceFile = path.join(dir, 'source', 'doc.md');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, markdown, 'utf8');

  const workdir = path.join(dir, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  const convertedMarkdown = path.join(workdir, 'doc_converted.md');
  fs.writeFileSync(convertedMarkdown, markdown, 'utf8');

  return makeContext({ sourceFile, workdir, convertedMarkdown });
}

test('transformImageTargets rewrites Markdown and HTML image targets', () => {
  const markdown = '![alt](a.png)\n\n<img src="b.png" width="20">\n\n<IMG SRC=\'c.png\'>\n';

  const output = transformImageTargets(markdown, (target) => `x/${target}`);

  assert.equal(output.includes('![alt](x/a.png)'), true);
  assert.equal(output.includes('<img src="x/b.png" width="20">'), true);
  assert.equal(output.includes('<IMG SRC="x/c.png">'), true);
});

test('transformImageTargets leaves a target alone when the transform returns undefined', () => {
  const markdown = '![alt](a.png) and ![other](b.png)\n';

  const output = transformImageTargets(markdown, (target) => (target === 'a.png' ? 'z.png' : undefined));

  assert.equal(output, '![alt](z.png) and ![other](b.png)\n');
});

test('transformImageTargets skips fenced code blocks', () => {
  const markdown = ['```markdown', '![alt](a.png)', '```', '', '![alt](a.png)'].join('\n');

  const output = transformImageTargets(markdown, () => 'REWRITTEN');

  assert.equal(output, ['```markdown', '![alt](a.png)', '```', '', '![alt](REWRITTEN)'].join('\n'));
});

test('transformImageTargets does not let an info-string fence close a block (#47)', () => {
  // The standard way of documenting what a fenced block looks like: the inner
  // ```js opens nothing and closes nothing, so only the last image renders.
  const markdown = ['```', '![a](in-block.png)', '```js', '![b](fake-close.png)', '```', '![c](real.png)'].join('\n');

  const output = transformImageTargets(markdown, () => 'REWRITTEN');

  assert.equal(
    output,
    ['```', '![a](in-block.png)', '```js', '![b](fake-close.png)', '```', '![c](REWRITTEN)'].join('\n'),
  );
});

test('inlineAssets embeds the image after a documented fence example (#47)', (t) => {
  const dir = tempDir(t);
  const markdown = ['```', '![a](images/logo.png)', '```js', '![b](images/logo.png)', '```', '![c](images/logo.png)'].join('\n');
  const context = contextFor(dir, markdown);
  writePng(path.join(dir, 'source'), 'images/logo.png');

  const warnings = inlineAssets(context);

  const output = fs.readFileSync(context.convertedMarkdown, 'utf8');
  assert.deepEqual(warnings, []);
  assert.equal(output.split(`data:image/png;base64,${PNG_BASE64}`).length - 1, 1, output);
  assert.equal(output.endsWith(`![c](data:image/png;base64,${PNG_BASE64})`), true, output);
});

test('transformImageTargets skips fenced code blocks in a CRLF document and keeps its line endings (#99)', () => {
  const markdown = ['```', '![alt](a.png)', '```', '', '![alt](a.png)', ''].join('\r\n');

  const output = transformImageTargets(markdown, () => 'REWRITTEN');

  assert.equal(output, ['```', '![alt](a.png)', '```', '', '![alt](REWRITTEN)', ''].join('\r\n'));
});

test('inlineAssets reports nothing for a missing image documented in a CRLF fence (#99)', (t) => {
  const dir = tempDir(t);
  const markdown = ['```', '![a](images/missing.png)', '```', '![b](images/logo.png)', ''].join('\r\n');
  const context = contextFor(dir, markdown);
  writePng(path.join(dir, 'source'), 'images/logo.png');

  const warnings = inlineAssets(context);

  const output = fs.readFileSync(context.convertedMarkdown, 'utf8');
  assert.deepEqual(warnings, []);
  assert.equal(output.includes('![a](images/missing.png)\r\n'), true, output);
  assert.equal(output.includes(`![b](data:image/png;base64,${PNG_BASE64})\r\n`), true, output);
});

test('transformImageTargets skips HTML comment blocks (#47)', () => {
  const markdown = ['<!--', '![alt](a.png)', '-->', '', '![alt](a.png)'].join('\n');

  const output = transformImageTargets(markdown, () => 'REWRITTEN');

  assert.equal(output, ['<!--', '![alt](a.png)', '-->', '', '![alt](REWRITTEN)'].join('\n'));
});

test('transformImageTargets skips inline code spans and restores them verbatim', () => {
  const markdown = 'Write `![alt](a.png)` to embed ![alt](a.png).\n';

  const output = transformImageTargets(markdown, () => 'REWRITTEN');

  assert.equal(output, 'Write `![alt](a.png)` to embed ![alt](REWRITTEN).\n');
});

test('transformImageTargets handles angle-bracketed targets and re-brackets spaced ones', () => {
  assert.equal(transformImageTargets('![a](<my file.png>)', (target) => `dir/${target}`), '![a](<dir/my file.png>)');
  assert.equal(transformImageTargets('![a](plain.png)', (target) => `dir/${target}`), '![a](dir/plain.png)');
});

test('absolutizeImageTargets resolves relative targets against the document directory', (t) => {
  const dir = tempDir(t);
  writePng(dir, 'images/logo.png');

  const output = absolutizeImageTargets('![logo](images/logo.png)', dir);

  assert.equal(output, `![logo](${path.join(dir, 'images', 'logo.png').split(path.sep).join('/')})`);
});

test('absolutizeImageTargets leaves URLs, data URIs and fragments untouched', (t) => {
  const dir = tempDir(t);
  const markdown = [
    '![a](https://example.com/x.png)',
    '![b](//cdn.example.com/x.png)',
    '![c](data:image/png;base64,AAAA)',
    '![d](#anchor)',
  ].join('\n');

  assert.equal(absolutizeImageTargets(markdown, dir), markdown);
});

test('absolutizeImageTargets decodes percent-encoded targets to find the file', (t) => {
  const dir = tempDir(t);
  writePng(dir, 'my logo.png');

  const output = absolutizeImageTargets('![logo](my%20logo.png)', dir);

  assert.equal(output, `![logo](<${path.join(dir, 'my logo.png').split(path.sep).join('/')}>)`);
});

test('inlineAssets embeds a relative asset resolved against the source directory', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '# Doc\n\n![logo](images/logo.png)\n');
  writePng(path.join(dir, 'source'), 'images/logo.png');

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(
    fs.readFileSync(context.convertedMarkdown, 'utf8'),
    `# Doc\n\n![logo](data:image/png;base64,${PNG_BASE64})\n`,
  );
});

test('inlineAssets embeds an absolute target', (t) => {
  const dir = tempDir(t);
  const asset = writePng(dir, 'assets/logo.png');
  const context = contextFor(dir, `![logo](${asset.split(path.sep).join('/')})\n`);

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8').includes(`base64,${PNG_BASE64}`), true);
});

test('inlineAssets does not read a Windows drive letter as a URL scheme', (t) => {
  const dir = tempDir(t);
  // A literal drive-letter target, so the claim is exercised on every
  // platform rather than only where `path.sep` happens to produce one: `C:`
  // must be treated as a path (reported as missing) and not skipped as a URL,
  // which is why a scheme needs at least two characters.
  const context = contextFor(dir, '![logo](C:/docs/logo.png)\n');

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, ['Asset not found, left unresolved: C:/docs/logo.png']);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8'), '![logo](C:/docs/logo.png)\n');
});

test('inlineAssets leaves targets that already resolve inside the work directory alone', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![diagram](doc-1.svg)\n');
  writeFile(path.join(dir, 'work'), 'doc-1.svg', '<svg></svg>');

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8'), '![diagram](doc-1.svg)\n');
});

test('inlineAssets never rewrites image syntax inside code (#28)', (t) => {
  const dir = tempDir(t);
  const markdown = ['```markdown', '![logo](images/logo.png)', '```', '', 'inline `![logo](images/logo.png)`', ''].join('\n');
  const context = contextFor(dir, markdown);
  writePng(path.join(dir, 'source'), 'images/logo.png');

  inlineAssets(context);

  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8'), markdown);
});

test('inlineAssets warns once per missing asset and leaves it as written', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![a](gone.png)\n\n![b](gone.png)\n\n![c](also-gone.png)\n');

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, [
    'Asset not found, left unresolved: gone.png',
    'Asset not found, left unresolved: also-gone.png',
  ]);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8').includes('![a](gone.png)'), true);
});

test('inlineAssets leaves remote images untouched and does not warn about them', (t) => {
  const dir = tempDir(t);
  const markdown = '![a](https://example.com/x.png)\n\n<img src="data:image/png;base64,AAAA">\n';
  const context = contextFor(dir, markdown);

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8'), markdown);
});

test('inlineAssets picks the MIME type from the extension and falls back for unknown ones', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![svg](a.svg)\n\n![odd](b.xyz)\n');
  writeFile(path.join(dir, 'source'), 'a.svg', '<svg/>');
  writeFile(path.join(dir, 'source'), 'b.xyz', 'x');

  inlineAssets(context);

  const output = fs.readFileSync(context.convertedMarkdown, 'utf8');
  assert.equal(output.includes('data:image/svg+xml;base64,'), true);
  assert.equal(output.includes('data:application/octet-stream;base64,'), true);
});

test('transformImageTargets keeps balanced parentheses in a target (#55)', () => {
  const markdown = '![shot](images/screenshot(1).png) and ![deep](a(b(c)d).png)\n';

  const output = transformImageTargets(markdown, (target) => `x/${target}`);

  // The rewritten targets carry parentheses, so they come back bracketed.
  assert.equal(output, '![shot](<x/images/screenshot(1).png>) and ![deep](<x/a(b(c)d).png>)\n');
});

test('inlineAssets embeds an asset whose name contains parentheses (#55)', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![shot](images/screenshot(1).png)\n');
  writePng(path.join(dir, 'source'), 'images/screenshot(1).png');

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(
    fs.readFileSync(context.convertedMarkdown, 'utf8'),
    `![shot](data:image/png;base64,${PNG_BASE64})\n`,
  );
});

test('inlineAssets reads an asset once however often it is referenced (#55)', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![a](images/logo.png)\n\n![b](images/logo.png)\n\n<img src="images/logo.png">\n');
  const asset = writePng(path.join(dir, 'source'), 'images/logo.png');

  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
    if (file === asset) {
      reads += 1;
    }
    return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  });

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(reads, 1, 'the asset is base64-encoded once and reused');
  assert.equal(
    fs.readFileSync(context.convertedMarkdown, 'utf8').split(`base64,${PNG_BASE64}`).length - 1,
    3,
  );
});

test('inlineAssets embeds an asset of exactly the size limit (#55)', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![big](big.png)\n');
  const big = path.join(dir, 'source', 'big.png');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 32 * 1024 * 1024);

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, []);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8').startsWith('![big](data:image/png;base64,'), true);
});

test('inlineAssets reports one byte over the limit with the real size (#55)', (t) => {
  const dir = tempDir(t);
  const context = contextFor(dir, '![big](big.png)\n');
  const big = path.join(dir, 'source', 'big.png');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 32 * 1024 * 1024 + 1);

  const warnings = inlineAssets(context);

  assert.deepEqual(warnings, ['Asset too large to embed (32.0 MiB, limit 32 MiB), left unresolved: big.png']);
  assert.equal(fs.readFileSync(context.convertedMarkdown, 'utf8'), '![big](big.png)\n');
});

test('transformImageTargets rewrites an unquoted src attribute (#55)', () => {
  const output = transformImageTargets('<img src=x.png>\n', (target) => `y/${target}`);

  assert.equal(output, '<img src="y/x.png">\n');
});

test('transformImageTargets rewrites src, not an attribute ending in -src (#101)', () => {
  const seen: string[] = [];
  const output = transformImageTargets(
    '<img data-src="large.png" src="thumb.png">\n\n<img src="a.png" data-src="b.png">\n\n<img lazy-src=c.png>\n',
    (target) => {
      seen.push(target);
      return `y/${target}`;
    },
  );

  assert.deepEqual(seen, ['thumb.png', 'a.png']);
  assert.equal(
    output,
    '<img data-src="large.png" src="y/thumb.png">\n\n<img src="y/a.png" data-src="b.png">\n\n<img lazy-src=c.png>\n',
  );
});
