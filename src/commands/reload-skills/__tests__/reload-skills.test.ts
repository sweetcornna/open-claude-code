import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearCommandsCache } from '../../../commands.js'
import reloadSkills from '../index.js'
import { call } from '../reload-skills.js'

let configDir: string
const savedEnv: Record<string, string | undefined> = {}

// COMMANDS() eagerly evaluates every descriptor's isEnabled, and /login's
// throws outright when no credential is present. A dummy key is enough — the
// command list is never executed, only enumerated.
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'] as const

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  configDir = mkdtempSync(join(tmpdir(), 'occ-reload-skills-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-reload-skills'
  clearCommandsCache()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(configDir, { recursive: true, force: true })
  // The command clears process-global command caches; leave the registry in a
  // clean state so later suites re-read with the restored config dir.
  clearCommandsCache()
})

function writeUserSkill(name: string): void {
  const dir = join(configDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A throwaway skill used by the reload-skills test.\n---\n\nBody.\n`,
  )
}

async function reload(): Promise<string> {
  const result = await call('', {} as never)
  expect(result.type).toBe('text')
  return (result as { type: 'text'; value: string }).value
}

describe('/reload-skills descriptor', () => {
  test('is a local command usable headlessly', () => {
    expect(reloadSkills.name).toBe('reload-skills')
    expect(reloadSkills.type).toBe('local')
    expect(reloadSkills.supportsNonInteractive).toBe(true)
  })
})

describe('/reload-skills', () => {
  test('reports no changes when nothing moved on disk', async () => {
    await reload()
    expect(await reload()).toContain('no changes')
  })

  test('counts a skill that appeared since the last read', async () => {
    const baseline = await reload()
    expect(baseline).toContain('Reloaded skills:')

    writeUserSkill('reload-skills-fixture')

    const after = await reload()
    expect(after).toContain('1 added')
    expect(after).not.toContain('removed')
  })

  test('counts a skill that disappeared since the last read', async () => {
    writeUserSkill('reload-skills-fixture')
    await reload()

    rmSync(join(configDir, 'skills', 'reload-skills-fixture'), {
      recursive: true,
      force: true,
    })

    expect(await reload()).toContain('1 removed')
  })
})
