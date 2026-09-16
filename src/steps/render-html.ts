import fs from 'fs';
import { ConversionContext, ToolRunner } from '../types';
import { buildMdToPdfArgs } from './md-to-pdf-args';
import { stampGeneratedHtml } from './output-targets';
import { runTool } from './run-tool';

/**
 * Renders the converted Markdown to a standalone HTML file for inspection.
 *
 * Uses md-to-pdf's `--as-html` flag on top of the argument list `renderPdf`
 * uses (`buildMdToPdfArgs`), so the embedded styles, document title, config
 * file and Mermaid SVGs match the PDF output. Document assets are already
 * embedded by `inlineAssets`, which also makes the emitted HTML
 * self-contained once it is copied next to the PDF.
 *
 * @param context - Mutable conversion state for the current source file.
 * @param run - Starts md-to-pdf; defaults to the real {@link runTool} (#71).
 */
export function renderHtml(context: ConversionContext, run: ToolRunner = runTool): void {
  run('mdToPdf', [...buildMdToPdfArgs(context), '--as-html'], context.options);

  // The marker lets a later run tell its own HTML apart from a hand-written
  // file at the same path. A missing file is reported by copyOutput.
  if (fs.existsSync(context.tempHtml)) {
    fs.writeFileSync(context.tempHtml, stampGeneratedHtml(fs.readFileSync(context.tempHtml, 'utf8')), 'utf8');
  }
}
