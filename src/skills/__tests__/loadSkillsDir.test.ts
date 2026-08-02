import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PROJECT_DIR_NAME } from 'src/config/paths.js'
import type { FrontmatterData } from '../../utils/text/frontmatterParser.js'
import {
  createSkillCommand,
  getSkillsPath,
  isSpecConformantSkillName,
  parseSkillFrontmatterFields,
} from '../loadSkillsDir.js'

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
