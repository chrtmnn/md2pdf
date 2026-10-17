/**
 * Packs the already built package without running lifecycle scripts and
 * checks that the tarball carries exactly what a user installs (#56): the
 * compiled CLI with its stylesheet and Chromium configs, the README, the
 * license and package.json — nothing else.
 *
 * Usage: node scripts/pack-check.mjs [destination-dir]
 *
 * Prints the tarball path as the last line. Under GitHub Actions it is also
 * written to the step output `tarball`.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_FILES = new Set(['package.json', 'README.md', 'LICENSE']);
const REQUIRED = [
  ...ROOT_FILES,
  'dist/md2pdf.js',
  'dist/css/default.css',
  'dist/config/md-to-pdf.config.json',
  'dist/config/md-to-pdf.no-sandbox.config.json',
  'dist/config/puppeteer.no-sandbox.config.json',
];

const destination = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-pack-')));
fs.mkdirSync(destination, { recursive: true });

// Through a shell, because npm is a batch file on Windows.
const output = execSync(`npm pack --json --ignore-scripts --pack-destination "${destination}"`, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const [result] = JSON.parse(output);
const files = result.files.map((file) => file.path.replaceAll('\\', '/'));

const problems = [
  ...REQUIRED.filter((file) => !files.includes(file)).map((file) => `missing: ${file}`),
  ...files
    .filter((file) => !ROOT_FILES.has(file) && !(file.startsWith('dist/') && !file.startsWith('dist/test/')))
    .map((file) => `unexpected: ${file}`),
];

const entry = new URL('../dist/md2pdf.js', import.meta.url);
if (fs.existsSync(entry) && !fs.readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n')) {
  problems.push('dist/md2pdf.js does not start with an LF-terminated "#!/usr/bin/env node" line');
}

if (problems.length > 0) {
  console.error(`The package contents are wrong:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  process.exit(1);
}

const tarball = path.join(destination, result.filename);
console.log(`${files.length} files, ${result.size} bytes packed, ${result.unpackedSize} bytes unpacked`);
console.log(tarball);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
}
