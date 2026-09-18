import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConverterOptions } from '../types';
import { absolutizeImageTargets } from './inline-assets';
import { removeDoctocBlocks } from './doctoc-markers';
import { commonAncestorDirectory, joinDocuments, prependTocMarkers, removeFrontmatter } from './merge-assembly';
import { NATIVE_PATH_RULES, PathRules, comparisonKey } from './path-rules';
import { stripBom } from './markdown-scan';

/**
 * Result of assembling the merged Markdown file.
 */
export type MergedInput = {
  /** Absolute path of the generated merged Markdown file. */
  mergedFile: string;
  /** Temporary directory holding the merged file; removed unless `--keep-temp` is set. */
  mergeDir: string;
  /** Directory the merged PDF should be written to. */
  targetDir: string;
  /** Number of source documents actually concatenated. */
  mergedCount: number;
  /** Positionals that did not exist and were left out of the merge. */
  skipped: string[];
  /** Non-fatal messages the caller should surface. */
  warnings: string[];
};

/**
 * Resolves the temporary directory that holds the merged Markdown file.
 *
 * Mirrors the placement rules of `prepareWorkdir` so `-r/--temp-root` and
 * `-p/--temp-in-output` behave the same for the merge scratch space as for
 * the conversion work directory.
 *
 * @param options - Resolved converter options for the current run.
 * @param targetDir - Directory the merged PDF will be written to.
 * @returns The created temporary directory.
 */
function createMergeDirectory(options: ConverterOptions, targetDir: string): string {
  let base: string;
  if (options.tempInOutput) {
    base = targetDir;
  } else if (options.tempRoot) {
    base = path.resolve(options.tempRoot);
  } else {
    base = os.tmpdir();
  }

  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'merge_'));
}

/**
 * Reads a source document and normalises it for concatenation.
 *
 * Strips a UTF-8 BOM (only the first document may keep one, and keeping none
 * is simplest) and trims trailing whitespace so the caller can guarantee a
 * blank line between documents even when a file does not end in a newline.
 *
 * Frontmatter is kept only on the first document, where md-to-pdf still
 * parses it; in any later one the same block would render as content (#49).
 *
 * Image targets are pinned to the document they came from: concatenation is
 * the last moment at which each section's own directory is still known, and
 * `inlineAssets` later embeds those absolute paths as `data:` URIs.
 *
 * With `--toc` the document's own doctoc blocks are removed: the merged file
 * gets one table of contents in front of all documents instead.
 *
 * @param file - Absolute path of the source Markdown file.
 * @param isFirst - Whether this is the first document of the merge.
 * @param removeToc - Whether to remove the document's doctoc blocks.
 * @returns The normalised body, whether frontmatter had to be dropped, and
 *   whether a doctoc block was removed.
 * @throws When the document has a doctoc START marker without an END marker.
 */
function readDocument(
  file: string,
  isFirst: boolean,
  removeToc: boolean,
): { body: string; droppedFrontmatter: boolean; droppedToc: boolean } {
  const raw = stripBom(fs.readFileSync(file, 'utf8')).trimEnd();
  const { body, removed } = isFirst ? { body: raw, removed: false } : removeFrontmatter(raw);
  let withoutToc = { body, removed: 0 };

  if (removeToc) {
    try {
      withoutToc = removeDoctocBlocks(body);
    } catch (error) {
      throw new Error(
        `${file}: ${(error as Error).message}. Add the missing marker or remove the stray one; the file was left unchanged.`,
      );
    }
  }

  return {
    body: absolutizeImageTargets(withoutToc.body.trimEnd(), path.dirname(file)),
    droppedFrontmatter: removed,
    droppedToc: withoutToc.removed > 0,
  };
}

/**
 * Concatenates the resolved Markdown files into a single temporary Markdown
 * file so the existing pipeline can run over it exactly once.
 *
 * No PDF-merging library is involved: merging before rendering keeps the
 * pipeline unchanged and lets `--toc` build one table of contents spanning
 * every document, in front of the first one (see {@link prependTocMarkers}).
 *
 * Relative asset handling: image targets **are** rewritten, to the absolute
 * path they resolve to inside their own source document's directory. The
 * merged file lives in a temp directory and combines documents from possibly
 * several directories, so there is no single base left to resolve against
 * once the sections are joined; pinning each target while its origin is
 * still known is what lets `inlineAssets` embed it later. Targets that do not
 * resolve to an existing file are left exactly as written.
 *
 * Link targets are **not** rewritten. They are not fetched during rendering,
 * so rewriting them would only risk corrupting link text; a relative link
 * between merged documents stays relative and may not point anywhere useful
 * in the PDF.
 *
 * @param files - Resolved input paths, in conversion order.
 * @param options - Resolved converter options; `options.merge` supplies the output base name.
 * @param rules - Path rules for the ancestor and directory comparisons; the running platform's by default.
 * @returns The merged file, its temp directory, the default target directory, and any warnings.
 */
export function mergeMarkdown(
  files: string[],
  options: ConverterOptions,
  rules: PathRules = NATIVE_PATH_RULES,
): MergedInput {
  if (!options.merge) {
    throw new Error('mergeMarkdown called without --merge.');
  }

  const skipped: string[] = [];
  const existing: string[] = [];

  for (const file of files) {
    if (fs.existsSync(file)) {
      existing.push(path.resolve(file));
    } else {
      skipped.push(file);
    }
  }

  if (existing.length === 0) {
    throw new Error('Nothing to merge: no existing Markdown files were resolved.');
  }

  const warnings: string[] = [];
  const ancestor = commonAncestorDirectory(existing, rules);
  const targetDir = options.outputDir ? path.resolve(options.outputDir) : ancestor;

  const distinctDirectories = new Set(
    existing.map((file) => {
      return comparisonKey(path.dirname(file), rules);
    }),
  );

  if (distinctDirectories.size > 1) {
    warnings.push(
      `Merging files from ${distinctDirectories.size} directories. Images are resolved per source document, but relative links are not rewritten and may not resolve in the merged PDF.`,
    );
  }

  const buildToc = options.toc === 'always';
  const documents = existing.map((file, index) => readDocument(file, index === 0, buildToc));
  const droppedFrontmatter = documents.filter((document) => document.droppedFrontmatter).length;

  if (droppedFrontmatter > 0) {
    warnings.push(
      `Dropped the YAML frontmatter of ${droppedFrontmatter} document${droppedFrontmatter === 1 ? '' : 's'}: only the first document's is parsed, any later one would render as content.`,
    );
  }

  const droppedToc = documents.filter((document) => document.droppedToc).length;

  if (droppedToc > 0) {
    warnings.push(
      `Removed the table of contents of ${droppedToc} document${droppedToc === 1 ? '' : 's'}: --toc puts one table of contents in front of the merged documents.`,
    );
  }

  const joined = joinDocuments(documents.map((document) => document.body));
  const content = buildToc ? prependTocMarkers(joined) : joined;

  fs.mkdirSync(targetDir, { recursive: true });
  const mergeDir = createMergeDirectory(options, targetDir);

  // The merged file is named after `--merge` so prepareWorkdir derives the
  // PDF name, the temp file names, and the fallback document title from it.
  const mergedFile = path.join(mergeDir, `${options.merge}.md`);
  fs.writeFileSync(mergedFile, content, 'utf8');

  return { mergedFile, mergeDir, targetDir, mergedCount: existing.length, skipped, warnings };
}
