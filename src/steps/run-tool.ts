import { execFileSync } from 'child_process';
import fs from 'fs';
import { PackageOverrides, ToolName } from '../types';
import {
  formatExecError,
  InterruptedError,
  interruptSignal,
  resolveToolInvocation,
  ToolEnvironment,
} from './tool-invocation';

type RunToolOptions = {
  verbose: boolean;
  packageOverrides: PackageOverrides;
};

/**
 * Wall-clock limit for one external tool, overridable via `MD2PDF_TOOL_TIMEOUT`
 * (milliseconds; `0` disables it).
 *
 * mermaid-cli and md-to-pdf both drive a headless Chromium, which can hang
 * instead of exiting — without a limit the run blocks forever with a spinner
 * that never stops (#51). Ten minutes is far above a normal render of a large
 * document and still ends a wedged process.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Output buffer for a piped run.
 *
 * The tools are chatty on failure — 10 MiB was reachable, and exceeding it
 * killed the child with `ENOBUFS`, reported as a tool failure (#51).
 */
const OUTPUT_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * The running process and its filesystem, for {@link resolveToolInvocation}.
 *
 * Packages are searched from this module's own directory, which is where
 * `require('<package>')` would resolve from: the checkout's `node_modules` in
 * development, the package's own dependencies once installed.
 */
const PROCESS_ENVIRONMENT: ToolEnvironment = {
  platform: process.platform,
  execPath: process.execPath,
  exists: fs.existsSync,
  searchPaths: (packageName) => require.resolve.paths(packageName) ?? [],
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * Resolves the tool timeout from the environment.
 *
 * @param env - Environment to read `MD2PDF_TOOL_TIMEOUT` from.
 * @returns The timeout in milliseconds, or `undefined` when disabled.
 */
export function resolveToolTimeout(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.MD2PDF_TOOL_TIMEOUT?.trim();
  if (!raw) {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid MD2PDF_TOOL_TIMEOUT: ${raw}. Expected a number of milliseconds.`);
  }

  return parsed === 0 ? undefined : parsed;
}

/**
 * Runs one conversion tool with optional inherited stdio.
 *
 * The tool is the installed dependency, or npx for a `*_PKG` override (see
 * {@link resolveToolInvocation}). Arguments are passed as an array and the
 * child process is spawned without a shell, so no value is ever reinterpreted
 * by `cmd.exe` or `/bin/sh`.
 *
 * The child is given a wall-clock timeout and a generous output buffer, so a
 * wedged Chromium ends the run instead of blocking it forever and a chatty
 * failure is not turned into an `ENOBUFS` error (#51). A tool stopped by
 * Ctrl-C or SIGTERM throws an {@link InterruptedError}, which ends the whole
 * run instead of failing only the current file (#98).
 *
 * @param tool - Tool to run.
 * @param args - Arguments for the tool's CLI.
 * @param options - Output handling and the npx overrides of the run.
 */
export function runTool(tool: ToolName, args: string[], options: RunToolOptions): void {
  const { file, leadingArgs, label } = resolveToolInvocation(
    tool,
    options.packageOverrides[tool],
    PROCESS_ENVIRONMENT,
  );

  const timeout = resolveToolTimeout();
  try {
    execFileSync(file, [...leadingArgs, ...args], {
      encoding: 'utf8',
      maxBuffer: OUTPUT_BUFFER_BYTES,
      timeout,
      stdio: options.verbose ? 'inherit' : 'pipe',
    });
  } catch (error) {
    const signal = interruptSignal(error);
    if (signal) {
      throw new InterruptedError(signal);
    }
    throw new Error(formatExecError(error, label, timeout));
  }
}
