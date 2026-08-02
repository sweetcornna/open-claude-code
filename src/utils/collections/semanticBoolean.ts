// Re-export shim — implementation lives in tool-runtime/semanticBoolean.ts;
// its header explains why z.coerce.boolean() is the wrong fix. Stays behind
// so existing `src/*` importers and test mocks keep resolving unchanged.
export * from '@open-claude-code/tool-runtime/semanticBoolean.js'
