/**
 * Argument parsing for `/remote-control`. Kept apart from bridge.tsx so the
 * subcommand surface can be pinned by tests without pulling in Ink, the
 * command registry, or the bridge transport.
 */

export type RemoteControlAuthAction = 'login' | 'register'

type RemoteControlInvocation =
  | { kind: 'logout' }
  | { kind: 'status' }
  | { kind: 'auth'; action: RemoteControlAuthAction }
  /** Connect the current REPL, optionally naming the remote session. */
  | { kind: 'connect'; name?: string }

/**
 * `login` / `register` / `logout` / `status` are reserved words; anything else
 * is a session name. A name is therefore only ever an explicit third value —
 * an empty argument means "no name", not the empty-string name.
 */
export function parseRemoteControlArgs(args: string): RemoteControlInvocation {
  const value = args.trim()
  switch (value) {
    case 'logout':
      return { kind: 'logout' }
    case 'status':
      return { kind: 'status' }
    case 'login':
    case 'register':
      return { kind: 'auth', action: value }
    default:
      return { kind: 'connect', name: value || undefined }
  }
}
