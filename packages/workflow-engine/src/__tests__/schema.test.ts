import { expect, test } from 'bun:test'
import { workflowInputSchema, workflowRunInputSchema } from '../tool/schema.js'

test('empty object passes (all fields optional)', () => {
  expect(workflowInputSchema.safeParse({}).success).toBe(true)
})

test('all known fields can be filled', () => {
  const r = workflowInputSchema.safeParse({
    script: 'return 1',
    name: 'release',
    scriptPath: '/abs/x.ts',
    args: { n: 1 },
    resumeFromRunId: 'run-1',
    resumePolicy: { scope: 'agents', agentIds: [0, 2] },
    description: 'do thing',
    title: 'T',
    maxConcurrency: 3,
  })
  expect(r.success).toBe(true)
})

test('args accepts any JSON value (object/array/string/number/boolean/null)', () => {
  for (const args of [{ a: 1 }, [1, 2], 's', 42, true, null]) {
    expect(workflowInputSchema.safeParse({ args }).success).toBe(true)
  }
})

test('named workflow description uses the isolated public default', () => {
  expect(workflowRunInputSchema.shape.name.description).toContain(
    '.occ/workflows',
  )
  expect(workflowRunInputSchema.shape.name.description).not.toContain(
    '.claude/workflows',
  )
})

test('type errors rejected (script/name/scriptPath not strings)', () => {
  expect(workflowInputSchema.safeParse({ script: 123 }).success).toBe(false)
  expect(workflowInputSchema.safeParse({ name: 42 }).success).toBe(false)
  expect(workflowInputSchema.safeParse({ scriptPath: {} }).success).toBe(false)
})

test('resumeFromRunId/description/title must be strings', () => {
  expect(workflowInputSchema.safeParse({ resumeFromRunId: 1 }).success).toBe(
    false,
  )
  expect(workflowInputSchema.safeParse({ description: 1 }).success).toBe(false)
  expect(workflowInputSchema.safeParse({ title: 1 }).success).toBe(false)
})

test('resumePolicy accepts checkpoint/all/inclusive range/unique agent selectors only with resumeFromRunId', () => {
  for (const resumePolicy of [
    { scope: 'checkpoint' },
    { scope: 'all' },
    { scope: 'range', fromAgentId: 0, toAgentId: 999 },
    { scope: 'agents', agentIds: [0, 2, 999] },
  ]) {
    expect(
      workflowInputSchema.safeParse({
        resumeFromRunId: 'run-1',
        resumePolicy,
      }).success,
    ).toBe(true)
    expect(workflowInputSchema.safeParse({ resumePolicy }).success).toBe(false)
  }
})

test('resumePolicy rejects malformed, reversed, duplicate, negative, and out-of-bounds selectors', () => {
  for (const resumePolicy of [
    null,
    {},
    { scope: 'unknown' },
    { scope: 'all', agentIds: [1] },
    { scope: 'range', fromAgentId: 2, toAgentId: 1 },
    { scope: 'range', fromAgentId: -1, toAgentId: 1 },
    { scope: 'range', fromAgentId: 0, toAgentId: 1000 },
    { scope: 'range', fromAgentId: 0.5, toAgentId: 1 },
    { scope: 'agents', agentIds: [] },
    { scope: 'agents', agentIds: [1, 1] },
    { scope: 'agents', agentIds: [-1] },
    { scope: 'agents', agentIds: [1000] },
    { scope: 'agents', agentIds: ['1'] },
    { scope: 'agents', agentIds: [1], extra: true },
  ]) {
    expect(
      workflowInputSchema.safeParse({
        resumeFromRunId: 'run-1',
        resumePolicy,
      }).success,
    ).toBe(false)
  }
})

test('operation variants are strict and cannot swallow each other fields', () => {
  for (const valid of [
    { script: 'return 1' },
    { operation: 'run', script: 'return 1' },
    { operation: 'status', runId: 'run-1' },
    { operation: 'query', runId: 'run-1' },
    { operation: 'cancel', runId: 'run-1' },
    { operation: 'cancel', runId: 'run-1', agentId: 2 },
  ]) {
    expect(workflowInputSchema.safeParse(valid).success).toBe(true)
  }

  for (const invalid of [
    { operation: 'unknown', runId: 'run-1' },
    { operation: 'status', runId: 'run-1', script: 'return 1' },
    { operation: 'cancel', runId: 'run-1', scriptPath: '/x' },
    { script: 'return 1', runId: 'run-1' },
    { operation: 'run', script: 'return 1', agentId: 2 },
    { operation: 'status' },
    { operation: 'cancel', runId: 'run-1', agentId: -1 },
    { script: 'return 1', extra: 1 },
  ]) {
    expect(workflowInputSchema.safeParse(invalid).success).toBe(false)
  }
})

test('maxConcurrency: integers 1-16 valid; 0/17/decimal/non-number rejected', () => {
  for (const n of [1, 3, 5, 16]) {
    expect(workflowInputSchema.safeParse({ maxConcurrency: n }).success).toBe(
      true,
    )
  }
  for (const bad of [0, -1, 17, 100, 1.5, '3', NaN]) {
    expect(workflowInputSchema.safeParse({ maxConcurrency: bad }).success).toBe(
      false,
    )
  }
})

test('maxConcurrency optional (safeParse succeeds when omitted)', () => {
  expect(workflowInputSchema.safeParse({ script: 'x' }).success).toBe(true)
})
