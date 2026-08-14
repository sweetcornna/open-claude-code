/**
 * `settings.worktree.baseRef`: schema acceptance plus the predicate that
 * decides which ref a new worktree branches from.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { SettingsSchema } from '../types.js'

const settingsMock = setupSettingsMock()
const { shouldBranchFromLocalHead } = await import('../../git/worktree.js')

afterAll(() => settingsMock.reset())

function parse(worktree: unknown): Record<string, unknown> | undefined {
  const result = SettingsSchema().safeParse({ worktree })
  if (!result.success) return undefined
  return (result.data as { worktree?: Record<string, unknown> }).worktree
}

describe('settings.worktree.baseRef schema', () => {
  test('accepts both documented values', () => {
    expect(parse({ baseRef: 'fresh' })?.baseRef).toBe('fresh')
    expect(parse({ baseRef: 'head' })?.baseRef).toBe('head')
  })

  test('is optional — existing worktree settings keep parsing', () => {
    expect(parse({ sparsePaths: ['src'] })?.baseRef).toBeUndefined()
  })

  test('an invalid value degrades to undefined instead of failing the file', () => {
    // .catch(undefined): a typo in one worktree key must not make the whole
    // settings file unreadable.
    expect(parse({ baseRef: 'origin/main' })?.baseRef).toBeUndefined()
    expect(parse({ baseRef: 'origin/main' })).toBeDefined()
  })
})

describe('shouldBranchFromLocalHead', () => {
  test('is false by default — worktrees branch from origin/<default>', () => {
    settingsMock.set({ getInitialSettings: () => ({}) })
    expect(shouldBranchFromLocalHead()).toBe(false)

    settingsMock.set({ getInitialSettings: () => ({ worktree: {} }) })
    expect(shouldBranchFromLocalHead()).toBe(false)
  })

  test("is false for the explicit 'fresh' value", () => {
    settingsMock.set({
      getInitialSettings: () => ({ worktree: { baseRef: 'fresh' } }),
    })
    expect(shouldBranchFromLocalHead()).toBe(false)
  })

  test("is true for 'head'", () => {
    settingsMock.set({
      getInitialSettings: () => ({ worktree: { baseRef: 'head' } }),
    })
    expect(shouldBranchFromLocalHead()).toBe(true)
  })
})
