// Limit the number of cached session-file lookups to prevent unbounded Map growth
// in long-running daemon / swarm sessions that spawn many sub-agents.
export const MAX_CACHED_SESSION_FILES = 200
