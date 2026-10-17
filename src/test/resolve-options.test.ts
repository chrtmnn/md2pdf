/**
 * Resolution of the parsed Commander options into `ConverterOptions`.
 *
 * The arguments are parsed by the real program declaration from
 * `cli-program.ts`, so option conflicts are covered too. Commander throws
 * instead of exiting and its error output is silenced.
 */

import path from 'path';
import test, { beforeEach, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { createProgram } from '../cli-program';
import { collect, resolveOptions } from '../steps/resolve-options';
import { comparablePath, tempDir, writeFile } from './helpers';

const PACKAGE_ENV_VARS = ['DOCTOC_PKG', 'MERMAID_CLI_PKG', 'MD_TO_PDF_PKG'] as const;

function parse(args: string[]): Command {
  return createProgram()
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .parse(args, { from: 'user' });
}

/**
 * Sets or removes (`undefined`) environment variables for one test and
 * restores the caller's values afterwards, so a developer's own settings
 * cannot leak in.
 */
function withEnv(t: TestContext, values: Record<string, string | undefined>): void {
  const saved = Object.keys(values).map((name) => [name, process.env[name]] as const);

  t.after(() => {
    for (const [name, value] of saved) {
      setEnv(name, value);
    }
  });

  for (const [name, value] of Object.entries(values)) {
    setEnv(name, value);
  }
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * Moves the process into a fresh temp directory for one test and back out
 * afterwards. `resolveOptions` resolves `-s` against `process.cwd()`, the
 * directory an npm-installed `md2pdf` is called from (#56).
 *
 * The way back is registered before the directory's removal, because
 * after-hooks run in registration order and Windows refuses to remove the
 * working directory of a live process.
 */
function enterTempDir(t: TestContext): string {
  const previous = process.cwd();
  t.after(() => process.chdir(previous));

  const directory = tempDir(t);
  process.chdir(directory);
  return directory;
}

/**
 * Moves into a throwaway working directory and points `MD2PDF_CONFIG_DIR` at
 * a throwaway location before every test in this file.
 *
 * Without `MD2PDF_CONFIG_DIR`, `chooseStylesheet` falls back to the real
 * `~/.md2pdf` and stats the developer's own `default.css`, which would make
 * any test that later asserts on `stylesheet`/`stylesheetOrigin` depend on the
 * machine it runs on; without the working directory, a `-s` value would be
 * looked up wherever the suite was started. Doing it here rather than per test
 * makes the guarantee structural: a new test cannot forget it. Tests that need
 * a specific config directory still call `withEnv` and win, because it runs
 * afterwards.
 */
beforeEach((context) => {
  // Registered at file level, so the hook only ever runs for a test; the
  // declared `TestContext | SuiteContext` covers hooks inside a `describe`.
  const t = context as TestContext;
  enterTempDir(t);
  withEnv(t, { MD2PDF_CONFIG_DIR: tempDir(t) });
});

/**
 * Sets the package override variables for one test; the ones not given are
 * removed, so a developer's own `DOCTOC_PKG` cannot leak in.
 */
function withPackageEnv(t: TestContext, values: Partial<Record<(typeof PACKAGE_ENV_VARS)[number], string>>): void {
  withEnv(t, Object.fromEntries(PACKAGE_ENV_VARS.map((name) => [name, values[name]])));
}

test('collect appends without mutating the previous values', () => {
  const previous = ['a=1'];

  assert.deepEqual(collect('b=2', previous), ['a=1', 'b=2']);
  assert.deepEqual(previous, ['a=1']);
});

test('--css-var starts empty and collects every value without a declared default (#59)', () => {
  assert.deepEqual(collect('a=1'), ['a=1']);
  assert.deepEqual(resolveOptions(parse(['doc.md'])).cssVars, []);
  assert.deepEqual(resolveOptions(parse(['--css-var', 'a=1', '--css-var', 'b=2', 'doc.md'])).cssVars, [
    { name: '--a', value: '1' },
    { name: '--b', value: '2' },
  ]);
});

test('falls back to the bundled default stylesheet', (t) => {
  // An empty config directory, so a developer's own ~/.md2pdf/default.css
  // cannot decide the outcome of this test (#40).
  withEnv(t, { MD2PDF_CONFIG_DIR: tempDir(t) });

  const options = resolveOptions(parse(['doc.md']));

  assert.equal(
    comparablePath(options.stylesheet!),
    comparablePath(path.resolve(__dirname, '..', 'css', 'default.css')),
  );
  assert.equal(options.stylesheetOrigin, 'bundled');
});

test('keeps an existing custom stylesheet as given', (t) => {
  const dir = tempDir(t);
  const stylesheet = writeFile(dir, 'custom.css', 'body {}\n');

  assert.equal(resolveOptions(parse(['-s', stylesheet, 'doc.md'])).stylesheet, stylesheet);
  assert.equal(resolveOptions(parse(['-s', stylesheet, 'doc.md'])).stylesheetOrigin, 'option');
});

test('rejects a stylesheet that does not exist', (t) => {
  const missing = path.join(tempDir(t), 'missing.css');

  assert.throws(() => resolveOptions(parse(['-s', missing, 'doc.md'])), {
    message: `Stylesheet not found: ${missing}`,
  });
});

test('uses default.css from the config directory when no -s is given (#40)', (t) => {
  const config = tempDir(t);
  const personal = writeFile(config, 'default.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  const options = resolveOptions(parse(['doc.md']));

  assert.equal(options.stylesheet, personal);
  assert.equal(options.stylesheetOrigin, 'user-default');
});

test('-s default forces the bundled stylesheet over a personal one (#40)', (t) => {
  const config = tempDir(t);
  writeFile(config, 'default.css', 'body {}\n');
  writeFile(config, 'default', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  const options = resolveOptions(parse(['-s', 'default', 'doc.md']));

  assert.equal(
    comparablePath(options.stylesheet!),
    comparablePath(path.resolve(__dirname, '..', 'css', 'default.css')),
  );
  assert.equal(options.stylesheetOrigin, 'bundled');
});

test('-s default.css still selects the personal default (#40)', (t) => {
  const config = tempDir(t);
  const personal = writeFile(config, 'default.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  const options = resolveOptions(parse(['-s', 'default.css', 'doc.md']));

  assert.equal(options.stylesheet, personal);
  assert.equal(options.stylesheetOrigin, 'option');
});

test('a personal default.css never overrides an explicit -s (#40)', (t) => {
  const config = tempDir(t);
  writeFile(config, 'default.css', 'body {}\n');
  const custom = writeFile(config, 'custom.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  assert.equal(resolveOptions(parse(['-s', 'custom', 'doc.md'])).stylesheet, custom);
  assert.equal(resolveOptions(parse(['-s', 'custom', 'doc.md'])).stylesheetOrigin, 'option');
});

test('defaults every flag to false and the optional values to undefined', (t) => {
  withEnv(t, { MD2PDF_CONFIG_DIR: tempDir(t) });

  const options = resolveOptions(parse(['doc.md']));

  assert.deepEqual([options.tempInOutput, options.writeToc, options.keepTemp], [false, false, false]);
  assert.equal(options.toc, 'auto');
  assert.deepEqual([options.verbose, options.html, options.png, options.recursive], [false, false, false, false]);
  assert.equal(options.outputDir, undefined);
  assert.equal(options.title, undefined);
  assert.equal(options.tempRoot, undefined);
  assert.equal(options.merge, undefined);
  assert.deepEqual(options.cssVars, []);
});

test('turns every flag on when it is given', () => {
  const options = resolveOptions(
    parse(['-R', '--temp-in-output', '--toc', '-u', '--keep-temp', '-v', '--html', '--png', 'doc.md']),
  );

  assert.deepEqual([options.tempInOutput, options.writeToc, options.keepTemp], [true, true, true]);
  assert.equal(options.toc, 'always');
  assert.deepEqual([options.verbose, options.html, options.png, options.recursive], [true, true, true, true]);
});

test('the previous option names keep working as hidden aliases (#59)', () => {
  const options = resolveOptions(parse(['-R', '-p', '-f', '-u', '-k', '--verbose', '--png', 'doc.md']));

  assert.deepEqual([options.tempInOutput, options.writeToc, options.keepTemp], [true, true, true]);
  assert.equal(options.toc, 'always');
  assert.equal(resolveOptions(parse(['--force-doctoc', 'doc.md'])).toc, 'always');
  assert.equal(resolveOptions(parse(['--update-md-toc', 'doc.md'])).writeToc, true);
  assert.equal(resolveOptions(parse(['-r', 'scratch', 'doc.md'])).tempRoot, 'scratch');
});

test('--no-toc switches the automatic table of contents off (#59)', () => {
  assert.equal(resolveOptions(parse(['--no-toc', 'doc.md'])).toc, 'never');
});

test('--debug implies --html, --keep-temp and --verbose (#59)', () => {
  const options = resolveOptions(parse(['--debug', 'doc.md']));

  assert.deepEqual([options.html, options.keepTemp, options.verbose], [true, true, true]);
});

test('--title overrides the derived document title (#59)', () => {
  assert.equal(resolveOptions(parse(['--title', 'My Report', 'doc.md'])).title, 'My Report');
});

test('passes the directory options through unchanged', () => {
  const options = resolveOptions(parse(['-o', 'out', '-r', 'scratch', 'doc.md']));

  assert.equal(options.outputDir, 'out');
  assert.equal(options.tempRoot, 'scratch');
});

test('parses repeated --css-var values in order', () => {
  const options = resolveOptions(parse(['--css-var', 'font-text=Aptos', '--css-var', '--page-size=A5', 'doc.md']));

  assert.deepEqual(options.cssVars, [
    { name: '--font-text', value: 'Aptos' },
    { name: '--page-size', value: 'A5' },
  ]);
});

test('validates the option values while resolving', () => {
  assert.throws(() => resolveOptions(parse(['--css-var', 'no-separator', 'doc.md'])), /Expected name=value/);
  assert.throws(() => resolveOptions(parse(['--merge', 'out/report', 'doc.md'])), /without path separators/);
});

test('normalises the --merge name', () => {
  assert.equal(resolveOptions(parse(['--merge', 'report.pdf', 'doc.md'])).merge, 'report');
});

test('runs every tool from the installed dependency without overrides (#56)', (t) => {
  withPackageEnv(t, {});

  assert.deepEqual(resolveOptions(parse(['doc.md'])).packageOverrides, {});
});

test('takes npx package selectors from the environment', (t) => {
  withPackageEnv(t, {
    DOCTOC_PKG: 'doctoc@latest',
    MERMAID_CLI_PKG: '@mermaid-js/mermaid-cli@10.0.0',
    MD_TO_PDF_PKG: 'md-to-pdf@5.0.0',
  });

  assert.deepEqual(resolveOptions(parse(['doc.md'])).packageOverrides, {
    doctoc: 'doctoc@latest',
    mermaidCli: '@mermaid-js/mermaid-cli@10.0.0',
    mdToPdf: 'md-to-pdf@5.0.0',
  });
});

test('treats an empty package variable as unset', (t) => {
  withPackageEnv(t, { DOCTOC_PKG: '' });

  assert.deepEqual(resolveOptions(parse(['doc.md'])).packageOverrides, {});
});

test('reads MD2PDF_NO_SANDBOX into sandboxOff (#95)', (t) => {
  withEnv(t, { MD2PDF_NO_SANDBOX: '1' });

  assert.equal(resolveOptions(parse(['doc.md'])).sandboxOff, 'env');
});

test('resolves a relative stylesheet against the working directory (#34)', () => {
  const stylesheet = writeFile(process.cwd(), 'local.css', 'body {}\n');

  assert.equal(
    comparablePath(resolveOptions(parse(['-s', 'local.css', 'doc.md'])).stylesheet!),
    comparablePath(stylesheet),
  );
});

test('falls back to a named stylesheet in the config directory, with or without .css (#34)', (t) => {
  const config = tempDir(t);
  const custom = writeFile(config, 'custom.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  assert.equal(resolveOptions(parse(['-s', 'custom.css', 'doc.md'])).stylesheet, custom);
  assert.equal(resolveOptions(parse(['-s', 'custom', 'doc.md'])).stylesheet, custom);
});

test('prefers the working directory over the config directory (#34)', (t) => {
  const config = tempDir(t);
  const local = writeFile(process.cwd(), 'local.css', 'body {}\n');
  writeFile(config, 'local.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  assert.equal(resolveOptions(parse(['-s', 'local.css', 'doc.md'])).stylesheet, local);
});

test('skips a directory that carries the stylesheet name (#34)', (t) => {
  const config = tempDir(t);
  writeFile(process.cwd(), 'custom.css/keep', '');
  const custom = writeFile(config, 'custom.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  assert.equal(resolveOptions(parse(['-s', 'custom.css', 'doc.md'])).stylesheet, custom);
});

test('lists every tried location for an unknown stylesheet name (#34)', (t) => {
  const config = tempDir(t);
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  assert.throws(() => resolveOptions(parse(['-s', 'missing', 'doc.md'])), {
    message: [
      'Stylesheet not found: missing',
      'Tried:',
      `  - ${path.join(process.cwd(), 'missing')}`,
      `  - ${path.join(config, 'missing')}`,
      `  - ${path.join(config, 'missing.css')}`,
    ].join('\n'),
  });
});

test('rejects --temp-in-output together with --temp-root in either order, form and name (#60)', () => {
  const conflict = /cannot be used with option/;

  assert.throws(() => parse(['--temp-in-output', '--temp-root', 'scratch', 'doc.md']), conflict);
  assert.throws(() => parse(['--temp-root', 'scratch', '--temp-in-output', 'doc.md']), conflict);
  assert.throws(() => parse(['--temp-in-output', '--temp-root=scratch', 'doc.md']), conflict);
  // The short flags are the previous names of the same two options (#59), so
  // they have to conflict in every combination as well.
  assert.throws(() => parse(['-p', '-r', 'scratch', 'doc.md']), conflict);
  assert.throws(() => parse(['-r', 'scratch', '-p', 'doc.md']), conflict);
  assert.throws(() => parse(['-p', '--temp-root', 'scratch', 'doc.md']), conflict);
  assert.throws(() => parse(['--temp-in-output', '-r', 'scratch', 'doc.md']), conflict);
});

test('rejects -u together with --merge before any work starts (#60)', () => {
  const combined = /-u cannot be combined with --merge/;

  assert.throws(() => resolveOptions(parse(['-u', '--merge', 'handbook', 'a.md', 'b.md'])), combined);
  assert.throws(() => resolveOptions(parse(['--merge=handbook', '--update-md-toc', 'a.md'])), combined);
});

test('rejects -u together with --no-toc before any work starts (#103)', () => {
  const combined = /-u cannot be combined with --no-toc/;

  assert.throws(() => resolveOptions(parse(['-u', '--no-toc', 'doc.md'])), combined);
  assert.throws(() => resolveOptions(parse(['--no-toc', '--write-toc', 'doc.md'])), combined);
  assert.throws(() => resolveOptions(parse(['--update-md-toc', '--no-toc', 'doc.md'])), combined);
  assert.equal(resolveOptions(parse(['-u', '--toc', 'doc.md'])).toc, 'always');
  assert.equal(resolveOptions(parse(['--no-toc', 'doc.md'])).toc, 'never');
});

test('rejects an empty -s value instead of falling back to the default (#55)', (t) => {
  const config = tempDir(t);
  writeFile(config, 'default.css', 'body {}\n');
  withEnv(t, { MD2PDF_CONFIG_DIR: config });

  assert.throws(() => resolveOptions(parse(['-s', '', 'doc.md'])), /Empty -s\/--stylesheet value/);
  assert.throws(() => resolveOptions(parse(['-s', '   ', 'doc.md'])), /Empty -s\/--stylesheet value/);
});
