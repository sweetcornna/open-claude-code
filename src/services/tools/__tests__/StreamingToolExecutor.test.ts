import { describe, expect, test } from 'bun:test'
import { StreamingToolExecutor } from '../StreamingToolExecutor.js'
import type { ToolUseContext } from '../../../Tool.js'

function makeMinimalContext(): ToolUseContext {
  const abortController = new AbortController()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { builtinAgents: [], customAgents: [] },
    },
    abortController,
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () => ({}) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

describe('StreamingToolExecutor.discard()', () => {
  test('clears the internal tools array', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    // Access internal state via reflection
    const toolsBefore = (executor as unknown as { tools: unknown[] }).tools
    expect(toolsBefore).toHaveLength(0)

    executor.discard()

    const toolsAfter = (executor as unknown as { tools: unknown[] }).tools
    expect(toolsAfter).toHaveLength(0)
  })

  test('aborts the sibling abort controller', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    const siblingController = (
      executor as unknown as { siblingAbortController: AbortController }
    ).siblingAbortController
    expect(siblingController.signal.aborted).toBe(false)

    executor.discard()

    expect(siblingController.signal.aborted).toBe(true)
  })

  test('sets discarded flag so getCompletedResults yields nothing', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const results = [...executor.getCompletedResults()]
    expect(results).toHaveLength(0)
  })

  test('sets discarded flag so getRemainingResults yields nothing', async () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const results: unknown[] = []
    for await (const update of executor.getRemainingResults()) {
      results.push(update)
    }
    expect(results).toHaveLength(0)
  })

  test('clears progressAvailableResolve', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const resolve = (
      executor as unknown as { progressAvailableResolve?: () => void }
    ).progressAvailableResolve
    expect(resolve).toBeUndefined()
  })

  test('can be called multiple times without error', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    expect(() => {
      executor.discard()
      executor.discard()
      executor.discard()
    }).not.toThrow()
  })

  test('releases references to allow GC of discarded executor', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    // All internal references should be cleared/released
    const internals = executor as unknown as {
      tools: unknown[]
      progressAvailableResolve?: () => void
      turnSpan: unknown
    }
    expect(internals.tools).toHaveLength(0)
    expect(internals.progressAvailableResolve).toBeUndefined()
    expect(internals.turnSpan).toBeNull()
  })
})

/**
 * One failing tool must not cancel unrelated siblings in the same batch.
 *
 * The reported symptom: a `gh release view` on a missing tag returned non-zero
 * and three unrelated `ssh` diagnostics were cancelled *before starting*, each
 * reporting "Cancelled: parallel tool call Bash(gh release ...) errored". The
 * batch dispatches in order, so the first command's exit status decided the
 * fate of every later one.
 *
 * The only genuine coupling between Bash calls is the working directory, which
 * persists across commands while shell state does not. So the cascade is kept
 * for exactly that case and dropped everywhere else.
 */
describe('StreamingToolExecutor sibling cancellation scope', () => {
  type Tracked = {
    id: string
    block: { id: string; name: string; input: Record<string, unknown> }
    assistantMessage: { uuid: string }
    status: string
    isConcurrencySafe: boolean
    pendingProgress: unknown[]
  }

  function makeExecutor() {
    const ctx = makeMinimalContext()
    return new StreamingToolExecutor([], () => true as any, ctx) as unknown as {
      shouldCancelSiblingsOnError: (t: Tracked) => boolean
      createSyntheticErrorMessage: (
        id: string,
        reason: string,
        msg: { uuid: string },
      ) => { toolUseResult: string }
      hasErrored: boolean
      erroredToolDescription: string
    }
  }

  function tracked(name: string, command?: string): Tracked {
    return {
      id: 't',
      block: {
        id: 't',
        name,
        input: command === undefined ? {} : { command },
      },
      assistantMessage: { uuid: 'a' },
      status: 'queued',
      isConcurrencySafe: false,
      pendingProgress: [],
    }
  }

  const INDEPENDENT_FAILURES: Array<[string, string]> = [
    ['gh release view --repo owner/repo', 'the reported trigger'],
    ["ssh -o BatchMode=yes host 'set -eu; nginx -T'", 'a reported victim'],
    ['mkdir -p /tmp/x', 'unrelated to any sibling'],
    ['grep -q TODO src/x.ts', 'grep exits 1 on no match — not an error'],
    ['test -f missing', 'test exits 1 by design'],
    ['git diff --check', 'read-only probe'],
  ]

  for (const [command, why] of INDEPENDENT_FAILURES) {
    test(`Bash \`${command}\` failing does NOT cancel siblings (${why})`, () => {
      expect(
        makeExecutor().shouldCancelSiblingsOnError(tracked('Bash', command)),
      ).toBe(false)
    })
  }

  const CWD_CHANGING: string[] = [
    'cd /tmp/build && make',
    '(cd sub && make)',
    'pushd /tmp && ls',
  ]

  for (const command of CWD_CHANGING) {
    test(`Bash \`${command}\` failing DOES cancel siblings (cwd persists)`, () => {
      expect(
        makeExecutor().shouldCancelSiblingsOnError(tracked('Bash', command)),
      ).toBe(true)
    })
  }

  test('non-Bash tools never cancel siblings', () => {
    const ex = makeExecutor()
    for (const name of ['Read', 'WebFetch', 'Grep', 'Glob', 'Edit']) {
      expect(ex.shouldCancelSiblingsOnError(tracked(name, 'cd /tmp'))).toBe(
        false,
      )
    }
  })

  test('a Bash call with no command string does not cancel siblings', () => {
    const ex = makeExecutor()
    expect(ex.shouldCancelSiblingsOnError(tracked('Bash'))).toBe(false)
    expect(ex.shouldCancelSiblingsOnError(tracked('Bash', ''))).toBe(false)
  })

  test('the cancellation message tells the model to re-run', () => {
    const ex = makeExecutor()
    ex.hasErrored = true
    ex.erroredToolDescription = 'Bash(cd /tmp/build && make)'
    const text = ex.createSyntheticErrorMessage('t9', 'sibling_error', {
      uuid: 'a',
    }).toolUseResult

    // A bare "Cancelled" reads as a verdict on this call, so the model drops
    // work it should simply redo.
    expect(text).toContain('Re-run')
    expect(text).toContain('working directory')
    expect(text).toContain('Bash(cd /tmp/build && make)')
  })
})
