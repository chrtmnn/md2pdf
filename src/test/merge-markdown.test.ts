/**
 * Behaviour of the merge assembly step (#6) including the per-document image
 * absolutisation added by #28.
 *
 * Nothing here asserts the *name* of the merge temp directory: PR #30 changes
 * how that name is generated, and the contract these tests pin down is that
 * the directory exists, is distinct per run, and is the one the merged file
 * lives in.
 */

import fs from 'fs';
import path from 'path';
import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_BREAK_HTML } from '../steps/merge-assembly';
import { MergedInput, mergeMarkdown } from '../steps/merge-markdown';
import { scanDoctocMarkers } from '../steps/doctoc-markers';
import { NATIVE_PATH_RULES, POSIX_PATH_RULES, PathRules, WINDOWS_PATH_RULES } from '../steps/path-rules';
import { DOCTOC_END_MARKER, DOCTOC_MARKER } from '../steps/toc-placement';
import { ConverterOptions } from '../types';
import { comparablePath, makeOptions, removeAfter, tempDir, writePng, writeFile } from './helpers';

/**
 * Runs the production merge step and registers the temp directory it created.
 *
 * Without `-r`/`-p` the merge directory lands in `os.tmpdir()`, outside the
 * fixture — and the pipeline's own cleanup (`md2pdf.ts`) never runs in a unit
 * test, so every run used to leave a `merge_*` directory behind. Registering
 * the result keeps the default placement under test.
 */
function merge(
  t: TestContext,
  files: string[],
  options: ConverterOptions,
  rules: PathRules = NATIVE_PATH_RULES,
): MergedInput {
  const result = mergeMarkdown(files, options, rules);
  removeAfter(t, result.mergeDir);
  return result;
}

test('concatenates documents with a break block between them', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n\nBody A.\n');
  const b = writeFile(dir, 'b.md', '# B\n\nBody B.\n');

  const result = merge(t, [a, b], makeOptions({ merge: 'combined' }));

  const merged = fs.readFileSync(result.mergedFile, 'utf8');
  assert.equal(merged, `# A\n\nBody A.\n\n${DOCUMENT_BREAK_HTML}\n\n# B\n\nBody B.\n`);
  assert.equal(result.mergedCount, 2);
  assert.deepEqual(result.skipped, []);
});

test('a document without a trailing newline cannot glue onto the next one', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', 'last line of A');
  const b = writeFile(dir, 'b.md', '# B\n');

  const merged = fs.readFileSync(
    merge(t, [a, b], makeOptions({ merge: 'combined' })).mergedFile,
    'utf8',
  );

  assert.equal(merged.includes(`last line of A\n\n${DOCUMENT_BREAK_HTML}`), true);
});

test('strips a UTF-8 BOM from every document, not just the first', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '\uFEFF# A\n');
  const b = writeFile(dir, 'b.md', '\uFEFF# B\n');

  const merged = fs.readFileSync(
    merge(t, [a, b], makeOptions({ merge: 'combined' })).mergedFile,
    'utf8',
  );

  assert.equal(merged.includes('\uFEFF'), false);
  assert.equal(merged.startsWith('# A'), true);
});

test('names the merged file after --merge so the rest of the pipeline derives from it', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');

  const result = merge(t, [a], makeOptions({ merge: 'quarterly-report' }));

  assert.equal(path.basename(result.mergedFile), 'quarterly-report.md');
});

test('creates a distinct, existing merge directory per run', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');
  const options = makeOptions({ merge: 'combined' });

  const first = merge(t, [a], options);
  const second = merge(t, [a], options);

  for (const result of [first, second]) {
    assert.equal(fs.statSync(result.mergeDir).isDirectory(), true);
    assert.equal(comparablePath(path.dirname(result.mergedFile)), comparablePath(result.mergeDir));
  }
  assert.notEqual(comparablePath(first.mergeDir), comparablePath(second.mergeDir));
});

test('honours --temp-root and --temp-in-output for the merge directory', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');
  const root = path.join(dir, 'scratch');
  const out = path.join(dir, 'out');

  const rooted = merge(t, [a], makeOptions({ merge: 'combined', tempRoot: root }));
  assert.equal(comparablePath(path.dirname(rooted.mergeDir)), comparablePath(root));

  const inOutput = merge(t, [a], makeOptions({ merge: 'combined', tempInOutput: true, outputDir: out }));
  assert.equal(comparablePath(path.dirname(inOutput.mergeDir)), comparablePath(out));
});

test('defaults the target directory to the common ancestor, unless -o is given', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'one/a.md', '# A\n');
  const b = writeFile(dir, 'two/b.md', '# B\n');

  const defaulted = merge(t, [a, b], makeOptions({ merge: 'combined' }));
  assert.equal(comparablePath(defaulted.targetDir), comparablePath(dir));

  const explicit = merge(t, [a, b], makeOptions({ merge: 'combined', outputDir: path.join(dir, 'out') }));
  assert.equal(comparablePath(explicit.targetDir), comparablePath(path.join(dir, 'out')));
  assert.equal(fs.existsSync(explicit.targetDir), true, 'the target directory is created');
});

test('warns once when the inputs span more than one directory', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'one/a.md', '# A\n');
  const b = writeFile(dir, 'two/b.md', '# B\n');

  const spread = merge(t, [a, b], makeOptions({ merge: 'combined' }));
  assert.equal(spread.warnings.length, 1);
  assert.match(spread.warnings[0], /relative links are not rewritten/);

  const together = merge(t, [a, a], makeOptions({ merge: 'combined' }));
  assert.deepEqual(together.warnings, []);
});

test('reports missing inputs as skipped instead of failing', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');
  const missing = path.join(dir, 'gone.md');

  const result = merge(t, [a, missing], makeOptions({ merge: 'combined' }));

  assert.deepEqual(result.skipped, [missing]);
  assert.equal(result.mergedCount, 1);
});

test('throws when nothing can be merged or when --merge is absent', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');

  assert.throws(
    () => mergeMarkdown([path.join(dir, 'gone.md')], makeOptions({ merge: 'combined' })),
    /Nothing to merge/,
  );
  assert.throws(() => mergeMarkdown([a], makeOptions()), /without --merge/);
});

test('pins relative image targets to their own source document (#28)', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'one/a.md', '# A\n\n![logo](images/logo.png)\n');
  const b = writeFile(dir, 'two/b.md', '# B\n\n![logo](images/logo.png)\n');
  writePng(dir, 'one/images/logo.png');
  writePng(dir, 'two/images/logo.png');

  const merged = fs.readFileSync(
    merge(t, [a, b], makeOptions({ merge: 'combined' })).mergedFile,
    'utf8',
  );

  const expectedA = path.join(dir, 'one', 'images', 'logo.png').split(path.sep).join('/');
  const expectedB = path.join(dir, 'two', 'images', 'logo.png').split(path.sep).join('/');
  assert.equal(merged.includes(`![logo](${expectedA})`), true, merged);
  assert.equal(merged.includes(`![logo](${expectedB})`), true, merged);
});

test('leaves image targets that do not resolve exactly as written (#28)', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '![gone](images/missing.png)\n\n![remote](https://example.com/x.png)\n');

  const merged = fs.readFileSync(
    merge(t, [a], makeOptions({ merge: 'combined' })).mergedFile,
    'utf8',
  );

  assert.equal(merged.includes('![gone](images/missing.png)'), true);
  assert.equal(merged.includes('![remote](https://example.com/x.png)'), true);
});

test('keeps only the first document frontmatter and warns about the rest (#49)', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '---\ntitle: A\n---\n\n# A\n');
  const b = writeFile(dir, 'b.md', '---\ntitle: B\npdf_options:\n  format: A5\n---\n\n# B\n');

  const result = merge(t, [a, b], makeOptions({ merge: 'combined' }));
  const merged = fs.readFileSync(result.mergedFile, 'utf8');

  assert.equal(merged, `---\ntitle: A\n---\n\n# A\n\n${DOCUMENT_BREAK_HTML}\n\n# B\n`);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Dropped the YAML frontmatter of 1 document/);
});

test('an empty input file does not add a second page break (#49)', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');
  const empty = writeFile(dir, 'empty.md', '');
  const c = writeFile(dir, 'c.md', '# C\n');

  const merged = fs.readFileSync(
    merge(t, [a, empty, c], makeOptions({ merge: 'combined' })).mergedFile,
    'utf8',
  );

  assert.equal(merged, `# A\n\n${DOCUMENT_BREAK_HTML}\n\n# C\n`);
});

test('a document holding nothing but frontmatter contributes no section (#49)', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');
  const meta = writeFile(dir, 'meta.md', '---\ntitle: Meta\n---\n');
  const c = writeFile(dir, 'c.md', '# C\n');

  const merged = fs.readFileSync(
    merge(t, [a, meta, c], makeOptions({ merge: 'combined' })).mergedFile,
    'utf8',
  );

  assert.equal(merged, `# A\n\n${DOCUMENT_BREAK_HTML}\n\n# C\n`);
});

test('the multi-directory warning compares directories per the platform rules (#50)', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'One/a.md', '# A\n');
  const b = writeFile(dir, 'one/b.md', '# B\n');

  if (comparablePath(path.dirname(a)) === comparablePath(path.dirname(b))) {
    t.skip('the filesystem folded the two directories into one');
    return;
  }

  assert.deepEqual(
    merge(t, [a, b], makeOptions({ merge: 'combined' }), WINDOWS_PATH_RULES).warnings,
    [],
    'Windows rules see one directory spelled two ways',
  );
  assert.equal(
    merge(t, [a, b], makeOptions({ merge: 'combined' }), POSIX_PATH_RULES).warnings.length,
    1,
    'POSIX rules see two directories',
  );
});

test('--toc replaces the documents own tables of contents with one in front of them', (t) => {
  const dir = tempDir(t);
  const start = `${DOCTOC_MARKER} please keep comment here to allow auto update -->`;
  const a = writeFile(dir, 'a.md', `# A\n\n${start}\n\n- [Old A](#old-a)\n\n${DOCTOC_END_MARKER}\n\n## A1\n`);
  const b = writeFile(dir, 'b.md', `# B\n\n${start}\n- [Old B](#old-b)\n${DOCTOC_END_MARKER}\n\nBody B.\n`);
  const c = writeFile(dir, 'c.md', '# C\n\n```\n' + `${start}\n${DOCTOC_END_MARKER}\n` + '```\n');

  const result = merge(t, [a, b, c], makeOptions({ merge: 'combined', toc: 'always' }));
  const merged = fs.readFileSync(result.mergedFile, 'utf8');

  assert.equal(merged.startsWith(`${start}\n${DOCTOC_END_MARKER}\n\n${DOCUMENT_BREAK_HTML}\n\n# A\n`), true);
  assert.equal(merged.includes('Old A'), false);
  assert.equal(merged.includes('Old B'), false);
  assert.equal(merged.includes('```\n' + `${start}\n${DOCTOC_END_MARKER}\n` + '```'), true, 'documented example kept');
  assert.deepEqual(scanDoctocMarkers(merged), { kind: 'pair', startIndex: 0, endIndex: 1 });
  assert.deepEqual(result.warnings, [
    'Removed the table of contents of 2 documents: --toc puts one table of contents in front of the merged documents.',
  ]);
});

test('without --toc a merge leaves the documents tables of contents alone', (t) => {
  const dir = tempDir(t);
  const start = `${DOCTOC_MARKER} please keep comment here to allow auto update -->`;
  const source = `# A\n\n${start}\n- [A1](#a1)\n${DOCTOC_END_MARKER}\n\n## A1\n`;
  const a = writeFile(dir, 'a.md', source);

  const merged = fs.readFileSync(merge(t, [a], makeOptions({ merge: 'combined' })).mergedFile, 'utf8');

  assert.equal(merged, source);
});

test('--toc fails the merge on a document with a START marker but no END marker', (t) => {
  const dir = tempDir(t);
  const a = writeFile(dir, 'a.md', '# A\n');
  const b = writeFile(dir, 'b.md', `# B\n\n${DOCTOC_MARKER} please keep comment here to allow auto update -->\n\nBody.\n`);

  assert.throws(
    () => merge(t, [a, b], makeOptions({ merge: 'combined', toc: 'always', tempRoot: dir })),
    /b\.md: doctoc START marker on line 3 has no END marker/,
  );
});
