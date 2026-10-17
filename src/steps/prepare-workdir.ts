import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConversionContext, ConverterOptions } from '../types';
import { deriveOutputPaths, sanitizeStemForTemp, shortenStemForTemp } from './output-targets';

/**
 * Creates the per-file conversion context and temporary work directory.
 *
 * @param sourceFile - Markdown file path received from the CLI.
 * @param options - Resolved converter options for the current run.
 * @returns A populated conversion context, or `undefined` when the source file does not exist.
 */
export function prepareWorkdir(sourceFile: string, options: ConverterOptions): ConversionContext | undefined {
  if (!fs.existsSync(sourceFile)) {
    return undefined;
  }

  const absSrc = path.resolve(sourceFile);
  const sourceDir = path.dirname(absSrc);
  const { stem, targetDir, outputPdf, outputHtml } = deriveOutputPaths(absSrc, options.outputDir);
  // Every generated name is built from the shortened stem, so a very long
  // source file name cannot push a temp name past the filesystem's limit and
  // fail the run with a raw ENAMETOOLONG (#55).
  // Before the work directory, not after: an unusable `-o` (a path that is a
  // file, say) used to fail *after* `mkdtempSync` had already created the
  // work directory, which nothing then removed (#51).
  fs.mkdirSync(targetDir, { recursive: true });

  let base: string;
  if (options.tempInOutput) {
    base = options.outputDir ? path.resolve(options.outputDir) : sourceDir;
  } else if (options.tempRoot) {
    base = path.resolve(options.tempRoot);
  } else {
    base = os.tmpdir();
  }

  // The base directory is part of the budget: Windows limits the whole path,
  // so a deep `-o` leaves less room for the generated names (#55). The
  // sanitized stem keeps spaces out of the Mermaid asset links mermaid-cli
  // derives from the converted file's name (#84).
  const tempStem = shortenStemForTemp(sanitizeStemForTemp(stem), base);

  fs.mkdirSync(base, { recursive: true });
  const workdir = fs.mkdtempSync(path.join(base, `${tempStem}_`));

  return {
    options,
    sourceFile: absSrc,
    sourceDir,
    stem,
    tempStem,
    workdir,
    inputMarkdown: absSrc,
    convertedMarkdown: path.join(workdir, `${tempStem}_converted.md`),
    targetDir,
    outputPdf,
    tempPdf: path.join(workdir, `${tempStem}_converted.pdf`),
    outputHtml,
    tempHtml: path.join(workdir, `${tempStem}_converted.html`),
    docTitle: stem,
  };
}
