import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '..', 'check-bundle-integrity.ts')
let root: string | null = null

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

async function createDist(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'occ-bundle-integrity-'))
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, content)
  }
  return root
}

function runCheck(distDir: string) {
  return spawnSync('bun', [scriptPath, distDir], {
    encoding: 'utf8',
  })
}

describe('check-bundle-integrity nested chunks', () => {
  test('accepts valid imports between nested Vite chunks', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'import "./shared.js"\n',
      'chunks/shared.js': 'export const value = 1\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('找到 3 个 JS 文件')
  })

  test('rejects a missing import from a nested chunk', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'import "./missing.js"\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('chunks/entry.js:1 → ./missing.js')
  })

  test('scans nested chunks for unresolved runtime dependencies', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': '__require("missing-production-package")\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('missing-production-package')
    expect(result.stdout).toContain('chunks/entry.js:1')
  })
})
