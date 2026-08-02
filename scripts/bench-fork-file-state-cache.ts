/**
 * What a forked subagent's inherited `readFileState` actually retains.
 *
 * The fork path built the child's cache with TWO sequential clones:
 *
 *   runAgent.ts:393      agentReadFileState = cloneFileStateCache(parent)
 *   forkedAgent.ts:380   readFileState      = cloneFileStateCache(override)
 *
 * `cloneFileStateCache` is shallow — lru-cache's `dump()` hands back the same
 * `FileState` objects, so both clones alias the parent's `content` strings.
 * That makes the copy itself nearly free, and it is why the "50N MB full
 * clone" entry in docs/memory-peak-analysis.md was wrong by ~3 orders of
 * magnitude. The cost is not duplication, it is RETENTION: every outstanding
 * clone is a root that keeps the parent's file contents alive.
 *
 * runAgent's teardown knows this and releases the cache:
 *
 *   runAgent.ts:865      agentToolUseContext.readFileState.clear()
 *
 * but that clears only the SECOND clone. `agentReadFileState` is a local of
 * the still-live async generator frame and is never cleared, so the release
 * frees nothing: the parent's content stays pinned for the rest of the
 * agent's frame lifetime, including past a parent compaction
 * (compact.ts:545 `context.readFileState.clear()`).
 *
 * Policies:
 *   double  - two clones, teardown clears the child cache only (before).
 *   single  - one clone, which IS the child cache the teardown clears (after).
 *
 * Both policies call the real shipped `cloneFileStateCache`, so the numbers
 * measure the change in retention, not a reimplementation.
 *
 * Run:
 *   bun run scripts/bench-fork-file-state-cache.ts [forks] [entries] [kbPerFile]
 */
import { heapStats } from 'bun:jsc'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  type FileStateCache,
  READ_FILE_STATE_CACHE_SIZE,
} from '../packages/tool-runtime/src/fileStateCache.js'

/**
 * JSC heap size once collection has settled. One `Bun.gc(true)` is not enough
 * after a run has produced garbage — JSC frees the rest on later passes.
 *
 * Deliberately `bun:jsc` rather than `process.memoryUsage().heapUsed`: on Bun
 * 1.3.13 heapUsed is a frozen constant (measured: it reports ~212 KB before
 * and after allocating 50k strings), so any probe built on it reads zero.
 */
function settledHeapUsed(): number {
  for (let i = 0; i < 6; i++) Bun.gc(true)
  return heapStats().heapSize
}

/** A parent session cache holding `entries` distinct files. */
function parentCache(
  entries: number,
  kbPerFile: number,
  fill: string,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  for (let i = 0; i < entries; i++) {
    cache.set(`/repo/src/module${i}/file${i}.ts`, {
      content: fill.repeat(kbPerFile * 1024),
      timestamp: 1,
      offset: 0,
      limit: undefined,
    })
  }
  return cache
}

type Policy = 'double' | 'single'

/**
 * One live `runAgent` frame after its teardown has run. `intermediate` models
 * the `agentReadFileState` local that the frame still closes over.
 */
type AgentFrame = {
  intermediate: FileStateCache | undefined
  child: FileStateCache
}

/**
 * Spawn `forks` fork-children off `parent`, run each to completion (teardown
 * included), and keep their frames alive — the state a long session sits in
 * while several forked agents are still on the stack.
 */
function spawnForks(
  policy: Policy,
  parent: FileStateCache,
  forks: number,
): AgentFrame[] {
  const frames: AgentFrame[] = []
  for (let i = 0; i < forks; i++) {
    // runAgent.ts:391-394 — the fork branch.
    const intermediate =
      policy === 'double' ? cloneFileStateCache(parent) : undefined
    // forkedAgent.ts:380 — createSubagentContext always clones.
    const child = cloneFileStateCache(intermediate ?? parent)
    // runAgent.ts:865 — "Release cloned file state cache memory".
    child.clear()
    frames.push({ intermediate, child })
  }
  return frames
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * Bytes of the parent's PRE-fork file contents that survive a parent
 * compaction because a fork frame still pins them.
 *
 * Measured on the allocation side, not the release side. `heapStats().heapSize`
 * grows promptly but does not shrink promptly — JSC keeps the pages — so
 * subtracting a post-release sample reads noise (measured: a 1-fork release
 * that provably pins 4.88 MB reported 0.01 MB). Growth is reliable, so the
 * probe instead replaces the parent's contents and asks how much the heap
 * grew: if generation A was freed, generation B reuses its space and the
 * delta is ~0; if a fork still pins generation A, the delta is A's full size.
 */
function pinnedAcrossCompaction(
  policy: Policy,
  forks: number,
  entries: number,
  kbPerFile: number,
): number {
  const parent = parentCache(entries, kbPerFile, 'a')
  const frames = spawnForks(policy, parent, forks)
  if (frames.length !== forks) throw new Error('unreachable')

  const before = settledHeapUsed()
  // compact.ts:545 clears the parent, then the session reads a fresh
  // generation of files as work continues.
  parent.clear()
  for (let i = 0; i < entries; i++) {
    parent.set(`/repo/src/module${i}/next${i}.ts`, {
      content: 'b'.repeat(kbPerFile * 1024),
      timestamp: 2,
      offset: 0,
      limit: undefined,
    })
  }
  const after = settledHeapUsed()

  // Keep both reachable across the samples, as the live frames would be.
  if (parent.size !== entries || frames.length !== forks) {
    throw new Error('unreachable')
  }
  return after - before
}

function main(): void {
  const forks = Number(process.argv[2] ?? 8)
  const entries = Number(process.argv[3] ?? READ_FILE_STATE_CACHE_SIZE)
  const kbPerFile = Number(process.argv[4] ?? 50)
  const contentBytes = entries * kbPerFile * 1024

  console.log(
    `parent cache: ${entries} entries x ${kbPerFile} KB = ${mb(contentBytes)} of content\n` +
      `forks: ${forks}, each run to completion with teardown\n`,
  )

  const results = (['double', 'single'] as const).map(policy => ({
    policy,
    retained: pinnedAcrossCompaction(policy, forks, entries, kbPerFile),
  }))

  console.log('policy                  parent content pinned past compaction')
  for (const { policy, retained } of results) {
    const label =
      policy === 'double' ? 'double clone (before)' : 'single clone (after) '
    console.log(`${label}   ${mb(retained).padStart(12)}`)
  }

  const [before, after] = results
  if (!before || !after) throw new Error('unreachable')
  console.log(
    `\nfreed by dropping the redundant clone: ${mb(before.retained - after.retained)}` +
      `\nparent content that should have been released: ${mb(contentBytes)}`,
  )
}

main()
