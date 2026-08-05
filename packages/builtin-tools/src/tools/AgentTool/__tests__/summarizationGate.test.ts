/**
 * Structural guard: every caller of runAsyncAgentLifecycle must decide
 * `enableSummarization` through the single shared predicate.
 *
 * This exists because the resume path regressed exactly this way. When the
 * recap gate was widened for interactive TUI sessions, AgentTool.tsx was
 * updated but resumeAgent.ts kept an inlined
 * `isCoordinatorMode() || isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled()`.
 * Consequences: OCC_AGENT_SUMMARIES=0 silently did nothing on resume, and a
 * background agent continued via SendMessage stopped updating its recap.
 * Nothing caught it — the resume path has no behavioural test, and driving it
 * end-to-end would mean standing up a whole agent loop.
 *
 * A source-level invariant is the cheap, honest cover here: it fails both if
 * someone re-inlines the expression AND if a third caller appears without the
 * gate.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// __tests__ → AgentTool → tools → src → builtin-tools → packages → repo root
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..')

const LIFECYCLE_FN = 'runAsyncAgentLifecycle'
const GATE_FN = 'isBackgroundAgentSummarizationEnabled'

/** Where runAsyncAgentLifecycle is defined — not a caller. */
const DEFINITION_FILE =
  'packages/builtin-tools/src/tools/AgentTool/agentToolUtils.ts'

/** Every file expected to invoke the lifecycle helper. */
const CALLER_FILES = [
  'packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx',
  'packages/builtin-tools/src/tools/AgentTool/resumeAgent.ts',
]

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

async function findLifecycleCallSiteFiles(): Promise<string[]> {
  const glob = new Bun.Glob('{src,packages}/**/*.{ts,tsx}')
  const hits: string[] = []
  for await (const relPath of glob.scan({ cwd: REPO_ROOT })) {
    if (relPath.includes('node_modules') || relPath.includes('__tests__')) {
      continue
    }
    if (relPath === DEFINITION_FILE) continue
    if (read(relPath).includes(`${LIFECYCLE_FN}({`)) {
      hits.push(relPath)
    }
  }
  return hits.sort()
}

describe('runAsyncAgentLifecycle summarization gate', () => {
  test('the set of callers is exactly the two known ones', async () => {
    // A new caller must consciously opt into the gate rather than inheriting
    // whatever expression got copy-pasted along with the call.
    expect(await findLifecycleCallSiteFiles()).toEqual([...CALLER_FILES].sort())
  })

  test.each(
    CALLER_FILES,
  )('%s routes enableSummarization through the shared predicate', relPath => {
    const source = read(relPath)
    const assignments = source.match(/enableSummarization:[\s\S]*?,\n/g) ?? []

    expect(assignments.length).toBeGreaterThan(0)
    for (const assignment of assignments) {
      expect(assignment).toContain(GATE_FN)
      // The old inlined form must not come back: the SDK flag is consulted
      // *inside* the predicate, never at the call site, or the env kill
      // switch stops outranking it.
      expect(assignment).not.toContain('getSdkAgentProgressSummariesEnabled')
    }
  })

  test.each(
    CALLER_FILES,
  )('%s still passes the coordinator and fork-subagent opt-ins through', relPath => {
    // Both explicit opt-ins must survive on both paths, so coordinator mode
    // and fork subagents keep summarizing in non-interactive sessions.
    // Asserted by term, not by exact text: AgentTool.tsx hoists the
    // coordinator check into a local `isCoordinator` (same feature-gate +
    // env logic as isCoordinatorMode(); see coordinatorMode.ts:36-41) because
    // it reuses it elsewhere, while resumeAgent.ts calls the function inline.
    const assignment = (read(relPath).match(
      /enableSummarization:[\s\S]*?,\n/,
    ) ?? [''])[0]

    expect(assignment).toMatch(/isCoordinator(Mode\(\))?/)
    expect(assignment).toContain('isForkSubagentEnabled()')
  })
})
