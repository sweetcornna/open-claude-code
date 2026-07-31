import { getInitialState, STATE, type State } from './container.js'
import { __resetTurnBudgetForTests } from './cost.js'
import { __clearSessionSwitchSubscribers } from './session.js'

// Only used in tests
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  __resetTurnBudgetForTests()
  __clearSessionSwitchSubscribers()
}
