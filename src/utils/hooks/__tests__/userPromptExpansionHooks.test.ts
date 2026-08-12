import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getRegisteredHooks,
  getSessionTrustAccepted,
  registerHookCallbacks,
  setSessionTrustAccepted,
} from '../../../bootstrap/state.js'
import { resetTrustDialogAcceptedCacheForTesting } from '../../config/config.js'
import type {
  HookInput,
  HookJSONOutput,
} from '../../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../../state/AppState.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AggregatedHookResult } from '../execution.js'
import { executeUserPromptExpansionHooks } from '../promptExpansionHooks.js'

// No mock.module in this file. Bun's mock.module is process-global and
// last-write-wins across the whole run, so mocking the hooks config or
// settings here would leak into every other test file. Hooks are injected
// through the SDK callback registry (bootstrap state) instead.
//
// The trust setup below is defensive, not cosmetic. executeHooks() opens with
// a security gate: shouldSkipHookDueToTrust() returns true whenever the session
// looks INTERACTIVE and the workspace trust dialog has not been accepted, and
// it returns before running a single hook. Three suites under src/utils/
// (__tests__/tasks.test.ts, task/__tests__/agentScopedTasks.test.ts,
// task/__tests__/agentTagToolIntegration.test.ts) install the shared
// mock.module('src/bootstrap/state.ts', stateMockWith(...)) at file scope, and
// tests/mocks/state.ts deliberately PINS getIsNonInteractiveSession to false.
// mock.module is process-global with no teardown, so once any of those files
// loads, every later file in the shard is "interactive" — untrusted — and every
// hook silently no-ops. That is invisible when this file runs alone and fatal
// under `bun test src/utils/`, which is exactly how it was found.
//
// We cannot un-pin that (other suites rely on it), so we open the other half of
// the gate with the module's own in-memory setter rather than another
// mock.module — setSessionTrustAccepted() short-circuits computeTrustDialogAccepted()
// before it touches config or disk, and works whether or not the state module
// is mocked because the shared mock delegates every non-pinned export to the
// real implementation.

function makeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ sessionHooks: new Map() }) as unknown as AppState,
    options: {},
  } as unknown as ToolUseContext
}

async function collect(
  generator: AsyncGenerator<AggregatedHookResult>,
): Promise<AggregatedHookResult[]> {
  const results: AggregatedHookResult[] = []
  for await (const result of generator) {
    results.push(result)
  }
  return results
}

function registerCallback(
  matcher: string | undefined,
  callback: (input: HookInput) => HookJSONOutput,
): void {
  registerHookCallbacks({
    UserPromptExpansion: [
      {
        matcher,
        hooks: [{ type: 'callback', callback: async input => callback(input) }],
      },
    ],
  })
}

let previousTrust = false

beforeEach(() => {
  previousTrust = getSessionTrustAccepted()
  setSessionTrustAccepted(true)
  resetTrustDialogAcceptedCacheForTesting()
})

afterEach(() => {
  // Restore both halves of the trust state: the session flag AND the latch
  // checkHasTrustDialogAccepted() sets on first true read (`_trustAccepted ||=`).
  // Leaving the latch set would hand "workspace trusted" to every later file in
  // the shard — the same reverse-pollution bug in the other direction.
  setSessionTrustAccepted(previousTrust)
  resetTrustDialogAcceptedCacheForTesting()
  // Drop only this suite's event, not the whole registry: resetSdkInitState()
  // would also null initJsonSchema, which belongs to whoever set it.
  delete getRegisteredHooks()?.UserPromptExpansion
})

describe('executeUserPromptExpansionHooks', () => {
  test('yields nothing when no UserPromptExpansion hook is configured', async () => {
    const results = await collect(
      executeUserPromptExpansionHooks(
        'slash_command',
        'review',
        'HEAD~1',
        'builtin',
        '/review HEAD~1',
        'default',
        makeContext(),
      ),
    )
    expect(results).toEqual([])
  })

  test('passes the official payload shape to the hook', async () => {
    let seen: HookInput | undefined
    registerCallback(undefined, input => {
      seen = input
      return {}
    })

    await collect(
      executeUserPromptExpansionHooks(
        'mcp_prompt',
        'summarize',
        'last 3 files',
        'mcp',
        '/summarize last 3 files',
        'acceptEdits',
        makeContext(),
      ),
    )

    expect(seen).toBeDefined()
    expect(seen).toMatchObject({
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'mcp_prompt',
      command_name: 'summarize',
      command_args: 'last 3 files',
      command_source: 'mcp',
      prompt: '/summarize last 3 files',
      permission_mode: 'acceptEdits',
    })
  })

  test('additionalContext is additive — surfaced separately from the prompt', async () => {
    registerCallback(undefined, () => ({
      hookSpecificOutput: {
        hookEventName: 'UserPromptExpansion',
        additionalContext: 'repo is in a dirty state',
      },
    }))

    const results = await collect(
      executeUserPromptExpansionHooks(
        'slash_command',
        'review',
        '',
        'builtin',
        '/review',
        'default',
        makeContext(),
      ),
    )

    expect(results.flatMap(result => result.additionalContexts ?? [])).toEqual([
      'repo is in a dirty state',
    ])
    // The hook cannot rewrite the prompt: no result carries replacement text.
    expect(results.every(result => !('prompt' in result))).toBe(true)
  })

  test('decision "block" produces a blocking error the caller can veto on', async () => {
    registerCallback(undefined, () => ({
      decision: 'block',
      reason: 'not on main',
    }))

    const results = await collect(
      executeUserPromptExpansionHooks(
        'slash_command',
        'deploy',
        '',
        'builtin',
        '/deploy',
        'default',
        makeContext(),
      ),
    )

    const blocking = results.find(result => result.blockingError)
    expect(blocking?.blockingError?.blockingError).toBe('not on main')
  })

  test('matchers match on command_name', async () => {
    registerCallback('review', () => ({
      hookSpecificOutput: {
        hookEventName: 'UserPromptExpansion',
        additionalContext: 'only for review',
      },
    }))

    const matched = await collect(
      executeUserPromptExpansionHooks(
        'slash_command',
        'review',
        '',
        'builtin',
        '/review',
        'default',
        makeContext(),
      ),
    )
    expect(matched.flatMap(r => r.additionalContexts ?? [])).toEqual([
      'only for review',
    ])

    const unmatched = await collect(
      executeUserPromptExpansionHooks(
        'slash_command',
        'commit',
        '',
        'builtin',
        '/commit',
        'default',
        makeContext(),
      ),
    )
    expect(unmatched.flatMap(r => r.additionalContexts ?? [])).toEqual([])
  })
})
