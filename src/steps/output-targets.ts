import path from 'path';
import { NATIVE_PATH_RULES, PathRules } from './path-rules';

/**
 * Paths a single-file conversion writes to, derived from the source file alone.
 */
export type OutputPaths = {
  /** Source file name without its extension. */
  stem: string;
  /** Directory the outputs are written to: `-o` when given, otherwise the source directory. */
  targetDir: string;
  /** Final PDF path. */
  outputPdf: string;
  /** Final debug HTML path, only written when `--debug` is set. */
  outputHtml: string;
};

/**
 * Several source files that would write the same output.
 */
export type OutputCollision = {
  /** The PDF path every source in {@link OutputCollision.sources} would write. */
  outputPdf: string;
  /** The colliding source files, in resolution order. */
  sources: string[];
};

/**
 * Marker stamped into every debug HTML md2pdf writes. An existing HTML file at
 * the output path is only replaced when it carries this marker, so a
 * hand-written `<stem>.html` next to the Markdown is never overwritten.
 */
export const GENERATOR_MARKER = '<meta name="generator" content="md2pdf">';

/**
 * Number of leading bytes of an existing HTML file searched for
 * {@link GENERATOR_MARKER}. The marker sits right after the `<head>` tag, well
 * before the inlined stylesheet, so a short prefix is enough and a large
 * hand-written file is never read in full.
 */
export const GENERATOR_MARKER_SCAN_BYTES = 64 * 1024;

/**
 * Longest single path component most filesystems accept, in bytes
 * (`NAME_MAX` on Linux and macOS, the same limit in practice on NTFS).
 */
const MAX_NAME_BYTES = 255;

/**
 * Longest suffix appended to the shortened stem: a Mermaid asset, which
 * mermaid-cli names after the converted Markdown file and numbers per diagram
 * (`_converted-1.svg`, `_converted-12.png`). That is longer than
 * `_converted.html` (#100); 999 diagrams leave a generous margin, and the
 * suffix is well past `_XXXXXX` for the `mkdtempSync` directory name.
 */
const LONGEST_TEMP_SUFFIX = '_converted-999.svg'.length;

/** Random suffix `mkdtempSync` appends to the directory name. */
const MKDTEMP_SUFFIX = '_XXXXXX'.length;

/** Shortest stem worth generating; below this the base directory is the problem. */
const MIN_TEMP_STEM = 8;

/**
 * Characters a temp name keeps as they are: letters, combining marks, digits
 * and `._-`. Anything else becomes `_`.
 */
const UNSAFE_TEMP_CHAR_RE = /[^\p{L}\p{M}\p{N}._-]/gu;

/**
 * Replaces the characters in a file stem that would break a link to a file
 * named after it.
 *
 * mermaid-cli names its assets after the converted Markdown file and links
 * them with a bare destination, `![diagram](./<stem>_converted-1.svg)`
 * (#84). A space ends a bare CommonMark destination, so for `my first doc.md`
 * the link pointed at `./my` and the diagram was missing from the PDF. `#`,
 * `?` and `%` change the meaning of the URL the browser loads the asset from,
 * even inside `<…>`, and `()<>\` can break the Markdown syntax itself.
 * Letters in any script are kept, so a work directory kept with
 * `--keep-temp` is still recognisable.
 *
 * Only *temp* names are sanitized; the output PDF and the document title keep
 * the original stem.
 *
 * @param stem - Source file name without its extension.
 * @returns The stem with every unsafe character replaced by `_`.
 */
export function sanitizeStemForTemp(stem: string): string {
  return stem.replace(UNSAFE_TEMP_CHAR_RE, '_');
}

/**
 * Shortens a file stem so the temp directory and the temp files derived from
 * it stay inside the platform's limits.
 *
 * Two different limits apply (#55). Every filesystem caps a single name at
 * `NAME_MAX`, so a 250-character source file name made `mkdtempSync` fail with
 * a raw `ENAMETOOLONG`. Windows additionally caps the *whole* path at
 * `MAX_PATH`, which the longest generated path has to fit:
 *
 * ```text
 * <baseDir>\<stem>_XXXXXX\<stem>_converted-999.svg
 * ```
 *
 * The stem appears twice there, hence the halved budget below. Only *temp*
 * names are shortened; the output PDF keeps the full stem, since the source
 * file proves that name fits.
 *
 * Truncation counts UTF-8 bytes, not characters, and never splits a code
 * point — a stem of 200 umlauts is 400 bytes.
 *
 * @param stem - Source file name without its extension.
 * @param baseDir - Directory the temp directory will be created in; omit when
 *   the caller does not know it yet.
 * @param rules - Path rules to apply; the running platform's by default.
 * @returns The stem, shortened when it would not fit.
 * @throws When `baseDir` is so deep that no usable name is left.
 */
export function shortenStemForTemp(stem: string, baseDir?: string, rules: PathRules = NATIVE_PATH_RULES): string {
  let limit = MAX_NAME_BYTES - LONGEST_TEMP_SUFFIX;

  if (baseDir !== undefined && rules.maxPathLength !== undefined) {
    // baseDir + separator + <stem>_XXXXXX + separator + <stem>_converted-999.svg
    const fixed = baseDir.length + 2 + MKDTEMP_SUFFIX + LONGEST_TEMP_SUFFIX;
    const perStem = Math.floor((rules.maxPathLength - fixed) / 2);

    if (perStem < MIN_TEMP_STEM) {
      throw new Error(
        `Temp directory path too long: ${baseDir} leaves no room for a work directory name (the platform limits a path to ${rules.maxPathLength} characters). Use --temp-root with a shorter path.`,
      );
    }

    limit = Math.min(limit, perStem);
  }

  if (Buffer.byteLength(stem, 'utf8') <= limit) {
    return stem;
  }

  const truncated = Buffer.from(stem, 'utf8').subarray(0, limit).toString('utf8');
  // A partial code point at the cut decodes to U+FFFD; dropping it keeps the
  // name a faithful prefix of the original.
  return truncated.endsWith('\uFFFD') ? truncated.slice(0, -1) : truncated;
}

/**
 * Derives the output paths for a source file.
 *
 * `prepareWorkdir` and the collision check both use this, so the pre-flight
 * check can never disagree with the paths that are actually written.
 *
 * @param sourceFile - Markdown source file path.
 * @param outputDir - The `-o` directory, or `undefined` to write next to the source.
 * @returns The derived output paths, all absolute.
 */
export function deriveOutputPaths(sourceFile: string, outputDir: string | undefined): OutputPaths {
  const absSrc = path.resolve(sourceFile);
  const stem = path.parse(path.basename(absSrc)).name;
  const targetDir = outputDir ? path.resolve(outputDir) : path.dirname(absSrc);

  return {
    stem,
    targetDir,
    outputPdf: path.join(targetDir, `${stem}.pdf`),
    outputHtml: path.join(targetDir, `${stem}.html`),
  };
}

/**
 * Finds source files that would write the same output, e.g. `a/README.md` and
 * `b/README.md` with `-o out`.
 *
 * Only the PDF path is compared: the debug HTML is derived from the same stem
 * and target directory, so two sources collide on both or on neither. Paths
 * are compared case-insensitively on Windows only, like the input
 * deduplication in `resolve-inputs.ts`.
 *
 * @param sourceFiles - Source files of the run, in resolution order.
 * @param outputDir - The `-o` directory, or `undefined`.
 * @param platform - Platform whose path comparison rules apply.
 * @returns One entry per output path claimed by more than one source, in order of first appearance.
 */
export function findOutputCollisions(
  sourceFiles: string[],
  outputDir: string | undefined,
  platform: NodeJS.Platform = process.platform,
): OutputCollision[] {
  const claims = new Map<string, OutputCollision>();

  for (const sourceFile of sourceFiles) {
    const { outputPdf } = deriveOutputPaths(sourceFile, outputDir);
    const key = platform === 'win32' ? outputPdf.toLowerCase() : outputPdf;
    const claim = claims.get(key);
    if (claim) {
      claim.sources.push(sourceFile);
    } else {
      claims.set(key, { outputPdf, sources: [sourceFile] });
    }
  }

  return [...claims.values()].filter((claim) => claim.sources.length > 1);
}

/**
 * Formats the collision report printed before a run is aborted.
 *
 * @param collisions - Non-empty result of {@link findOutputCollisions}.
 * @returns A multi-line message naming every contested output and its sources.
 */
export function describeOutputCollisions(collisions: OutputCollision[]): string {
  const lines = ['Several inputs would write the same output, so nothing was converted:'];
  for (const { outputPdf, sources } of collisions) {
    lines.push(`  ${outputPdf}`);
    sources.forEach((source) => lines.push(`    <- ${source}`));
  }
  lines.push('Convert them in separate runs or into different -o directories.');
  return lines.join('\n');
}

/**
 * Inserts {@link GENERATOR_MARKER} into an HTML document, directly after the
 * opening `<head>` tag.
 *
 * Without a `<head>` the marker goes after the opening `<html>` tag, and
 * without that at the very start. A document that already carries the marker
 * is returned unchanged.
 *
 * @param html - HTML document as emitted by md-to-pdf.
 * @returns The document with the marker.
 */
export function stampGeneratedHtml(html: string): string {
  if (isGeneratedHtml(html)) {
    return html;
  }

  // `\s` or `>` after the tag name, so `<header>` does not count as `<head>`.
  for (const tag of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i]) {
    const match = tag.exec(html);
    if (match) {
      const end = match.index + match[0].length;
      return html.slice(0, end) + GENERATOR_MARKER + html.slice(end);
    }
  }

  return GENERATOR_MARKER + html;
}

/**
 * Checks whether an HTML document was written by md2pdf.
 *
 * @param htmlPrefix - The document, or at least its first {@link GENERATOR_MARKER_SCAN_BYTES} bytes.
 * @returns `true` when the document carries {@link GENERATOR_MARKER}.
 */
export function isGeneratedHtml(htmlPrefix: string): boolean {
  return htmlPrefix.includes(GENERATOR_MARKER);
}
