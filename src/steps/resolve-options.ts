import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { ConverterOptions, TocMode } from '../types';
import { resolveSandboxOff } from './chromium-sandbox';
import { parseCssVars, parseMergeName, translateLegacyCssVars } from './option-values';
import { chooseStylesheet, configDirectory } from './stylesheet-lookup';
import { readPackageOverrides } from './tool-invocation';

/**
 * Reports whether a path is an existing file. A directory that happens to
 * carry the stylesheet's name does not count, so the lookup moves on.
 *
 * @param file - Absolute path to check.
 * @returns True when `file` exists and is a regular file.
 */
function isFile(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

type RawOptions = {
  stylesheet?: string;
  cssVar?: string[];
  outputDir?: string;
  title?: string;
  tempRoot?: string;
  tempRootAlias?: string;
  tempInOutput?: boolean;
  tempInOutputAlias?: boolean;
  toc?: boolean;
  forceDoctoc?: boolean;
  writeToc?: boolean;
  updateMdToc?: boolean;
  keepTemp?: boolean;
  keepTempAlias?: boolean;
  verbose?: boolean;
  html?: boolean;
  debug?: boolean;
  png?: boolean;
  recursive?: boolean;
  merge?: string;
};

/**
 * Commander collector for repeatable CLI options.
 *
 * @param value - Newly parsed option value.
 * @param previous - Previously collected values for the same option.
 * @returns A new array containing all collected values.
 */
export function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

/**
 * Folds `--toc` / `--no-toc` and the previous `-f/--force-doctoc` into one
 * mode.
 *
 * Commander reports `toc` as `undefined` when neither flag is given, which is
 * the automatic behaviour: doctoc runs exactly for a source that carries
 * genuine markers.
 *
 * @param rawOptions - Parsed Commander options.
 * @returns The table-of-contents mode for the run.
 */
function resolveTocMode(rawOptions: RawOptions): TocMode {
  if (rawOptions.toc === false) {
    return 'never';
  }

  return rawOptions.toc === true || rawOptions.forceDoctoc ? 'always' : 'auto';
}

/**
 * Resolves and validates raw Commander options into the internal options shape.
 *
 * @param program - Parsed Commander program instance.
 * @returns Converter options with defaults, npx overrides, and CSS overrides resolved.
 */
export function resolveOptions(program: Command): ConverterOptions {
  const rawOptions = program.opts<RawOptions>();

  // `--debug` is the previous name of `--html` and now means "tell me
  // everything": the HTML file, the temp directory and the tool output (#59).
  const debug = Boolean(rawOptions.debug);
  const writeToc = Boolean(rawOptions.writeToc || rawOptions.updateMdToc);

  // A merged run converts a temporary concatenation, so `-u` would refresh
  // that copy and leave every source file unchanged (#60).
  if (writeToc && rawOptions.merge !== undefined) {
    throw new Error(
      '-u cannot be combined with --merge: a merged run converts a temporary concatenation of the files, so no source file would be updated.',
    );
  }

  const { cssVars, warnings: cssVarWarnings } = translateLegacyCssVars(parseCssVars(rawOptions.cssVar ?? []));

  // Relative values and bare names refer to the directory md2pdf was called
  // from, which is the working directory of an npm-installed command (#56).
  const chosenStylesheet = chooseStylesheet(
    rawOptions.stylesheet,
    {
      invocationDir: process.cwd(),
      configDir: configDirectory(process.env, os.homedir()),
      bundledStylesheet: path.resolve(__dirname, '..', 'css', 'default.css'),
    },
    isFile,
  );

  return {
    stylesheet: chosenStylesheet.path,
    stylesheetOrigin: chosenStylesheet.origin,
    cssVars,
    cssVarWarnings,
    outputDir: rawOptions.outputDir,
    title: rawOptions.title,
    tempRoot: rawOptions.tempRoot ?? rawOptions.tempRootAlias,
    tempInOutput: Boolean(rawOptions.tempInOutput || rawOptions.tempInOutputAlias),
    toc: resolveTocMode(rawOptions),
    writeToc,
    keepTemp: Boolean(rawOptions.keepTemp || rawOptions.keepTempAlias || debug),
    verbose: Boolean(rawOptions.verbose || debug),
    html: Boolean(rawOptions.html || debug),
    png: Boolean(rawOptions.png),
    recursive: Boolean(rawOptions.recursive),
    merge: rawOptions.merge === undefined ? undefined : parseMergeName(rawOptions.merge),
    packageOverrides: readPackageOverrides(process.env),
    // Chromium refuses to start as root with its sandbox on (#95).
    sandboxOff: resolveSandboxOff(process.env, process.getuid?.()),
  };
}
