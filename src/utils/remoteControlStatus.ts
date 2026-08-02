import { HAPPY_BIN, HAPPY_NPM_PACKAGE } from '../cli/remoteControlLauncher.js'
import { whichSync } from './process/which.js'

/**
 * Local view of remote-control readiness.
 *
 * Remote control is Happy driving `occ --acp`, so "is it available here" is
 * two facts: whether the `happy` binary is on PATH, and whether the user has
 * pointed it at a self-hosted server.
 */
export function formatRemoteControlLocalStatus(): string {
  try {
    const happyPath = whichSync(HAPPY_BIN)
    const server = process.env.HAPPY_SERVER_URL
    return [
      `Remote Control: ${happyPath ? 'ready' : 'unavailable'} (via Happy over ACP)`,
      `  happy=${happyPath ?? `not found — npm install -g ${HAPPY_NPM_PACKAGE}`}`,
      `  server=${server ? `${server} (self-hosted)` : 'default (Happy hosted relay)'}`,
      '  agent=occ --acp',
    ].join('\n')
  } catch (error) {
    return [
      'Remote Control: unknown',
      `  reason=${error instanceof Error ? error.message : String(error)}`,
    ].join('\n')
  }
}
