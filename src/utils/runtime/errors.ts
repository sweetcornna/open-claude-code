// Re-export shim — implementation lives in tool-runtime/errors.ts (kept
// dependency-free there; see its function-level comments, e.g. why
// classifyAxiosError checks .isAxiosError directly). This file stays behind
// so existing `src/*` importers and test mocks keep resolving unchanged.
export * from '@open-claude-code/tool-runtime/errors.js'
