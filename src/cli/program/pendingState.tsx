// Extracted verbatim from src/main.tsx (S7-4b split).
//
// Module-level argv handoff between `main()` (which strips `assistant` / `ssh`
// out of process.argv before Commander parses it) and the root action (which
// reads the stashed values). Both sides must observe the same object identity,
// so this has to live in exactly one module.
import { feature } from 'bun:bundle';

// Set by early argv processing when `claude assistant [sessionId]` is detected
export type PendingAssistantChat = { sessionId?: string; discover: boolean };
export const _pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS')
  ? { sessionId: undefined, discover: false }
  : undefined;

// `claude ssh <host> [dir]` — parsed from argv early so the main command
// path can pick it up and hand
// the REPL an SSH-backed session instead of a local one.
export type PendingSSH = {
  host: string | undefined;
  cwd: string | undefined;
  permissionMode: string | undefined;
  dangerouslySkipPermissions: boolean;
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean;
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[];
  remoteBin: string | undefined;
};
export const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE')
  ? {
      host: undefined,
      cwd: undefined,
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
      remoteBin: undefined,
    }
  : undefined;
