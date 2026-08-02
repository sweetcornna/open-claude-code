import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

/**
 * Characterization test for REPL.tsx's hook call order.
 *
 * S7-4d splits REPL.tsx by lifting hook clusters into `src/screens/repl/`.
 * React identifies hooks purely by call order, so a cluster that moves must be
 * called from the exact position it used to occupy — otherwise every hook after
 * it shifts by one and the component silently reads another hook's state.
 *
 * This test rebuilds the flattened hook sequence (splicing each extracted
 * cluster back at its call site) and pins it to a golden fixture. It is a
 * *characterization* test: it does not claim the order is correct, only that it
 * has not changed. Any diff is a prompt to think, not automatically a bug.
 *
 * When you legitimately add or remove a hook, regenerate the fixture:
 *   bun run src/screens/__tests__/replHookOrder.test.ts --update
 * (or just edit the JSON) and confirm the diff is only your intended change.
 */

const here = dirname(fileURLToPath(import.meta.url))
const screensDir = resolve(here, '..')

/** Clusters that were lifted out of the component body into their own hook. */
const EXTRACTED_CLUSTERS: Record<string, string> = {
  useReplAutomation: 'repl/useReplAutomation.ts',
  useTranscriptSearch: 'repl/useTranscriptSearch.ts',
}

const HOOK_CALL = /\b(?:React\.)?(use[A-Z]\w*)\s*[!?]?\s*\(/g

function hookSequence(source: string): string[] {
  const out: string[] = []
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    // Skip comments so prose mentioning a hook name never counts as a call.
    if (
      line.startsWith('//') ||
      line.startsWith('*') ||
      line.startsWith('/*')
    ) {
      continue
    }
    HOOK_CALL.lastIndex = 0
    let m: RegExpExecArray | null = HOOK_CALL.exec(rawLine)
    while (m !== null) {
      out.push(m[1]!)
      m = HOOK_CALL.exec(rawLine)
    }
  }
  return out
}

/**
 * Everything *after* a declaration marker, to end of file. The marker itself is
 * dropped: `export function useReplAutomation(` would otherwise be counted as a
 * call to the very hook whose body we are about to splice in.
 */
function bodyAfter(source: string, marker: string): string {
  const i = source.indexOf(marker)
  expect(i, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0)
  return source.slice(i + marker.length)
}

function flattenedReplHookOrder(): string[] {
  const replBody = bodyAfter(
    readFileSync(resolve(screensDir, 'REPL.tsx'), 'utf8'),
    'export function REPL(',
  )

  const clusterSequences = new Map<string, string[]>()
  for (const [hookName, relPath] of Object.entries(EXTRACTED_CLUSTERS)) {
    const body = bodyAfter(
      readFileSync(resolve(screensDir, relPath), 'utf8'),
      `export function ${hookName}(`,
    )
    clusterSequences.set(hookName, hookSequence(body))
  }

  const flattened: string[] = []
  for (const hook of hookSequence(replBody)) {
    const inlined = clusterSequences.get(hook)
    if (inlined) flattened.push(...inlined)
    else flattened.push(hook)
  }
  return flattened
}

describe('REPL hook call order', () => {
  test('matches the golden sequence captured before the S7-4d split', () => {
    const golden = JSON.parse(
      readFileSync(resolve(here, 'fixtures/repl-hook-order.json'), 'utf8'),
    ) as string[]

    expect(flattenedReplHookOrder()).toEqual(golden)
  })

  test('every extracted cluster is actually called from REPL.tsx', () => {
    const repl = readFileSync(resolve(screensDir, 'REPL.tsx'), 'utf8')
    for (const hookName of Object.keys(EXTRACTED_CLUSTERS)) {
      expect(repl).toContain(`${hookName}({`)
    }
  })
})
