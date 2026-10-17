import fs from 'fs';
import path from 'path';
import { ConversionContext } from '../types';
import { classifyLines } from './markdown-scan';

/**
 * Upper size limit for a single inlined asset.
 *
 * Base64 grows a file by roughly a third and the result is held in memory as
 * a JavaScript string, so an accidental multi-hundred-megabyte reference must
 * not take the whole run down. Oversized assets are reported and left alone.
 */
const MAX_INLINE_BYTES = 32 * 1024 * 1024;

/**
 * Formats a byte count for the oversize warning.
 *
 * Rounded to whole megabytes, `32 MiB + 1 byte` read as "32 MB" — the limit,
 * not the file — which made the message look like it was naming the wrong
 * number (#55). One decimal and the binary unit keep the two apart.
 *
 * @param bytes - Size in bytes.
 * @returns The size as `<n.n> MiB`.
 */
function describeSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * File extension to MIME type mapping used when building `data:` URIs.
 *
 * Only image types are listed: image references are the only asset targets
 * this step rewrites.
 */
const MIME_TYPES: Record<string, string> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

/**
 * Markdown inline image, captured up to (but excluding) the target itself.
 *
 * The bare (unbracketed) target allows **balanced** parentheses, which
 * CommonMark permits and which Windows screenshots (`screenshot(1).png`)
 * routinely contain: a target of `[^\s()]+` stopped at the first `(` and
 * left the image unembedded while reporting a path that appears nowhere in
 * the document (#55). Nesting is matched two levels deep, which covers real
 * file names; anything deeper is left as written rather than mis-parsed.
 */
const MD_IMAGE_RE = /(!\[[^\]]*\]\(\s*)(<[^>\n]*>|(?:[^\s()]|\((?:[^\s()]|\([^\s()]*\))*\))+)/g;

/**
 * HTML `<img>` tag `src` attribute in quoted or bare form. The attribute name
 * must follow whitespace: `\b` also matched between `-` and `s`, so the `src`
 * inside `data-src` was rewritten and the real `src` never reached (#101).
 */
const HTML_IMG_RE = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Inline code span, used to mask code out before image targets are matched. */
const CODE_SPAN_RE = /(`+)(?:[^`]|(?!\1)`)*\1/g;

/**
 * Placeholder pattern for masked inline code spans. Uses a Unicode private
 * use character so it cannot collide with document content.
 */
const CODE_SPAN_PLACEHOLDER = '\uE000';

/**
 * Transformation applied to a single image target.
 *
 * @param target - Raw target as written in the document, without surrounding
 *   angle brackets or quotes.
 * @returns The replacement target, or `undefined` to leave the target as is.
 */
type TargetTransform = (target: string) => string | undefined;

/**
 * Decides whether a target already points somewhere the renderer can reach on
 * its own and must therefore not be touched.
 *
 * A scheme needs at least two characters so that Windows drive letters
 * (`C:/docs/x.png`) are treated as filesystem paths rather than as URLs.
 *
 * @param target - Raw image target from the document.
 * @returns `true` for URLs, protocol-relative targets, and fragments.
 */
function isExternalTarget(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]+:|\/\/|#)/i.test(target);
}

/**
 * Resolves a document-relative target to an existing file.
 *
 * Markdown targets may be percent-encoded (`my%20file.png`), so the raw form
 * is tried first and the decoded form second.
 *
 * @param baseDir - Directory the target should be resolved against.
 * @param target - Raw image target from the document.
 * @returns The absolute path of the existing file, or `undefined`.
 */
function resolveExisting(baseDir: string, target: string): string | undefined {
  const candidates = [target];

  try {
    const decoded = decodeURIComponent(target);
    if (decoded !== target) {
      candidates.push(decoded);
    }
  } catch {
    // A malformed escape sequence just means the raw form is the only option.
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(baseDir, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }

  return undefined;
}

/**
 * Masks inline code spans so image syntax inside backticks is never rewritten.
 *
 * @param line - A single line of Markdown outside a fenced code block.
 * @returns The masked line and the spans needed to restore it.
 */
function maskCodeSpans(line: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const masked = line.replace(CODE_SPAN_RE, (match) => {
    spans.push(match);
    return `${CODE_SPAN_PLACEHOLDER}${spans.length - 1}${CODE_SPAN_PLACEHOLDER}`;
  });

  return { masked, spans };
}

/**
 * Restores the code spans removed by {@link maskCodeSpans}.
 *
 * @param line - Line containing code span placeholders.
 * @param spans - Spans captured while masking, in order.
 * @returns The line with its original code spans back in place.
 */
function restoreCodeSpans(line: string, spans: string[]): string {
  if (spans.length === 0) {
    return line;
  }

  return line.replace(
    new RegExp(`${CODE_SPAN_PLACEHOLDER}(\\d+)${CODE_SPAN_PLACEHOLDER}`, 'g'),
    (_match, index: string) => spans[Number(index)],
  );
}

/**
 * Renders a replacement target back into Markdown link-destination syntax.
 *
 * Angle brackets are only used when the target contains characters that would
 * otherwise terminate the destination early.
 *
 * @param target - Replacement target.
 * @returns The destination as it should appear between the parentheses.
 */
function formatMarkdownTarget(target: string): string {
  return /[\s()]/.test(target) ? `<${target}>` : target;
}

/**
 * Applies a transformation to every image target in a Markdown document.
 *
 * Fenced code blocks, HTML comment blocks and inline code spans are skipped
 * so documentation that *shows* image syntax is never rewritten. Both Markdown image syntax and
 * HTML `<img src>` attributes are covered; reference-style images
 * (`![alt][ref]`) are deliberately left alone because a link reference
 * definition is shared between links and images.
 *
 * @param markdown - Full document contents.
 * @param transform - Callback deciding the replacement for each target.
 * @returns The rewritten document.
 */
export function transformImageTargets(markdown: string, transform: TargetTransform): string {
  const lines = markdown.split('\n');
  // Classified without the `\r` a CRLF document leaves on every line: the
  // fence matcher does not expect one, so a CRLF fence was never recognised
  // and the examples inside it were embedded (#99). The lines themselves are
  // rewritten with their `\r`, so the line endings survive.
  const kinds = classifyLines(lines.map((line) => line.replace(/\r$/, '')));

  const rewritten = lines.map((line, index) => {
    // Only lines that render as Markdown are rewritten. Delegating the
    // tracking to `markdown-scan.ts` keeps this in step with the title and
    // TOC scanners: a local copy had drifted from the CommonMark rule that an
    // info-string fence (```js) can open a block but never close one, so a
    // documented example closed the block early and the next real image was
    // silently left unembedded (#47).
    if (kinds[index] !== 'content') {
      return line;
    }

    const { masked, spans } = maskCodeSpans(line);

    let result = masked.replace(MD_IMAGE_RE, (match, prefix: string, rawTarget: string) => {
      const bracketed = rawTarget.startsWith('<') && rawTarget.endsWith('>');
      const target = bracketed ? rawTarget.slice(1, -1) : rawTarget;
      const replacement = transform(target);
      return replacement === undefined ? match : `${prefix}${formatMarkdownTarget(replacement)}`;
    });

    result = result.replace(
      HTML_IMG_RE,
      (match, prefix: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
        const target = doubleQuoted ?? singleQuoted ?? bare ?? '';
        const replacement = transform(target);
        return replacement === undefined ? match : `${prefix}"${replacement.replace(/"/g, '&quot;')}"`;
      },
    );

    return restoreCodeSpans(result, spans);
  });

  return rewritten.join('\n');
}

/**
 * Rewrites document-relative image targets to absolute filesystem paths.
 *
 * Used by `mergeMarkdown`, where every document contributes its own base
 * directory: once the sections are concatenated into one file there is no
 * single directory left to resolve against, so each target is pinned to its
 * originating document while that information is still available.
 *
 * @param markdown - Contents of one source document.
 * @param baseDir - Directory of that source document.
 * @returns The document with resolvable relative image targets made absolute.
 */
export function absolutizeImageTargets(markdown: string, baseDir: string): string {
  return transformImageTargets(markdown, (target) => {
    if (!target || isExternalTarget(target) || path.isAbsolute(target)) {
      return undefined;
    }

    const resolved = resolveExisting(baseDir, target);

    // Forward slashes keep the rewritten target free of Markdown escape
    // sequences (`\_`, `\(`) that a Windows path would otherwise introduce if
    // the asset ever fails to embed and the raw path reaches the parser.
    return resolved && resolved.split(path.sep).join('/');
  });
}

/**
 * Replaces local image references with self-contained `data:` URIs.
 *
 * md-to-pdf serves `--basedir` over HTTP and loads the document from that
 * server, so a reference is only reachable when it resolves inside the served
 * directory. The served directory is the isolated work directory (it has to
 * be: it holds the converted Markdown and the Mermaid output), which means a
 * relative reference in the user's document would otherwise look for the
 * asset next to the generated file instead of next to the source. Absolute
 * paths do not help either — Chromium refuses to load `file://` resources
 * from an `http://localhost` page.
 *
 * Inlining sidesteps both problems without giving up the temp directory
 * isolation, and matches how stylesheet assets are handled. Targets that
 * already resolve inside the work directory are left untouched, which is what
 * keeps the Mermaid SVGs (generated into the work directory and referenced
 * relatively from the converted Markdown) working.
 *
 * @param context - Mutable conversion state for the current source file.
 * @returns Non-fatal messages about assets that could not be inlined.
 */
export function inlineAssets(context: ConversionContext): string[] {
  const warnings: string[] = [];
  const reported = new Set<string>();

  /**
   * Records a warning once per distinct target.
   *
   * @param message - Message to surface to the caller.
   */
  function warn(message: string): void {
    if (!reported.has(message)) {
      reported.add(message);
      warnings.push(message);
    }
  }

  const markdown = fs.readFileSync(context.convertedMarkdown, 'utf8');

  // One `data:` URI per file on disk: ten references to the same 30 MB image
  // used to be read and base64-encoded ten times over (#55). Keyed by the
  // resolved path, so two spellings of the same file share the entry.
  const encoded = new Map<string, string>();

  const rewritten = transformImageTargets(markdown, (target) => {
    if (!target || isExternalTarget(target)) {
      return undefined;
    }

    if (!path.isAbsolute(target) && resolveExisting(context.workdir, target)) {
      // Already reachable through --basedir; this is the Mermaid output.
      return undefined;
    }

    const resolved = path.isAbsolute(target)
      ? resolveExisting(path.parse(target).root, target)
      : resolveExisting(context.sourceDir, target);

    if (!resolved) {
      warn(`Asset not found, left unresolved: ${target}`);
      return undefined;
    }

    const cached = encoded.get(resolved);
    if (cached) {
      return cached;
    }

    const { size } = fs.statSync(resolved);
    if (size > MAX_INLINE_BYTES) {
      warn(
        `Asset too large to embed (${describeSize(size)}, limit ${MAX_INLINE_BYTES / 1024 / 1024} MiB), left unresolved: ${target}`,
      );
      return undefined;
    }

    const mime = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    const dataUri = `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
    encoded.set(resolved, dataUri);
    return dataUri;
  });

  if (rewritten !== markdown) {
    fs.writeFileSync(context.convertedMarkdown, rewritten, 'utf8');
  }

  return warnings;
}
