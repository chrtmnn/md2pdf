/**
 * Rules for starting the conversion tools without a shell and for turning a
 * failed run into a readable error message. A tool runs from the installed
 * dependency by default — its `bin` script, started with the running Node
 * binary — and through `npx <selector>` when a `*_PKG` variable names a
 * package. Kept separate from `run-tool.ts`, which spawns the child process,
 * so the lookups and the error formatting can be exercised directly on any
 * platform.
 */

import path from 'path';
import { PackageOverrides, ToolName } from '../types';

/** An executable and the arguments that must precede the tool's own. */
export type ProcessInvocation = {
  file: string;
  leadingArgs: string[];
};

/** How one tool is started, and the name its failures are reported under. */
export type ToolInvocation = ProcessInvocation & {
  /** The package name, or `npx <selector>` for an override. */
  label: string;
};

/** What {@link resolveToolInvocation} needs from the process and the filesystem. */
export type ToolEnvironment = {
  /** Platform to resolve npx for, normally `process.platform`. */
  platform: NodeJS.Platform;
  /** Path of the running Node binary, normally `process.execPath`. */
  execPath: string;
  /** Existence check for the npx candidates, normally `fs.existsSync`. */
  exists: (candidate: string) => boolean;
  /** `node_modules` directories to search for a package, nearest first, normally `require.resolve.paths`. */
  searchPaths: (packageName: string) => string[];
  /** Reads a file as text, or returns `undefined` when it cannot be read. */
  readFile: (file: string) => string | undefined;
};

type ToolPackage = {
  /** npm package that provides the tool. */
  packageName: string;
  /** Command in the package's `bin` field that starts its CLI. */
  binName: string;
  /** Variable that replaces the installed package with an npx selector. */
  overrideEnv: string;
};

/** The package behind each tool. */
export const TOOL_PACKAGES: Record<ToolName, ToolPackage> = {
  doctoc: { packageName: 'doctoc', binName: 'doctoc', overrideEnv: 'DOCTOC_PKG' },
  mermaidCli: { packageName: '@mermaid-js/mermaid-cli', binName: 'mmdc', overrideEnv: 'MERMAID_CLI_PKG' },
  mdToPdf: { packageName: 'md-to-pdf', binName: 'md-to-pdf', overrideEnv: 'MD_TO_PDF_PKG' },
};

/**
 * Reads the npx package selectors from `DOCTOC_PKG`, `MERMAID_CLI_PKG` and
 * `MD_TO_PDF_PKG`. An empty variable counts as unset.
 *
 * @param env - Environment to read, normally `process.env`.
 * @returns The selector of every tool that has one.
 */
export function readPackageOverrides(env: NodeJS.ProcessEnv): PackageOverrides {
  const overrides: PackageOverrides = {};

  for (const tool of Object.keys(TOOL_PACKAGES) as ToolName[]) {
    const selector = env[TOOL_PACKAGES[tool].overrideEnv];
    if (selector) {
      overrides[tool] = selector;
    }
  }

  return overrides;
}

/**
 * Decides how a tool is started.
 *
 * Without an override the installed dependency runs directly (#56): the
 * version md2pdf was installed with, offline, and with the Chromium that
 * Puppeteer downloaded at install time. `npx <pkg>@<version>` could not
 * provide that for a global install — it runs in the user's directory, finds
 * nothing there, and fetches every tool plus another Chromium into its own
 * cache. An override still goes through npx on purpose, to try a different
 * version without reinstalling.
 *
 * @param tool - Tool to start.
 * @param override - npx package selector for the tool, if any.
 * @param environment - Process and filesystem access.
 * @returns The executable, its leading arguments, and the label for errors.
 */
export function resolveToolInvocation(
  tool: ToolName,
  override: string | undefined,
  environment: ToolEnvironment,
): ToolInvocation {
  if (override) {
    const npx = locateNpxInvocation(environment.platform, environment.execPath, environment.exists);
    return { file: npx.file, leadingArgs: [...npx.leadingArgs, override], label: `npx ${override}` };
  }

  const { packageName } = TOOL_PACKAGES[tool];
  const bin = locateInstalledBin(tool, environment.searchPaths(packageName), environment.readFile);
  return { file: environment.execPath, leadingArgs: [bin], label: packageName };
}

/**
 * Finds the CLI script of an installed tool package.
 *
 * `require.resolve('<pkg>/package.json')` cannot do this: a package whose
 * `exports` map does not list `./package.json` — mermaid-cli is one — makes it
 * throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. The `node_modules` directories Node
 * would search are walked instead, which covers the repository checkout, npm's
 * global layout and pnpm's symlinked store alike. As in Node's own resolution,
 * the nearest package wins, even when it turns out to lack the command.
 *
 * @param tool - Tool to look up.
 * @param searchPaths - `node_modules` directories, nearest first.
 * @param readFile - Reads a file as text, or returns `undefined` when it cannot be read.
 * @returns Absolute path of the script the package's `bin` entry names.
 * @throws When no directory holds the package, or the nearest one has no such command.
 */
export function locateInstalledBin(
  tool: ToolName,
  searchPaths: string[],
  readFile: (file: string) => string | undefined,
): string {
  const { packageName, binName, overrideEnv } = TOOL_PACKAGES[tool];
  const manifests = searchPaths.map((directory) => path.join(directory, packageName, 'package.json'));

  for (const manifest of manifests) {
    const text = readFile(manifest);
    if (text === undefined) {
      continue;
    }

    const entry = binEntry(parseJson(text), packageName, binName);
    if (!entry) {
      throw new Error(`${manifest} has no "${binName}" command. Reinstall md2pdf, or set ${overrideEnv} to run it through npx.`);
    }

    return path.resolve(path.dirname(manifest), entry);
  }

  throw new Error(
    `Could not find the installed ${packageName} package. Reinstall md2pdf, or set ${overrideEnv} to run it through npx. ` +
      `Looked in:\n${manifests.map((manifest) => `  ${manifest}`).join('\n')}`,
  );
}

/**
 * Picks the script a package's `bin` field starts for a command.
 *
 * A `bin` string belongs to the command named after the package without its
 * scope, as npm links it.
 *
 * @param manifest - Parsed `package.json`.
 * @param packageName - Name of the package, used for a `bin` string.
 * @param binName - Command to look up.
 * @returns The script path as written in the manifest, or `undefined`.
 */
export function binEntry(manifest: unknown, packageName: string, binName: string): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) {
    return undefined;
  }

  const { bin } = manifest as { bin?: unknown };
  if (typeof bin === 'string') {
    return packageName.split('/').pop() === binName ? bin : undefined;
  }

  if (typeof bin === 'object' && bin !== null) {
    const entry = (bin as Record<string, unknown>)[binName];
    return typeof entry === 'string' ? entry : undefined;
  }

  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Determines how to spawn npx without going through a shell.
 *
 * On Windows the `npx` on `PATH` is `npx.cmd`, a batch file that Node refuses
 * to spawn with `shell: false` (the CVE-2024-27980 hardening). Running the
 * bundled `npx-cli.js` with the current Node binary is the equivalent
 * invocation that needs no shell. Everywhere else `npx` is directly
 * executable.
 *
 * @param platform - Platform to resolve for, normally `process.platform`.
 * @param execPath - Path of the running Node binary, normally `process.execPath`.
 * @param exists - Existence check for candidate paths, normally `fs.existsSync`.
 * @returns The executable to spawn and the arguments that must precede the npx arguments.
 */
export function locateNpxInvocation(
  platform: NodeJS.Platform,
  execPath: string,
  exists: (candidate: string) => boolean,
): ProcessInvocation {
  if (platform !== 'win32') {
    return { file: 'npx', leadingArgs: [] };
  }

  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const npxCli = candidates.find((candidate) => exists(candidate));

  if (!npxCli) {
    throw new Error(
      `Could not locate npm's npx-cli.js next to ${execPath}. ` +
        `Looked in:\n${candidates.map((candidate) => `  ${candidate}`).join('\n')}`,
    );
  }

  return { file: execPath, leadingArgs: [npxCli] };
}

/** The signals that end the whole run when they stop a tool (#98). */
export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/**
 * Thrown instead of a tool failure when the tool was stopped by Ctrl-C or
 * SIGTERM, so the run ends instead of moving on to the next file (#98).
 */
export class InterruptedError extends Error {
  /** The signal that stopped the tool. */
  readonly signal: InterruptSignal;

  /**
   * @param signal - The signal that stopped the tool.
   */
  constructor(signal: InterruptSignal) {
    super(`Interrupted by ${signal}`);
    this.name = 'InterruptedError';
    this.signal = signal;
  }

  /** 128 + the signal number, the shell convention for a terminated process. */
  get exitCode(): number {
    return this.signal === 'SIGINT' ? 130 : 143;
  }
}

/**
 * `STATUS_CONTROL_C_EXIT`, the exit status of a Windows process ended by a
 * console Ctrl-C, unsigned and as a signed 32-bit value.
 */
const WINDOWS_CTRL_C_EXIT = [0xc000013a, -0x3ffffec6];

/**
 * Tells whether a failed tool run was stopped by the user rather than failing
 * on its own.
 *
 * Ctrl-C reaches the whole process group, so the tool dies with it. md2pdf's
 * own signal handler cannot react to it while the run is going: the pipeline
 * is synchronous, and the handler only runs once the main event loop turns
 * again, which is after the last file (#98). The failed tool run is the one
 * place where control comes back, so the interrupt is recognised there:
 *
 * - killed by `SIGINT`/`SIGTERM` (POSIX);
 * - exit status 130/143, which a tool that catches the signal itself uses —
 *   Puppeteer, inside md-to-pdf and mermaid-cli, exits with 130 on SIGINT;
 * - `STATUS_CONTROL_C_EXIT` (Windows).
 *
 * A timeout also kills the tool with SIGTERM, but that is md2pdf's own doing,
 * not the user's, and stays an ordinary failure.
 *
 * @param error - Value thrown by `execFileSync`.
 * @returns The signal to end the run with, or `undefined` for an ordinary failure.
 */
export function interruptSignal(error: unknown): InterruptSignal | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, signal, status } = error as { code?: unknown; signal?: unknown; status?: unknown };
  if (code === 'ETIMEDOUT') {
    return undefined;
  }
  if (signal === 'SIGINT' || signal === 'SIGTERM') {
    return signal;
  }
  if (status === 130 || WINDOWS_CTRL_C_EXIT.includes(status as number)) {
    return 'SIGINT';
  }
  if (status === 143) {
    return 'SIGTERM';
  }

  return undefined;
}

/**
 * Builds the message for a failed tool run.
 *
 * The tool's own output is the most useful explanation, so stderr and stdout
 * are preferred over the generic message `execFileSync` attaches. A tool that
 * md2pdf stopped itself because it ran past the timeout is reported as such,
 * together with the variable that raises the limit: it usually printed
 * nothing, and a bare `<tool> failed` did not say what happened (#102).
 *
 * @param error - Value thrown by `execFileSync`.
 * @param label - Name of the failed tool, used when it printed nothing.
 * @param timeoutMs - The timeout the tool ran with, `undefined` when disabled.
 * @returns The message to re-throw.
 */
export function formatExecError(error: unknown, label: string, timeoutMs?: number): string {
  if (!isExecError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const details = [error.stderr?.toString(), error.stdout?.toString()].filter(Boolean).join('\n').trim();
  if (error.code === 'ETIMEDOUT') {
    const limit = timeoutMs === undefined ? 'the time limit' : formatDuration(timeoutMs);
    const timedOut =
      `${label} did not finish within ${limit} and was stopped. ` +
      'Set MD2PDF_TOOL_TIMEOUT (milliseconds, 0 disables the limit) to allow longer.';
    return details ? `${timedOut}\n${details}` : timedOut;
  }

  return details || `${label} failed`;
}

/**
 * Renders a duration in the largest whole unit that expresses it exactly.
 *
 * @param ms - Duration in milliseconds.
 * @returns E.g. `10 minutes`, `1 second`, `1500 ms`.
 */
function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [60 * 60 * 1000, 'hour'],
    [60 * 1000, 'minute'],
    [1000, 'second'],
  ];
  for (const [size, unit] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return `${count} ${unit}${count === 1 ? '' : 's'}`;
    }
  }

  return `${ms} ms`;
}

function isExecError(
  error: unknown,
): error is { stdout?: Buffer | string; stderr?: Buffer | string; code?: unknown } {
  return typeof error === 'object' && error !== null && ('stdout' in error || 'stderr' in error);
}
