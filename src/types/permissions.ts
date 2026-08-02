// Re-export shim — pure permission types live in tool-runtime/types/
// permissions.ts (extracted to break import cycles; see its header). Stays
// behind so existing `src/*` importers and test mocks keep resolving.
export * from '@open-claude-code/tool-runtime/types/permissions.js'
