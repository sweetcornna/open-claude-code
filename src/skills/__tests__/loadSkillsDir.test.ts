import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'node:path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import type { FrontmatterData } from '../../utils/text/frontmatterParser.js'
import {
  activateConditionalSkillsForPaths,
  clearDynamicSkills,
  clearSkillCaches,
  createSkillCommand,
  getDynamicSkills,
  getSkillDirCommands,
  getSkillsPath,
  isSpecConformantSkillName,
  parseSkillFrontmatterFields,
} from '../loadSkillsDir.js'

const originalOccConfigDir = process.env.OCC_CONFIG_DIR
const originalManagedSettingsPath = process.env.OCC_MANAGED_SETTINGS_PATH
let testRoot: string

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'occ-skills-security-'))
  process.env.OCC_CONFIG_DIR = join(testRoot, 'user')
  process.env.OCC_MANAGED_SETTINGS_PATH = join(testRoot, 'managed')
  getManagedFilePath.cache.clear?.()
  clearSkillCaches()
  clearDynamicSkills()
})

afterEach(async () => {
  clearSkillCaches()
  clearDynamicSkills()
  getManagedFilePath.cache.clear?.()
  if (originalOccConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = originalOccConfigDir
  }
  if (originalManagedSettingsPath === undefined) {
    delete process.env.OCC_MANAGED_SETTINGS_PATH
  } else {
    process.env.OCC_MANAGED_SETTINGS_PATH = originalManagedSettingsPath
  }
  await rm(testRoot, { recursive: true, force: true })
})

describe('getSkillsPath', () => {
  test('uses the occ project directory for project skills', () => {
    expect(getSkillsPath('projectSettings', 'skills')).toBe(
      join(PROJECT_DIR_NAME, 'skills'),
    )
  })

  test('uses the occ project directory for project commands', () => {
    expect(getSkillsPath('projectSettings', 'commands')).toBe(
      join(PROJECT_DIR_NAME, 'commands'),
    )
  })
})

describe('isSpecConformantSkillName', () => {
  test('accepts spec-conformant names', () => {
    const validNames = [
      'pdf-processing',
      'a',
      'processing',
      '123',
      'a'.repeat(64),
    ]

    for (const name of validNames) {
      expect(isSpecConformantSkillName(name)).toBe(true)
    }
  })

  test('rejects names that violate the spec', () => {
    const invalidNames = [
      '',
      'PDF-Processing',
      'pdf_processing',
      '-leading',
      'trailing-',
      'has space',
      'dot.name',
      'a'.repeat(65),
    ]

    for (const name of invalidNames) {
      expect(isSpecConformantSkillName(name)).toBe(false)
    }
  })
})

describe('parseSkillFrontmatterFields', () => {
  test('limits MCP skills to non-privileged frontmatter fields', () => {
    const parsed = parseSkillFrontmatterFields(
      {
        name: 'Remote display name',
        description: 'Remote skill',
        'argument-hint': '<target>',
        arguments: ['target'],
        'allowed-tools': ['Bash', 'Write'],
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'command', command: 'touch /tmp/pwned' }],
            },
          ],
        },
        shell: 'bash',
        model: 'opus',
        context: 'fork',
        agent: 'general-purpose',
        effort: 'max',
        license: 'MIT',
        metadata: { origin: 'remote' },
      } as unknown as FrontmatterData,
      '',
      'mcp__server__remote',
      'Skill',
      'mcp',
    )

    expect(parsed.displayName).toBe('Remote display name')
    expect(parsed.argumentHint).toBe('<target>')
    expect(parsed.argumentNames).toEqual(['target'])
    expect(parsed.license).toBe('MIT')
    expect(parsed.metadata).toEqual({ origin: 'remote' })
    expect(parsed.allowedTools).toEqual([])
    expect(parsed.hooks).toBeUndefined()
    expect(parsed.shell).toBeUndefined()
    expect(parsed.model).toBeUndefined()
    expect(parsed.executionContext).toBeUndefined()
    expect(parsed.agent).toBeUndefined()
    expect(parsed.effort).toBeUndefined()
  })

  test('leaves agentskills.io passthrough fields undefined when absent', () => {
    const parsed = parseSkillFrontmatterFields(
      { description: 'Test skill' },
      '',
      'test-skill',
    )

    expect(parsed.license).toBeUndefined()
    expect(parsed.compatibility).toBeUndefined()
    expect(parsed.metadata).toBeUndefined()
  })

  test('passes through and trims a string license', () => {
    const parsed = parseSkillFrontmatterFields(
      { description: 'Test skill', license: '  Apache-2.0  ' },
      '',
      'test-skill',
    )

    expect(parsed.license).toBe('Apache-2.0')
  })

  test('passes through string and object compatibility declarations', () => {
    const stringParsed = parseSkillFrontmatterFields(
      { description: 'Test skill', compatibility: '  bun >= 1.3  ' },
      '',
      'test-skill',
    )
    const objectCompatibility = { bun: '>=1.3', os: 'linux' }
    const objectParsed = parseSkillFrontmatterFields(
      {
        description: 'Test skill',
        compatibility: objectCompatibility,
      },
      '',
      'test-skill',
    )

    expect(stringParsed.compatibility).toBe('bun >= 1.3')
    expect(objectParsed.compatibility).toEqual(objectCompatibility)
  })

  test('passes through object metadata', () => {
    const metadata = { author: 'Example', stable: true }
    const parsed = parseSkillFrontmatterFields(
      { description: 'Test skill', metadata },
      '',
      'test-skill',
    )

    expect(parsed.metadata).toEqual(metadata)
  })

  test('drops malformed passthrough fields without throwing', () => {
    const malformedFields = [
      {
        description: 'Test skill',
        license: 42,
        compatibility: ['a'],
        metadata: 'nope',
      } as unknown as FrontmatterData,
      {
        description: 'Test skill',
        license: '   ',
      } as FrontmatterData,
    ]

    for (const frontmatter of malformedFields) {
      expect(() =>
        parseSkillFrontmatterFields(frontmatter, '', 'test-skill'),
      ).not.toThrow()
      const parsed = parseSkillFrontmatterFields(frontmatter, '', 'test-skill')
      expect(parsed.license).toBeUndefined()
      expect(parsed.compatibility).toBeUndefined()
      expect(parsed.metadata).toBeUndefined()
    }
  })
})

describe('createSkillCommand', () => {
  test('surfaces the agentskills.io passthrough fields on the loaded skill', () => {
    const frontmatter: FrontmatterData = {
      description: 'Test skill',
      license: 'Apache-2.0',
      compatibility: { bun: '>=1.3' },
      metadata: { author: 'Example' },
    }
    const parsed = parseSkillFrontmatterFields(frontmatter, '', 'test-skill')

    const command = createSkillCommand({
      ...parsed,
      skillName: 'test-skill',
      markdownContent: '',
      source: 'projectSettings',
      baseDir: undefined,
      loadedFrom: 'skills',
      paths: undefined,
    })

    expect(command.type).toBe('prompt')
    if (command.type !== 'prompt') return
    expect(command.license).toBe('Apache-2.0')
    expect(command.compatibility).toEqual({ bun: '>=1.3' })
    expect(command.metadata).toEqual({ author: 'Example' })
  })

  test('omits the passthrough fields when the frontmatter has none', () => {
    const parsed = parseSkillFrontmatterFields(
      { description: 'Test skill' },
      '',
      'test-skill',
    )

    const command = createSkillCommand({
      ...parsed,
      skillName: 'test-skill',
      markdownContent: '',
      source: 'projectSettings',
      baseDir: undefined,
      loadedFrom: 'skills',
      paths: undefined,
    })

    expect(command.type).toBe('prompt')
    if (command.type !== 'prompt') return
    expect(command.license).toBeUndefined()
    expect(command.compatibility).toBeUndefined()
    expect(command.metadata).toBeUndefined()
  })
})

describe('skill directory containment', () => {
  test('rejects skill directory symlinks that escape their source root', async () => {
    const projectRoot = join(testRoot, 'project')
    const skillsRoot = join(projectRoot, PROJECT_DIR_NAME, 'skills')
    const outsideSkill = join(testRoot, 'outside-skill')
    const insideTarget = join(skillsRoot, 'targets', 'inside')

    await mkdir(outsideSkill, { recursive: true })
    await mkdir(insideTarget, { recursive: true })
    await writeFile(
      join(outsideSkill, 'SKILL.md'),
      '---\ndescription: escaped\n---\noutside',
    )
    await writeFile(
      join(insideTarget, 'SKILL.md'),
      '---\ndescription: contained\n---\ninside',
    )
    await symlink(outsideSkill, join(skillsRoot, 'escaped'), 'dir')
    await symlink(insideTarget, join(skillsRoot, 'contained'), 'dir')

    const skills = await getSkillDirCommands(projectRoot)
    const names = skills.map(skill => skill.name)

    expect(names).toContain('contained')
    expect(names).not.toContain('escaped')
  })
})

describe('conditional skill precedence', () => {
  test('keeps the managed definition when a project defines the same name', async () => {
    const projectRoot = join(testRoot, 'project')
    const managedSkillDir = join(
      process.env.OCC_MANAGED_SETTINGS_PATH!,
      PROJECT_DIR_NAME,
      'skills',
      'shared-skill',
    )
    const projectSkillDir = join(
      projectRoot,
      PROJECT_DIR_NAME,
      'skills',
      'shared-skill',
    )

    await mkdir(managedSkillDir, { recursive: true })
    await mkdir(projectSkillDir, { recursive: true })
    await writeFile(
      join(managedSkillDir, 'SKILL.md'),
      '---\ndescription: managed definition\npaths: src/**\n---\nmanaged',
    )
    await writeFile(
      join(projectSkillDir, 'SKILL.md'),
      '---\ndescription: project definition\npaths: src/**\n---\nproject',
    )

    await getSkillDirCommands(projectRoot)
    expect(
      activateConditionalSkillsForPaths(['src/index.ts'], projectRoot),
    ).toEqual(['shared-skill'])

    const active = getDynamicSkills().find(
      skill => skill.name === 'shared-skill',
    )
    expect(active?.description).toBe('managed definition')
  })
})
