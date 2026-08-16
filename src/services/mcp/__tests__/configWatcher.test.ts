import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpConfigWatcher } from '../configWatcher.js'

const stops: Array<() => void> = []
const dirs: string[] = []

afterEach(async () => {
  while (stops.length) stops.pop()!()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-watch-'))
  dirs.push(dir)
  return dir
}

/** watchFile polls on a 1s interval; allow two ticks plus the debounce. */
function settle(): Promise<void> {
  return new Promise(r => setTimeout(r, 2600))
}

/**
 * watchFile takes its baseline stat asynchronously after registration. A
 * mutation that lands before that first stat is invisible (baseline and next
 * poll agree), so give the watcher one full poll tick to arm before mutating —
 * on a loaded CI runner `unlink` reliably won that race.
 */
function armed(): Promise<void> {
  return new Promise(r => setTimeout(r, 1200))
}

describe('startMcpConfigWatcher', () => {
  test('fires when a watched file is modified', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{"mcpServers":{}}')

    let fired = 0
    stops.push(startMcpConfigWatcher([file], () => void fired++))
    await armed()

    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')
    await settle()

    expect(fired).toBeGreaterThan(0)
  }, 15_000)

  test('fires when a watched file is deleted — the case that leaked processes', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')

    let fired = 0
    stops.push(startMcpConfigWatcher([file], () => void fired++))
    await armed()

    await unlink(file)
    await settle()

    expect(fired).toBeGreaterThan(0)
  }, 15_000)

  test('fires when a watched file appears for the first time', async () => {
    // Watching a not-yet-existing path is why this uses watchFile rather than
    // a directory watcher: `.mcp.json` usually does not exist at startup.
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')

    let fired = 0
    stops.push(startMcpConfigWatcher([file], () => void fired++))

    await writeFile(file, '{"mcpServers":{}}')
    await settle()

    expect(fired).toBeGreaterThan(0)
  })

  test('stop() silences the watcher', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{}')

    let fired = 0
    const stop = startMcpConfigWatcher([file], () => void fired++)
    stop()
    stop() // idempotent

    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')
    await settle()

    expect(fired).toBe(0)
  })
})
