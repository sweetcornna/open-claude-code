// Re-export shim — implementation lives in tool-runtime/stringUtils.ts (see
// its header for what it is). This file stays behind so existing `src/*`
// importers and `mock.module('src/...')` in tests keep resolving unchanged.
export * from '@open-claude-code/tool-runtime/stringUtils.js'
