// Progress-payload type stubs. The decompiled source (here AND in the
// reference tree) never yielded real definitions — this file was referenced
// by imports but not emitted. Restoring real types is NOT a local fix:
// `ToolProgressData` is pinned exact-equal to tool-runtime's (also `any`) by
// src/__tests__/toolRuntimeTypeContract.test.ts, so it must be migrated in
// lockstep across packages, and the shapes have to be reconstructed from
// each tool's onProgress call sites. Tracked as a standalone migration —
// do not "fix" a single alias here in passing.
export type AgentToolProgress = any
export type BashProgress = any
export type MCPProgress = any
export type REPLToolProgress = any
export type SkillToolProgress = any
export type TaskOutputProgress = any
export type ToolProgressData = any
export type WebSearchProgress = any
export type ShellProgress = any
export type PowerShellProgress = any
export type SdkWorkflowProgress = any
