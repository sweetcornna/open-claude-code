import { createContext, runInContext, Script, type Context } from 'node:vm'
import type { WorkflowMeta } from '../types.js'

export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

/** Shape of the hook functions the engine injects into a script. */
export type WorkflowHooks = {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>
  pipeline: <T, R>(
    items: readonly T[],
    ...stages: Array<
      (prev: unknown, item: T, index: number) => Promise<unknown>
    >
  ) => Promise<Array<R | null>>
  phase: (title: string) => void
  log: (message: string) => void
  workflow: (
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ) => Promise<unknown>
}

const MAX_BOUNDARY_ARRAY_LENGTH = 4096
const RESERVED_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch)
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

function skipTrivia(source: string, from: number): number {
  let i = from
  if (i === 0 && source.startsWith('#!')) {
    const newline = source.indexOf('\n')
    i = newline === -1 ? source.length : newline + 1
  }
  while (i < source.length) {
    if (/\s/.test(source[i]!)) {
      i++
      continue
    }
    if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i + 2)
      i = newline === -1 ? source.length : newline + 1
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return source.length
      i = end + 2
      continue
    }
    break
  }
  return i
}

function consumeKeyword(
  source: string,
  from: number,
  keyword: string,
): number | null {
  if (!source.startsWith(keyword, from)) return null
  if (isIdentifierPart(source[from - 1])) return null
  if (isIdentifierPart(source[from + keyword.length])) return null
  return from + keyword.length
}

function metaHeaderEnd(source: string): number | null {
  let i = skipTrivia(source, 0)
  i = consumeKeyword(source, i, 'export') ?? -1
  if (i < 0) return null
  i = skipTrivia(source, i)
  i = consumeKeyword(source, i, 'const') ?? -1
  if (i < 0) return null
  i = skipTrivia(source, i)
  i = consumeKeyword(source, i, 'meta') ?? -1
  if (i < 0) return null
  i = skipTrivia(source, i)
  if (source[i] !== '=') return null
  return skipTrivia(source, i + 1)
}

/**
 * Replace strings and comments with spaces while retaining code positions. This
 * is deliberately a lexer rather than a parser: it keeps the workflow package
 * free of a parser on the CLI startup path.
 */
function codeOnly(source: string): string {
  const chars = [...source]
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]!
    const next = chars[i + 1]
    if (ch === '/' && next === '/') {
      chars[i++] = ' '
      chars[i++] = ' '
      while (i < chars.length && chars[i] !== '\n') chars[i++] = ' '
      continue
    }
    if (ch === '/' && next === '*') {
      chars[i++] = ' '
      chars[i++] = ' '
      while (i < chars.length) {
        if (chars[i] === '*' && chars[i + 1] === '/') {
          chars[i++] = ' '
          chars[i++] = ' '
          break
        }
        if (chars[i] !== '\n') chars[i] = ' '
        i++
      }
      continue
    }
    if (ch !== '"' && ch !== "'" && ch !== '`') {
      i++
      continue
    }
    const quote = ch
    chars[i++] = ' '
    while (i < chars.length) {
      const current = chars[i]!
      if (current === '\\') {
        chars[i++] = ' '
        if (i < chars.length && chars[i] !== '\n') chars[i] = ' '
        i++
        continue
      }
      if (current === quote) {
        chars[i++] = ' '
        break
      }
      if (current !== '\n') chars[i] = ' '
      i++
    }
  }
  return chars.join('')
}

class MetaLiteralParser {
  private position: number

  constructor(
    private readonly source: string,
    start: number,
  ) {
    this.position = start
  }

  parse(): { value: unknown; end: number } {
    if (this.source[this.position] !== '{') {
      throw new ScriptError('meta must be an object literal `{ ... }`')
    }
    const value = this.parseObject()
    return { value, end: this.position }
  }

  private fail(message: string): never {
    throw new ScriptError(
      `meta must be a plain literal (no variable/function calls/interpolation): ${message}`,
    )
  }

  private skip(): void {
    this.position = skipTrivia(this.source, this.position)
  }

  private parseValue(): unknown {
    this.skip()
    const ch = this.source[this.position]
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString()
    if (ch === '-' || ch === '.' || /[0-9]/.test(ch ?? '')) {
      return this.parseNumber()
    }
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      const end = consumeKeyword(this.source, this.position, word)
      if (end !== null) {
        this.position = end
        return value
      }
    }
    return this.fail(`unexpected token at offset ${this.position}`)
  }

  private parseObject(): Record<string, unknown> {
    this.position++
    const result: Record<string, unknown> = Object.create(null)
    this.skip()
    if (this.source[this.position] === '}') {
      this.position++
      return result
    }
    while (this.position < this.source.length) {
      this.skip()
      const key = this.parseKey()
      if (RESERVED_META_KEYS.has(key)) {
        this.fail(`reserved key name not allowed in meta: ${key}`)
      }
      this.skip()
      if (this.source[this.position] !== ':') {
        this.fail('only plain properties are allowed in meta')
      }
      this.position++
      Object.defineProperty(result, key, {
        value: this.parseValue(),
        writable: true,
        enumerable: true,
        configurable: true,
      })
      this.skip()
      const delimiter = this.source[this.position]
      if (delimiter === '}') {
        this.position++
        return result
      }
      if (delimiter !== ',') this.fail('expected `,` or `}` in meta object')
      this.position++
      this.skip()
      if (this.source[this.position] === '}') {
        this.position++
        return result
      }
    }
    throw new ScriptError('meta literal braces are not closed')
  }

  private parseKey(): string {
    const ch = this.source[this.position]
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString()
    if (isIdentifierStart(ch)) {
      const start = this.position++
      while (isIdentifierPart(this.source[this.position])) this.position++
      return this.source.slice(start, this.position)
    }
    if (ch === '-' || /[0-9]/.test(ch ?? '')) {
      return String(this.parseNumber())
    }
    return this.fail(
      'computed, spread, and method keys are not allowed in meta',
    )
  }

  private parseArray(): unknown[] {
    this.position++
    const result: unknown[] = []
    this.skip()
    if (this.source[this.position] === ']') {
      this.position++
      return result
    }
    while (this.position < this.source.length) {
      if (this.source[this.position] === ',') {
        this.fail('sparse arrays are not allowed in meta')
      }
      result.push(this.parseValue())
      this.skip()
      const delimiter = this.source[this.position]
      if (delimiter === ']') {
        this.position++
        return result
      }
      if (delimiter !== ',') this.fail('expected `,` or `]` in meta array')
      this.position++
      this.skip()
      if (this.source[this.position] === ']') {
        this.position++
        return result
      }
    }
    return this.fail('meta array is not closed')
  }

  private parseString(): string {
    const quote = this.source[this.position++]!
    let result = ''
    while (this.position < this.source.length) {
      const ch = this.source[this.position++]!
      if (ch === quote) return result
      if (quote === '`' && ch === '$' && this.source[this.position] === '{') {
        this.fail('template interpolation is not allowed in meta')
      }
      if (ch !== '\\') {
        if ((quote === '"' || quote === "'") && (ch === '\n' || ch === '\r')) {
          this.fail('unterminated string in meta')
        }
        result += ch
        continue
      }
      if (this.position >= this.source.length) {
        this.fail('unterminated escape in meta string')
      }
      const escaped = this.source[this.position++]!
      const simple: Record<string, string> = {
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '0': '\0',
        '\\': '\\',
        '"': '"',
        "'": "'",
        '`': '`',
      }
      if (escaped in simple) {
        result += simple[escaped]
        continue
      }
      if (escaped === '\n') continue
      if (escaped === '\r') {
        if (this.source[this.position] === '\n') this.position++
        continue
      }
      if (escaped === 'x') {
        result += String.fromCodePoint(this.readHex(2))
        continue
      }
      if (escaped === 'u') {
        if (this.source[this.position] === '{') {
          this.position++
          const end = this.source.indexOf('}', this.position)
          if (end === -1) this.fail('unterminated Unicode escape in meta')
          const digits = this.source.slice(this.position, end)
          if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) {
            this.fail('invalid Unicode escape in meta')
          }
          const codePoint = Number.parseInt(digits, 16)
          if (codePoint > 0x10ffff) this.fail('invalid Unicode code point')
          result += String.fromCodePoint(codePoint)
          this.position = end + 1
          continue
        }
        result += String.fromCodePoint(this.readHex(4))
        continue
      }
      if (/[1-9]/.test(escaped)) {
        this.fail('legacy octal escapes are not allowed in meta')
      }
      result += escaped
    }
    return this.fail('unterminated string in meta')
  }

  private readHex(length: number): number {
    const digits = this.source.slice(this.position, this.position + length)
    if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) {
      this.fail('invalid hexadecimal escape in meta')
    }
    this.position += length
    return Number.parseInt(digits, 16)
  }

  private parseNumber(): number {
    const remaining = this.source.slice(this.position)
    const match =
      /^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
        remaining,
      )
    if (!match) return this.fail('invalid number in meta')
    const raw = match[0]
    if (isIdentifierPart(remaining[raw.length])) {
      return this.fail('invalid number in meta')
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) this.fail('meta numbers must be finite')
    this.position += raw.length
    return value
  }
}

/**
 * Extract the optional first-statement `export const meta = { ... }` pure
 * literal. Parsing is data-only: getters, calls, computed keys, spreads, and
 * interpolation are rejected without evaluating any user code.
 */
export function extractMeta(source: string): {
  meta: WorkflowMeta | null
  body: string
} {
  const headerEnd = metaHeaderEnd(source)
  if (headerEnd === null) {
    if (/\bexport\s+const\s+meta\b/.test(codeOnly(source))) {
      throw new ScriptError(
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
      )
    }
    return { meta: null, body: source }
  }

  const parsed = new MetaLiteralParser(source, headerEnd).parse()
  const meta = validateMeta(parsed.value)
  const body = source.slice(parsed.end).replace(/^[ \t]*;[ \t]*(?:\r?\n)?/, '')
  return { meta, body }
}

function validateMeta(v: unknown): WorkflowMeta {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ScriptError('meta must be an object')
  }
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.description !== 'string') {
    throw new ScriptError('meta must include string name and description')
  }
  return o as unknown as WorkflowMeta
}

// ---- VM hardening ----

const VM_SETUP_SOURCE = `(() => {
  class NonDeterministicError extends Error {
    constructor(fn) {
      super(fn + ' is not available in workflow scripts (would break resume determinism). Pass timestamps/random seeds via args.')
      this.name = 'NonDeterministicError'
    }
  }

  const RealDate = Date
  function SafeDate(...values) {
    if (values.length === 0) {
      throw new NonDeterministicError('Date.now()/new Date()')
    }
    return Reflect.construct(RealDate, values, new.target || SafeDate)
  }
  SafeDate.now = () => { throw new NonDeterministicError('Date.now()') }
  SafeDate.parse = RealDate.parse
  SafeDate.UTC = RealDate.UTC
  SafeDate.prototype = RealDate.prototype
  RealDate.prototype.constructor = SafeDate
  globalThis.Date = SafeDate

  Math.random = () => { throw new NonDeterministicError('Math.random()') }

  for (const name of [
    'ShadowRealm', 'WebAssembly', 'FinalizationRegistry', 'WeakRef', 'Atomics',
    'SharedArrayBuffer', 'queueMicrotask', 'console', '$vm', 'gc', 'edenGC',
    'fullGC', 'print', 'readFile', 'Loader', 'process', 'require', 'module',
    'global', 'Buffer',
  ]) {
    delete globalThis[name]
  }

  function enableOverride(proto, key) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    if (!descriptor || 'get' in descriptor) return
    const value = descriptor.value
    Object.defineProperty(proto, key, {
      get() { return value },
      set(next) {
        if (this === proto) return
        Object.defineProperty(this, key, {
          value: next,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      },
      enumerable: descriptor.enumerable,
      configurable: true,
    })
  }

  const errorConstructors = [
    Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError,
    URIError, AggregateError, globalThis.SuppressedError,
  ].filter(Boolean)
  for (const [proto, keys] of [
    [Object.prototype, Object.getOwnPropertyNames(Object.prototype)],
    [Function.prototype, ['toString', 'constructor', 'name', 'length']],
    [Array.prototype, ['toString', 'constructor']],
    [Date.prototype, ['toString', 'toLocaleString', 'valueOf', 'constructor']],
    ...errorConstructors.map(C => [
      C.prototype,
      ['name', 'message', 'toString', 'constructor'],
    ]),
  ]) {
    for (const key of keys) enableOverride(proto, key)
  }

  for (const C of [
    Promise, Object, Array, Function, globalThis.Iterator, Map, Set, WeakMap,
    WeakSet, String, Number, Boolean, Symbol, BigInt, Date, RegExp,
    ArrayBuffer, DataView, ...errorConstructors,
  ].filter(Boolean)) {
    Object.freeze(C)
    Object.freeze(C.prototype)
  }
  for (const C of [
    Object.getPrototypeOf(Int8Array), Int8Array, Uint8Array,
    Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    globalThis.Float16Array, Float32Array, Float64Array, BigInt64Array,
    BigUint64Array,
  ].filter(Boolean)) {
    Object.freeze(C)
    Object.freeze(C.prototype)
  }
  for (const fn of [async () => {}, function* () {}, async function* () {}]) {
    Object.freeze(fn.constructor)
    Object.freeze(fn.constructor.prototype)
  }
  for (const namespace of [JSON, Math, Reflect, Proxy]) {
    Object.freeze(namespace)
  }
  if (typeof Intl !== 'undefined') {
    for (const key of Object.getOwnPropertyNames(Intl)) {
      const C = Intl[key]
      if (typeof C === 'function') {
        Object.freeze(C)
        if (C.prototype) Object.freeze(C.prototype)
      }
    }
    Object.freeze(Intl)
  }
  Object.defineProperty(globalThis, 'then', {
    value: undefined,
    writable: false,
    configurable: false,
  })
})()`

function assertScriptBody(body: string): void {
  const code = codeOnly(body)
  if (/^\s*import\b/m.test(code)) {
    throw new ScriptError(
      'workflow scripts are the body of new AsyncFunction (not ESM modules); import is not supported. ' +
        'agent / parallel / pipeline / phase / log / workflow / args / budget are injected as parameters — use them directly.',
    )
  }
  if (/\bimport\s*\(/m.test(code)) {
    throw new ScriptError(
      'dynamic import(...) is forbidden in workflow scripts: it bypasses the Date/Math sandbox and breaks resume determinism. ' +
        'The sandbox does not guarantee security (same trust level as the LLM), but explicit escapes are prohibited. Inject external dependencies via args.',
    )
  }
  if (/^\s*export\b/m.test(code)) {
    throw new ScriptError(
      'workflow scripts allow only one export const meta = {...} (already extracted by the engine). ' +
        'Remove other export / export default statements; use top-level return for the result.',
    )
  }
}

function boundaryError(path: string, reason: string): ScriptError {
  return new ScriptError(
    `${path} is not JSON-like across the workflow VM boundary: ${reason}`,
  )
}

type BoundaryRealm = {
  objectPrototype: object
  arrayPrototype: object
}

function cloneBoundary(
  value: unknown,
  realm: BoundaryRealm,
  path: string,
  active = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (value === undefined) {
    throw boundaryError(path, 'undefined is not allowed')
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw boundaryError(path, 'numbers must be finite')
    }
    return value
  }
  if (typeof value === 'function') {
    throw boundaryError(path, 'functions are not allowed')
  }
  if (typeof value === 'symbol') {
    throw boundaryError(path, 'symbols are not allowed')
  }
  if (typeof value === 'bigint') {
    throw boundaryError(path, 'bigints are not allowed')
  }
  if (active.has(value)) throw boundaryError(path, 'cycles are not allowed')

  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    throw boundaryError(path, 'unable to inspect prototype')
  }

  if (Array.isArray(value)) {
    if (prototype !== realm.arrayPrototype) {
      throw boundaryError(
        path,
        'array prototype is not the expected realm intrinsic',
      )
    }
    const length = value.length
    if (!Number.isSafeInteger(length)) {
      throw boundaryError(path, 'array length is not a safe integer')
    }
    if (length > MAX_BOUNDARY_ARRAY_LENGTH) {
      throw boundaryError(
        path,
        `array length ${length} exceeds the maximum of ${MAX_BOUNDARY_ARRAY_LENGTH}`,
      )
    }
    let keys: Array<string | symbol>
    try {
      keys = Reflect.ownKeys(value)
    } catch {
      throw boundaryError(path, 'unable to inspect array properties')
    }
    for (const key of keys) {
      if (typeof key === 'symbol') {
        throw boundaryError(path, 'symbol properties are not allowed')
      }
      if (key === 'length') continue
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index >= length) {
        throw boundaryError(
          path,
          `non-index array property ${JSON.stringify(key)}`,
        )
      }
    }

    active.add(value)
    const result: unknown[] = []
    result.length = length
    try {
      for (let i = 0; i < length; i++) {
        let descriptor: PropertyDescriptor | undefined
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        } catch {
          throw boundaryError(`${path}[${i}]`, 'unable to inspect property')
        }
        if (!descriptor) continue
        if (!('value' in descriptor)) {
          throw boundaryError(`${path}[${i}]`, 'accessors are not allowed')
        }
        result[i] = cloneBoundary(
          descriptor.value,
          realm,
          `${path}[${i}]`,
          active,
        )
      }
    } finally {
      active.delete(value)
    }
    return result
  }

  if (prototype !== realm.objectPrototype && prototype !== null) {
    throw boundaryError(path, 'custom prototypes are not allowed')
  }
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw boundaryError(path, 'unable to inspect object properties')
  }

  active.add(value)
  const result: Record<string, unknown> = {}
  try {
    for (const key of keys) {
      if (typeof key === 'symbol') {
        throw boundaryError(path, 'symbol properties are not allowed')
      }
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key)
      } catch {
        throw boundaryError(`${path}.${key}`, 'unable to inspect property')
      }
      if (!descriptor?.enumerable) {
        throw boundaryError(
          `${path}.${key}`,
          'non-enumerable properties are not allowed',
        )
      }
      if (!('value' in descriptor)) {
        throw boundaryError(`${path}.${key}`, 'accessors are not allowed')
      }
      Object.defineProperty(result, key, {
        value: cloneBoundary(descriptor.value, realm, `${path}.${key}`, active),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
  } finally {
    active.delete(value)
  }
  return result
}

function nullPrototypeFunction<T extends (...args: never[]) => unknown>(
  fn: T,
): T {
  Object.setPrototypeOf(fn, null)
  return Object.freeze(fn)
}

function hostErrorDetails(error: unknown): {
  name: string
  message: string
  stack?: string
} {
  if (typeof error === 'string') return { name: 'Error', message: error }
  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
  ) {
    return { name: 'Error', message: String(error) }
  }
  let name = 'Error'
  let message = '<unprintable thrown value>'
  let stack: string | undefined
  try {
    if (typeof (error as { name?: unknown })?.name === 'string') {
      name = (error as { name: string }).name
    }
  } catch {}
  try {
    if (typeof (error as { message?: unknown })?.message === 'string') {
      message = (error as { message: string }).message
    }
  } catch {}
  try {
    if (typeof (error as { stack?: unknown })?.stack === 'string') {
      stack = (error as { stack: string }).stack
    }
  } catch {}
  return { name, message, ...(stack ? { stack } : {}) }
}

function vmErrorToHost(error: unknown): Error {
  if (typeof error === 'string') return new Error(error)
  const details = hostErrorDetails(error)
  const result = new Error(details.message)
  result.name = details.name
  if (details.stack) result.stack = details.stack
  return result
}

type VmRuntime = {
  context: Context
  hostRealm: BoundaryRealm
  vmRealm: BoundaryRealm
  toVm: (value: unknown, path: string) => unknown
  fromVm: (value: unknown, path: string) => unknown
  asyncWrapper: (
    impl: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => Promise<unknown>
  syncWrapper: (
    impl: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => unknown
  normalizeVmError: (error: unknown) => unknown
  invokeVm: (fn: (...args: unknown[]) => unknown, args: unknown[]) => unknown
  invokeTimer: (fn: (...args: unknown[]) => unknown, args: unknown[]) => void
}

function createVmRuntime(): VmRuntime {
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  })
  runInContext(VM_SETUP_SOURCE, context)

  const hostRealm: BoundaryRealm = {
    objectPrototype: Object.prototype,
    arrayPrototype: Array.prototype,
  }
  const vmRealm: BoundaryRealm = {
    objectPrototype: runInContext('Object.prototype', context) as object,
    arrayPrototype: runInContext('Array.prototype', context) as object,
  }
  const cloneIntoVm = runInContext(
    `(value => {
      const active = new WeakMap()
      function clone(input) {
        if (input === null || typeof input !== 'object') return input
        const existing = active.get(input)
        if (existing !== undefined) return existing
        if (Array.isArray(input)) {
          const output = []
          active.set(input, output)
          output.length = input.length
          for (let i = 0; i < input.length; i++) {
            if (Object.prototype.hasOwnProperty.call(input, i)) {
              output[i] = clone(input[i])
            }
          }
          return output
        }
        const output = {}
        active.set(input, output)
        for (const key of Object.keys(input)) {
          Object.defineProperty(output, key, {
            value: clone(input[key]),
            writable: true,
            enumerable: true,
            configurable: true,
          })
        }
        return output
      }
      return clone(value)
    })`,
    context,
  ) as (value: unknown) => unknown

  const makeAsyncWrapper = runInContext(
    '(hostFn => async (...values) => await hostFn(...values))',
    context,
  ) as (
    hostFn: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => Promise<unknown>
  const makeSyncWrapper = runInContext(
    '(hostFn => (...values) => hostFn(...values))',
    context,
  ) as (
    hostFn: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => unknown
  const invokeVm = runInContext('((fn, values) => fn(...values))', context) as (
    fn: (...args: unknown[]) => unknown,
    values: unknown[],
  ) => unknown
  const invokeTimer = runInContext(
    `((fn, values) => {
      Promise.resolve().then(() => fn(...values)).catch(() => {})
    })`,
    context,
  ) as (fn: (...args: unknown[]) => unknown, values: unknown[]) => void

  const safeErrors = new WeakMap<object, unknown>()
  const safeError = (error: unknown): object => {
    const details = hostErrorDetails(error)
    const copy = Object.create(null) as Record<string, unknown>
    Object.defineProperties(copy, {
      name: { value: details.name, enumerable: true },
      message: { value: details.message, enumerable: true },
      ...(details.stack
        ? { stack: { value: details.stack, enumerable: true } }
        : {}),
    })
    Object.freeze(copy)
    safeErrors.set(copy, error)
    return copy
  }

  const toVm = (value: unknown, path: string): unknown =>
    cloneIntoVm(cloneBoundary(value, hostRealm, path))
  const fromVm = (value: unknown, path: string): unknown =>
    cloneBoundary(value, vmRealm, path)

  const asyncWrapper = (
    impl: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => Promise<unknown>) => {
    const guarded = nullPrototypeFunction(async (...args: unknown[]) => {
      try {
        return await impl(...args)
      } catch (error) {
        throw safeError(error)
      }
    })
    return makeAsyncWrapper(guarded)
  }
  const syncWrapper = (
    impl: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) => {
    const guarded = nullPrototypeFunction((...args: unknown[]) => {
      try {
        return impl(...args)
      } catch (error) {
        throw safeError(error)
      }
    })
    return makeSyncWrapper(guarded)
  }
  const normalizeVmError = (error: unknown): unknown => {
    if (
      (typeof error === 'object' || typeof error === 'function') &&
      error !== null &&
      safeErrors.has(error)
    ) {
      return safeErrors.get(error)
    }
    return vmErrorToHost(error)
  }

  return {
    context,
    hostRealm,
    vmRealm,
    toVm,
    fromVm,
    asyncWrapper,
    syncWrapper,
    normalizeVmError,
    invokeVm,
    invokeTimer,
  }
}

function defineGlobal(context: Context, name: string, value: unknown): void {
  Object.defineProperty(context, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function vmFunctionArray(
  value: unknown,
  runtime: VmRuntime,
  path: string,
): Array<(...args: unknown[]) => unknown> {
  if (!Array.isArray(value)) throw boundaryError(path, 'expected an array')
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    throw boundaryError(path, 'unable to inspect prototype')
  }
  if (prototype !== runtime.vmRealm.arrayPrototype) {
    throw boundaryError(path, 'array prototype is not the VM Array prototype')
  }
  if (value.length > MAX_BOUNDARY_ARRAY_LENGTH) {
    throw boundaryError(
      path,
      `array length ${value.length} exceeds the maximum of ${MAX_BOUNDARY_ARRAY_LENGTH}`,
    )
  }
  const result: Array<(...args: unknown[]) => unknown> = []
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !('value' in descriptor)) {
      throw boundaryError(`${path}[${i}]`, 'expected a function')
    }
    if (typeof descriptor.value !== 'function') {
      throw boundaryError(`${path}[${i}]`, 'expected a function')
    }
    result.push(descriptor.value as (...args: unknown[]) => unknown)
  }
  return result
}

function buildVmBudget(runtime: VmRuntime, budget: unknown): unknown {
  let total: unknown = null
  let spent: (() => unknown) | undefined
  let remaining: (() => unknown) | undefined
  if (typeof budget === 'object' && budget !== null) {
    try {
      total = (budget as { total?: unknown }).total ?? null
      const maybeSpent = (budget as { spent?: unknown }).spent
      const maybeRemaining = (budget as { remaining?: unknown }).remaining
      if (typeof maybeSpent === 'function') {
        spent = () => maybeSpent.call(budget)
      }
      if (typeof maybeRemaining === 'function') {
        remaining = () => maybeRemaining.call(budget)
      }
    } catch {
      throw boundaryError('budget', 'unable to read budget API')
    }
  }
  const makeBudget = runInContext(
    `((total, spent, remaining) => Object.freeze(Object.assign(
      Object.create(null), { total, spent, remaining }
    )))`,
    runtime.context,
  ) as (total: unknown, spent: unknown, remaining: unknown) => unknown
  const vmSpent = runtime.syncWrapper(() =>
    runtime.toVm(spent ? spent() : 0, 'budget.spent() return value'),
  )
  const vmRemaining = runtime.syncWrapper(() => {
    const value = remaining ? remaining() : null
    if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
    return runtime.toVm(value, 'budget.remaining() return value')
  })
  return makeBudget(runtime.toVm(total, 'budget.total'), vmSpent, vmRemaining)
}

function installRuntimeGlobals(
  runtime: VmRuntime,
  hooks: WorkflowHooks,
  args: unknown,
  budget: unknown,
): () => void {
  const { context } = runtime

  const callVmFunction = async (
    fn: (...args: unknown[]) => unknown,
    hostArgs: unknown[],
    path: string,
  ): Promise<unknown> => {
    const vmArgs = hostArgs.map((value, index) =>
      runtime.toVm(value, `${path} argument ${index}`),
    )
    try {
      const result = runtime.invokeVm(fn, vmArgs)
      return runtime.fromVm(await result, `${path} return value`)
    } catch (error) {
      throw runtime.normalizeVmError(error)
    }
  }

  defineGlobal(
    context,
    'agent',
    runtime.asyncWrapper(async (prompt, opts) => {
      const cleanPrompt = runtime.fromVm(prompt, 'agent prompt')
      const cleanOpts =
        opts === undefined ? undefined : runtime.fromVm(opts, 'agent options')
      const result = await hooks.agent(
        cleanPrompt as string,
        cleanOpts as Record<string, unknown> | undefined,
      )
      return runtime.toVm(result, 'agent return value')
    }),
  )

  defineGlobal(
    context,
    'parallel',
    runtime.asyncWrapper(async thunks => {
      const vmThunks = vmFunctionArray(thunks, runtime, 'parallel thunks')
      const hostThunks = vmThunks.map((thunk, index) =>
        nullPrototypeFunction(async () =>
          callVmFunction(thunk, [], `parallel thunk ${index}`),
        ),
      )
      return runtime.toVm(
        await hooks.parallel(hostThunks),
        'parallel return value',
      )
    }),
  )

  defineGlobal(
    context,
    'pipeline',
    runtime.asyncWrapper(async (items, ...stages) => {
      const cleanItems = runtime.fromVm(items, 'pipeline items')
      if (!Array.isArray(cleanItems)) {
        throw boundaryError('pipeline items', 'expected an array')
      }
      const vmStages = stages.map((stage, index) => {
        if (typeof stage !== 'function') {
          throw boundaryError(`pipeline stage ${index}`, 'expected a function')
        }
        return stage as (...args: unknown[]) => unknown
      })
      const hostStages = vmStages.map((stage, index) =>
        nullPrototypeFunction(
          async (previous: unknown, item: unknown, itemIndex: number) =>
            callVmFunction(
              stage,
              [previous, item, itemIndex],
              `pipeline stage ${index}`,
            ),
        ),
      )
      return runtime.toVm(
        await hooks.pipeline(cleanItems, ...hostStages),
        'pipeline return value',
      )
    }),
  )

  defineGlobal(
    context,
    'phase',
    runtime.syncWrapper(title => {
      hooks.phase(runtime.fromVm(title, 'phase title') as string)
    }),
  )
  defineGlobal(
    context,
    'log',
    runtime.syncWrapper(message => {
      hooks.log(runtime.fromVm(message, 'log message') as string)
    }),
  )
  defineGlobal(
    context,
    'workflow',
    runtime.asyncWrapper(async (nameOrRef, workflowArgs) => {
      const cleanRef = runtime.fromVm(nameOrRef, 'workflow reference')
      const cleanArgs =
        workflowArgs === undefined
          ? undefined
          : runtime.fromVm(workflowArgs, 'workflow args')
      const result = await hooks.workflow(
        cleanRef as string | { scriptPath: string },
        cleanArgs,
      )
      return runtime.toVm(result, 'workflow return value')
    }),
  )

  defineGlobal(
    context,
    'args',
    args === undefined ? undefined : runtime.toVm(args, 'args'),
  )
  defineGlobal(context, 'budget', buildVmBudget(runtime, budget))

  let timerSequence = 1
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  defineGlobal(
    context,
    'setTimeout',
    runtime.syncWrapper((callback, delay, ...callbackArgs) => {
      if (typeof callback !== 'function') {
        throw new TypeError('setTimeout callback must be a function')
      }
      const cleanDelay = runtime.fromVm(delay, 'setTimeout delay')
      if (
        cleanDelay !== undefined &&
        typeof cleanDelay !== 'number' &&
        typeof cleanDelay !== 'string'
      ) {
        throw boundaryError('setTimeout delay', 'expected a number or string')
      }
      const cleanArgs = callbackArgs.map((value, index) =>
        runtime.fromVm(value, `setTimeout argument ${index}`),
      )
      const vmArgs = cleanArgs.map((value, index) =>
        runtime.toVm(value, `setTimeout argument ${index}`),
      )
      const id = timerSequence++
      const handle = setTimeout(
        () => {
          timers.delete(id)
          runtime.invokeTimer(
            callback as (...args: unknown[]) => unknown,
            vmArgs,
          )
        },
        Number(cleanDelay ?? 0),
      )
      timers.set(id, handle)
      return id
    }),
  )
  defineGlobal(
    context,
    'clearTimeout',
    runtime.syncWrapper(timerId => {
      const cleanId = runtime.fromVm(timerId, 'clearTimeout id')
      if (typeof cleanId !== 'number') return
      const handle = timers.get(cleanId)
      if (!handle) return
      clearTimeout(handle)
      timers.delete(cleanId)
    }),
  )

  return () => {
    for (const handle of timers.values()) clearTimeout(handle)
    timers.clear()
  }
}

export type ParsedScript = {
  meta: WorkflowMeta | null
  execute: (
    hooks: WorkflowHooks,
    args: unknown,
    budget: unknown,
  ) => Promise<unknown>
}

export function parseScript(source: string): ParsedScript {
  const sourceWithoutMeta =
    metaHeaderEnd(source) === null ? source : extractMeta(source).body
  assertScriptBody(sourceWithoutMeta)
  const { meta, body } = extractMeta(source)
  assertScriptBody(body)

  let script: Script
  try {
    const syntaxCheck = new Script(
      `async function __workflow() {'use strict';\n${body}\n}`,
    )
    // Bun's vm.Script defers parsing until the first run; validate in a throwaway
    // context so parseScript keeps its synchronous syntax-error contract.
    syntaxCheck.runInContext(
      createContext(Object.create(null), {
        codeGeneration: { strings: false, wasm: false },
      }),
    )
    script = new Script(`(async () => {'use strict';\n${body}\n})()`, {
      filename: 'workflow.js',
      importModuleDynamically: () => {
        throw 'dynamic import(...) is forbidden in workflow scripts'
      },
    })
  } catch (error) {
    throw new ScriptError(`Script syntax error: ${(error as Error).message}`)
  }

  return {
    meta,
    async execute(hooks, args, budget) {
      const runtime = createVmRuntime()
      const cleanupTimers = installRuntimeGlobals(runtime, hooks, args, budget)
      try {
        const result = script.runInContext(runtime.context)
        return runtime.fromVm(await result, 'workflow return value')
      } catch (error) {
        throw runtime.normalizeVmError(error)
      } finally {
        cleanupTimers()
      }
    },
  }
}
