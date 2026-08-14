/**
 * `types.ts` is a pure schema leaf — no mocks, no module graph.
 *
 * These cover the alias rescue in front of the (strict) Edit input schema:
 * a model that writes `path`/`old_str`/`new_str` would otherwise get a
 * double failure (unrecognized key AND missing required field) and re-send
 * the whole edit, paying for the file content twice.
 */
import { describe, expect, test } from 'bun:test'
import { toJSONSchema } from 'zod/v4'
import { coerceEditInput, inputSchema } from '../types.js'

const CANONICAL = {
  file_path: '/tmp/a.ts',
  old_string: 'before',
  new_string: 'after',
}

describe('coerceEditInput', () => {
  test('promotes the text_editor spellings to the canonical keys', () => {
    expect(
      coerceEditInput({
        path: '/tmp/a.ts',
        old_str: 'before',
        new_str: 'after',
      }),
    ).toEqual(CANONICAL)
  })

  test('never overwrites a canonical key that is already present', () => {
    // Both spellings present means we cannot know which one the model meant;
    // the canonical one is the only defensible choice.
    expect(
      coerceEditInput({ ...CANONICAL, path: '/tmp/WRONG.ts' }),
    ).toMatchObject({ file_path: '/tmp/a.ts' })
  })

  test('maps replace_name onto replace_all, accepting the quoted boolean', () => {
    expect(coerceEditInput({ ...CANONICAL, replace_name: true })).toEqual({
      ...CANONICAL,
      replace_all: true,
    })
    expect(coerceEditInput({ ...CANONICAL, replace_name: 'true' })).toEqual({
      ...CANONICAL,
      replace_all: true,
    })
    expect(coerceEditInput({ ...CANONICAL, replace_name: 'false' })).toEqual({
      ...CANONICAL,
      replace_all: false,
    })
  })

  test('drops replace_name even when replace_all already decided the answer', () => {
    // Leaving it behind would trip strictObject's unrecognized-key check,
    // which is the failure this whole function exists to avoid.
    expect(
      coerceEditInput({ ...CANONICAL, replace_all: true, replace_name: false }),
    ).toEqual({ ...CANONICAL, replace_all: true })
  })

  test('leaves non-string aliases alone rather than smuggling in a bad type', () => {
    const input = { ...CANONICAL, extra: 1 }
    expect(coerceEditInput({ path: 42, ...CANONICAL })).toMatchObject(CANONICAL)
    // Untouched inputs are returned by identity — no needless copy per call.
    expect(coerceEditInput(input)).toBe(input)
  })

  test('passes through non-objects instead of throwing', () => {
    expect(coerceEditInput(null)).toBe(null)
    expect(coerceEditInput('nope')).toBe('nope')
    expect(coerceEditInput([1, 2])).toEqual([1, 2])
  })
})

describe('Edit input schema', () => {
  test('parses an all-aliases input that strictObject alone would reject', () => {
    const parsed = inputSchema().safeParse({
      path: '/tmp/a.ts',
      old_str: 'before',
      new_str: 'after',
      replace_name: 'true',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({
      ...CANONICAL,
      replace_all: true,
    })
  })

  test('still rejects genuinely unknown keys', () => {
    expect(inputSchema().safeParse({ ...CANONICAL, made_up: 1 }).success).toBe(
      false,
    )
  })

  test('does not advertise the aliases in the schema sent to the model', () => {
    // Silent tolerance, not a documented input shape: publishing the aliases
    // would train the model to keep using them.
    const json = toJSONSchema(inputSchema(), {
      unrepresentable: 'any',
    }) as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(json.properties).sort()).toEqual([
      'file_path',
      'new_string',
      'old_string',
      'replace_all',
    ])
    expect(json.required.sort()).toEqual([
      'file_path',
      'new_string',
      'old_string',
    ])
  })
})
