#!/usr/bin/env node

import fs from 'fs';
import { createProgram } from './cli-program';
import { formatError, PipelineReporter, runPipeline } from './pipeline';
import { resolveOptions } from './steps/resolve-options';
import { createStatusLine } from './steps/status-line';
import { runTool } from './steps/run-tool';
import { createTempRegistry } from './steps/temp-registry';
import { ConverterOptions } from './types';

const program = createProgram().parse(process.argv);

if (program.args.length === 0) {
  // `error: true` sends the help to stderr and exits 1: invoking the tool
  // with no arguments is a usage error, not a successful run (#51).
  program.help({ error: true });
}

let options: ConverterOptions;
try {
  options = resolveOptions(program);
} catch (error) {
  console.error(formatError(error));
  process.exit(1);
}

void main(options).catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});

/**
 * Wires the run to this process: the `@clack/prompts` UI, the temp-directory
 * registry the signal handlers empty, and the exit code.
 *
 * The conversion itself lives in `pipeline.ts` (#71). What stays here is what
 * cannot be tested because it *is* the process — the argument parsing above,
 * the terminal, the signal handlers and `process.exit`.
 *
 * @param options - Resolved converter options for the run.
 */
async function main(options: ConverterOptions): Promise<void> {
  const { S_STEP_ACTIVE, intro, isTTY, log, outro } = await import('@clack/prompts');

  // The live line only makes sense on a terminal: piped into a file or a CI
  // log its escape sequences would end up in the output, and `--verbose` wants
  // a durable line per step rather than one that is overwritten (#59).
  const interactive = isTTY(process.stdout) && !options.verbose;
  const status = createStatusLine(process.stdout, interactive);

  // Every message blanks the live line first, so nothing the run prints can
  // collide with the step that is still on screen.
  const reporter: PipelineReporter = {
    intro: (message) => {
      status.hide();
      intro(message);
    },
    outro: (message) => {
      status.hide();
      outro(message);
    },
    info: (message) => {
      status.hide();
      log.info(message);
    },
    success: (message) => {
      status.hide();
      log.success(message);
    },
    warn: (message) => {
      status.hide();
      log.warn(message);
    },
    error: (message) => {
      status.hide();
      log.error(message);
    },
    // Shows what is running right now, in clack's own line shape.
    status: (text) => status.show(`${S_STEP_ACTIVE}  ${text}`),
    clearStatus: () => status.hide(),
    interactive,
  };

  // `finally` covers a failure but not a signal, so every live temp directory
  // is registered and removed on Ctrl-C as well (#51). While an external tool
  // runs, `execFileSync` blocks the event loop and the handler only fires once
  // that child has exited — which the same Ctrl-C asks it to do, since the
  // signal reaches the whole process group.
  const tempDirs = createTempRegistry(
    (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    options.keepTemp,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      status.hide();
      tempDirs.removeAll();
      // 128 + signal number, the shell convention for a terminated process.
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  // A successful run returns and lets Node exit on its own, as it always has;
  // only a failure sets the exit code explicitly.
  const exitCode = runPipeline(program.args, options, { reporter, tempDirs, run: runTool });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
