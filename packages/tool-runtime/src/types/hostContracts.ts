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
 *   FileState, FileStateCache      `../fileStateCache.js` (moved into this
 *                                  package: the host class is nominal, see
 *                                  that file's header)
 */

import type { UUID } from 'crypto'

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
 * payloads that the host accepts. (`noExplicitAny` is among the disabled
 * rules, so no suppression comment — it would be flagged as ineffective.)
 */
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

/**
 * Mirrors `src/components/Spinner/types.ts`, re-exported by
 * `src/components/Spinner.tsx`.
 */
export type SpinnerMode =
  | 'tool-input'
  | 'tool-use'
  | 'responding'
  | 'thinking'
  | 'requesting'

/** Mirrors `THEME_NAMES` in `src/utils/theme.ts`. */
export type ThemeName =
  | 'dark'
  | 'light'
  | 'light-daltonized'
  | 'dark-daltonized'
  | 'light-ansi'
  | 'dark-ansi'

/**
 * The key set of the host `Theme` record (`src/utils/theme.ts`).
 *
 * The Tool contract only ever uses `keyof Theme` — it names a palette entry,
 * it never reads one. Declaring the key union directly (rather than copying
 * the 69-field `{ [k]: string }` record) keeps that intent legible and stops
 * this package from looking like it owns a color palette. The contract test
 * pins this union to `keyof Theme` in both directions, so adding or renaming
 * a theme key on the host fails typecheck here.
 */
export type ThemeColorName =
  | 'autoAccept'
  | 'bashBorder'
  | 'claude'
  | 'claudeShimmer'
  | 'claudeBlue_FOR_SYSTEM_SPINNER'
  | 'claudeBlueShimmer_FOR_SYSTEM_SPINNER'
  | 'permission'
  | 'permissionShimmer'
  | 'planMode'
  | 'ide'
  | 'promptBorder'
  | 'promptBorderShimmer'
  | 'text'
  | 'inverseText'
  | 'inactive'
  | 'inactiveShimmer'
  | 'subtle'
  | 'suggestion'
  | 'remember'
  | 'background'
  | 'success'
  | 'error'
  | 'warning'
  | 'merged'
  | 'warningShimmer'
  | 'diffAdded'
  | 'diffRemoved'
  | 'diffAddedDimmed'
  | 'diffRemovedDimmed'
  | 'diffAddedWord'
  | 'diffRemovedWord'
  | 'red_FOR_SUBAGENTS_ONLY'
  | 'blue_FOR_SUBAGENTS_ONLY'
  | 'green_FOR_SUBAGENTS_ONLY'
  | 'yellow_FOR_SUBAGENTS_ONLY'
  | 'purple_FOR_SUBAGENTS_ONLY'
  | 'orange_FOR_SUBAGENTS_ONLY'
  | 'pink_FOR_SUBAGENTS_ONLY'
  | 'cyan_FOR_SUBAGENTS_ONLY'
  | 'professionalBlue'
  | 'chromeYellow'
  | 'clawd_body'
  | 'clawd_background'
  | 'userMessageBackground'
  | 'userMessageBackgroundHover'
  | 'messageActionsBackground'
  | 'selectionBg'
  | 'bashMessageBackgroundColor'
  | 'memoryBackgroundColor'
  | 'rate_limit_fill'
  | 'rate_limit_empty'
  | 'fastMode'
  | 'fastModeShimmer'
  | 'briefLabelYou'
  | 'briefLabelClaude'
  | 'rainbow_red'
  | 'rainbow_orange'
  | 'rainbow_yellow'
  | 'rainbow_green'
  | 'rainbow_blue'
  | 'rainbow_indigo'
  | 'rainbow_violet'
  | 'rainbow_red_shimmer'
  | 'rainbow_orange_shimmer'
  | 'rainbow_yellow_shimmer'
  | 'rainbow_green_shimmer'
  | 'rainbow_blue_shimmer'
  | 'rainbow_indigo_shimmer'
  | 'rainbow_violet_shimmer'

/** Mirrors `src/utils/fileHistory.ts`. */
export type FileHistoryBackup = {
  backupFileName: string | null
  version: number
  backupTime: Date
}

/** Mirrors `src/utils/fileHistory.ts`. */
export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

/** Mirrors `src/utils/fileHistory.ts`. */
export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  snapshotSequence: number
}

/** Mirrors `src/types/logs.ts`. */
export type FileAttributionState = {
  contentHash: string
  claudeContribution: number
  mtime: number
}

/** Mirrors `src/utils/commitAttribution.ts`. */
export type AttributionState = {
  fileStates: Map<string, FileAttributionState>
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>
  surface: string
  startingHeadSha: string | null
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}

/** Mirrors `HOOK_EVENTS` in `src/entrypoints/sdk/coreTypes.ts`. */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'

/** Mirrors `src/types/hooks.ts`. */
export type HookProgress = {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

/**
 * Mirrors `promptRequestSchema` in `src/types/hooks.ts`. The host derives its
 * type via `z.infer`; this is the same shape written out, so the contract does
 * not need zod at the type level.
 */
export type PromptRequest = {
  prompt: string
  message: string
  options: { key: string; label: string; description?: string }[]
}

/** Mirrors `src/types/hooks.ts`. */
export type PromptResponse = {
  prompt_response: string
  selected: string
}

/** Mirrors `src/context/notifications.tsx`. */
export type NotificationPriority = 'low' | 'medium' | 'high' | 'immediate'

type BaseNotification = {
  key: string
  /** Keys of notifications this one invalidates. */
  invalidates?: string[]
  priority: NotificationPriority
  timeoutMs?: number
  /** Combine notifications sharing a key, like Array.reduce(). */
  fold?: (accumulator: Notification, incoming: Notification) => Notification
}

/**
 * Mirrors `src/context/notifications.tsx`.
 *
 * Reproduced in full rather than narrowed to the keys the tools happen to
 * pass today. `addNotification` takes this type as a *parameter*, so the
 * position is contravariant: the host's handler is only assignable to the
 * contract's field if this declaration is a subtype of the host's. Dropping a
 * member here would silently make that assignment illegal the first time a
 * caller used it.
 */
export type Notification =
  | (BaseNotification & { text: string; color?: ThemeColorName })
  | (BaseNotification & { jsx: import('react').ReactNode })
