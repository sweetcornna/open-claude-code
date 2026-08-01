/**
 * Exit codes the supervisor uses to decide retry vs park.
 * Permanent errors (bad worker kind, unusable config) use EXIT_CODE_PERMANENT
 * so the supervisor doesn't waste cycles retrying.
 */
const EXIT_CODE_PERMANENT = 78 // EX_CONFIG from sysexits.h

/**
 * Worker kinds this build knows how to run.
 *
 * Empty since remote control moved to Happy over ACP — the `remoteControl`
 * worker was a headless driver for occ's own bridge, and there is no bridge
 * any more. The supervisor machinery (spawn, backoff, park, state file) is
 * kept as the extension point for the next long-running worker.
 */
export const DAEMON_WORKER_KINDS: readonly string[] = []

/**
 * Daemon worker entry point. Called from `cli.tsx` via:
 *   `occ --daemon-worker=<kind>`
 *
 * The supervisor spawns this as a child process. Each `kind` maps to a
 * different long-running task.
 */
export async function runDaemonWorker(kind?: string): Promise<void> {
  if (!kind) {
    console.error('Error: --daemon-worker requires a worker kind')
    process.exitCode = EXIT_CODE_PERMANENT
    return
  }

  console.error(`Error: unknown daemon worker kind '${kind}'`)
  process.exitCode = EXIT_CODE_PERMANENT
}
