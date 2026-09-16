import fs from 'fs';
import { ConversionContext, ToolRunner } from '../types';
import { runTool } from './run-tool';

const MERMAID_FENCE_RE = /^[ \t]{0,3}(?:```|~~~)\s*mermaid\b/m;

/**
 * Puppeteer scale factor passed to mermaid-cli (`-s, --scale`) when `--png` is
 * active. mermaid-cli defaults to a scale of 1, which renders visibly blurry
 * once embedded in a print PDF; 3 keeps PNG diagrams sharp at print resolution.
 */
const PNG_PRINT_SCALE = 3;

/**
 * Detects whether a Markdown file contains at least one Mermaid code fence.
 *
 * Indented fences (up to three leading spaces) and both backtick and tilde
 * delimiters are recognised. Fences embedded inside HTML wrappers such as
 * `<pre><code>` are not matched because they do not begin at line start.
 *
 * @param filePath - Markdown file to inspect.
 */
export function hasMermaidFences(filePath: string): boolean {
  return MERMAID_FENCE_RE.test(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Renders Mermaid fences to SVG assets and writes the converted Markdown file.
 *
 * @param context - Mutable conversion state for the current source file.
 * @param run - Starts mermaid-cli; defaults to the real {@link runTool} (#71).
 */
export function renderMermaid(context: ConversionContext, run: ToolRunner = runTool): void {
  const args = ['-i', context.inputMarkdown, '-o', context.convertedMarkdown];

  if (context.options.png) {
    args.push('-e', 'png', '-s', String(PNG_PRINT_SCALE));
  }

  run('mermaidCli', args, context.options);
}
