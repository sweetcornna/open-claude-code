import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rename, rm, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let activeTail: Promise<void> | undefined
let tempDir: string | undefined
let originalWrite: typeof process.stdout.write | undefined

async function waitForOutput(
  getOutput: () => string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (getOutput().includes(expected)) return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for tail output: ${expected}`)
}

async function startTail(
  logPath: string,
  initialOutput: string,
): Promise<() => string> {
  let output = ''
  originalWrite = process.stdout.write
  process.stdout.write = ((chunk: Uint8Array | string) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stdout.write

  const { tailLog } = await import('../tail.js')
  activeTail = tailLog(logPath)
  await waitForOutput(() => output, initialOutput)
  await Bun.sleep(25)
  return () => output
}

afterEach(async () => {
  if (activeTail) {
    process.emit('SIGINT')
    await activeTail
    activeTail = undefined
  }
  if (originalWrite) {
    process.stdout.write = originalWrite
    originalWrite = undefined
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('tailLog', () => {
  test('module exports tailLog function', async () => {
    const mod = await import('../tail.js')
    expect(typeof mod.tailLog).toBe('function')
  })

  test('resets its read position when the file is truncated', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'occ-tail-truncate-'))
    const logPath = join(tempDir, 'session.log')
    await writeFile(logPath, 'initial-output-is-long\n')

    const getOutput = await startTail(logPath, 'initial-output-is-long\n')
    await writeFile(logPath, 'fresh\n')

    await waitForOutput(getOutput, 'fresh\n')
    expect(getOutput()).toContain('fresh\n')
  })

  test('reads a replacement file after rename rotation', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'occ-tail-rename-'))
    const logPath = join(tempDir, 'session.log')
    await writeFile(logPath, 'initial-output-is-long\n')

    const getOutput = await startTail(logPath, 'initial-output-is-long\n')
    await rename(logPath, `${logPath}.1`)
    await writeFile(logPath, 'rotated\n')

    await waitForOutput(getOutput, 'rotated\n')
    expect(getOutput()).toContain('rotated\n')
  })

  test('reads from the beginning after delete and recreate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'occ-tail-recreate-'))
    const logPath = join(tempDir, 'session.log')
    await writeFile(logPath, 'initial-output-is-long\n')

    const getOutput = await startTail(logPath, 'initial-output-is-long\n')
    await unlink(logPath)
    await Bun.sleep(400)
    await writeFile(logPath, 'recreated\n')

    await waitForOutput(getOutput, 'recreated\n')
    expect(getOutput()).toContain('recreated\n')
  })
})
