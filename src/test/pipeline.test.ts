/**
 * Behaviour of the conversion run itself (#71).
 *
 * `runPipeline` is driven here with a recording reporter, a temp-directory
 * registry the test owns, and a fake tool runner that writes what doctoc,
 * mermaid-cli and md-to-pdf would have written. Every other step — the work
 * directory, the merge, the stylesheet, the asset embedding, the output swap —
 * runs for real, so this covers the orchestration that used to be reachable
 * only by starting the CLI: which steps run for which options, what a failing
 * file does to the rest of the run, which temp directories survive it, and
 * which summary and exit code come out.
 *
 * Nothing here spawns a process or needs the network; `pnpm pack:smoke` stays
 * the place where the real tools run.
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../pipeline';
import { createTempRegistry } from '../steps/temp-registry';
import { ConverterOptions } from '../types';
import {
  createFakeTools,
  createRecordingReporter,
  ReportedLine,
  FakeToolBehaviour,
  FAKE_PDF_CONTENT,
  FakeTools,
  makeOptions,
  RecordingReporter,
  removeAfter,
  tempDir,
  writeFile,
  writePng,
} from './helpers';

/** What a fixture run reports back. */
type PipelineRun = {
  /** The exit code the run returned, or `-1` when it threw instead. */
  code: number;
  /** What a run-level step threw, which the CLI turns into a message and exit 1. */
  thrown: unknown;
  /** Everything it printed. */
  reporter: RecordingReporter;
  /** Every tool it started. */
  tools: FakeTools;
  /** Every temp directory it registered, in order. */
  registered: string[];
  /** The directories still registered when it returned. */
  live: string[];
};

/**
 * Runs the pipeline over a fixture.
 *
 * Every directory the run registers is also handed to `removeAfter`, so even a
 * `--keep-temp` run leaves nothing behind in the OS temp directory: the CSS
 * temp directory always lands there, whatever `-r`/`-p` say.
 *
 * @param t - Active test context.
 * @param args - Positional arguments, as the CLI would pass them.
 * @param overrides - Converter options on top of {@link makeOptions}.
 * @param behaviour - Per-tool replacements for the fake runner's defaults.
 * @param interactive - What the run should see as `reporter.interactive`.
 * @returns The exit code and everything the run touched.
 */
function runFixture(
  t: TestContext,
  args: string[],
  overrides: Partial<ConverterOptions> = {},
  behaviour: FakeToolBehaviour = {},
  interactive = false,
): PipelineRun {
  const recorder = createRecordingReporter(interactive);
  const tools = createFakeTools(behaviour);
  const registered: string[] = [];
  const registry = createTempRegistry(
    (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    overrides.keepTemp ?? false,
  );

  const tempDirs = {
    ...registry,
    register: (directory: string) => {
      registered.push(directory);
      removeAfter(t, directory);
      registry.register(directory);
    },
  };

  let code = -1;
  let thrown: unknown;
  try {
    code = runPipeline(args, makeOptions(overrides), { reporter: recorder.reporter, tempDirs, run: tools.run });
  } catch (error) {
    // A failing run-level step aborts the whole run; `md2pdf.ts` catches it,
    // prints the message and exits 1.
    thrown = error;
  }

  return { code, thrown, reporter: recorder, tools, registered, live: registry.live() };
}

/**
 * Position of the first recorded line of a kind containing `needle`, for the
 * assertions that care about order rather than presence.
 *
 * @param run - A finished fixture run.
 * @param kind - Which reporter method to look for.
 * @param needle - Substring the line must contain.
 * @returns The index in `reporter.lines`, or `-1`.
 */
function indexOf(run: PipelineRun, kind: ReportedLine['kind'], needle: string): number {
  return run.reporter.lines.findIndex((line) => line.kind === kind && line.text.includes(needle));
}

/** A stylesheet that reads one variable, for the `--css-var` checks. */
function writeStylesheet(dir: string): string {
  return writeFile(dir, 'sheet.css', ':root { --ink: black; }\nbody { color: var(--ink); }\n');
}

test('converts a file, writes the PDF and reports one success', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n\nText.\n');

  const run = runFixture(t, [file], { tempRoot: path.join(dir, 'temp') });

  assert.equal(run.code, 0);
  assert.equal(run.reporter.outro(), '1 converted');
  assert.equal(fs.readFileSync(path.join(dir, 'doc.pdf'), 'utf8'), FAKE_PDF_CONTENT);
  assert.equal(run.tools.callsTo('mdToPdf').length, 1, 'the PDF render is the only md-to-pdf run');
  assert.equal(run.tools.callsTo('doctoc').length, 0, 'a file without markers gets no TOC');
  assert.equal(run.tools.callsTo('mermaidCli').length, 0, 'a file without fences gets a plain copy');
  assert.ok(run.reporter.has('success', 'Created '), 'the file ends with its output path');
});

test('the document title comes from the first heading', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Real Heading\n\nText.\n');

  const run = runFixture(t, [file], { tempRoot: path.join(dir, 'temp') });

  assert.deepEqual(
    run.tools.callsTo('mdToPdf')[0].args.filter((arg) => arg.startsWith('--document-title=')),
    ['--document-title=Real Heading'],
  );
});

test('--title beats the first heading (#59)', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Real Heading\n\nText.\n');

  const run = runFixture(t, [file], { tempRoot: path.join(dir, 'temp'), title: 'From the flag' });

  assert.ok(
    run.tools.callsTo('mdToPdf')[0].args.includes('--document-title=From the flag'),
    'the explicit title reaches md-to-pdf',
  );
  assert.equal(
    run.reporter.of('status').some((line) => line.includes('Extracting document title')),
    false,
    'the title step is skipped entirely',
  );
});

test('aborts before anything is written when two inputs share an output path (#45)', (t) => {
  const dir = tempDir(t);
  const first = writeFile(dir, 'a/doc.md', '# A\n');
  const second = writeFile(dir, 'b/doc.md', '# B\n');
  const out = path.join(dir, 'out');

  const run = runFixture(t, [first, second], { outputDir: out, tempRoot: path.join(dir, 'temp') });

  assert.equal(run.code, 1);
  assert.equal(run.reporter.outro(), 'Conversion aborted');
  assert.equal(run.tools.calls.length, 0, 'no tool ran');
  assert.equal(run.registered.length, 0, 'not even a temp directory was created');
  assert.equal(fs.existsSync(out), false, 'the output directory was never created');
  assert.ok(run.reporter.has('error', 'doc.pdf'), 'the message names the contested output');
});

test('refuses a merge that resolved no input, before any temp directory exists', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'empty'));

  const run = runFixture(t, [path.join(dir, 'empty')], { merge: 'book', tempRoot: path.join(dir, 'temp') });

  assert.equal(run.code, 1);
  assert.equal(run.reporter.outro(), 'Merge failed');
  assert.ok(run.reporter.has('error', 'Nothing to merge'));
  assert.equal(run.registered.length, 0, 'the early exit cannot leak a temp directory');
});

test('a failing step fails only its file and the run carries on (#51)', (t) => {
  const dir = tempDir(t);
  const first = writeFile(dir, 'a.md', '# A\n');
  const second = writeFile(dir, 'b.md', '# B\n');

  const run = runFixture(
    t,
    [first, second],
    { tempRoot: path.join(dir, 'temp') },
    {
      mdToPdf: (args) => {
        if (path.basename(args[0]).startsWith('a')) {
          throw new Error('md-to-pdf exploded');
        }
        fs.writeFileSync(args[0].replace(/\.md$/, '.pdf'), FAKE_PDF_CONTENT, 'utf8');
      },
    },
  );

  assert.equal(run.code, 1);
  assert.equal(run.reporter.outro(), '1 converted, 1 failed');
  assert.ok(run.reporter.has('error', 'md-to-pdf exploded'), 'the tool error reaches the user');
  assert.equal(fs.existsSync(path.join(dir, 'a.pdf')), false, 'the failed file wrote nothing');
  assert.equal(fs.existsSync(path.join(dir, 'b.pdf')), true, 'the next file still converted');
  assert.deepEqual(run.live, [], 'every temp directory was unregistered');
  run.registered.forEach((directory) => {
    assert.equal(fs.existsSync(directory), false, `${directory} was removed`);
  });
});

test('names the failing step on its own line when there is no live line to end', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');

  const piped = runFixture(
    t,
    [file],
    { tempRoot: path.join(dir, 'temp') },
    {
      mdToPdf: () => {
        throw new Error('nope');
      },
    },
  );
  const terminal = runFixture(
    t,
    [file],
    { tempRoot: path.join(dir, 'temp') },
    {
      mdToPdf: () => {
        throw new Error('nope');
      },
    },
    true,
  );

  assert.ok(piped.reporter.has('error', 'doc.md · Rendering PDF failed'));
  assert.equal(
    terminal.reporter.has('error', 'Rendering PDF failed'),
    false,
    'on a terminal the live line already carries the step',
  );
  assert.ok(terminal.reporter.has('error', 'nope'), 'the failure itself is still reported');
});

test('removes the work and stylesheet directories after a successful run', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');

  const run = runFixture(t, [file], {
    tempRoot: path.join(dir, 'temp'),
    stylesheet: writeStylesheet(dir),
    stylesheetOrigin: 'option',
    cssVars: [{ name: '--ink', value: 'red' }],
  });

  assert.equal(run.code, 0);
  assert.equal(run.registered.length, 2, 'the work directory and the CSS directory were tracked');
  assert.deepEqual(run.live, []);
  run.registered.forEach((directory) => {
    assert.equal(fs.existsSync(directory), false, `${directory} was removed`);
  });
});

test('--keep-temp keeps every temp directory and says where they are (#51)', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');

  const run = runFixture(t, [file], { tempRoot: path.join(dir, 'temp'), keepTemp: true });

  assert.equal(run.code, 0);
  run.registered.forEach((directory) => {
    assert.equal(fs.existsSync(directory), true, `${directory} was kept`);
  });
  assert.ok(run.reporter.has('info', 'Temp kept at '), 'the work directory is named');
  assert.ok(run.reporter.has('info', 'Effective stylesheet kept at '), 'the stylesheet directory is named');
  assert.deepEqual(run.live, [], 'a kept directory is still unregistered from the signal handler');
});

test('counts a missing file and a non-Markdown file as failures', (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, 'gone.md');
  const notes = writeFile(dir, 'notes.txt', 'plain\n');

  const run = runFixture(t, [missing, notes], { tempRoot: path.join(dir, 'temp') });

  assert.equal(run.code, 1);
  assert.equal(run.reporter.outro(), '0 converted, 2 failed');
  assert.ok(run.reporter.has('warn', `Skipped missing file: ${missing}`));
  assert.ok(run.reporter.has('warn', 'Skipped non-Markdown file'));
});

test('merges every input into one PDF next to them', (t) => {
  const dir = tempDir(t);
  const first = writeFile(dir, 'a.md', '# A\n');
  const second = writeFile(dir, 'b.md', '# B\n');

  const run = runFixture(t, [first, second], { merge: 'book', tempRoot: path.join(dir, 'temp') });

  assert.equal(run.code, 0);
  assert.equal(run.reporter.outro(), '2 merged into book.pdf');
  assert.equal(fs.existsSync(path.join(dir, 'book.pdf')), true);
  assert.equal(run.tools.callsTo('mdToPdf').length, 1, 'the merged document is rendered once');
  assert.ok(
    run.tools.callsTo('mdToPdf')[0].args.includes('--document-title=book'),
    'the merge name is the document title',
  );
});

test('a merged run reports what it left out and still exits 1', (t) => {
  const dir = tempDir(t);
  const first = writeFile(dir, 'a.md', '# A\n');
  const second = writeFile(dir, 'b.md', '# B\n');

  const run = runFixture(t, [first, second, path.join(dir, 'gone.md')], {
    merge: 'book',
    tempRoot: path.join(dir, 'temp'),
  });

  assert.equal(run.code, 1);
  assert.equal(run.reporter.outro(), '2 merged into book.pdf, 1 skipped');
  assert.ok(run.reporter.has('warn', 'Skipped missing file'));
});

test('a merged run that renders nothing ends as a failed merge', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'a.md', '# A\n');

  const run = runFixture(
    t,
    [file],
    { merge: 'book', tempRoot: path.join(dir, 'temp') },
    {
      mdToPdf: () => {
        throw new Error('render failed');
      },
    },
  );

  assert.equal(run.code, 1);
  assert.equal(run.reporter.outro(), 'Merge failed');
  assert.deepEqual(run.live, [], 'the merge directory was unregistered too');
});

test('runs doctoc exactly when the TOC mode says so', (t) => {
  const dir = tempDir(t);
  const withMarkers = writeFile(
    dir,
    'marked.md',
    [
      '# Doc',
      '',
      '<!-- START doctoc generated TOC please keep comment here to allow auto update -->',
      '<!-- END doctoc generated TOC please keep comment here to allow auto update -->',
      '',
      '## Section',
      '',
    ].join('\n'),
  );
  const plain = writeFile(dir, 'plain.md', '# Doc\n\n## Section\n');
  const temp = path.join(dir, 'temp');

  assert.equal(runFixture(t, [withMarkers], { tempRoot: temp }).tools.callsTo('doctoc').length, 1, 'markers → run');
  assert.equal(runFixture(t, [plain], { tempRoot: temp }).tools.callsTo('doctoc').length, 0, 'no markers → no run');
  assert.equal(
    runFixture(t, [plain], { tempRoot: temp, toc: 'always' }).tools.callsTo('doctoc').length,
    1,
    '--toc forces a run',
  );
  assert.equal(
    runFixture(t, [withMarkers], { tempRoot: temp, toc: 'never' }).tools.callsTo('doctoc').length,
    0,
    '--no-toc switches it off',
  );
});

test('-u without a marker block warns before doctoc runs', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n\n## Section\n');

  const run = runFixture(t, [file], { tempRoot: path.join(dir, 'temp'), toc: 'always', writeToc: true });

  assert.equal(run.code, 0);
  assert.ok(run.reporter.has('warn', 'has no doctoc marker block'), 'the user is told the source stays as it is');
  assert.ok(
    indexOf(run, 'warn', 'has no doctoc marker block') < indexOf(run, 'status', 'Table of contents'),
    'the warning comes before the doctoc step, not after it',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '# Doc\n\n## Section\n', 'the source file is untouched');
});

test('runs mermaid-cli only for a document with fences', (t) => {
  const dir = tempDir(t);
  const withDiagram = writeFile(dir, 'diagram.md', '# Doc\n\n```mermaid\ngraph TD;A-->B;\n```\n');
  const plain = writeFile(dir, 'plain.md', '# Doc\n');
  const temp = path.join(dir, 'temp');

  const diagramRun = runFixture(t, [withDiagram], { tempRoot: temp });
  const plainRun = runFixture(t, [plain], { tempRoot: temp });

  assert.equal(diagramRun.tools.callsTo('mermaidCli').length, 1);
  assert.equal(plainRun.tools.callsTo('mermaidCli').length, 0);
  assert.ok(
    plainRun.reporter.of('status').some((line) => line.includes('Preparing Markdown')),
    'the plain copy is a labelled step of its own',
  );
});

test('--html renders and copies the HTML next to the PDF, and nothing does without it', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');

  const withHtml = runFixture(t, [file], { tempRoot: path.join(dir, 'temp'), html: true });

  assert.equal(withHtml.code, 0);
  assert.equal(withHtml.tools.callsTo('mdToPdf').length, 2, 'the PDF and the HTML render');
  assert.ok(withHtml.tools.callsTo('mdToPdf')[1].args.includes('--as-html'));
  assert.ok(
    fs.readFileSync(path.join(dir, 'doc.html'), 'utf8').includes('content="md2pdf"'),
    'the copied HTML carries the generator marker',
  );
  assert.ok(
    indexOf(withHtml, 'success', 'doc.pdf') < indexOf(withHtml, 'success', 'doc.html'),
    'the PDF is announced before the HTML',
  );

  fs.rmSync(path.join(dir, 'doc.html'));
  const withoutHtml = runFixture(t, [file], { tempRoot: path.join(dir, 'temp') });

  assert.equal(withoutHtml.tools.callsTo('mdToPdf').length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'doc.html')), false);
});

test('refuses to replace an HTML file md2pdf did not write (#45)', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');
  writeFile(dir, 'doc.html', '<html><body>hand written</body></html>');

  const run = runFixture(t, [file], { tempRoot: path.join(dir, 'temp'), html: true });

  assert.equal(run.code, 1);
  assert.ok(run.reporter.has('error', 'Refusing to overwrite'));
  assert.equal(run.tools.calls.length, 0, 'the check runs before anything is rendered');
  assert.equal(fs.readFileSync(path.join(dir, 'doc.html'), 'utf8'), '<html><body>hand written</body></html>');
});

test('warns about an override no stylesheet reads (#60)', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');

  const run = runFixture(t, [file], {
    tempRoot: path.join(dir, 'temp'),
    stylesheet: writeStylesheet(dir),
    stylesheetOrigin: 'option',
    cssVars: [
      { name: '--ink', value: 'red' },
      { name: '--inkk', value: 'blue' },
    ],
  });

  assert.equal(run.code, 0);
  assert.ok(run.reporter.has('warn', '--inkk'), 'the unread override is named');
  assert.equal(
    run.reporter.of('warn').some((line) => line.includes('--ink ')),
    false,
    'the override the stylesheet reads is not reported',
  );
});

test('surfaces the asset warnings of a document and the retired --css-var names', (t) => {
  const dir = tempDir(t);
  writePng(dir, 'logo.png');
  const file = writeFile(dir, 'doc.md', '# Doc\n\n![](logo.png)\n\n![](missing.png)\n');

  const run = runFixture(t, [file], {
    tempRoot: path.join(dir, 'temp'),
    cssVarWarnings: ['--page-break-before is now --heading-break-before'],
  });

  assert.equal(run.code, 0);
  assert.ok(run.reporter.has('warn', 'missing.png'), 'the asset that could not be embedded is reported');
  assert.ok(run.reporter.has('warn', '--page-break-before'), 'the option translation is reported');
});

test('--verbose keeps a durable line per step and names the stylesheet', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');

  const run = runFixture(t, [file], {
    tempRoot: path.join(dir, 'temp'),
    verbose: true,
    stylesheet: writeStylesheet(dir),
    stylesheetOrigin: 'option',
  });

  assert.equal(run.code, 0);
  assert.ok(run.reporter.has('info', 'Resolving input files'), 'a run-level step is logged');
  assert.ok(run.reporter.has('info', 'doc.md · Rendering PDF'), 'a per-file step is logged');
  assert.ok(run.reporter.has('info', 'sheet.css'), 'the effective stylesheet is named');
});

test('a failing run-level step aborts the whole run and says which one', (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'doc.md', '# Doc\n');
  // A file where the temp root should be: every placement below it fails.
  const blocked = writeFile(dir, 'blocked', 'not a directory\n');

  const run = runFixture(t, [file], { merge: 'book', tempRoot: blocked });

  assert.equal(run.code, -1, 'the failure propagates instead of being counted per file');
  assert.ok(run.thrown instanceof Error);
  assert.ok(run.reporter.has('error', 'Merging Markdown files failed'), 'the step that failed is named');
  assert.equal(run.reporter.outro(), undefined, 'no summary is printed for a run that never ran');
});

test('--keep-temp also keeps the merged Markdown', (t) => {
  const dir = tempDir(t);
  const first = writeFile(dir, 'a.md', '# A\n');
  const second = writeFile(dir, 'b.md', '# B\n');

  const run = runFixture(t, [first, second], { merge: 'book', tempRoot: path.join(dir, 'temp'), keepTemp: true });

  assert.equal(run.code, 0);
  const kept = run.reporter.of('info').find((line) => line.startsWith('Merged Markdown kept at '));
  assert.ok(kept, 'the merged file is named');
  assert.equal(fs.existsSync(kept.replace('Merged Markdown kept at ', '')), true, 'and it is still there');
});

test('--title beats the name a merged run derives from --merge (#59)', (t) => {
  const dir = tempDir(t);
  const first = writeFile(dir, 'a.md', '# A\n');
  const second = writeFile(dir, 'b.md', '# B\n');

  const run = runFixture(t, [first, second], {
    merge: 'book',
    title: 'The Whole Book',
    tempRoot: path.join(dir, 'temp'),
  });

  assert.equal(run.code, 0);
  assert.ok(
    run.tools.callsTo('mdToPdf')[0].args.includes('--document-title=The Whole Book'),
    'the explicit title wins over the merge name',
  );
  assert.equal(fs.existsSync(path.join(dir, 'book.pdf')), true, 'the file is still named after --merge');
});
