/**
 * Whether the headless Chromium that mermaid-cli and md-to-pdf start keeps
 * its sandbox (#95).
 *
 * Chromium refuses to start as root with the sandbox on ("Running as root
 * without --no-sandbox is not supported"), which is how md2pdf runs in a
 * container, a CI image or a cloud development session. The sandbox is
 * therefore switched off for root, and on request through `MD2PDF_NO_SANDBOX=1`
 * for a non-root user whose sandbox cannot start either (e.g. blocked user
 * namespaces). Everywhere else it stays on.
 */

/** Why the sandbox is off, or `undefined` while it stays on. */
export type SandboxOffReason = 'root' | 'env';

/**
 * Decides whether Chromium runs without its sandbox.
 *
 * `MD2PDF_NO_SANDBOX` takes `1` to switch the sandbox off, and `0` or an empty
 * value to leave the decision to the user id. Any other value is an error, so
 * a typo cannot leave a run that fails as before without saying why.
 *
 * @param env - Environment to read `MD2PDF_NO_SANDBOX` from.
 * @param uid - The process's user id; `undefined` where the platform has none (Windows).
 * @returns Why the sandbox is off, or `undefined` when it stays on.
 */
export function resolveSandboxOff(env: NodeJS.ProcessEnv, uid: number | undefined): SandboxOffReason | undefined {
  const raw = env.MD2PDF_NO_SANDBOX?.trim() ?? '';

  if (raw === '1') {
    return 'env';
  }
  if (raw !== '' && raw !== '0') {
    throw new Error(`Invalid MD2PDF_NO_SANDBOX: ${raw}. Expected 1, or 0 to decide by the user id.`);
  }

  return uid === 0 ? 'root' : undefined;
}

/**
 * The `--verbose` line for a run whose Chromium has no sandbox.
 *
 * @param reason - Why the sandbox is off.
 */
export function describeSandboxOff(reason: SandboxOffReason): string {
  return reason === 'root'
    ? 'Chromium runs without its sandbox (running as root)'
    : 'Chromium runs without its sandbox (MD2PDF_NO_SANDBOX=1)';
}
