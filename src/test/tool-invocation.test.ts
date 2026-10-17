/**
 * How the conversion tools are started without a shell, and how a failed run
 * is reported.
 *
 * The platform, the filesystem and the search paths are passed in, so the
 * Windows npx lookup and the installed-package lookup run on every platform
 * without touching the real Node installation. One test resolves the real
 * dependencies of this checkout, because that is where a package's `exports`
 * map gets in the way (#56).
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  binEntry,
  formatExecError,
  InterruptedError,
  interruptSignal,
  locateInstalledBin,
  locateNpxInvocation,
  readPackageOverrides,
  resolveToolInvocation,
  TOOL_PACKAGES,
  ToolEnvironment,
} from '../steps/tool-invocation';
import { ToolName } from '../types';

const execPath = path.join(path.sep, 'nodejs', 'node.exe');
const besideNode = path.join(path.sep, 'nodejs', 'node_modules', 'npm', 'bin', 'npx-cli.js');
const libLayout = path.join(path.sep, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
const nearModules = path.join(path.sep, 'app', 'node_modules');
const farModules = path.join(path.sep, 'node_modules');

/** A read-only filesystem holding exactly the given files. */
function files(entries: Record<string, string>): (file: string) => string | undefined {
  return (file) => entries[file];
}

function environment(entries: Record<string, string>, overrides: Partial<ToolEnvironment> = {}): ToolEnvironment {
  return {
    platform: 'linux',
    execPath,
    exists: () => false,
    searchPaths: () => [nearModules, farModules],
    readFile: files(entries),
    ...overrides,
  };
}

test('locateNpxInvocation spawns npx by name outside Windows', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const invocation = locateNpxInvocation(platform, execPath, () => {
      throw new Error('the filesystem must not be consulted');
    });

    assert.deepEqual(invocation, { file: 'npx', leadingArgs: [] });
  }
});

test('locateNpxInvocation runs npx-cli.js next to node.exe with the current Node binary on Windows', () => {
  const invocation = locateNpxInvocation('win32', execPath, (candidate) => candidate === besideNode);

  assert.deepEqual(invocation, { file: execPath, leadingArgs: [besideNode] });
});

test('locateNpxInvocation falls back to the ../lib/node_modules layout', () => {
  const invocation = locateNpxInvocation('win32', execPath, (candidate) => candidate === libLayout);

  assert.deepEqual(invocation, { file: execPath, leadingArgs: [libLayout] });
});

test('locateNpxInvocation prefers the copy next to node.exe when both layouts exist', () => {
  const invocation = locateNpxInvocation('win32', execPath, () => true);

  assert.deepEqual(invocation.leadingArgs, [besideNode]);
});

test('locateNpxInvocation names the Node binary and every candidate when npx-cli.js is missing', () => {
  assert.throws(
    () => locateNpxInvocation('win32', execPath, () => false),
    (error: Error) => {
      assert.match(error.message, /Could not locate npm's npx-cli\.js/);
      assert.ok(error.message.includes(execPath), 'names the Node binary');
      assert.ok(error.message.includes(besideNode), 'names the first candidate');
      assert.ok(error.message.includes(libLayout), 'names the second candidate');
      return true;
    },
  );
});

test('binEntry picks the named command from a bin map', () => {
  assert.equal(binEntry({ bin: { 'md-to-pdf': 'dist/cli.js', md2pdf: 'dist/cli.js' } }, 'md-to-pdf', 'md-to-pdf'), 'dist/cli.js');
  assert.equal(binEntry({ bin: { mmdc: './src/cli.js' } }, '@mermaid-js/mermaid-cli', 'mmdc'), './src/cli.js');
});

test('binEntry gives a bin string to the command named after the unscoped package', () => {
  assert.equal(binEntry({ bin: 'doctoc.js' }, 'doctoc', 'doctoc'), 'doctoc.js');
  assert.equal(binEntry({ bin: 'cli.js' }, '@scope/tool', 'tool'), 'cli.js');
  assert.equal(binEntry({ bin: 'cli.js' }, '@scope/tool', 'other'), undefined);
});

test('binEntry returns undefined for a manifest without a usable bin', () => {
  for (const manifest of [undefined, null, 'text', {}, { bin: 42 }, { bin: { other: 'x.js' } }, { bin: { mmdc: 7 } }]) {
    assert.equal(binEntry(manifest, '@mermaid-js/mermaid-cli', 'mmdc'), undefined);
  }
});

test('locateInstalledBin resolves the bin script against the package directory', () => {
  const manifest = path.join(nearModules, '@mermaid-js', 'mermaid-cli', 'package.json');

  const bin = locateInstalledBin(
    'mermaidCli',
    [nearModules, farModules],
    files({ [manifest]: JSON.stringify({ bin: { mmdc: './src/cli.js' } }) }),
  );

  assert.equal(bin, path.resolve(nearModules, '@mermaid-js', 'mermaid-cli', 'src', 'cli.js'));
});

test('locateInstalledBin skips directories without the package', () => {
  const far = path.join(farModules, 'md-to-pdf', 'package.json');

  const bin = locateInstalledBin('mdToPdf', [nearModules, farModules], files({ [far]: '{"bin":{"md-to-pdf":"dist/cli.js"}}' }));

  assert.equal(bin, path.resolve(farModules, 'md-to-pdf', 'dist', 'cli.js'));
});

test('locateInstalledBin takes the nearest package, like Node itself', () => {
  const near = path.join(nearModules, 'doctoc', 'package.json');
  const far = path.join(farModules, 'doctoc', 'package.json');

  const bin = locateInstalledBin('doctoc', [nearModules, farModules], files({ [near]: '{"bin":"near.js"}', [far]: '{"bin":"far.js"}' }));

  assert.equal(bin, path.resolve(nearModules, 'doctoc', 'near.js'));
});

test('locateInstalledBin fails on the nearest package when it lacks the command', () => {
  const near = path.join(nearModules, 'doctoc', 'package.json');
  const far = path.join(farModules, 'doctoc', 'package.json');

  for (const broken of ['{"name":"doctoc"}', 'not json']) {
    assert.throws(
      () => locateInstalledBin('doctoc', [nearModules, farModules], files({ [near]: broken, [far]: '{"bin":"far.js"}' })),
      (error: Error) => {
        assert.ok(error.message.includes(near), 'names the manifest');
        assert.match(error.message, /no "doctoc" command/);
        assert.match(error.message, /DOCTOC_PKG/);
        return true;
      },
    );
  }
});

test('locateInstalledBin names every manifest it tried and the override variable', () => {
  assert.throws(
    () => locateInstalledBin('doctoc', [nearModules, farModules], files({})),
    (error: Error) => {
      assert.match(error.message, /Could not find the installed doctoc package/);
      assert.match(error.message, /DOCTOC_PKG/);
      assert.ok(error.message.includes(path.join(nearModules, 'doctoc', 'package.json')), 'names the near manifest');
      assert.ok(error.message.includes(path.join(farModules, 'doctoc', 'package.json')), 'names the far manifest');
      return true;
    },
  );
});

test('locateInstalledBin finds every tool among the dependencies of this checkout (#56)', () => {
  const readFile = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

  for (const [tool, { packageName }] of Object.entries(TOOL_PACKAGES)) {
    const bin = locateInstalledBin(tool as ToolName, require.resolve.paths(packageName) ?? [], readFile);

    assert.ok(fs.statSync(bin).isFile(), `${packageName} resolves to an existing script: ${bin}`);
  }
});

test('resolveToolInvocation runs the installed bin script with the current Node binary', () => {
  const manifest = path.join(nearModules, 'md-to-pdf', 'package.json');

  const invocation = resolveToolInvocation(
    'mdToPdf',
    undefined,
    environment({ [manifest]: '{"bin":{"md-to-pdf":"dist/cli.js"}}' }),
  );

  assert.deepEqual(invocation, {
    file: execPath,
    leadingArgs: [path.resolve(nearModules, 'md-to-pdf', 'dist', 'cli.js')],
    label: 'md-to-pdf',
  });
});

test('resolveToolInvocation goes through npx for a package override, without looking for the installed package', () => {
  const noLookup = {
    searchPaths: () => {
      throw new Error('the installed package must not be looked up');
    },
  };

  assert.deepEqual(resolveToolInvocation('doctoc', 'doctoc@latest', environment({}, noLookup)), {
    file: 'npx',
    leadingArgs: ['doctoc@latest'],
    label: 'npx doctoc@latest',
  });

  const windows = environment({}, { ...noLookup, platform: 'win32', exists: (candidate) => candidate === besideNode });
  assert.deepEqual(resolveToolInvocation('doctoc', 'doctoc@latest', windows), {
    file: execPath,
    leadingArgs: [besideNode, 'doctoc@latest'],
    label: 'npx doctoc@latest',
  });
});

test('readPackageOverrides keeps the non-empty package variables only', () => {
  assert.deepEqual(readPackageOverrides({}), {});
  assert.deepEqual(
    readPackageOverrides({ DOCTOC_PKG: 'doctoc@latest', MERMAID_CLI_PKG: '', MD_TO_PDF_PKG: 'md-to-pdf@5.0.0', OTHER: 'x' }),
    { doctoc: 'doctoc@latest', mdToPdf: 'md-to-pdf@5.0.0' },
  );
});

test('formatExecError reports the tool output, stderr before stdout', () => {
  assert.equal(formatExecError({ stderr: 'boom\n', stdout: '' }, 'doctoc'), 'boom');
  assert.equal(formatExecError({ stdout: 'only stdout\n' }, 'doctoc'), 'only stdout');
  assert.equal(formatExecError({ stderr: 'err', stdout: 'out' }, 'doctoc'), 'err\nout');
});

test('formatExecError reads Buffer output as well as strings', () => {
  const error = { stderr: Buffer.from('from a buffer\n'), stdout: Buffer.alloc(0) };

  assert.equal(formatExecError(error, 'md-to-pdf'), 'from a buffer');
});

test('formatExecError names the tool when it printed nothing', () => {
  assert.equal(formatExecError({ stderr: '', stdout: '' }, 'md-to-pdf'), 'md-to-pdf failed');
  assert.equal(formatExecError({ stderr: '  \n', stdout: '\n' }, 'npx md-to-pdf@5.2.5'), 'npx md-to-pdf@5.2.5 failed');
});

test('formatExecError falls back to the message of an error without tool output', () => {
  assert.equal(formatExecError(new Error('spawn EINVAL'), 'doctoc'), 'spawn EINVAL');
  assert.equal(formatExecError('plain string', 'doctoc'), 'plain string');
  assert.equal(formatExecError(null, 'doctoc'), 'null');
});

test('interruptSignal recognises a tool stopped by Ctrl-C or SIGTERM (#98)', () => {
  assert.equal(interruptSignal({ signal: 'SIGINT', status: null }), 'SIGINT');
  assert.equal(interruptSignal({ signal: 'SIGTERM', status: null }), 'SIGTERM');
  assert.equal(interruptSignal({ signal: null, status: 130 }), 'SIGINT', 'Puppeteer exits with 130 on SIGINT');
  assert.equal(interruptSignal({ signal: null, status: 143 }), 'SIGTERM');
  assert.equal(interruptSignal({ signal: null, status: 0xc000013a }), 'SIGINT', 'STATUS_CONTROL_C_EXIT on Windows');
  assert.equal(interruptSignal({ signal: null, status: -0x3ffffec6 }), 'SIGINT', 'the same status, signed');
});

test('interruptSignal leaves ordinary failures and md2pdf\'s own timeout alone (#98)', () => {
  assert.equal(interruptSignal({ signal: null, status: 1, stderr: 'boom' }), undefined);
  assert.equal(interruptSignal({ signal: 'SIGKILL', status: null }), undefined);
  assert.equal(interruptSignal({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }), undefined, 'a timeout is not the user');
  assert.equal(interruptSignal(new Error('spawn EINVAL')), undefined);
  assert.equal(interruptSignal(null), undefined);
  assert.equal(interruptSignal('SIGINT'), undefined);
});

test('InterruptedError carries the shell exit code of its signal (#98)', () => {
  assert.equal(new InterruptedError('SIGINT').exitCode, 130);
  assert.equal(new InterruptedError('SIGTERM').exitCode, 143);
  assert.ok(new InterruptedError('SIGINT') instanceof Error);
});
