/**
 * Pins the types that `@open-claude-code/tool-runtime` re-declares to the host
 * definitions they mirror.
 *
 * Wave C2 of the tool-runtime dependency inversion removed the `import type`
 * edges that ran from the Tool contract back into `src/`. Most of those types
 * are now declared a second time inside the package
 * (`types/hostContracts.ts`), which buys the leaf property at the cost of a
 * copy — and a copy can drift.
 *
 * This file is that drift alarm. It is a *compile-time* test: the assertions
 * below are type-level, so the real check runs under `bun run typecheck`, and
 * an incompatible change on either side fails the build. The runtime `expect`
 * exists only so the file is a legitimate `bun test` target and shows up in
 * the suite.
 *
 * Not covered here, deliberately:
 *
 *   - Types re-pointed at a leaf package that already owns them (the Message
 *     family and SystemPrompt from `@ant/model-provider`, LangfuseSpan from
 *     `@langfuse/tracing`, `Resource` from the MCP SDK). Those are the *same*
 *     type, not a copy.
 *   - Types bound through `types/hostBindings.ts` (AppState, Command,
 *     MCPServerConnection, AgentDefinition, AgentDefinitionsResult). Module
 *     augmentation gives exact identity, so there is nothing to compare.
 *   - FileStateCache, whose implementation moved into the package outright.
 */

import { describe, expect, test } from 'bun:test'

import type * as TR from '@open-claude-code/tool-runtime/types/hostContracts.js'
import type { CanUseToolFn as ContractCanUseToolFn } from '@open-claude-code/tool-runtime/Tool.js'

import type { CanUseToolFn as HostCanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { SpinnerMode } from 'src/components/Spinner.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import type { SDKStatus } from 'src/entrypoints/agentSdkTypes.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from 'src/types/hooks.js'
import type { AgentId } from 'src/types/ids.js'
import type { FileAttributionState } from 'src/types/logs.js'
import type { ToolProgressData } from 'src/types/tools.js'
import type { DeepImmutable } from 'src/types/utils.js'
import type { AttributionState } from 'src/utils/commitAttribution.js'
import type {
  FileHistoryBackup,
  FileHistorySnapshot,
  FileHistoryState,
} from 'src/utils/filesystem/fileHistory.js'
import type { DenialTrackingState } from 'src/utils/permissions/denialTracking.js'
import type { Theme, ThemeName } from 'src/utils/terminal/theme.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import type { ContentReplacementState } from 'src/utils/toolResultStorage.js'

/**
 * Asserts `A` and `B` are the same type, invariantly.
 *
 * Mutual assignability (`A extends B` and `B extends A`) is too weak for this
 * job: it treats `{ a: string }` and `{ a: string; b?: never }` as equal, and
 * it accepts `any` on either side. The conditional pair below compares the
 * types as written, so a widened field or an accidental `any` is caught.
 */
type IsExactly<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false

/** Compiles only when `A` and `B` are exactly the same type. */
function assertExact<A, B>(
  _witness: IsExactly<A, B> extends true ? true : never,
): void {
  void _witness
}

/**
 * Compiles only when `Sub` is assignable to `Super`. Used where the contract
 * deliberately declares a subset of the host type rather than a clone.
 */
function assertAssignableTo<Sub extends Super, Super>(): void {}

describe('tool-runtime host type contract', () => {
  test('re-declared scalar and union types match the host exactly', () => {
    assertExact<TR.QuerySource, QuerySource>(true)
    assertExact<TR.SDKStatus, SDKStatus>(true)
    assertExact<TR.AgentId, AgentId>(true)
    assertExact<TR.ThinkingConfig, ThinkingConfig>(true)
    assertExact<TR.SpinnerMode, SpinnerMode>(true)
    assertExact<TR.ThemeName, ThemeName>(true)
    assertExact<TR.ToolProgressData, ToolProgressData>(true)
    expect(true).toBe(true)
  })

  test('the theme colour union is exactly the host palette key set', () => {
    // `userFacingNameBackgroundColor` returns this; it used to be `keyof Theme`.
    // Adding or renaming a Theme key on the host must fail here.
    assertExact<TR.ThemeColorName, keyof Theme>(true)
    expect(true).toBe(true)
  })

  test('re-declared state records match the host exactly', () => {
    assertExact<TR.DenialTrackingState, DenialTrackingState>(true)
    assertExact<TR.ContentReplacementState, ContentReplacementState>(true)
    assertExact<TR.FileAttributionState, FileAttributionState>(true)
    assertExact<TR.AttributionState, AttributionState>(true)
    assertExact<TR.FileHistoryBackup, FileHistoryBackup>(true)
    assertExact<TR.FileHistorySnapshot, FileHistorySnapshot>(true)
    assertExact<TR.FileHistoryState, FileHistoryState>(true)
    expect(true).toBe(true)
  })

  test('re-declared hook types match the host exactly', () => {
    assertExact<TR.HookProgress, HookProgress>(true)
    assertExact<TR.PromptRequest, PromptRequest>(true)
    assertExact<TR.PromptResponse, PromptResponse>(true)
    expect(true).toBe(true)
  })

  test('DeepImmutable behaves identically on a representative payload', () => {
    // DeepImmutable is generic, so it cannot be compared directly; compare its
    // application. The host version is currently an identity stub, and
    // ToolPermissionContext is computed through it.
    type Payload = { a: string; b: { c: number }; d: readonly string[] }
    assertExact<TR.DeepImmutable<Payload>, DeepImmutable<Payload>>(true)
    expect(true).toBe(true)
  })

  test('the Notification copy matches the host exactly', () => {
    // `addNotification` takes this as a parameter, so the position is
    // contravariant: the host's handler is assignable to the contract's field
    // only while the package's Notification is a subtype of the host's.
    // Exactness is the stronger guarantee, and it currently holds.
    assertExact<TR.Notification, Notification>(true)
    assertAssignableTo<TR.Notification, Notification>()
    assertAssignableTo<Notification, TR.Notification>()
    expect(true).toBe(true)
  })

  test('CanUseToolFn matches the host declaration exactly', () => {
    // This one is a copy in the other direction: the contract declares it (it
    // takes a Tool and a ToolUseContext, so it cannot be imported from the
    // host without a cycle), and `src/hooks/useCanUseTool.tsx` still declares
    // its own for its callers. Two declarations, so the same drift risk.
    assertExact<ContractCanUseToolFn, HostCanUseToolFn>(true)
    expect(true).toBe(true)
  })
})
