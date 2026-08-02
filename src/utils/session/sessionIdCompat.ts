/**
 * Session ID tag translation for the CCR (Claude Code Web) compat layer.
 *
 * Worker endpoints (/v1/code/sessions/{id}/worker/*) hand out `cse_*`, while
 * the claude.ai frontend routes on `session_*` — compat/convert.go:27 validates
 * TagSession. Same UUID, different costume.
 *
 * Lives in utils/ (not constants/) so `getRemoteSessionUrl` can lazily require
 * it and keep constants/ a leaf of the module DAG at load time.
 */

/**
 * Re-tag a `cse_*` session ID to `session_*` for use with the v1 compat API.
 *
 * No-op for IDs that aren't `cse_*`.
 */
export function toCompatSessionId(id: string): string {
  if (!id.startsWith('cse_')) return id
  return 'session_' + id.slice('cse_'.length)
}
