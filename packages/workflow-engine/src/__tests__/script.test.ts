import { expect, test } from 'bun:test'
import {
  ScriptError,
  extractMeta,
  parseScript,
  type WorkflowHooks,
} from '../engine/script.js'

const stubHooks: WorkflowHooks = {
  agent: async () => 'agent-result',
  parallel: async thunks =>
    Promise.all(
      thunks.map(async t => {
        try {
          return await t()
        } catch {
          return null
        }
      }),
    ),
  pipeline: async () => [],
  phase: () => {},
  log: () => {},
  workflow: async () => null,
}

test('extractMeta extracts plain literals and strips the statement', () => {
  const src = `export const meta = { name: 'x', description: 'y' }\nreturn 1`
  const { meta, body } = extractMeta(src)
  expect(meta?.name).toBe('x')
  expect(meta?.description).toBe('y')
  expect(body).not.toContain('export const meta')
  expect(body).toContain('return 1')
})

test('extractMeta returns null when no meta and body unchanged', () => {
  const src = `return 42`
  const { meta, body } = extractMeta(src)
  expect(meta).toBeNull()
  expect(body).toBe(src)
})

test('extractMeta rejects non-plain literals (variable references)', () => {
  const src = `const x = 1\nexport const meta = { name: 'x', description: y }\nreturn 1`
  expect(() => extractMeta(src)).toThrow(ScriptError)
})

test('parseScript executes top-level return of body', async () => {
  const { execute } = parseScript(`return args.n + 1`)
  const out = await execute(stubHooks, { n: 41 }, { total: null })
  expect(out).toBe(42)
})

test('Date.now() in script throws non-determinism error', async () => {
  const { execute } = parseScript(`return Date.now()`)
  await expect(execute(stubHooks, {}, { total: null })).rejects.toThrow(
    /Date\.now/,
  )
})

test('Math.random() in script throws non-determinism error', async () => {
  const { execute } = parseScript(`return Math.random()`)
  await expect(execute(stubHooks, {}, { total: null })).rejects.toThrow(
    /Math\.random/,
  )
})

test('no-arg new Date() throws, but new Date(arg) is allowed', async () => {
  const bad = parseScript(`return new Date()`)
  await expect(bad.execute(stubHooks, {}, { total: null })).rejects.toThrow(
    /new Date/,
  )
  const good = parseScript(
    `return new Date('2020-06-12T00:00:00Z').getUTCFullYear()`,
  )
  await expect(good.execute(stubHooks, {}, { total: null })).resolves.toBe(2020)
})

// ---- meta validation error branches and nesting ----

test('extractMeta meta is array → ScriptError', () => {
  expect(() => extractMeta('export const meta = [1, 2]\nreturn 1')).toThrow(
    ScriptError,
  )
})

test('extractMeta meta missing name → ScriptError', () => {
  expect(() =>
    extractMeta('export const meta = { description: "d" }\nreturn 1'),
  ).toThrow(ScriptError)
})

test('extractMeta meta missing description → ScriptError', () => {
  expect(() =>
    extractMeta('export const meta = { name: "n" }\nreturn 1'),
  ).toThrow(ScriptError)
})

test('extractMeta meta unclosed braces → ScriptError', () => {
  expect(() =>
    extractMeta('export const meta = { name: "n", description: "d"\nreturn 1'),
  ).toThrow(ScriptError)
})

test('extractMeta supports nested objects (phases array)', () => {
  const src = `export const meta = { name: 'x', description: 'y', phases: [{ title: 'A' }, { title: 'B' }] }\nreturn 1`
  const { meta } = extractMeta(src)
  expect(meta?.name).toBe('x')
  expect(meta?.phases).toHaveLength(2)
  expect(meta?.phases?.[0]?.title).toBe('A')
  expect(meta?.phases?.[1]?.title).toBe('B')
})

test('parseScript syntax error → ScriptError', () => {
  expect(() => parseScript('return ((')).toThrow(ScriptError)
})

test('parseScript detects import → guided ScriptError (not a generic syntax error)', () => {
  expect(() =>
    parseScript(
      `import { foo } from 'bar'\nexport const meta = { name: 'n', description: 'd' }\nreturn foo()`,
    ),
  ).toThrow(ScriptError)
  expect(() =>
    parseScript(
      `import { foo } from 'bar'\nexport const meta = { name: 'n', description: 'd' }\nreturn foo()`,
    ),
  ).toThrow(/import is not supported/)
})

test('parseScript detects extra export beyond meta → guided ScriptError', () => {
  expect(() =>
    parseScript(
      `export const meta = { name: 'n', description: 'd' }\nexport const X = 1\nreturn X`,
    ),
  ).toThrow(ScriptError)
  expect(() =>
    parseScript(
      `export const meta = { name: 'n', description: 'd' }\nexport const X = 1\nreturn X`,
    ),
  ).toThrow(/allow only one export const meta/)
})

test('parseScript does not misfire on normal plain JS scripts (no import / no extra export)', () => {
  const { execute } = parseScript(
    `export const meta = { name: 'n', description: 'd' }\nconst r = await agent('hi')\nreturn r`,
  )
  expect(typeof execute).toBe('function')
})

test('parseScript detects dynamic import(...) → guided ScriptError (sandbox anti-escape)', () => {
  expect(() =>
    parseScript(
      `const cp = await import('node:child_process')\nreturn cp.execSync('id').toString()`,
    ),
  ).toThrow(ScriptError)
  expect(() =>
    parseScript(`const cp = await import('node:child_process')\nreturn cp`),
  ).toThrow(/import/)
})

test('parseScript does not misfire when a line contains the import string literal (e.g. prompt contains "import")', () => {
  // import inside a string should not be caught by the static regex — prompt may contain the word "import"
  const { execute } = parseScript(
    `export const meta = { name: 'n', description: 'd' }\nconst r = await agent('please import this module')\nreturn r`,
  )
  expect(typeof execute).toBe('function')
})

test('meta must be the first statement and never evaluates getters, calls, or interpolation', () => {
  expect(() =>
    extractMeta(
      `const before = true\nexport const meta = { name: 'n', description: 'd' }`,
    ),
  ).toThrow(/FIRST statement/)
  expect(() =>
    extractMeta(
      `export const meta = { name: 'n', get description() { throw new Error('ran') } }`,
    ),
  ).toThrow(/plain literal/)
  expect(() =>
    extractMeta(
      `export const meta = { name: 'n', description: (() => { throw new Error('ran') })() }`,
    ),
  ).toThrow(/plain literal/)
  expect(() =>
    extractMeta(
      "export const meta = { name: 'n', description: `unsafe $" +
        '{process.env.HOME}` }',
    ),
  ).toThrow(/interpolation/)
})

test('VM exposes only workflow globals plus safe standard intrinsics', async () => {
  const { execute } = parseScript(`
    return {
      process: typeof process,
      require: typeof require,
      module: typeof module,
      global: typeof global,
      globalThisProcess: typeof globalThis.process,
      globalThisRequire: typeof globalThis.require,
      buffer: typeof Buffer,
      shadowRealm: typeof ShadowRealm,
      agent: typeof agent,
      timeout: typeof setTimeout,
      array: typeof Array,
    }
  `)
  await expect(execute(stubHooks, {}, { total: null })).resolves.toEqual({
    process: 'undefined',
    require: 'undefined',
    module: 'undefined',
    global: 'undefined',
    globalThisProcess: 'undefined',
    globalThisRequire: 'undefined',
    buffer: 'undefined',
    shadowRealm: 'undefined',
    agent: 'function',
    timeout: 'function',
    array: 'function',
  })
})

test('host hook functions cannot be used to escape the VM realm', async () => {
  const attempts = [
    `return agent.constructor.constructor('return process')()`,
    `return Object.getPrototypeOf(agent).constructor('return process')()`,
    `return globalThis.constructor.constructor('return process')()`,
  ]
  for (const source of attempts) {
    await expect(
      parseScript(source).execute(stubHooks, {}, { total: null }),
    ).rejects.toThrow()
  }
})

test('string and wasm code generation are disabled', async () => {
  for (const source of [
    `return Function('return 1')()`,
    `return eval('1 + 1')`,
    `return WebAssembly`,
  ]) {
    await expect(
      parseScript(source).execute(stubHooks, {}, { total: null }),
    ).rejects.toThrow()
  }
})

test('args and workflow return values are recursively cleaned across realms', async () => {
  const { execute } = parseScript(`
    return {
      value: args.nested.value,
      argProtoSafe: Object.getPrototypeOf(args) === Object.prototype,
      nestedProtoSafe: Object.getPrototypeOf(args.nested) === Object.prototype,
      resultProtoSafe: Object.getPrototypeOf({ ok: true }) === Object.prototype,
    }
  `)
  const result = await execute(
    stubHooks,
    { nested: { value: 7 } },
    { total: null },
  )
  expect(result).toEqual({
    value: 7,
    argProtoSafe: true,
    nestedProtoSafe: true,
    resultProtoSafe: true,
  })
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
})

test('boundary rejects custom prototypes, cycles, functions, symbols, and oversized arrays', async () => {
  const executeArgs = parseScript(`return args`).execute
  const custom = Object.create({ inherited: true }) as Record<string, unknown>
  custom.value = 1
  await expect(executeArgs(stubHooks, custom, null)).rejects.toThrow(
    /custom prototypes/,
  )

  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  await expect(executeArgs(stubHooks, cycle, null)).rejects.toThrow(/cycles/)
  await expect(executeArgs(stubHooks, { fn: () => 1 }, null)).rejects.toThrow(
    /functions/,
  )
  await expect(
    executeArgs(stubHooks, { symbol: Symbol('x') }, null),
  ).rejects.toThrow(/symbols/)
  await expect(executeArgs(stubHooks, Array(4097), null)).rejects.toThrow(
    /maximum of 4096/,
  )

  await expect(
    parseScript(`const x = {}; x.self = x; return x`).execute(
      stubHooks,
      {},
      null,
    ),
  ).rejects.toThrow(/cycles/)
  await expect(
    parseScript(`return Object.create({ inherited: true })`).execute(
      stubHooks,
      {},
      null,
    ),
  ).rejects.toThrow(/custom prototypes/)
})

test('hook arguments and results are cleaned in both directions', async () => {
  let receivedOptions: unknown
  const hooks: WorkflowHooks = {
    ...stubHooks,
    agent: async (_prompt, opts) => {
      receivedOptions = opts
      return { answer: 42 }
    },
  }
  const result = await parseScript(`
    const value = await agent('hello', { nested: { ok: true } })
    return {
      answer: value.answer,
      resultProtoSafe: Object.getPrototypeOf(value) === Object.prototype,
    }
  `).execute(hooks, {}, null)

  expect(receivedOptions).toEqual({ nested: { ok: true } })
  expect(Object.getPrototypeOf(receivedOptions)).toBe(Object.prototype)
  expect(result).toEqual({ answer: 42, resultProtoSafe: true })

  const cyclicHooks: WorkflowHooks = {
    ...stubHooks,
    agent: async () => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      return cyclic
    },
  }
  await expect(
    parseScript(`return agent('hello')`).execute(cyclicHooks, {}, null),
  ).rejects.toThrow(/cycles/)
})

test('timers are cleared when execution settles, independent of abort', async () => {
  let fired = false
  const hooks: WorkflowHooks = {
    ...stubHooks,
    log: message => {
      if (message === 'late') fired = true
    },
  }
  const result = await parseScript(`
    setTimeout(() => log('late'), 20)
    return 'done'
  `).execute(hooks, {}, null)
  expect(result).toBe('done')
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(fired).toBe(false)
})

test('normal async workflow supports agent, parallel, pipeline, timers, and logs', async () => {
  const messages: string[] = []
  const hooks: WorkflowHooks = {
    ...stubHooks,
    agent: async prompt => `${prompt}:ok`,
    pipeline: async <T, R>(
      items: readonly T[],
      ...stages: Array<
        (prev: unknown, item: T, index: number) => Promise<unknown>
      >
    ) =>
      Promise.all(
        items.map(async (item, index): Promise<R | null> => {
          let previous: unknown = item
          for (const stage of stages) {
            previous = await stage(previous, item, index)
          }
          return previous as R
        }),
      ),
    log: message => messages.push(message),
  }
  const result = await parseScript(`
    const direct = await agent('direct')
    const fanout = await parallel([
      () => agent('a'),
      () => agent('b'),
    ])
    const piped = await pipeline([1, 2], async (_prev, item) => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return item * 2
    })
    log('finished')
    return { direct, fanout, piped }
  `).execute(hooks, {}, null)

  expect(result).toEqual({
    direct: 'direct:ok',
    fanout: ['a:ok', 'b:ok'],
    piped: [2, 4],
  })
  expect(messages).toEqual(['finished'])
})
