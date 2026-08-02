// Re-export shim — types live in tool-runtime/permissions/PermissionResult.ts
// (extracted to break import cycles; see its header). Stays behind so
// existing `src/*` importers and test mocks keep resolving unchanged.
export * from '@open-claude-code/tool-runtime/permissions/PermissionResult.js'
