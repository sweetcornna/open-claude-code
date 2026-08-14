/**
 * `deriveAgentObjective` is a pure leaf with no imports, so this file mocks
 * nothing — see the "Mock 使用规范" section of CLAUDE.md.
 */
import { describe, expect, test } from 'bun:test'
import {
  AGENT_OBJECTIVE_MAX_LENGTH,
  deriveAgentObjective,
} from '../agentObjective.js'

describe('deriveAgentObjective', () => {
  test('explicit objective wins over prompt and description', () => {
    expect(
      deriveAgentObjective({
        objective: 'Own the streaming adapter rewrite',
        prompt: 'Read every file under src/services/api and report back.',
        description: 'Rewrite adapter',
      }),
    ).toBe('Own the streaming adapter rewrite')
  })

  test('a blank objective falls through to the prompt', () => {
    expect(
      deriveAgentObjective({
        objective: '   \n  ',
        prompt: 'Port the conduct prompt sections.',
      }),
    ).toBe('Port the conduct prompt sections.')
  })

  test('prompt extraction skips headings, blank lines and rules', () => {
    const prompt = [
      '',
      '# Task',
      '',
      '---',
      '',
      'Audit the retry classifier for missing status codes.',
      '',
      'Then write it up.',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe(
      'Audit the retry classifier for missing status codes.',
    )
  })

  test('prompt extraction skips environment preamble lines', () => {
    const prompt = [
      'Working directory: /Users/x/project',
      'Platform: darwin',
      'Branch: main',
      '',
      'Find every call site of getAPIProvider().',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe(
      'Find every call site of getAPIProvider().',
    )
  })

  test('a Goal: label is content, not environment preamble', () => {
    expect(
      deriveAgentObjective({ prompt: 'Goal: unify the two truncate helpers.' }),
    ).toBe('Goal: unify the two truncate helpers.')
  })

  test('folds a multi-line paragraph into a single line', () => {
    const prompt = [
      'Trace how the deferred tool index is built',
      '   and confirm the schema reaches the',
      'TF-IDF documents.',
      '',
      'Report back.',
    ].join('\n')
    const result = deriveAgentObjective({ prompt })
    expect(result).toBe(
      'Trace how the deferred tool index is built and confirm the schema reaches the TF-IDF documents.',
    )
    expect(result).not.toContain('\n')
  })

  test('keeps only the first sentence, ignoring dots inside identifiers', () => {
    expect(
      deriveAgentObjective({
        prompt: 'Update src/utils/model/deepseekWire.ts to v2.4. Then rerun.',
      }),
    ).toBe('Update src/utils/model/deepseekWire.ts to v2.4.')
  })

  test('skips fenced code blocks before the first substantive line', () => {
    const prompt = [
      '```',
      'bun run precheck',
      '```',
      '',
      'Make precheck pass again.',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe('Make precheck pass again.')
  })

  test('strips list markers and emphasis from the extracted line', () => {
    expect(
      deriveAgentObjective({ prompt: '- **Delete** the dead bridge modules.' }),
    ).toBe('Delete the dead bridge modules.')
  })

  test('takes only the first bullet instead of folding a whole list', () => {
    const prompt = ['# 任务', '', '1. 改 A', '2. 改 B', '3. 改 C'].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe('改 A')
  })
})

describe('deriveAgentObjective — task headings', () => {
  test('a task heading discards the environment opener before it', () => {
    const prompt = [
      '你在仓库 /Users/cornna/project/open-claude-code（occ）里工作。',
      '',
      '# 背景',
      '',
      '这个仓库是官方 Claude Code 的反编译重建版本。',
      '',
      '# 任务',
      '',
      '创建 `src/constants/prompts/conduct.ts`，把下列 6 个段落移植过来。',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe(
      '创建 `src/constants/prompts/conduct.ts`，把下列 6 个段落移植过来。',
    )
  })

  test('resets even when a full paragraph was already collected', () => {
    // The reset cannot be conditional on "nothing collected yet": the heading
    // sits several sections below the opener in every real brief.
    const prompt = [
      'You are working in the occ repository.',
      '',
      'Some background prose that would otherwise win.',
      '',
      '## Task',
      '',
      'Make the retry classifier handle 429 without a Retry-After header.',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe(
      'Make the retry classifier handle 429 without a Retry-After header.',
    )
  })

  test('the first task heading wins when several are present', () => {
    const prompt = [
      'Preamble line.',
      '',
      '# 任务 A',
      '',
      '把 objective 字段接到 AgentTool 上。',
      '',
      '# 任务 B',
      '',
      '顺便把 lastToolInfo 改成惰性计算。',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe(
      '把 objective 字段接到 AgentTool 上。',
    )
  })

  test('tolerates numbering, colons and emphasis in the heading', () => {
    const shapes = [
      '# Task 1',
      '## 任务 A：接线',
      '### **Goal:**',
      '# Your task',
      '# What to do',
      '# Assignment',
      '# 要做的改造',
      '# 目标',
    ]
    for (const heading of shapes) {
      expect(
        deriveAgentObjective({
          prompt: `Preamble.\n\n${heading}\n\nDo the thing.`,
        }),
      ).toBe('Do the thing.')
    }
  })

  test('non-task headings do not reset the scan', () => {
    const prompt = [
      'The real opening sentence.',
      '',
      '# 背景',
      '',
      'Background prose.',
      '',
      '## Notes',
      '',
      'More notes.',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe('The real opening sentence.')
  })

  test('a task heading quoted inside a code fence does not reset', () => {
    const prompt = [
      'Reproduce the report below.',
      '',
      '```markdown',
      '# Task',
      'this is sample data, not the assignment',
      '```',
    ].join('\n')
    expect(deriveAgentObjective({ prompt })).toBe('Reproduce the report below.')
  })

  test('a trailing task heading with no body falls back to description', () => {
    expect(
      deriveAgentObjective({
        prompt: 'Preamble sentence.\n\n# Task\n',
        description: 'Port conduct sections',
      }),
    ).toBe('Port conduct sections')
  })
})

describe('deriveAgentObjective — budget and fallbacks', () => {
  test('truncates to the character budget with an ellipsis', () => {
    const objective = 'x'.repeat(AGENT_OBJECTIVE_MAX_LENGTH + 50)
    const result = deriveAgentObjective({ objective })!
    expect([...result]).toHaveLength(AGENT_OBJECTIVE_MAX_LENGTH)
    expect(result.endsWith('…')).toBe(true)
  })

  test('leaves a value at exactly the budget untouched', () => {
    const objective = 'y'.repeat(AGENT_OBJECTIVE_MAX_LENGTH)
    expect(deriveAgentObjective({ objective })).toBe(objective)
  })

  test('falls back to description when the prompt yields nothing', () => {
    expect(
      deriveAgentObjective({
        prompt: '# Heading only\n\n---\n\n<task>\n',
        description: 'Port prompt sections',
      }),
    ).toBe('Port prompt sections')
  })

  test('uses description when there is no prompt at all', () => {
    expect(deriveAgentObjective({ description: 'Audit retries' })).toBe(
      'Audit retries',
    )
  })

  test('returns null when every source is empty', () => {
    expect(deriveAgentObjective({})).toBeNull()
    expect(
      deriveAgentObjective({
        objective: '  ',
        prompt: '\n\n',
        description: '',
      }),
    ).toBeNull()
  })
})
