import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const {
  activateConditionalSkillsForPaths,
  clearDynamicSkills,
  clearSkillCaches,
  getDynamicSkills,
  getSkillDirCommands,
} = await import('../loadSkillsDir.js')
const { getClaudeConfigHomeDir } = await import(
  '../../utils/config/envUtils.js'
)
const { getManagedFilePath } = await import(
  '../../utils/settings/managedPath.js'
)

const savedEnv = new Map<string, string | undefined>()
let testRoot = ''

async function writeSkill(
  skillsRoot: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = join(skillsRoot, name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\ndescription: ${description}\npaths:\n  - "src/**"\n---\n${body}`,
  )
}

beforeEach(async () => {
  for (const name of ['OCC_CONFIG_DIR', 'OCC_MANAGED_SETTINGS_PATH']) {
    savedEnv.set(name, process.env[name])
  }

  testRoot = await mkdtemp(join(tmpdir(), 'occ-skill-security-'))
  process.env.OCC_CONFIG_DIR = join(testRoot, 'user')
  process.env.OCC_MANAGED_SETTINGS_PATH = join(testRoot, 'managed')
  getClaudeConfigHomeDir.cache.clear?.()
  getManagedFilePath.cache.clear?.()
  clearSkillCaches()
  clearDynamicSkills()
})

afterEach(async () => {
  clearSkillCaches()
  clearDynamicSkills()
  await rm(testRoot, { recursive: true, force: true })

  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
  getClaudeConfigHomeDir.cache.clear?.()
  getManagedFilePath.cache.clear?.()
})

describe('skill directory containment', () => {
  test('rejects a project skill directory symlink that escapes its skill root', async () => {
    const projectRoot = join(testRoot, 'project')
    const projectSkills = join(projectRoot, PROJECT_DIR_NAME, 'skills')
    const outsideSkill = join(testRoot, 'outside-skill')
    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await mkdir(projectSkills, { recursive: true })
    await writeSkill(testRoot, 'outside-skill', 'Outside', 'outside body')
    await symlink(outsideSkill, join(projectSkills, 'escaped'), 'dir')

    const commands = await getSkillDirCommands(projectRoot)

    expect(commands.some(command => command.name === 'escaped')).toBe(false)
  })
})

describe('conditional skill precedence', () => {
  test('keeps the managed skill when a project declares the same conditional name', async () => {
    const projectRoot = join(testRoot, 'project')
    const managedSkills = join(
      process.env.OCC_MANAGED_SETTINGS_PATH!,
      PROJECT_DIR_NAME,
      'skills',
    )
    const projectSkills = join(projectRoot, PROJECT_DIR_NAME, 'skills')
    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await writeSkill(
      managedSkills,
      'shared-conditional',
      'Managed conditional',
      'managed body',
    )
    await writeSkill(
      projectSkills,
      'shared-conditional',
      'Project conditional',
      'project body',
    )

    await getSkillDirCommands(projectRoot)
    expect(
      activateConditionalSkillsForPaths(['src/example.ts'], projectRoot),
    ).toEqual(['shared-conditional'])

    const activated = getDynamicSkills().find(
      skill => skill.name === 'shared-conditional',
    )
    expect(activated?.type).toBe('prompt')
    if (activated?.type !== 'prompt') return
    expect(activated.source).toBe('policySettings')
  })
})
