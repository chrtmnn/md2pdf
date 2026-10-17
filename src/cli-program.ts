import fs from 'fs';
import path from 'path';
import { Command, Option } from 'commander';
import { collect } from './steps/resolve-options';

/**
 * Reads the package version for `--version`.
 *
 * Resolved from disk rather than imported, because `package.json` sits outside
 * the TypeScript `rootDir`.
 *
 * @returns The version string, or `0.0.0` when the file cannot be read.
 */
export function packageVersion(): string {
  try {
    const manifest = fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Declares the md2pdf command line without parsing it.
 *
 * Kept out of `md2pdf.ts`, which parses `process.argv` as soon as it is
 * imported, so the tests parse against the very same declarations, option
 * conflicts included, instead of a hand-kept copy that could drift.
 *
 * The option names describe what the user wants, not how it is implemented
 * (#59). Every previous name is still accepted as a hidden alias, so existing
 * command lines and scripts keep working:
 *
 * | Name | Previous name |
 * |---|---|
 * | `--toc` | `-f`, `--force-doctoc` |
 * | `-u, --write-toc` | `--update-md-toc` |
 * | `--html` | `--debug` (which now also implies `--keep-temp --verbose`) |
 * | `--keep-temp` | `-k` |
 * | `--temp-root` | `-r` |
 * | `--temp-in-output` | `-p` |
 *
 * The three `*-alias` long names exist only because Commander cannot give one
 * option two long forms; the short flag is the form that was freed up here.
 *
 * `--help` lists the options in sections rather than as one flat list of
 * implementation names, the first complaint in #59. Each `optionsGroup()` call
 * sets the heading for the options declared after it.
 *
 * @returns A fresh, unparsed Commander program.
 */
export function createProgram(): Command {
  const program = new Command()
    .name('md2pdf')
    .description('Render Mermaid diagrams and convert Markdown to PDF')
    .argument('[files...]', 'Markdown files or directories to convert')
    .optionsGroup('Input:')
    .option('-R, --recursive', 'Expand directory arguments recursively')
    .option('--merge <name>', 'Merge all resolved Markdown files into a single PDF with this base name')
    .optionsGroup('Output:')
    .option('-o, --output-dir <dir>', 'Output directory for PDFs')
    .option('--title <text>', 'Document title, instead of the first heading (or the --merge name)')
    .option('--html', 'Also emit a standalone HTML file next to the PDF')
    .optionsGroup('Styling:')
    .option(
      '-s, --stylesheet <name|path>',
      'Stylesheet path, or the name of a stylesheet in ~/.md2pdf (".css" optional); "default" forces the bundled one',
    )
    // No default value: Commander would advertise an empty array as
    // "(default: [])" (#59). `collect` starts the list instead.
    .addOption(new Option('--css-var <name=value>', 'Override a CSS custom property, repeatable').argParser(collect))
    .optionsGroup('TOC:')
    .option('--toc', 'Build a table of contents even when the source has no table of contents markers')
    .option('--no-toc', 'Never build or refresh a table of contents')
    .option('-u, --write-toc', 'Write the refreshed table of contents back into the source Markdown')
    .optionsGroup('Diagrams:')
    .option('--png', 'Render Mermaid diagrams as PNG instead of SVG')
    .optionsGroup('Diagnostics:')
    .option('-v, --verbose', 'Print output from external conversion tools')
    .option('--debug', 'Shorthand for --html --keep-temp --verbose')
    .option('--keep-temp', 'Keep the temp working directory')
    .option('--temp-root <dir>', 'Root directory for temp work dirs');

  // Both options place the temp directory, so a run given both would have to
  // drop one of them silently (#60). The aliases conflict the same way.
  const tempRootNames = ['tempRoot', 'tempRootAlias'];
  program
    .addOption(
      new Option('--temp-in-output', 'Place the temp dir inside the output directory').conflicts(tempRootNames),
    )
    // Commander orders the sections by the first option registered in each,
    // so --version is declared here: as the first option it would pull
    // Diagnostics to the top of the help.
    .version(packageVersion(), '-V, --version', 'Print the version number')
    // Declared explicitly because Commander leaves a lazily created help option
    // without a group, which would open a generic "Options:" section of its own.
    .helpOption('-h, --help', 'Show this help')
    .addOption(new Option('-p, --temp-in-output-alias').hideHelp().conflicts(tempRootNames))
    .addOption(new Option('-r, --temp-root-alias <dir>').hideHelp())
    .addOption(new Option('-k, --keep-temp-alias').hideHelp())
    .addOption(new Option('-f, --force-doctoc').hideHelp())
    .addOption(new Option('--update-md-toc').hideHelp());

  return program;
}
