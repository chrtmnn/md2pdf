import path from 'path';
import { ConversionContext } from '../types';

/**
 * md-to-pdf config file that sets `pdf_options.preferCSSPageSize`, so the
 * stylesheet's `@page { size }` decides the paper size instead of Puppeteer's
 * `format: 'a4'` default.
 *
 * Passed through `--config-file` rather than `--pdf-options`: md-to-pdf assigns
 * `--pdf-options` over `pdf_options` wholesale, which would drop its
 * `printBackground` / `format` / `margin` defaults and any front-matter
 * `pdf_options`. A config file is merged onto the defaults instead, and front
 * matter still takes precedence over it.
 */
export const MD_TO_PDF_CONFIG = path.resolve(__dirname, '..', 'config', 'md-to-pdf.config.json');

/**
 * {@link MD_TO_PDF_CONFIG} plus `launch_options.args: ["--no-sandbox"]`, used
 * instead of it when Chromium has to run without its sandbox (#95). A second
 * file rather than a second `--config-file`: md-to-pdf reads only one.
 */
export const MD_TO_PDF_NO_SANDBOX_CONFIG = path.resolve(__dirname, '..', 'config', 'md-to-pdf.no-sandbox.config.json');

/**
 * Builds the md-to-pdf arguments that the PDF and the HTML render share.
 *
 * Both renders go through this one list so they see the same configuration
 * (#64): `renderHtml` used to maintain its own copy without `--config-file`,
 * so any config key that shapes the page (`marked_options`, `css`,
 * `launch_options`, …) would have reached the PDF only, and `--html` would
 * have stopped being a preview of it. `pdf_options` is ignored under
 * `--as-html`, so passing the file there changes nothing else. A caller
 * appends only the flags that are specific to its output.
 *
 * @param context - Conversion state for the current source file.
 * @returns The argument list, without the render-specific flags.
 */
export function buildMdToPdfArgs(context: ConversionContext): string[] {
  const args = [
    context.convertedMarkdown,
    // The work directory rather than the source directory: md-to-pdf serves
    // it over HTTP and loads the document from it, so it has to hold the
    // converted Markdown and the generated Mermaid assets.
    '--basedir',
    context.workdir,
    // Inline, not two argv elements: md-to-pdf's parser takes the following
    // token for a flag when the title starts with `--`, so a first heading of
    // `# --version` aborted the run with a raw Node stack trace (#51).
    `--document-title=${context.docTitle}`,
    '--config-file',
    context.options.sandboxOff ? MD_TO_PDF_NO_SANDBOX_CONFIG : MD_TO_PDF_CONFIG,
  ];

  if (context.effectiveStylesheet) {
    args.push('--stylesheet', context.effectiveStylesheet);
  }

  return args;
}
