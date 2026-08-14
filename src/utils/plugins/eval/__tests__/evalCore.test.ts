/**
 * Case format, discovery, deterministic assertions and the init scaffold.
 *
 * No `mock.module` anywhere: everything under test is either pure or takes its
 * side effects as parameters, and the few filesystem cases use a real temp
 * directory. That is deliberate — a process-global module mock here would leak
 * into every sibling file in the shard.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EvalCaseSchema,
  partitionRequestedTools,
  baseToolName,
} from '../caseSchema.js'
import { evaluateAssertions, resolveWorkspacePath } from '../assertions.js'
import {
  caseNameMatches,
  discoverCases,
  findPluginManifest,
  loadCase,
  resolveEvalsRoot,
} from '../discovery.js'
import { caseTemplate, scaffoldCase } from '../init.js'
import type { AgentRunOutcome } from '../types.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'occ-eval-test-'))
}

const OUTCOME: AgentRunOutcome = {
  ok: true,
  output: 'All done, wrote the changelog.',
  toolCalls: [
    { name: 'Write', inputJson: '{"file_path":"CHANGELOG.md"}' },
    { name: 'Skill', inputJson: '{"command":"my-plugin:changelog"}' },
  ],
  costUsd: 0.01,
  numTurns: 3,
  durationMs: 1200,
}

describe('case schema', () => {
  test('requires exactly one of prompt / prompt_file', () => {
    expect(
      EvalCaseSchema.safeParse({
        prompt: 'x',
        assert: [{ type: 'file_exists', path: 'a' }],
      }).success,
    ).toBe(true)
    expect(
      EvalCaseSchema.safeParse({ assert: [{ type: 'file_exists', path: 'a' }] })
        .success,
    ).toBe(false)
    expect(
      EvalCaseSchema.safeParse({
        prompt: 'x',
        prompt_file: 'p.md',
        assert: [{ type: 'file_exists', path: 'a' }],
      }).success,
    ).toBe(false)
  })

  test('rejects a case with nothing to grade it', () => {
    const result = EvalCaseSchema.safeParse({ prompt: 'x' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toContain('at least one')
  })

  test('a judge block alone is enough to grade a case', () => {
    expect(
      EvalCaseSchema.safeParse({ prompt: 'x', judge: { rubric: 'be good' } })
        .success,
    ).toBe(true)
  })

  test('skill_used defaults to with-only, other assertions to both', () => {
    const parsed = EvalCaseSchema.parse({
      prompt: 'x',
      assert: [
        { type: 'skill_used', skill: 'foo' },
        { type: 'file_exists', path: 'a' },
      ],
    })
    expect(parsed.assert[0]!.arm).toBe('with-only')
    expect(parsed.assert[1]!.arm).toBe('both')
  })

  test('rejects the stateful g regex flag', () => {
    expect(
      EvalCaseSchema.safeParse({
        prompt: 'x',
        assert: [{ type: 'file_matches', path: 'a', pattern: 'b', flags: 'g' }],
      }).success,
    ).toBe(false)
  })

  test('defaults runs to 1 so a bare case is cheap', () => {
    expect(
      EvalCaseSchema.parse({ prompt: 'x', judge: { rubric: 'r' } }).runs,
    ).toBe(1)
  })
})

describe('tool partitioning', () => {
  test('read and write tools are self-authorized, Bash is not', () => {
    const { allowed, denied } = partitionRequestedTools(
      ['Read', 'Write', 'Bash', 'WebFetch'],
      [],
    )
    expect(allowed).toEqual(['Read', 'Write'])
    expect(denied).toEqual(['Bash', 'WebFetch'])
  })

  test('an operator grant unlocks a denied tool, matching on base name', () => {
    const { allowed, denied } = partitionRequestedTools(
      ['Bash(git:*)'],
      ['Bash'],
    )
    expect(allowed).toEqual(['Bash(git:*)'])
    expect(denied).toEqual([])
  })

  test('baseToolName strips permission patterns', () => {
    expect(baseToolName('Bash(git commit:*)')).toBe('Bash')
    expect(baseToolName('Read')).toBe('Read')
  })
})

describe('workspace path confinement', () => {
  test('rejects absolute paths and parent traversal', () => {
    expect(resolveWorkspacePath('/ws', '/etc/passwd')).toBeNull()
    expect(resolveWorkspacePath('/ws', '../../.ssh/id_rsa')).toBeNull()
    expect(resolveWorkspacePath('/ws', 'a/../../out')).toBeNull()
  })

  test('accepts paths inside the workspace', () => {
    expect(resolveWorkspacePath('/ws', 'a/b.txt')).toBe('/ws/a/b.txt')
  })
})

describe('deterministic assertions', () => {
  test('file_exists and file_absent read the real workspace', async () => {
    const ws = tempDir()
    try {
      writeFileSync(join(ws, 'CHANGELOG.md'), '## 1.2.0\n')
      const results = await evaluateAssertions(
        EvalCaseSchema.parse({
          prompt: 'x',
          assert: [
            { type: 'file_exists', path: 'CHANGELOG.md' },
            { type: 'file_absent', path: 'TODO.md' },
            { type: 'file_exists', path: 'missing.md' },
          ],
        }).assert,
        { workspace: ws, outcome: OUTCOME, allowCommands: false },
        'with',
      )
      expect(results.map(r => r.passed)).toEqual([true, true, false])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('file_matches honours contains and not_contains', async () => {
    const ws = tempDir()
    try {
      writeFileSync(join(ws, 'CHANGELOG.md'), '## 1.2.0\nAdded things\n')
      const results = await evaluateAssertions(
        EvalCaseSchema.parse({
          prompt: 'x',
          assert: [
            {
              type: 'file_matches',
              path: 'CHANGELOG.md',
              pattern: '## 1\\.2\\.0',
            },
            {
              type: 'file_matches',
              path: 'CHANGELOG.md',
              pattern: 'TODO',
              match: 'not_contains',
            },
          ],
        }).assert,
        { workspace: ws, outcome: OUTCOME, allowCommands: false },
        'with',
      )
      expect(results.map(r => r.passed)).toEqual([true, true])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('an escaping path fails rather than reading the host', async () => {
    const ws = tempDir()
    try {
      const results = await evaluateAssertions(
        EvalCaseSchema.parse({
          prompt: 'x',
          assert: [{ type: 'file_exists', path: '../../../../etc/passwd' }],
        }).assert,
        { workspace: ws, outcome: OUTCOME, allowCommands: false },
        'with',
      )
      expect(results[0]!.passed).toBe(false)
      expect(results[0]!.detail).toContain('escapes the workspace')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  test('tool_used and skill_used read the transcript', async () => {
    const results = await evaluateAssertions(
      EvalCaseSchema.parse({
        prompt: 'x',
        assert: [
          { type: 'tool_used', tool: 'Write' },
          { type: 'tool_used', tool: 'Bash' },
          { type: 'skill_used', skill: 'changelog' },
          { type: 'skill_used', skill: 'nope' },
        ],
      }).assert,
      { workspace: '/nonexistent', outcome: OUTCOME, allowCommands: false },
      'with',
    )
    expect(results.map(r => r.passed)).toEqual([true, false, true, false])
  })

  test('tool_used matches on serialized input', async () => {
    const results = await evaluateAssertions(
      EvalCaseSchema.parse({
        prompt: 'x',
        assert: [
          { type: 'tool_used', tool: 'Write', input_matches: 'CHANGELOG' },
          { type: 'tool_used', tool: 'Write', input_matches: 'README' },
        ],
      }).assert,
      { workspace: '/nonexistent', outcome: OUTCOME, allowCommands: false },
      'with',
    )
    expect(results.map(r => r.passed)).toEqual([true, false])
  })

  test('output_matches reads the final answer', async () => {
    const results = await evaluateAssertions(
      EvalCaseSchema.parse({
        prompt: 'x',
        assert: [{ type: 'output_matches', pattern: 'wrote the changelog' }],
      }).assert,
      { workspace: '/nonexistent', outcome: OUTCOME, allowCommands: false },
      'with',
    )
    expect(results[0]!.passed).toBe(true)
  })

  test('with-only assertions are skipped entirely in the control arm', async () => {
    const assertions = EvalCaseSchema.parse({
      prompt: 'x',
      assert: [
        { type: 'skill_used', skill: 'changelog' },
        { type: 'tool_used', tool: 'Write' },
      ],
    }).assert
    const withArm = await evaluateAssertions(
      assertions,
      { workspace: '/nonexistent', outcome: OUTCOME, allowCommands: false },
      'with',
    )
    const withoutArm = await evaluateAssertions(
      assertions,
      { workspace: '/nonexistent', outcome: OUTCOME, allowCommands: false },
      'without',
    )
    expect(withArm).toHaveLength(2)
    // Not recorded as a failure in the control arm — simply not applicable.
    expect(withoutArm).toHaveLength(1)
    expect(withoutArm[0]!.label).toContain('tool_used')
  })

  test('command assertions fail closed without --allow-assert-commands', async () => {
    const results = await evaluateAssertions(
      EvalCaseSchema.parse({
        prompt: 'x',
        assert: [{ type: 'command', run: 'echo pwned' }],
      }).assert,
      { workspace: '/nonexistent', outcome: OUTCOME, allowCommands: false },
      'with',
    )
    expect(results[0]!.passed).toBe(false)
    expect(results[0]!.detail).toContain('--allow-assert-commands')
  })

  test('command assertions run when permitted, and check the exit code', async () => {
    const calls: string[] = []
    const results = await evaluateAssertions(
      EvalCaseSchema.parse({
        prompt: 'x',
        assert: [
          { type: 'command', run: 'true' },
          { type: 'command', run: 'false', expect_exit_code: 0 },
        ],
      }).assert,
      {
        workspace: '/nonexistent',
        outcome: OUTCOME,
        allowCommands: true,
        runCommand: async command => {
          calls.push(command)
          return { exitCode: command === 'true' ? 0 : 1, stdout: '' }
        },
      },
      'with',
    )
    expect(calls).toEqual(['true', 'false'])
    expect(results.map(r => r.passed)).toEqual([true, false])
  })
})

describe('discovery', () => {
  test('caseNameMatches supports * and ? only', () => {
    expect(caseNameMatches('adds-changelog', 'adds-*')).toBe(true)
    expect(caseNameMatches('adds-changelog', '*-changelog')).toBe(true)
    expect(caseNameMatches('adds-changelog', 'adds?changelog')).toBe(true)
    expect(caseNameMatches('adds-changelog', 'removes-*')).toBe(false)
    // A regex metacharacter is literal, not an alternation.
    expect(caseNameMatches('a+b', 'a+b')).toBe(true)
  })

  test('resolveEvalsRoot accepts a plugin root, an evals dir, or one case', () => {
    const root = tempDir()
    try {
      mkdirSync(join(root, 'evals', 'one'), { recursive: true })
      writeFileSync(join(root, 'evals', 'one', 'case.yaml'), 'prompt: hi\n')
      expect(resolveEvalsRoot(root)).toBe(join(root, 'evals'))
      expect(resolveEvalsRoot(join(root, 'evals'))).toBe(join(root, 'evals'))
      expect(resolveEvalsRoot(join(root, 'evals', 'one'))).toBe(
        join(root, 'evals', 'one'),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('findPluginManifest accepts both manifest locations', () => {
    const root = tempDir()
    try {
      expect(findPluginManifest(root)).toBeNull()
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}')
      expect(findPluginManifest(root)).toBe(
        join(root, '.claude-plugin', 'plugin.json'),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('loadCase reports a readable error instead of throwing', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'case.yaml'), 'prompt: hi\n')
      const result = loadCase(dir, { allowTools: [] })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('at least one')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('loadCase resolves prompt_file and names the case after its directory', () => {
    const root = tempDir()
    const dir = join(root, 'my-case')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'case.yaml'),
        'prompt_file: prompt.md\nassert:\n  - type: file_exists\n    path: a\n',
      )
      writeFileSync(join(dir, 'prompt.md'), 'Do the thing\n')
      const result = loadCase(dir, { allowTools: [] })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.name).toBe('my-case')
        expect(result.value.prompt.trim()).toBe('Do the thing')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('discoverCases applies --case and --tag filters and records load errors', () => {
    const root = tempDir()
    try {
      const write = (name: string, body: string): void => {
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(join(root, name, 'case.yaml'), body)
      }
      write(
        'alpha',
        'prompt: a\ntags: [fast]\nassert:\n  - type: file_exists\n    path: a\n',
      )
      write(
        'beta',
        'prompt: b\ntags: [slow]\nassert:\n  - type: file_exists\n    path: b\n',
      )
      write('broken', 'prompt: c\n')

      const all = discoverCases(root, { allowTools: [] })
      expect(all.cases.map(c => c.name)).toEqual(['alpha', 'beta'])
      expect(all.errors).toHaveLength(1)

      const filtered = discoverCases(root, {
        allowTools: [],
        caseFilter: 'al*',
      })
      expect(filtered.cases.map(c => c.name)).toEqual(['alpha'])

      const tagged = discoverCases(root, { allowTools: [], tags: ['slow'] })
      expect(tagged.cases.map(c => c.name)).toEqual(['beta'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--runs overrides the case file', () => {
    const root = tempDir()
    try {
      mkdirSync(join(root, 'a'), { recursive: true })
      writeFileSync(
        join(root, 'a', 'case.yaml'),
        'prompt: x\nruns: 2\nassert:\n  - type: file_exists\n    path: a\n',
      )
      const { cases } = discoverCases(root, { allowTools: [], runsOverride: 5 })
      expect(cases[0]!.spec.runs).toBe(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('init scaffold', () => {
  test('the generated template parses and grades deterministically', () => {
    const dir = tempDir()
    try {
      const result = scaffoldCase(dir, 'my-case')
      expect(result.ok).toBe(true)
      const loaded = loadCase(join(dir, 'evals', 'my-case'), { allowTools: [] })
      expect(loaded.ok).toBe(true)
      if (loaded.ok) {
        expect(loaded.value.spec.assert.length).toBeGreaterThan(0)
        // The scaffold must not commit the author to a paid grader.
        expect(loaded.value.spec.judge).toBeUndefined()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses invalid names and never overwrites', () => {
    const dir = tempDir()
    try {
      expect(scaffoldCase(dir, '../escape').ok).toBe(false)
      expect(scaffoldCase(dir, 'ok').ok).toBe(true)
      const second = scaffoldCase(dir, 'ok')
      expect(second.ok).toBe(false)
      if (!second.ok) expect(second.error).toContain('already exists')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the template names the case it was asked for', () => {
    expect(caseTemplate('widget-flow')).toContain('name: widget-flow')
  })
})
