import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  buildSkillDoctorReport,
  countSkillInvocations,
  type SkillListingCost,
} from '../report.js'

function assistantToolUse(
  blocks: Array<{ name: string; input?: unknown }>,
): Message {
  return {
    type: 'assistant',
    message: {
      content: blocks.map((b, i) => ({
        type: 'tool_use',
        id: `tool_${i}`,
        name: b.name,
        input: b.input ?? {},
      })),
    },
  } as unknown as Message
}

function userText(text: string): Message {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
  } as unknown as Message
}

function userStringContent(text: string): Message {
  return {
    type: 'user',
    message: { content: text },
  } as unknown as Message
}

describe('countSkillInvocations', () => {
  test('counts Skill tool_use blocks per skill', () => {
    const counts = countSkillInvocations([
      assistantToolUse([{ name: 'Skill', input: { skill: 'commit' } }]),
      assistantToolUse([{ name: 'Skill', input: { skill: 'commit' } }]),
      assistantToolUse([{ name: 'Skill', input: { skill: 'dataviz' } }]),
    ])

    expect(counts.get('commit')?.viaTool).toBe(2)
    expect(counts.get('commit')?.total).toBe(2)
    expect(counts.get('dataviz')?.total).toBe(1)
  })

  test('ignores tool_use blocks from other tools', () => {
    const counts = countSkillInvocations([
      assistantToolUse([
        { name: 'Bash', input: { command: 'ls' } },
        { name: 'FileRead', input: { file_path: '/tmp/x' } },
      ]),
    ])
    expect(counts.size).toBe(0)
  })

  test('ignores Skill calls with a missing or non-string skill name', () => {
    const counts = countSkillInvocations([
      assistantToolUse([
        { name: 'Skill', input: {} },
        { name: 'Skill', input: { skill: 42 } },
        { name: 'Skill', input: { skill: '' } },
      ]),
    ])
    expect(counts.size).toBe(0)
  })

  test('counts <command-name> breadcrumbs, stripping the leading slash', () => {
    const counts = countSkillInvocations([
      userText(
        '<command-name>/commit</command-name>\n<command-args></command-args>',
      ),
      // Model-only skills render without the slash.
      userText('<command-name>internal-skill</command-name>'),
    ])

    expect(counts.get('commit')?.viaBreadcrumb).toBe(1)
    expect(counts.get('commit')?.total).toBe(1)
    expect(counts.get('internal-skill')?.total).toBe(1)
  })

  test('reads breadcrumbs out of plain-string user content too', () => {
    const counts = countSkillInvocations([
      userStringContent('<command-name>/commit</command-name>'),
    ])
    expect(counts.get('commit')?.total).toBe(1)
  })

  test('does not double-count a Skill tool call that also emits a breadcrumb', () => {
    // processSlashCommand formats the same breadcrumb whether the user typed
    // `/commit` or the model invoked the Skill tool, so the two signals overlap.
    const counts = countSkillInvocations([
      assistantToolUse([{ name: 'Skill', input: { skill: 'commit' } }]),
      userText('<command-name>/commit</command-name>'),
    ])

    const commit = counts.get('commit')
    expect(commit?.viaTool).toBe(1)
    expect(commit?.viaBreadcrumb).toBe(1)
    expect(commit?.total).toBe(1)
  })

  test('keeps user-typed runs visible alongside model-driven ones', () => {
    const counts = countSkillInvocations([
      assistantToolUse([{ name: 'Skill', input: { skill: 'commit' } }]),
      userText('<command-name>/commit</command-name>'),
      userText('<command-name>/commit</command-name>'),
      userText('<command-name>/commit</command-name>'),
    ])
    expect(counts.get('commit')?.total).toBe(3)
  })

  test('returns nothing for a session with no skill activity', () => {
    expect(countSkillInvocations([]).size).toBe(0)
    expect(countSkillInvocations([userText('hello')]).size).toBe(0)
  })
})

function cost(
  name: string,
  chars: number,
  extra: Partial<SkillListingCost> = {},
): SkillListingCost {
  return { name, source: 'skills', chars, degraded: false, ...extra }
}

const TOTALS = {
  budget: 8_000,
  totalChars: 1_000,
  fullTotal: 1_000,
  overBudget: false,
  contextWindowTokens: 200_000,
}

describe('buildSkillDoctorReport', () => {
  test('separates used from never-used skills', () => {
    const report = buildSkillDoctorReport(
      [cost('used-one', 400), cost('never-used', 600)],
      new Map([['used-one', { viaTool: 2, viaBreadcrumb: 0, total: 2 }]]),
      TOTALS,
    )

    expect(report).toContain('Used this session: **1** of 2')
    expect(report).toContain('Never used this session — 1 skill')
    expect(report).toContain('`never-used`')
    expect(report).toContain('used 2×')
  })

  test('reports char and approximate token cost per skill', () => {
    const report = buildSkillDoctorReport([cost('big', 401)], new Map(), TOTALS)
    // 401 chars / 4 chars-per-token, rounded up.
    expect(report).toContain('401 chars (~101 tokens)')
  })

  test('flags unused skills that eat a large share of the budget', () => {
    const report = buildSkillDoctorReport(
      [cost('hog', 900), cost('tiny', 50)],
      new Map(),
      TOTALS,
    )
    const hogLine = report.split('\n').find(l => l.includes('`hog`'))
    const tinyLine = report.split('\n').find(l => l.includes('`tiny`'))
    // 5% of the 8000-char budget is 400.
    expect(hogLine).toContain('costly')
    expect(tinyLine).not.toContain('costly')
  })

  test('sorts the unused list by cost, most expensive first', () => {
    const report = buildSkillDoctorReport(
      [cost('cheap', 10), cost('expensive', 900), cost('mid', 100)],
      new Map(),
      TOTALS,
    )
    const order = report
      .split('\n')
      .filter(l => l.startsWith('- `'))
      .map(l => l.split('`')[1])
    expect(order).toEqual(['expensive', 'mid', 'cheap'])
  })

  test('names both settings keys when the listing is over budget', () => {
    const report = buildSkillDoctorReport([cost('a', 100)], new Map(), {
      ...TOTALS,
      totalChars: 8_000,
      fullTotal: 20_000,
      overBudget: true,
    })

    expect(report).toContain('Over budget')
    expect(report).toContain('skillListingBudgetFraction')
    expect(report).toContain('skillListingMaxDescChars')
  })

  test('marks entries the budget truncated', () => {
    const report = buildSkillDoctorReport(
      [cost('trimmed', 100, { degraded: true })],
      new Map(),
      TOTALS,
    )
    expect(report).toContain('truncated to fit budget')
  })

  test('handles a session with no loaded skills', () => {
    const report = buildSkillDoctorReport([], new Map(), {
      ...TOTALS,
      totalChars: 0,
    })
    expect(report).toContain('No skills are loaded')
    expect(report).not.toContain('Never used')
  })
})
