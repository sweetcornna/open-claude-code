// Re-export shim — implementation lives in tool-runtime/lazySchema.ts
// (defers Zod schema construction from module init to first access). Stays
// behind so existing `src/*` importers and test mocks keep resolving.
export * from '@open-claude-code/tool-runtime/lazySchema.js'
