import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_LISTING_DESC_CHARS,
  SKILL_BUDGET_CONTEXT_PERCENT,
  buildSkillListing,
  formatCommandsWithinBudget,
  getCharBudget,
} from '../prompt.js'
import type { Command } from 'src/types/command.js'

// Helper to build a minimal prompt Command
function makeCmd(
  name: string,
  description: string,
  whenToUse?: string,
  overrides?: Record<string, unknown>,
): Command {
  return {
    type: 'prompt',
    name,
    description,
    whenToUse,
    hasUserSpecifiedDescription: false,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    isHidden: false,
    progressMessage: 'running',
    userFacingName: () => name,
    source: 'userSettings',
    loadedFrom: 'skills',
    async getPromptForCommand() {
      return [{ type: 'text' as const, text: '' }]
    },
    ...overrides,
  } as unknown as Command
}

/** Bundled skills are the "locked" set: never degraded to make room. */
function makeBundledCmd(name: string, description: string): Command {
  return makeCmd(name, description, undefined, {
    source: 'bundled',
    loadedFrom: 'bundled',
  })
}

describe('MAX_LISTING_DESC_CHARS', () => {
  test('cap is 1536 (not the old 250)', () => {
    // Regression: v2.1.117 upgraded the per-entry description cap from 250 → 1536
    expect(MAX_LISTING_DESC_CHARS).toBe(1536)
  })

  test('description longer than 1536 chars is truncated', () => {
    const longDesc = 'x'.repeat(2000)
    const cmd = makeCmd('test-skill', longDesc)
    const result = formatCommandsWithinBudget([cmd], 200_000)
    // Should contain truncation ellipsis and must not contain the full 2000-char desc
    expect(result).toContain('…')
    // The entry itself should not exceed 1536 chars of description content
    // (the - name: prefix adds overhead we ignore here)
    expect(result.length).toBeLessThan(2000)
  })

  test('description of exactly 1536 chars is NOT truncated', () => {
    const desc = 'a'.repeat(1536)
    const cmd = makeCmd('my-skill', desc)
    const result = formatCommandsWithinBudget([cmd], 200_000)
    expect(result).not.toContain('…')
    expect(result).toContain(desc)
  })

  test('description longer than 250 but shorter than 1536 is NOT truncated by the cap', () => {
    // Regression: with old cap=250, a 300-char description would be truncated.
    // With cap=1536 it must pass through intact.
    const desc = 'b'.repeat(300)
    const cmd = makeCmd('another-skill', desc)
    const result = formatCommandsWithinBudget([cmd], 200_000)
    expect(result).toContain(desc)
  })
})

// The two settings-backed knobs: `skillListingBudgetFraction` (how much of the
// context window the whole listing may take) and `skillListingMaxDescChars`
// (how much any one skill may take). The host reads them from settings.json and
// hands them in; these tests exercise the pure budget math directly.
describe('skill listing budget options', () => {
  test('budgetFraction scales the char budget off the context window', () => {
    expect(getCharBudget(200_000)).toBe(8_000)
    expect(getCharBudget(200_000, { budgetFraction: 0.05 })).toBe(40_000)
    expect(getCharBudget(50_000, { budgetFraction: 0.02 })).toBe(4_000)
  })

  test('missing context window falls back to the default 200k window', () => {
    expect(getCharBudget(undefined, { budgetFraction: 0.02 })).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS * 4 * 0.02,
    )
    expect(getCharBudget(0)).toBe(
      DEFAULT_CONTEXT_WINDOW_TOKENS * 4 * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  })

  test('out-of-range budgetFraction falls back to the 1% default', () => {
    // Zod rejects these at settings-load time; a policy file merged in via
    // .passthrough() could still smuggle one through, so the math must not
    // produce a zero or negative budget.
    for (const budgetFraction of [0, -0.5, 2]) {
      expect(getCharBudget(200_000, { budgetFraction })).toBe(8_000)
    }
  })

  test('maxDescChars caps a single description below the 1536 default', () => {
    const desc = 'x'.repeat(500)
    const result = formatCommandsWithinBudget([makeCmd('s', desc)], 200_000, {
      maxDescChars: 40,
    })
    expect(result).toBe(`- s: ${'x'.repeat(39)}…`)
  })

  test('maxDescChars can be raised above the default', () => {
    const desc = 'x'.repeat(2000)
    const result = formatCommandsWithinBudget([makeCmd('s', desc)], 200_000, {
      maxDescChars: 3000,
    })
    expect(result).toBe(`- s: ${desc}`)
    expect(result).not.toContain('…')
  })

  test('invalid maxDescChars falls back to the 1536 default', () => {
    const desc = 'x'.repeat(2000)
    for (const maxDescChars of [0, -10, 12.5]) {
      const result = formatCommandsWithinBudget([makeCmd('s', desc)], 200_000, {
        maxDescChars,
      })
      expect(result).toBe(`- s: ${'x'.repeat(MAX_LISTING_DESC_CHARS - 1)}…`)
    }
  })

  test('a smaller budgetFraction forces truncation that 1% would not', () => {
    const cmds = [
      makeCmd('alpha', 'a'.repeat(200)),
      makeCmd('beta', 'b'.repeat(200)),
    ]
    expect(buildSkillListing(cmds, 200_000).overBudget).toBe(false)
    // 200k × 4 × 0.0001 = 80 chars for two ~208-char entries.
    const tight = buildSkillListing(cmds, 200_000, { budgetFraction: 0.0001 })
    expect(tight.overBudget).toBe(true)
    expect(tight.entries.every(e => e.degraded)).toBe(true)
  })
})

describe('buildSkillListing accounting', () => {
  test('reports per-entry cost and totals that match the rendered string', () => {
    const cmds = [makeCmd('alpha', 'a'.repeat(50)), makeCmd('beta', 'short')]
    const listing = buildSkillListing(cmds, 200_000)

    expect(listing.entries.map(e => e.command.name)).toEqual(['alpha', 'beta'])
    expect(listing.entries.map(e => e.entry).join('\n')).toBe(
      formatCommandsWithinBudget(cmds, 200_000),
    )
    expect(listing.entries[0]!.chars).toBe('- alpha: '.length + 50)
    expect(listing.totalChars).toBe(listing.fullTotal)
    expect(listing.overBudget).toBe(false)
    expect(listing.entries.every(e => !e.degraded)).toBe(true)
  })

  test('degrades over-budget entries to name-only and flags them', () => {
    const cmds = [
      makeCmd('alpha', 'a'.repeat(400)),
      makeCmd('beta', 'b'.repeat(400)),
      makeCmd('gamma', 'c'.repeat(400)),
    ]
    // 250 × 4 × 0.01 = 10 chars — not even the name-only baseline fits, so
    // nothing can be promoted.
    const listing = buildSkillListing(cmds, 250)

    expect(listing.budget).toBe(10)
    expect(listing.overBudget).toBe(true)
    expect(listing.entries.map(e => e.entry)).toEqual([
      '- alpha',
      '- beta',
      '- gamma',
    ])
    expect(listing.entries.every(e => e.degraded)).toBe(true)
    // Every skill still appears by name, so every skill is still invocable.
    expect(listing.entries).toHaveLength(3)
    expect(listing.totalChars).toBeLessThan(listing.fullTotal)
  })

  test('empty listing costs nothing', () => {
    const listing = buildSkillListing([], 200_000)
    expect(listing.entries).toEqual([])
    expect(listing.totalChars).toBe(0)
    expect(listing.overBudget).toBe(false)
    expect(formatCommandsWithinBudget([], 200_000)).toBe('')
  })
})

// Over-budget degradation: locked entries survive whole, everything else is
// baselined to `- <name>` and then greedily restored in descending usage-score
// order. The point is that a crowded listing loses the descriptions nobody
// reads, instead of trimming every description into uselessness.
describe('usage-ranked degradation', () => {
  // Three equal-cost candidates, so score is the only thing that can decide
  // which description survives.
  //   full: "- alpha: "+100 = 109   name-only: "- alpha" = 7   upgrade = 102
  //   full: "- beta: " +100 = 108   name-only: "- beta"  = 6   upgrade = 102
  //   full: "- gamma: "+100 = 109   name-only: "- gamma" = 7   upgrade = 102
  //   baseline = 7 + 6 + 7 + 2 newlines = 22
  const cmds = () => [
    makeCmd('alpha', 'a'.repeat(100)),
    makeCmd('beta', 'b'.repeat(100)),
    makeCmd('gamma', 'c'.repeat(100)),
  ]
  const SCORES: Record<string, number> = { alpha: 0, beta: 10, gamma: 5 }
  const usageScore = (name: string) => SCORES[name] ?? 0

  test('keeps the highest-scoring description and drops the rest', () => {
    // budget 150 → 128 spendable over the baseline: room for exactly one.
    const listing = buildSkillListing(cmds(), 3_750, { usageScore })

    expect(listing.budget).toBe(150)
    expect(listing.overBudget).toBe(true)
    expect(listing.entries.map(e => e.entry)).toEqual([
      '- alpha',
      `- beta: ${'b'.repeat(100)}`,
      '- gamma',
    ])
    expect(listing.entries.map(e => e.degraded)).toEqual([true, false, true])
  })

  test('restores descriptions in descending score order as room allows', () => {
    // budget 240 → 218 spendable: two upgrades at 102 fit, the third does not.
    const listing = buildSkillListing(cmds(), 6_000, { usageScore })

    // beta (10) and gamma (5) win; alpha (0) is left name-only.
    expect(listing.entries.map(e => e.degraded)).toEqual([true, false, false])
  })

  test('never exceeds the budget it was given', () => {
    const listing = buildSkillListing(cmds(), 3_750, { usageScore })
    expect(listing.totalChars).toBeLessThanOrEqual(listing.budget)
  })

  test('ties and missing scores degrade in stable listing order', () => {
    // A fresh install has no usage data at all: every score is 0. Sorting must
    // not reshuffle, so the earlier-listed skill keeps its description.
    const listing = buildSkillListing(cmds(), 3_750, { usageScore: () => 0 })
    expect(listing.entries.map(e => e.degraded)).toEqual([false, true, true])

    // Same outcome when no scorer is supplied at all.
    const unscored = buildSkillListing(cmds(), 3_750)
    expect(unscored.entries.map(e => e.entry)).toEqual(
      listing.entries.map(e => e.entry),
    )
  })

  test('bundled skills are locked and never degrade', () => {
    const withBundled = [
      makeCmd('alpha', 'a'.repeat(100)),
      makeBundledCmd('curated', 'c'.repeat(100)),
      makeCmd('gamma', 'g'.repeat(100)),
    ]
    // Tiny budget: nothing can be promoted, yet the bundled entry keeps its
    // description while the two high-scoring user skills lose theirs.
    const listing = buildSkillListing(withBundled, 250, {
      usageScore: name => (name === 'curated' ? 0 : 999),
    })

    expect(listing.entries.map(e => e.entry)).toEqual([
      '- alpha',
      `- curated: ${'c'.repeat(100)}`,
      '- gamma',
    ])
    expect(listing.entries[1]!.degraded).toBe(false)
  })

  test('an all-bundled listing is left intact when it cannot shrink', () => {
    const bundled = [
      makeBundledCmd('one', 'x'.repeat(100)),
      makeBundledCmd('two', 'y'.repeat(100)),
    ]
    const listing = buildSkillListing(bundled, 250)

    expect(listing.overBudget).toBe(true)
    expect(listing.entries.every(e => !e.degraded)).toBe(true)
    expect(listing.totalChars).toBe(listing.fullTotal)
  })

  test('every skill stays listed by name, so every skill stays invocable', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      makeCmd(`skill-${i}`, 'd'.repeat(500)),
    )
    // 1 char of budget — as hopeless as it gets.
    const listing = buildSkillListing(many, 25, { usageScore })

    expect(listing.entries).toHaveLength(40)
    for (let i = 0; i < 40; i++) {
      expect(listing.entries[i]!.entry).toBe(`- skill-${i}`)
    }
    // Blowing the budget is preferable to hiding a skill from the model.
    expect(listing.totalChars).toBeGreaterThan(listing.budget)
  })

  test('the under-budget path never consults usage scores', () => {
    // Guards the byte-for-byte stability of the default path: if scoring ever
    // leaks into it, a user's config would start shaping the system prompt.
    let calls = 0
    const listing = buildSkillListing(cmds(), 200_000, {
      usageScore: () => {
        calls++
        return 0
      },
    })

    expect(calls).toBe(0)
    expect(listing.overBudget).toBe(false)
    expect(listing.entries.every(e => !e.degraded)).toBe(true)
    expect(listing.entries.map(e => e.entry).join('\n')).toBe(
      formatCommandsWithinBudget(cmds(), 200_000),
    )
  })
})
