/**
 * Installs a packed md2pdf tarball into a throwaway global prefix and runs the
 * installed command from a directory outside the repository (#56). This is
 * the one check that spawns the real conversion tools — the unit tests never
 * do — and the one that notices a file missing from the tarball.
 *
 * Checked: `--version` and `--help`; a conversion with the bundled stylesheet;
 * a conversion with `-s <name>` from the config directory; doctoc filling
 * md2pdf's own marker block (first conversion) and a doctoc marker block
 * (second conversion); an image referenced by a relative path; the PDF itself.
 * `--mermaid` adds a diagram, which CI leaves out because mermaid-cli's
 * Chromium is the flakiest part on hosted runners. `--keep` keeps the
 * temporary directory, which is also kept after a failure.
 *
 * Usage: node scripts/package-smoke.mjs <tarball> [--mermaid] [--keep]
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PACKAGE_NAME = '@chrtmnn/md2pdf';
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SMOKE_COLOR = '#0a7e8c';

const options = process.argv.slice(2);
const withMermaid = options.includes('--mermaid');
const keep = options.includes('--keep');
const tarballArgument = options.find((option) => !option.startsWith('--'));

if (!tarballArgument) {
  console.error('Usage: node scripts/package-smoke.mjs <tarball> [--mermaid] [--keep]');
  process.exit(2);
}

const tarball = path.resolve(tarballArgument);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-smoke-')));
const prefix = path.join(root, 'prefix');
const work = path.join(root, 'work');
const config = path.join(root, 'config');

/**
 * Runs a command line through the shell: npm and the installed md2pdf are
 * batch files on Windows, which Node only starts through one. Every argument
 * is a flag or a path this script chose, so quoting each one is enough. A bare
 * command name stays unquoted: cmd.exe resolves `%~dp0` of a batch file called
 * as `"npm"` to the working directory, and npm.cmd then looks for its
 * `npm-cli.js` there.
 */
function run(command, args, { cwd = root, env = process.env, capture = false } = {}) {
  const executable = /[\\/]/.test(command) ? `"${command}"` : command;
  const line = [executable, ...args.map((part) => `"${part}"`)].join(' ');
  console.log(`> ${line}`);
  return execSync(line, { cwd, env, encoding: 'utf8', stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
}

/** md2pdf's own marker block (#83). */
const OWN_MARKERS = ['<!-- toc START -->', '<!-- toc END -->'];

/** doctoc's marker block. */
const DOCTOC_MARKERS = [
  '<!-- START doctoc generated TOC please keep comment here to allow auto update -->',
  '<!-- END doctoc generated TOC please keep comment here to allow auto update -->',
];

function writeGuide(markers) {
  const guide = [
    '# Smoke Test',
    '',
    ...markers,
    '',
    '## First section',
    '',
    '![pixel](images/pixel.png)',
    '',
    '## Second section',
    '',
    ...(withMermaid ? ['```mermaid', 'flowchart LR', '  A --> B', '```', ''] : []),
  ].join('\n');

  fs.writeFileSync(path.join(work, 'docs', 'guide.md'), guide);
}

function writeFixture() {
  fs.mkdirSync(path.join(work, 'docs', 'images'), { recursive: true });
  fs.writeFileSync(path.join(work, 'docs', 'images', 'pixel.png'), Buffer.from(PIXEL_PNG, 'base64'));
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'smoke.css'), `body { color: ${SMOKE_COLOR}; }\n`);
}

/**
 * Converts the fixture from the work directory with relative paths only, and
 * returns the HTML written next to the PDF.
 */
function convert(md2pdf, outputDir, extraArgs) {
  const env = { ...process.env, MD2PDF_CONFIG_DIR: config };
  for (const name of ['DOCTOC_PKG', 'MERMAID_CLI_PKG', 'MD_TO_PDF_PKG']) {
    delete env[name];
  }

  run(md2pdf, [...extraArgs, '--html', '-o', outputDir, path.join('docs', 'guide.md')], { cwd: work, env });

  const pdf = fs.readFileSync(path.join(work, outputDir, 'guide.pdf'));
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', `${outputDir}/guide.pdf is a PDF`);

  const html = fs.readFileSync(path.join(work, outputDir, 'guide.html'), 'utf8');
  assert.match(html, /href="#first-section"/, 'doctoc filled in the table of contents');
  assert.match(html, /data:image\/png;base64,/, 'the relative image was embedded');
  if (withMermaid) {
    assert.match(html, /<img[^>]+\.svg"/, 'the Mermaid diagram was rendered');
  }

  return html;
}

let passed = false;

try {
  run('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball]);

  const windows = process.platform === 'win32';
  const md2pdf = windows ? path.join(prefix, 'md2pdf.cmd') : path.join(prefix, 'bin', 'md2pdf');
  const packageDir = windows
    ? path.join(prefix, 'node_modules', PACKAGE_NAME)
    : path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME);
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

  assert.equal(run(md2pdf, ['--version'], { capture: true }).trim(), version, '--version prints the installed version');
  assert.match(run(md2pdf, ['--help'], { capture: true }), /Usage: md2pdf/, '--help prints the usage');

  writeFixture();

  writeGuide(OWN_MARKERS);
  const bundled = convert(md2pdf, 'out-bundled', []);
  assert.match(bundled, /--document-break-before/, 'the bundled default.css was applied');

  writeGuide(DOCTOC_MARKERS);
  const named = convert(md2pdf, 'out-named', ['-s', 'smoke']);
  assert.ok(named.includes(SMOKE_COLOR), 'the -s name was found in the config directory');
  assert.doesNotMatch(named, /--document-break-before/, 'the named stylesheet replaced the bundled one');

  passed = true;
  console.log(`Package smoke test passed for ${PACKAGE_NAME}@${version}${withMermaid ? ', Mermaid included' : ''}`);
} finally {
  if (keep || !passed) {
    console.log(`Kept ${root}`);
  } else {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
