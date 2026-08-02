/**
 * Structural re-declarations of host-owned types that the Tool contract
 * references.
 *
 * Wave C2 of the tool-runtime dependency inversion burned down the `import
 * type` edges that ran from `Tool.ts` back into `src/`. Those edges were
 * erased at compile time and so cost nothing at runtime, but they kept this
 * package from being a true leaf: `madge` and `tsc` both still saw
 * tool-runtime → src, so every host module that imports the Tool contract sat
 * on a cycle.
 *
 * Each type below is declared here structurally, at the shape the contract
 * actually needs. The host keeps its own definition; the two are pinned
 * together by `src/__tests__/toolRuntimeTypeContract.test.ts`, which asserts
 * mutual assignability so that drift on either side fails `bun run typecheck`
 * rather than silently widening the contract.
 *
 * Types NOT re-declared here, because a genuine leaf package already owns
 * them and importing it keeps exact type identity (strictly better than a
 * copy — nothing to drift):
 *
 *   Message family, SystemPrompt   `@ant/model-provider`
 *   LangfuseSpan                   `@langfuse/tracing`
 *   PermissionResult, PermissionMode, ...  `./permissions.js` (wave A)
 */

/**
 * Mirrors `src/types/utils.ts`. The host definition is currently an identity
 * stub; reproducing it verbatim keeps `ToolPermissionContext` byte-identical
 * to what the host used to compute.
 */
export type DeepImmutable<T> = T

/**
 * Mirrors `src/types/tools.ts`. That module is an auto-generated stub in which
 * every progress payload is `any`, so the contract's generic parameter
 * `P extends ToolProgressData` is unconstrained. Reproduced verbatim rather
 * than tightened: narrowing it here would reject existing tool progress
 * payloads that the host accepts.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors the host stub in src/types/tools.ts, which is `any`.
export type ToolProgressData = any

/**
 * Mirrors `src/constants/querySource.ts`. Deliberately `string`: the value
 * domain grows with features (`repl_main_thread:*`, `agent:*` prefixes), so
 * the host models it as a free-text telemetry label rather than a union.
 */
export type QuerySource = string

/**
 * Mirrors `src/entrypoints/sdk/coreTypes.generated.ts`. The literals are
 * documentation only — the trailing `| string` makes this equivalent to
 * `string`, and it is reproduced in that form so the two stay assignable in
 * both directions.
 */
export type SDKStatus = 'active' | 'idle' | 'error' | string

/**
 * Mirrors `src/types/ids.ts`. Branded so an AgentId can never be confused
 * with a SessionId, matching the treatment `bootstrapState.ts` already gives
 * `SessionId` in this package. The brand is structural, so the host's
 * `AgentId` and this one are the same type to `tsc`.
 */
export type AgentId = string & { readonly __brand: 'AgentId' }

/** Mirrors `src/utils/thinking.ts`. */
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/** Mirrors `src/utils/permissions/denialTracking.ts`. */
export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}

/** Mirrors `src/utils/toolResultStorage.ts`. */
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}
