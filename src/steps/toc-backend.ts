/**
 * The contract between the table-of-contents step (`run-toc.ts`) and the
 * library that actually builds a ToC (#83). The step owns everything that does
 * not depend on the library — the marker registry, the broken-pair guard,
 * placement of a new block, the `-u` write-back and its guard — and hands the
 * backend a document plus the block to fill. doctoc (`doctoc-backend.ts`) is
 * the only implementation today; replacing it means writing another one, not
 * touching the pipeline.
 */

import { ConverterOptions, ToolRunner } from '../types';
import { TocMarkerEntry } from './toc-markers';

/**
 * A ToC block in a document: the line indexes of its START and END marker
 * lines, 0-based, counting lines split on `\n`, both inclusive.
 */
export type TocBlock = { startIndex: number; endIndex: number };

/** What the step asks a backend to do. */
export type TocRequest = {
  /** The document to fill: the source contents, destined for the temp copy. */
  markdown: string;
  /**
   * The block to fill: the document's first genuine registry block, marker
   * lines included. Absent when the document has none and a new block has to
   * be created.
   */
  block?: TocBlock;
  /**
   * The marker lines the filled block must carry, without line terminator.
   * Absent when the block uses the backend's native marker, in which case the
   * backend writes the block exactly as the underlying tool does.
   */
  markers?: { start: string; end: string };
  /** A scratch file the backend may use for the run: the temp copy's path. */
  file: string;
  /** Converter options, passed through to the tool runner. */
  options: ConverterOptions;
  /** Starts the external tool. */
  run: ToolRunner;
};

/** What a backend returns. */
export type TocResult = {
  /** The document with the ToC block filled in. */
  markdown: string;
  /** Where the filled block is in {@link TocResult.markdown}; absent when no block was written. */
  block?: TocBlock;
};

/**
 * A library that builds a table of contents.
 *
 * An implementation must:
 *
 * - with a `block`, replace exactly that block — marker lines included — and
 *   leave every line before and after it byte-identical;
 * - without one, insert a new block anywhere and leave every existing line
 *   intact and in order (the step relocates the block afterwards);
 * - enclose the block in the requested `markers`, keeping the line ending of
 *   the line it replaces;
 * - leave a marker that a document merely shows (in a fence, inline code or a
 *   comment) byte-identical, and never fill any block but the requested one;
 * - keep the heading rules documented in AGENTS.md (*Table of contents*) —
 *   which headings are listed, GitHub-style anchors, a title kept from the
 *   previous block — so swapping the backend does not change a document's ToC.
 */
export interface TocBackend {
  /** Name used in messages, e.g. `doctoc`. */
  readonly name: string;
  /**
   * The registry entry whose blocks the backend writes itself, matched by
   * `name`. A block with this marker is filled without a `markers` request,
   * so the tool's own output stays what it was before the backend
   * abstraction existed.
   */
  readonly nativeMarker: TocMarkerEntry;
  /**
   * Fills or creates the ToC block.
   *
   * @param request - The document, the block to fill and how to run the tool.
   * @returns The filled document and where its block is.
   */
  generate(request: TocRequest): TocResult;
}
