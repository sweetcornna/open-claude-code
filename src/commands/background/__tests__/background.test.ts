/**
 * Surface + label tests for `/background`. No mocks: the descriptor has no
 * runtime imports and the label helper only imports a type.
 */

import { describe, expect, test } from 'bun:test'
import type { TaskState } from '../../../tasks/types.js'
import background from '../index.js'
import { describeTask } from '../taskLabels.js'

describe('/background descriptor', () => {
  test('matches the official command surface', () => {
    expect(background.type).toBe('local-jsx')
    expect(background.name).toBe('background')
    expect(background.aliases).toEqual(['bg'])
    expect(background.argumentHint).toBe('[prompt]')
  })

  test('is not immediate', () => {
    // occ has no `--reply-on-resume`, so an in-flight round cannot be
    // re-driven in the child. Queuing to the next stop point is what keeps
    // the handover from dropping it. See index.ts.
    expect('immediate' in background).toBe(false)
  })

  test('loads its implementation lazily', () => {
    // src/commands.ts imports every descriptor statically; anything eager here
    // is paid for on every interactive start.
    expect(typeof background.load).toBe('function')
  })
})

describe('describeTask', () => {
  const base = { id: 't1', status: 'running' as const }

  test('labels every background task kind', () => {
    const cases: Array<[TaskState, string]> = [
      [
        { ...base, type: 'local_bash', command: 'npm test' } as TaskState,
        'npm test',
      ],
      [
        {
          ...base,
          type: 'local_bash',
          kind: 'monitor',
          description: 'watch build',
        } as TaskState,
        'watch build',
      ],
      [
        { ...base, type: 'remote_agent', title: 'fix flake' } as TaskState,
        'fix flake',
      ],
      [
        {
          ...base,
          type: 'local_agent',
          agentType: 'Explore',
          prompt: 'find the parser',
        } as TaskState,
        'Explore: find the parser',
      ],
      [
        {
          ...base,
          type: 'in_process_teammate',
          identity: { agentName: 'ada' },
        } as TaskState,
        '@ada',
      ],
      [
        {
          ...base,
          type: 'local_workflow',
          description: 'release',
          summary: 'cut 2.41',
        } as TaskState,
        'cut 2.41',
      ],
      [
        {
          ...base,
          type: 'monitor_mcp',
          description: 'mcp health',
        } as TaskState,
        'mcp health',
      ],
      [
        { ...base, type: 'dream', description: 'idle work' } as TaskState,
        'idle work',
      ],
    ]

    for (const [task, expected] of cases) {
      expect(describeTask(task)).toBe(expected)
    }
  })

  test('truncates a long agent prompt', () => {
    const label = describeTask({
      ...base,
      type: 'local_agent',
      agentType: 'Explore',
      prompt: 'x'.repeat(200),
    } as TaskState)
    expect(label).toBe(`Explore: ${'x'.repeat(60)}`)
  })
})
