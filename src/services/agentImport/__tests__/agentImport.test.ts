/**
 * Tests for `occ import`.
 *
 * Mock-free by design. The whole feature is "read someone else's files and
 * write ours", so a mocked filesystem would test the mock: the symlink guard,
 * the no-clobber write and the `wx` race guard only mean anything against a
 * real directory tree. Fixtures are built under a temp dir, and OCC_CONFIG_DIR
 * points the write side at another one.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  containedPath,
  hasNoSymlinkComponent,
  hasShellExecMarker,
  toSafeName,
} from '../safety.js'
import { parseToml, TomlParseError } from '../toml.js'
import { parseJsonWithComments } from '../gemini.js'
import { scanAgentConfigs } from '../scan.js'
import type { McpServerStore } from '../types.js'
import { scanDigest } from '../digest.js'
import { parseImportArgs, runAgentImport } from '../command.js'
import { renderScanReport, UNTRUSTED_DATA_NOTICE } from '../report.js'

const previousConfigDir = process.env.OCC_CONFIG_DIR
const previousLegacyConfigDir = process.env.CLAUDE_CONFIG_DIR

/** Root holding the fake `~` (fixtures) and the fake occ config dir. */
let sandbox = ''
let fakeHome = ''
let occDir = ''
let repo = ''

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'occ-agent-import-'))
  fakeHome = join(sandbox, 'home')
  occDir = join(sandbox, 'occ-config')
  repo = join(sandbox, 'repo')
  mkdirSync(occDir, { recursive: true })
  mkdirSync(repo, { recursive: true })
  process.env.OCC_CONFIG_DIR = occDir
  delete process.env.CLAUDE_CONFIG_DIR

  // ---- Codex fixture -----------------------------------------------------
  const codex = join(fakeHome, '.codex')
  mkdirSync(join(codex, 'prompts'), { recursive: true })
  writeFileSync(
    join(codex, 'config.toml'),
    [
      'approval_policy = "full-auto"',
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = ["-y", "docs-mcp"]',
      'env = { DOCS_API_KEY = "sk-secret-value" }',
      '',
      '[mcp_servers."weird name/../etc"]',
      'url = "https://example.invalid/sse"',
      '',
      '[agents]',
      'enabled = true',
      'default_subagent_model = "gpt-x"',
      '',
      '[agents.reviewer]',
      'description = "Reviews diffs"',
      'instructions = """',
      'Review the diff and report bugs.',
      '"""',
      'tools = ["read"]',
      '',
      '[agents.summariser]',
      'description = "Summarises"',
      'instructions = "Summarise the change."',
      '',
      '[[skills.config]]',
      'path = "./skills/leftover"',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(codex, 'prompts', 'summarise.md'),
    'Summarise the current diff.\n',
    'utf8',
  )
  writeFileSync(
    join(codex, 'prompts', 'danger.md'),
    'Run this: !`rm -rf /`\n',
    'utf8',
  )
  writeFileSync(join(codex, 'AGENTS.md'), '# Codex house rules\n', 'utf8')

  // ---- Gemini fixture ----------------------------------------------------
  const gemini = join(fakeHome, '.gemini')
  mkdirSync(join(gemini, 'commands'), { recursive: true })
  writeFileSync(
    join(gemini, 'settings.json'),
    [
      '{',
      '  // user comment',
      '  "theme": "dark",',
      '  "mcpServers": {',
      '    "search": {',
      '      "httpUrl": "https://example.invalid/mcp",',
      '      "headers": { "Authorization": "Bearer sk-live" }',
      '    }',
      '  },',
      '}',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(gemini, 'commands', 'plan.toml'),
    [
      'description = "Draft a plan"',
      'prompt = """',
      'Draft a plan.',
      '"""',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(gemini, 'commands', 'shellish.toml'),
    ['prompt = "Status: !{git status}"', ''].join('\n'),
    'utf8',
  )
  writeFileSync(join(gemini, 'GEMINI.md'), '# Gemini house rules\n', 'utf8')
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = previousConfigDir
  if (previousLegacyConfigDir === undefined)
    delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousLegacyConfigDir
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

/**
 * In-memory stand-in for occ's global config.
 *
 * The apply path used to read back through `src/utils/config/config.js`, which
 * is process-global state that a full `bun test src/` run leaves in a different
 * shape than a single-file run does — the assertion saw an empty server list
 * even though the import had worked. Injecting the store keeps this suite
 * hermetic AND stops it writing into the shared test config, which was leaking
 * the other way.
 */
function makeMemoryMcpStore(): McpServerStore & {
  names(): string[]
  dump(): string
} {
  const servers = new Map<string, unknown>()
  return {
    has: name => servers.has(name),
    add: (name, config) => {
      servers.set(name, config)
    },
    names: () => [...servers.keys()],
    dump: () => JSON.stringify([...servers.entries()]),
  }
}

let mcpStore = makeMemoryMcpStore()

function scanFixture() {
  return scanAgentConfigs({ homeDir: fakeHome, cwd: repo, mcpStore })
}

beforeEach(() => {
  mcpStore = makeMemoryMcpStore()
})

describe('parseToml', () => {
  test('reads the shapes Codex and Gemini actually write', () => {
    const parsed = parseToml(
      [
        '# comment',
        'approval_policy = "on-request"',
        'count = 12',
        'ratio = 0.5',
        'flag = true',
        "literal = 'raw \\n stays'",
        'block = """',
        'line one',
        'line two',
        '"""',
        '',
        '[mcp_servers.docs]',
        'command = "npx"',
        'args = ["-y", "docs-mcp"]',
        'env = { A = "1", B = "2" }',
        '',
        '[[skills.config]]',
        'path = "./one"',
        '[[skills.config]]',
        'path = "./two"',
      ].join('\n'),
    )
    expect(parsed.approval_policy).toBe('on-request')
    expect(parsed.count).toBe(12)
    expect(parsed.ratio).toBe(0.5)
    expect(parsed.flag).toBe(true)
    expect(parsed.literal).toBe('raw \\n stays')
    expect(parsed.block).toBe('line one\nline two\n')
    const servers = parsed.mcp_servers as Record<
      string,
      Record<string, unknown>
    >
    expect(servers.docs?.command).toBe('npx')
    expect(servers.docs?.args).toEqual(['-y', 'docs-mcp'])
    expect(servers.docs?.env).toEqual({ A: '1', B: '2' })
    const skills = parsed.skills as { config: { path: string }[] }
    expect(skills.config.map(entry => entry.path)).toEqual(['./one', './two'])
  })

  test('rejects duplicates, datetimes and runaway nesting', () => {
    expect(() => parseToml('a = 1\na = 2\n')).toThrow(TomlParseError)
    expect(() => parseToml('[t]\n[t]\n')).toThrow(TomlParseError)
    expect(() => parseToml('when = 1979-05-27T07:32:00Z\n')).toThrow(
      TomlParseError,
    )
    expect(() => parseToml(`v = ${'['.repeat(200)}`)).toThrow(TomlParseError)
  })
})

describe('parseJsonWithComments', () => {
  test('keeps `https://` inside strings while stripping comments', () => {
    const parsed = parseJsonWithComments(
      '{ // note\n "url": "https://example.invalid/x", /* block */ "n": 1, }',
    ) as Record<string, unknown>
    expect(parsed.url).toBe('https://example.invalid/x')
    expect(parsed.n).toBe(1)
  })
})

describe('safety primitives', () => {
  test('toSafeName neuters traversal, frontmatter and flag shapes', () => {
    expect(toSafeName('../../etc/passwd')).toBe('______etc_passwd')
    expect(toSafeName('a---b')).toBe('a___b')
    expect(toSafeName('--force')).toBe('_force')
    expect(toSafeName('')).toBe('_')
    expect(toSafeName('ok_name-1')).toBe('ok_name-1')
    // Whatever comes out must satisfy occ's MCP server-name rule.
    for (const raw of ['../x', 'a b', 'emoji😀', '--x', '']) {
      expect(toSafeName(raw)).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })

  test('containedPath refuses escapes and the base itself', () => {
    expect(containedPath('/base', 'child')).toBe(join('/base', 'child'))
    expect(containedPath('/base', '../sibling')).toBeNull()
    expect(containedPath('/base', '/absolute')).toBeNull()
    expect(containedPath('/base', '.')).toBeNull()
  })

  test('hasNoSymlinkComponent rejects a symlinked directory component', async () => {
    const base = mkdtempSync(join(tmpdir(), 'occ-symlink-'))
    try {
      mkdirSync(join(base, 'real'), { recursive: true })
      symlinkSync(join(base, 'real'), join(base, 'link'), 'dir')
      expect(
        await hasNoSymlinkComponent(base, join(base, 'real', 'f.md')),
      ).toBe(join(base, 'real', 'f.md'))
      expect(
        await hasNoSymlinkComponent(base, join(base, 'link', 'f.md')),
      ).toBeNull()
      expect(
        await hasNoSymlinkComponent(base, join(base, '..', 'x')),
      ).toBeNull()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('hasShellExecMarker catches both marker spellings', () => {
    expect(hasShellExecMarker('prefix !`ls` suffix')).toBe(true)
    expect(hasShellExecMarker('```!\nls\n```')).toBe(true)
    expect(hasShellExecMarker('plain text with ! and `code`')).toBe(false)
  })
})

describe('scanAgentConfigs', () => {
  test('finds both agents and classifies every fixture entry', async () => {
    const scan = await scanFixture()
    expect(scan.error).toBeUndefined()
    expect(scan.scans.map(entry => entry.sourceId)).toEqual(['codex', 'gemini'])

    const items = scan.scans.flatMap(entry => entry.result.items)
    const ids = items.map(item => item.id)
    expect(ids).toContain('codex:user:mcp:docs')
    expect(ids).toContain('codex:user:subagent:reviewer')
    expect(ids).toContain('codex:user:command:summarise')
    expect(ids).toContain('codex:user:instructions')
    expect(ids).toContain('gemini:user:mcp:search')
    expect(ids).toContain('gemini:user:command:plan')
    expect(ids).toContain('gemini:user:instructions')

    // A foreign name that looks like a path traversal becomes a safe name.
    expect(ids).toContain('codex:user:mcp:weird_name____etc')

    const unmappable = scan.scans.flatMap(entry => entry.result.unmappable)
    const reasons = unmappable.map(entry => `${entry.label} :: ${entry.reason}`)
    // Shell-exec markers are held back, never translated.
    expect(reasons.some(text => text.startsWith('Command /danger'))).toBe(true)
    expect(reasons.some(text => text.startsWith('Command /shellish'))).toBe(
      true,
    )
    // Permission modes and skill directories are reported, never applied.
    expect(reasons.some(text => text.includes('approval_policy'))).toBe(true)
    expect(reasons.some(text => text.includes('Skill at'))).toBe(true)
    expect(reasons.some(text => text.includes('sandbox_mode'))).toBe(true)
    // `[agents]` scalars are Codex runtime settings, not subagents: they must
    // collapse into one line, not four bogus `Subagent "enabled"` entries.
    expect(
      reasons.filter(text => text.startsWith('[agents] settings:')),
    ).toHaveLength(1)
    expect(reasons.some(text => text.includes('Subagent "enabled"'))).toBe(
      false,
    )
  })

  test('strips MCP secrets and says so', async () => {
    const scan = await scanFixture()
    const items = scan.scans.flatMap(entry => entry.result.items)

    const docs = items.find(item => item.id === 'codex:user:mcp:docs')
    expect(docs).toBeDefined()
    expect(docs?.fingerprint).not.toContain('sk-secret-value')
    expect(docs?.fingerprint).not.toContain('DOCS_API_KEY')
    expect(docs?.note).toContain('DOCS_API_KEY')

    const search = items.find(item => item.id === 'gemini:user:mcp:search')
    expect(search?.fingerprint).not.toContain('sk-live')
    expect(search?.note).toContain('Authorization')
  })

  test('rejects an unknown source without throwing', async () => {
    const scan = await scanAgentConfigs({
      homeDir: fakeHome,
      cwd: repo,
      from: 'cursor',
    })
    expect(scan.scans).toEqual([])
    expect(scan.error).toContain('cursor')
  })

  test('scoping to one source only scans that one', async () => {
    const scan = await scanAgentConfigs({
      homeDir: fakeHome,
      cwd: repo,
      from: 'gemini',
    })
    expect(scan.scans.map(entry => entry.sourceId)).toEqual(['gemini'])
  })
})

describe('scanDigest', () => {
  test('is stable across scans and changes when the source changes', async () => {
    const first = scanDigest((await scanFixture()).scans)
    const second = scanDigest((await scanFixture()).scans)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{32}$/)

    const extra = join(fakeHome, '.gemini', 'commands', 'extra.toml')
    writeFileSync(extra, 'prompt = "Something new."\n', 'utf8')
    try {
      expect(scanDigest((await scanFixture()).scans)).not.toBe(first)
    } finally {
      rmSync(extra, { force: true })
    }
    expect(scanDigest((await scanFixture()).scans)).toBe(first)
  })
})

describe('parseImportArgs', () => {
  test('separates source, flags and the digest', () => {
    expect(parseImportArgs(['codex', '--dry-run'])).toMatchObject({
      source: 'codex',
      dryRun: true,
      confirm: false,
    })
    expect(parseImportArgs(['--yes=abc'])).toMatchObject({
      confirm: true,
      digest: 'abc',
    })
    expect(parseImportArgs(['--bogus']).unrecognised).toEqual(['--bogus'])
    expect(parseImportArgs(['codex', 'gemini']).unrecognised).toEqual([
      'gemini',
    ])
  })
})

describe('runAgentImport', () => {
  // A function, not a constant: `describe` bodies run before `beforeAll`, so a
  // captured `fakeHome` would still be the empty string and the scan would read
  // the developer's REAL ~/.codex.
  const runOptions = () => ({
    invocation: '/import',
    requireDigest: true,
    scan: { homeDir: fakeHome, cwd: repo, mcpStore },
  })

  test('the preview marks foreign labels as untrusted data', async () => {
    const result = await runAgentImport(parseImportArgs([]), runOptions())
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain(UNTRUSTED_DATA_NOTICE)
    expect(result.text).toMatch(/Scan digest: [0-9a-f]{32}/)
    expect(result.text).toContain('--yes=')
  })

  test('a bare --yes is refused on the model-facing surface', async () => {
    const result = await runAgentImport(
      parseImportArgs(['--yes']),
      runOptions(),
    )
    expect(result.exitCode).toBe(2)
    expect(result.text).toContain('needs the scan digest')
  })

  test('a stale digest is refused', async () => {
    const result = await runAgentImport(
      parseImportArgs(['--yes=00000000000000000000000000000000']),
      runOptions(),
    )
    expect(result.exitCode).toBe(2)
    expect(result.text).toContain('no longer matches the preview')
  })

  test('a malformed digest is refused', async () => {
    const result = await runAgentImport(
      parseImportArgs(['--yes=not-a-digest']),
      runOptions(),
    )
    expect(result.exitCode).toBe(2)
    expect(result.text).toContain('needs the scan digest')
  })

  test('dry run writes nothing', async () => {
    const digest = scanDigest((await scanFixture()).scans)
    const result = await runAgentImport(
      parseImportArgs([`--yes=${digest}`, '--dry-run']),
      runOptions(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('Dry run')
    expect(() =>
      readFileSync(join(occDir, 'commands', 'summarise.md'), 'utf8'),
    ).toThrow()
  })

  test('applies user-scope items, then skips them on a second run', async () => {
    const digest = scanDigest((await scanFixture()).scans)
    const first = await runAgentImport(
      parseImportArgs([`--yes=${digest}`]),
      runOptions(),
    )
    expect(first.exitCode).toBe(0)
    expect(first.text).toContain('Imported')

    expect(
      readFileSync(join(occDir, 'commands', 'summarise.md'), 'utf8'),
    ).toContain('Summarise the current diff.')
    expect(readFileSync(join(occDir, 'commands', 'plan.md'), 'utf8')).toContain(
      'Draft a plan.',
    )
    const summariser = readFileSync(
      join(occDir, 'agents', 'summariser.md'),
      'utf8',
    )
    expect(summariser).toContain('name: summariser')
    expect(summariser).toContain('Summarise the change.')
    // `reviewer` declares Codex tool restrictions occ cannot express, so it is
    // flagged and must NOT have been written by the confirm.
    expect(() =>
      readFileSync(join(occDir, 'agents', 'reviewer.md'), 'utf8'),
    ).toThrow()

    // MCP servers land in the store, secret-free and schema-validated.
    expect(mcpStore.names()).toContain('docs')
    expect(mcpStore.names()).toContain('search')
    expect(mcpStore.dump()).not.toContain('sk-secret-value')
    expect(mcpStore.dump()).not.toContain('sk-live')

    const memory = readFileSync(join(occDir, 'CLAUDE.md'), 'utf8')
    expect(memory).toContain('Codex house rules')
    expect(memory).toContain('Gemini house rules')
    expect(memory).toContain('<!-- occ-import: codex:user:instructions -->')

    // Second run: nothing new, nothing overwritten.
    const secondDigest = scanDigest((await scanFixture()).scans)
    const second = await runAgentImport(
      parseImportArgs([`--yes=${secondDigest}`]),
      runOptions(),
    )
    expect(second.exitCode).toBe(0)
    expect(second.text).toContain('Imported 0 items')
    expect(second.text).toContain('already imported (marker present')
    expect(second.text).toContain('already exists')
    expect(second.text).toContain('MCP server already exists in user config')
    // The memory file must not have grown a second copy.
    const memoryAfter = readFileSync(join(occDir, 'CLAUDE.md'), 'utf8')
    expect(memoryAfter).toBe(memory)
  })

  test('the applied report never leaks a stripped secret', async () => {
    const scan = await scanFixture()
    const text = renderScanReport(scan, '/import')
    expect(text).not.toContain('sk-secret-value')
    expect(text).not.toContain('sk-live')
  })
})

describe('/import slash command', () => {
  // The command's `load()` resolves its implementation through a dynamic
  // import. A wrong specifier there is invisible until someone actually types
  // `/import`, so exercise the real load path rather than the module's exports.
  //
  // Driven with a bad flag on purpose: `runAgentImport` rejects that before it
  // touches the filesystem, so this asserts the wiring without depending on
  // whether the machine running the suite happens to have a ~/.codex.
  test('loads and rejects a bad flag before scanning anything', async () => {
    const command = (await import('../../../commands/import/index.js')).default
    expect(command.type).toBe('local')
    if (command.type !== 'local') throw new Error('unreachable')
    const { call } = await command.load()
    const result = await call('--bogus', {} as never)
    expect(result.type).toBe('text')
    if (result.type !== 'text') throw new Error('unreachable')
    expect(result.value).toContain('Unrecognised argument: --bogus')
    expect(result.value).toContain('/import [codex|gemini]')
  })
})
