/**
 * Validation and normalisation of the CLI option values that carry more than
 * a boolean: `--css-var name=value` and `--merge <name>`. Kept separate from
 * `resolve-options.ts`, which also touches the filesystem to locate the
 * default stylesheet, so the validation rules can be exercised directly.
 */

import { CssVarOverride } from '../types';

/**
 * Normalizes the `--merge <name>` value into a plain PDF base name.
 *
 * The value is a name, not a path: the merged PDF always lands in the
 * resolved target directory, so anything that looks like a path is rejected
 * rather than silently reinterpreted. A trailing `.pdf` suffix is accepted
 * and removed, so both `report` and `report.pdf` produce `report.pdf`.
 *
 * @param value - Raw `--merge` value from the CLI.
 * @returns The validated PDF base name without extension.
 */
export function parseMergeName(value: string): string {
  const trimmed = value.trim();
  const name = /\.pdf$/i.test(trimmed) ? trimmed.slice(0, -4) : trimmed;

  if (!name || name === '.' || name === '..') {
    throw new Error(`Invalid --merge name: ${value}. Expected a PDF base name.`);
  }

  if (/[/\\]/.test(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Invalid --merge name: ${value}. Expected a plain file name without path separators.`);
  }

  if (/[<>:"|?*]/.test(name)) {
    throw new Error(
      `Invalid --merge name: ${value}. Expected a plain file name without the characters <>:"|?*.`,
    );
  }

  // `--merge "a.md" "b.md"` reads as "merge these files", but Commander takes
  // the first file as the name: one document was merged into `a.md.pdf` and
  // nothing said so (#84).
  if (/\.md$/i.test(name)) {
    throw new Error(
      `Invalid --merge name: ${value}. --merge takes the PDF base name first, then the files: --merge <name> <files...>.`,
    );
  }

  return name;
}

/**
 * Parses `--css-var name=value` entries into normalized CSS custom properties.
 *
 * A value that could escape the generated `:root {}` block is rejected: `{`,
 * `}`, `;` and a comment delimiter (`/*`, `*` + `/`).
 *
 * @param values - Raw CLI values collected from `--css-var`.
 * @returns Validated CSS variable overrides.
 */
export function parseCssVars(values: string[]): CssVarOverride[] {
  return values.map((entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(`Invalid CSS variable override: ${entry}. Expected name=value.`);
    }

    const rawName = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    const name = rawName.startsWith('--') ? rawName.slice(2) : rawName;

    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
      throw new Error(`Invalid CSS variable name: ${rawName}`);
    }

    // `/*` escapes the generated `:root {}` block as thoroughly as `}` does:
    // it comments out the rest of the block, so every later override — and
    // the closing brace — silently disappears (#46).
    if (!value || /[{};]/.test(value) || value.includes('/*') || value.includes('*/')) {
      throw new Error(`Invalid CSS variable value for ${rawName}: ${value}`);
    }

    return { name: `--${name}`, value };
  });
}

/**
 * Page-break variables that were replaced by their modern counterpart (#59).
 *
 * `default.css` used to define two custom properties per concept — a legacy
 * `page-break-before` one and a modern `break-before` one — so enabling a
 * break took two `--css-var` flags that had to agree. Chromium, the only
 * renderer involved, honours `break-before`, so the modern name is the only
 * one left and the legacy name is translated for a transition period.
 */
const LEGACY_CSS_VARS: Record<string, string> = {
  '--heading-page-break-before': '--heading-break-before',
  '--first-heading-page-break-before': '--first-heading-break-before',
  '--document-page-break-before': '--document-break-before',
};

/**
 * `page-break-before` values and what they are called in `break-before`.
 * Anything not listed means the same in both properties.
 */
const LEGACY_CSS_VALUES: Record<string, string> = {
  always: 'page',
};

/**
 * Rewrites overrides that use a retired page-break variable name.
 *
 * @param cssVars - Parsed overrides, in the order they were given.
 * @returns The overrides with legacy names translated, and one warning per
 *   translated override.
 */
export function translateLegacyCssVars(cssVars: CssVarOverride[]): {
  cssVars: CssVarOverride[];
  warnings: string[];
} {
  const warnings: string[] = [];

  const translated = cssVars.map((override) => {
    const name = LEGACY_CSS_VARS[override.name];
    if (!name) {
      return override;
    }

    const value = LEGACY_CSS_VALUES[override.value.toLowerCase()] ?? override.value;
    warnings.push(
      `${override.name} is deprecated; using ${name}=${value} instead. One variable per concept is enough since #59.`,
    );

    return { name, value };
  });

  return { cssVars: translated, warnings };
}
