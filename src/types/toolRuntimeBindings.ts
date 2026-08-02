/**
 * Binds the host's real types into the tool-runtime Tool contract.
 *
 * `@open-claude-code/tool-runtime` is a leaf package: it must not import from
 * `src/`, or every host module that touches the Tool contract lands back on an
 * import cycle. But a few types genuinely have to flow into the contract —
 * `ToolUseContext` carries the app state, the slash-command list, the MCP
 * connections and the agent definitions — and those are far too large to copy
 * into the package (see the header of `types/hostBindings.ts` for the
 * measurements that ruled copying out).
 *
 * So the package declares empty slots and this file fills them, using module
 * augmentation. The import direction is host → package, which is the direction
 * the layering allows, so tool-runtime keeps zero outgoing edges while the
 * contract still sees the host's exact types — not approximations of them.
 *
 * This file is type-only and emits nothing. It does not need to be imported:
 * `tsc` picks it up from the `include` glob, and the augmentation is then
 * global to the program. If it were ever dropped from compilation the slots
 * would fall back to placeholder types and typecheck would fail loudly at
 * hundreds of sites, which is the intended failure mode.
 *
 * To bind another type: add the member here and the matching alias in
 * `packages/tool-runtime/src/types/hostBindings.ts`. Prefer a structural
 * re-declaration in `types/hostContracts.ts` when the type is small and
 * closed — binding is for the ones that are not.
 */

declare module '@open-claude-code/tool-runtime/types/hostBindings.js' {
  interface HostTypeBindings {
    AgentDefinition: import('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js').AgentDefinition
    AgentDefinitionsResult: import('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js').AgentDefinitionsResult
    AppState: import('src/state/AppStateStore.js').AppState
    Command: import('src/types/command.js').Command
    MCPServerConnection: import('src/services/mcp/types.js').MCPServerConnection
  }
}

export {}
