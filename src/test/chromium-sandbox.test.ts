/**
 * When Chromium runs without its sandbox, and what the two Chromium-starting
 * tools are given for it (#95).
 */

import fs from 'fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSandboxOff, resolveSandboxOff } from '../steps/chromium-sandbox';
import { MD_TO_PDF_CONFIG, MD_TO_PDF_NO_SANDBOX_CONFIG } from '../steps/md-to-pdf-args';
import { PUPPETEER_NO_SANDBOX_CONFIG } from '../steps/render-mermaid';

/**
 * Reads one of the bundled JSON configs.
 *
 * @param file - Absolute path of the config.
 */
function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('the sandbox stays on for a normal user and where there is no user id', () => {
  assert.equal(resolveSandboxOff({}, 1000), undefined);
  assert.equal(resolveSandboxOff({}, undefined), undefined, 'Windows has no getuid');
});

test('the sandbox is off as root', () => {
  assert.equal(resolveSandboxOff({}, 0), 'root');
  assert.equal(resolveSandboxOff({ MD2PDF_NO_SANDBOX: '' }, 0), 'root');
  assert.equal(resolveSandboxOff({ MD2PDF_NO_SANDBOX: '0' }, 0), 'root', '0 leaves the decision to the user id');
});

test('MD2PDF_NO_SANDBOX=1 switches the sandbox off for any user', () => {
  assert.equal(resolveSandboxOff({ MD2PDF_NO_SANDBOX: '1' }, 1000), 'env');
  assert.equal(resolveSandboxOff({ MD2PDF_NO_SANDBOX: ' 1 ' }, undefined), 'env');
  assert.equal(resolveSandboxOff({ MD2PDF_NO_SANDBOX: '0' }, 1000), undefined);
});

test('an unknown MD2PDF_NO_SANDBOX value is an error', () => {
  assert.throws(() => resolveSandboxOff({ MD2PDF_NO_SANDBOX: 'yes' }, 1000), /Invalid MD2PDF_NO_SANDBOX: yes/);
  assert.throws(() => resolveSandboxOff({ MD2PDF_NO_SANDBOX: 'true' }, 0), /Invalid MD2PDF_NO_SANDBOX/);
});

test('describeSandboxOff names the reason', () => {
  assert.match(describeSandboxOff('root'), /without its sandbox \(running as root\)/);
  assert.match(describeSandboxOff('env'), /MD2PDF_NO_SANDBOX=1/);
});

test('the no-sandbox md-to-pdf config is the base config plus launch_options', () => {
  const base = readJson(MD_TO_PDF_CONFIG) as Record<string, unknown>;

  assert.deepEqual(readJson(MD_TO_PDF_NO_SANDBOX_CONFIG), {
    ...base,
    launch_options: { args: ['--no-sandbox'] },
  });
});

test('the Puppeteer config for mermaid-cli passes --no-sandbox', () => {
  assert.deepEqual(readJson(PUPPETEER_NO_SANDBOX_CONFIG), { args: ['--no-sandbox'] });
});
