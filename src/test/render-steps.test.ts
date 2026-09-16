/**
 * Behaviour of the three steps that hand work to an external tool (#71).
 *
 * The runner is the fake from `helpers.ts`, so what is asserted is the
 * argument list each step builds and what it does with the tool's output —
 * never the spawning itself, which `pnpm pack:smoke` covers.
 */

import fs from 'fs';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMdToPdfArgs } from '../steps/md-to-pdf-args';
import { hasMermaidFences, renderMermaid } from '../steps/render-mermaid';
import { renderHtml } from '../steps/render-html';
import { renderPdf } from '../steps/render-pdf';
import { createFakeTools, FAKE_HTML_CONTENT, makeContext, makeOptions, tempDir, writeFile } from './helpers';

test('hasMermaidFences looks at the file it is given', (t) => {
  const dir = tempDir(t);

  assert.equal(hasMermaidFences(writeFile(dir, 'a.md', '# Doc\n\n```mermaid\ngraph TD;A-->B;\n```\n')), true);
  assert.equal(hasMermaidFences(writeFile(dir, 'b.md', '# Doc\n\n```js\nconst mermaid = 1;\n```\n')), false);
});

test('renderMermaid converts the input into the converted Markdown', (t) => {
  const dir = tempDir(t);
  const context = makeContext({ sourceFile: writeFile(dir, 'doc.md', '# Doc\n'), workdir: dir });
  const tools = createFakeTools();

  renderMermaid(context, tools.run);

  assert.deepEqual(tools.callsTo('mermaidCli')[0].args, [
    '-i',
    context.inputMarkdown,
    '-o',
    context.convertedMarkdown,
  ]);
  assert.equal(fs.existsSync(context.convertedMarkdown), true);
});

test('--png asks mermaid-cli for PNG at print scale', (t) => {
  const dir = tempDir(t);
  const context = makeContext({
    sourceFile: writeFile(dir, 'doc.md', '# Doc\n'),
    workdir: dir,
    options: makeOptions({ png: true }),
  });
  const tools = createFakeTools();

  renderMermaid(context, tools.run);

  assert.deepEqual(tools.callsTo('mermaidCli')[0].args.slice(-4), ['-e', 'png', '-s', '3']);
});

test('renderPdf passes the shared argument list and nothing else', (t) => {
  const dir = tempDir(t);
  const context = makeContext({
    sourceFile: writeFile(dir, 'doc.md', '# Doc\n'),
    workdir: dir,
    effectiveStylesheet: writeFile(dir, 'sheet.css', 'body { color: black; }\n'),
  });
  fs.writeFileSync(context.convertedMarkdown, '# Doc\n', 'utf8');
  const tools = createFakeTools();

  renderPdf(context, tools.run);

  assert.deepEqual(tools.callsTo('mdToPdf')[0].args, buildMdToPdfArgs(context));
  assert.equal(
    tools.callsTo('mdToPdf')[0].args.includes('--as-html'),
    false,
    'the PDF render must not carry the HTML flag',
  );
  assert.ok(tools.callsTo('mdToPdf')[0].args.includes(context.effectiveStylesheet!), 'the stylesheet is passed on');
  assert.equal(fs.existsSync(context.tempPdf), true);
});

test('renderHtml adds --as-html and stamps the generator marker (#45)', (t) => {
  const dir = tempDir(t);
  const context = makeContext({
    sourceFile: writeFile(dir, 'doc.md', '# Doc\n'),
    workdir: dir,
    options: makeOptions({ html: true }),
  });
  fs.writeFileSync(context.convertedMarkdown, '# Doc\n', 'utf8');
  const tools = createFakeTools();

  renderHtml(context, tools.run);
  const html = fs.readFileSync(context.tempHtml, 'utf8');

  assert.deepEqual(tools.callsTo('mdToPdf')[0].args, [...buildMdToPdfArgs(context), '--as-html']);
  assert.ok(html.startsWith('<html><head><meta name="generator" content="md2pdf">'), html);
  assert.equal(html.length, FAKE_HTML_CONTENT.length + '<meta name="generator" content="md2pdf">'.length);
});

test('renderHtml leaves a missing HTML file to copyOutput to report', (t) => {
  const dir = tempDir(t);
  const context = makeContext({
    sourceFile: writeFile(dir, 'doc.md', '# Doc\n'),
    workdir: dir,
    options: makeOptions({ html: true }),
  });
  const tools = createFakeTools({ mdToPdf: () => {} });

  renderHtml(context, tools.run);

  assert.equal(fs.existsSync(context.tempHtml), false, 'nothing was written and nothing threw');
  assert.equal(path.dirname(context.tempHtml), dir);
});
