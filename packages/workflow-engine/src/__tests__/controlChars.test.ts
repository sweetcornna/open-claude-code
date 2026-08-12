import { expect, test } from 'bun:test'
import {
  argsHaveNoHiddenControlCharacters,
  hasNoHiddenControlCharacters,
  resolvedScriptControlCharMessage,
  WORKFLOW_ARGS_CONTROL_CHAR_MESSAGE,
  WORKFLOW_SCRIPT_CONTROL_CHAR_MESSAGE,
} from '../tool/controlChars.js'
import { workflowInputSchema } from '../tool/schema.js'

const REALISTIC_SCRIPT = [
  'export const meta = { name: "demo", description: "d", phases: [] }',
  '',
  'const out = await agent("summarize the repo")',
  '\treturn { out }',
].join('\n')

test('a normal multi-line script with tabs and newlines passes', () => {
  expect(hasNoHiddenControlCharacters(REALISTIC_SCRIPT)).toBe(true)
  expect(
    workflowInputSchema.safeParse({ script: REALISTIC_SCRIPT }).success,
  ).toBe(true)
})

test('ESC and NUL are rejected', () => {
  expect(hasNoHiddenControlCharacters('return 1\x1b[2K hidden')).toBe(false)
  expect(hasNoHiddenControlCharacters('return 1\x00 hidden')).toBe(false)
})

test('carriage return is rejected — it is the character that repaints a shown line', () => {
  expect(hasNoHiddenControlCharacters('safe line\r rm -rf /')).toBe(false)
  expect(hasNoHiddenControlCharacters('crlf\r\nscript')).toBe(false)
})

test('the full rejected code-unit range matches upstream: <0x20 except TAB/LF, plus 0x7F-0x9F', () => {
  for (let code = 0; code <= 0x9f; code++) {
    const allowed = code === 9 || code === 10 || (code >= 32 && code <= 126)
    expect({
      code,
      ok: hasNoHiddenControlCharacters(`a${String.fromCharCode(code)}b`),
    }).toEqual({ code, ok: allowed })
  }
})

test('code points above U+009F are untouched — multi-byte UTF-8 is never a false positive', () => {
  const multibyte =
    '// 中文注释 emoji 🚀 combining é ñ — “quotes” ✓\nreturn "日本語"'
  expect(hasNoHiddenControlCharacters(multibyte)).toBe(true)
  expect(workflowInputSchema.safeParse({ script: multibyte }).success).toBe(
    true,
  )
  // Surrogate pairs are two code units; neither half may be mistaken for a control char.
  expect(hasNoHiddenControlCharacters('\u{1F680}\u{10FFFF}')).toBe(true)
  // U+0085 (NEL) is a C1 control and IS rejected, but only as its own code point —
  // it must not poison the U+00A0+ range that starts right after it.
  expect(hasNoHiddenControlCharacters('')).toBe(false)
  expect(hasNoHiddenControlCharacters(' ÿ')).toBe(true)
})

test('schema rejects a control-char script with the upstream message', () => {
  const parsed = workflowInputSchema.safeParse({
    script: 'return 1\x1b]0;pwned\x07',
  })
  expect(parsed.success).toBe(false)
  if (parsed.success) return
  expect(JSON.stringify(parsed.error.issues)).toContain(
    WORKFLOW_SCRIPT_CONTROL_CHAR_MESSAGE,
  )
})

test('args are screened recursively across strings, arrays, objects and keys', () => {
  expect(argsHaveNoHiddenControlCharacters({ a: ['ok', { b: 'fine' }] })).toBe(
    true,
  )
  expect(argsHaveNoHiddenControlCharacters('plain')).toBe(true)
  expect(argsHaveNoHiddenControlCharacters(42)).toBe(true)
  expect(argsHaveNoHiddenControlCharacters(null)).toBe(true)
  expect(argsHaveNoHiddenControlCharacters(['ok', 'bad\x1b[2K'])).toBe(false)
  expect(argsHaveNoHiddenControlCharacters({ nested: { x: 'bad\r' } })).toBe(
    false,
  )
  expect(argsHaveNoHiddenControlCharacters({ 'key\x1b': 'ok' })).toBe(false)
})

test('args with legitimate unicode still pass the schema', () => {
  expect(
    workflowInputSchema.safeParse({
      script: 'return args',
      args: { question: '这个仓库做什么？ 🚀', list: ['α', 'β'] },
    }).success,
  ).toBe(true)
})

test('schema rejects control chars hidden in args with the args message', () => {
  const parsed = workflowInputSchema.safeParse({
    script: 'return args',
    args: { note: 'looks fine\x1b[1A overwritten' },
  })
  expect(parsed.success).toBe(false)
  if (parsed.success) return
  expect(JSON.stringify(parsed.error.issues)).toContain(
    WORKFLOW_ARGS_CONTROL_CHAR_MESSAGE,
  )
})

test('deeply nested args beyond the scan depth are accepted rather than refused', () => {
  let deep: unknown = 'bad\x1b'
  for (let i = 0; i < 200; i++) deep = { deep }
  expect(argsHaveNoHiddenControlCharacters(deep)).toBe(true)
})

test('the disk-loaded message names its source and explains the CRLF case', () => {
  const message = resolvedScriptControlCharMessage('/repo/.occ/workflows/x.ts')
  expect(message).toContain('/repo/.occ/workflows/x.ts')
  expect(message).toContain('CRLF')
})
