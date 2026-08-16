import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupPolicyLimitsMock } from '../../../../tests/mocks/policyLimits.js'

const policyLimits = setupPolicyLimitsMock()

afterAll(() => policyLimits.reset())

const { checkRemoteControlPolicy } = await import('../policyGate.js')

describe('allow_remote_control policy gate', () => {
  beforeEach(() => {
    policyLimits.set({})
  })

  test('passes when the policy allows remote control', async () => {
    policyLimits.set({ isPolicyAllowed: () => true })
    expect(await checkRemoteControlPolicy()).toBeNull()
  })

  test('reports the organization denial', async () => {
    policyLimits.set({ isPolicyAllowed: () => false })
    expect(await checkRemoteControlPolicy()).toBe(
      "Remote Control is disabled by your organization's policy.",
    )
  })

  test('asks about allow_remote_control specifically, after limits have loaded', async () => {
    const asked: string[] = []
    let loaded = false
    policyLimits.set({
      waitForPolicyLimitsToLoad: async () => {
        loaded = true
      },
      isPolicyAllowed: (limit: string) => {
        asked.push(limit)
        // A gate that answered before the limits loaded would read a default.
        expect(loaded).toBe(true)
        return true
      },
    })

    await checkRemoteControlPolicy()
    expect(asked).toEqual(['allow_remote_control'])
  })
})
