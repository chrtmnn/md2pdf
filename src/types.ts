/**
 * A single CSS custom property override passed from the CLI.
 */
export type CssVarOverride = {
  /** CSS custom property name, always normalized with the leading `--`. */
  name: string;
  /** Raw CSS value to write into the generated `:root` block. */
  value: string;
};

/**
 * Where the stylesheet of a run came from:
 *
 * - `option`: an explicit `-s/--stylesheet` value;
 * - `user-default`: `<config dir>/default.css`, picked because no `-s` was given;
 * - `bundled`: the bundled `src/css/default.css`, either as the last fallback
 *   or because `-s default` asked for it.
 */
export type StylesheetOrigin = 'option' | 'user-default' | 'bundled';

/**
 * How the table of contents is handled for a run; see
 * {@link ConverterOptions.toc}.
 */
export type TocMode = 'auto' | 'always' | 'never';

/** The external conversion tools a run starts. */
export type ToolName = 'doctoc' | 'mermaidCli' | 'mdToPdf';

/**
 * npx package selectors from `DOCTOC_PKG`, `MERMAID_CLI_PKG` and
 * `MD_TO_PDF_PKG`. A tool without one runs from the installed dependency.
 */
export type PackageOverrides = Partial<Record<ToolName, string>>;

/**
 * How a step starts an external tool.
 *
 * Every step that spawns doctoc, mermaid-cli or md-to-pdf takes its runner as
 * a parameter that defaults to the real `runTool`, so a test can pass a fake
 * that records the arguments and writes the file the tool would have written
 * (#71). The spawning itself — `execFileSync`, the timeout, the output buffer
 * — stays untested by design and is covered by `pnpm pack:smoke`.
 */
export type ToolRunner = (tool: ToolName, args: string[], options: ConverterOptions) => void;

/**
 * Resolved CLI options shared by every conversion step.
 */
export type ConverterOptions = {
  /** Stylesheet passed to md-to-pdf, either user-provided or the default stylesheet. */
  stylesheet?: string;
  /** How {@link ConverterOptions.stylesheet} was chosen, reported by `--verbose`. */
  stylesheetOrigin: StylesheetOrigin;
  /** CSS custom property overrides appended to the effective stylesheet. */
  cssVars: CssVarOverride[];
  /** Warnings raised while normalising the overrides, e.g. a retired variable name. */
  cssVarWarnings: string[];
  /** Target directory for generated PDFs. Defaults to each source file's directory. */
  outputDir?: string;
  /** Root directory for temporary work directories. Defaults to the OS temp directory. */
  tempRoot?: string;
  /** Whether temporary work directories should be created inside the output directory. */
  tempInOutput: boolean;
  /**
   * When a table of contents is built (#59):
   *
   * - `auto`: only when the source carries genuine doctoc markers (the default);
   * - `always`: also without markers (`--toc`, previously `-f`);
   * - `never`: not even for a source with markers (`--no-toc`).
   */
  toc: TocMode;
  /** Whether the refreshed table of contents is written back into the source Markdown. */
  writeToc: boolean;
  /** Whether temporary work directories should be preserved after conversion. */
  keepTemp: boolean;
  /** Whether external tool output should be printed while commands run. */
  verbose: boolean;
  /** Whether md-to-pdf should also emit an HTML file alongside the PDF. */
  html: boolean;
  /** Whether Mermaid diagrams should be rendered as PNG instead of the default SVG. */
  png: boolean;
  /** Whether directory arguments should be expanded into their subdirectories as well. */
  recursive: boolean;
  /**
   * Base name (without the `.pdf` suffix) of the single PDF all resolved
   * Markdown files should be merged into. Undefined when `--merge` is absent.
   */
  merge?: string;
  /** Document title from `--title`, overriding the first heading and the `--merge` name. */
  title?: string;
  /** npx package selectors that replace the installed conversion tools. */
  packageOverrides: PackageOverrides;
};

/**
 * Mutable per-file state passed through the conversion pipeline.
 */
export type ConversionContext = {
  /** Resolved options for this conversion run. */
  options: ConverterOptions;
  /** Absolute path to the original Markdown source file. */
  sourceFile: string;
  /** Directory containing the original Markdown source file. */
  sourceDir: string;
  /** Original source filename including extension. */
  baseName: string;
  /** Original source filename without extension. */
  stem: string;
  /** Isolated temporary directory for intermediate files. */
  workdir: string;
  /** Markdown file consumed by mermaid-cli, updated when doctoc creates a temp copy. */
  inputMarkdown: string;
  /** Markdown file emitted by mermaid-cli and consumed by md-to-pdf. */
  convertedMarkdown: string;
  /** Directory where the final PDF should be written. */
  targetDir: string;
  /** Final PDF path visible to the caller. */
  outputPdf: string;
  /** PDF path expected from md-to-pdf inside the temporary work directory. */
  tempPdf: string;
  /** Final debug HTML path visible to the caller, used when --debug is set. */
  outputHtml: string;
  /** HTML path expected from md-to-pdf inside the temporary work directory. */
  tempHtml: string;
  /** Stylesheet path actually passed to md-to-pdf after applying overrides. */
  effectiveStylesheet?: string;
  /** Document title passed to md-to-pdf. */
  docTitle: string;
};
