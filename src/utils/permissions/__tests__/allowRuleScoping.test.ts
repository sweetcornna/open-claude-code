/**
 * Regression guards for two ways an `allow` rule used to grant more than it
 * spelled out:
 *
 *  1. Allow was checked against the literal request path only, while deny and
 *     ask iterate every symlink target `getPathsForPermissionCheck` resolves.
 *     `allow: ["Edit(src/**)"]` plus `src/link -> <outside>/secret.txt` was
 *     therefore auto-approved.
 *  2. `dir/**` was stripped to `dir` unconditionally, which is a gitignore
 *     *basename* pattern — it matches at any depth. `allow: ["Edit(dist/**)"]`
 *     also granted `node_modules/<pkg>/dist/**`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

const { checkWritePermissionForTool, matchingRuleForInput } = await import(
  '../filesystem.js'
)
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function contextWithRules(opts: { allow?: string[]; deny?: string[] }): Ctx {
  const ctx = getEmptyToolPermissionContext()
  return {
    ...ctx,
    ...(opts.allow ? { alwaysAllowRules: { localSettings: opts.allow } } : {}),
    ...(opts.deny ? { alwaysDenyRules: { localSettings: opts.deny } } : {}),
  } as Ctx
}

// A minimal stand-in for FileEditTool: the permission engine only needs a name
// and getPath, and building the real tool would drag in the whole tool graph.
const editTool = {
  name: 'Edit',
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as Parameters<typeof checkWritePermissionForTool>[0]

// Realpath the temp root so the fixture paths are already canonical — the
// point of these tests is the symlink we create on purpose, not macOS's
// /tmp -> /private/tmp alias.
const BASE = `${realpathSync('/tmp')}/occ-allow-rule-scoping-test`
const REPO = `${BASE}/repo`
const OUTSIDE_SECRET = `${BASE}/other-repo/secret.txt`

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(`${REPO}/src`, { recursive: true })
  mkdirSync(`${BASE}/other-repo`, { recursive: true })
  writeFileSync(OUTSIDE_SECRET, 'API_KEY=hunter2')
  writeFileSync(`${REPO}/src/ok.ts`, '')
  symlinkSync(OUTSIDE_SECRET, `${REPO}/src/link`)
})

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true })
})

describe('allow rules must cover every resolved path', () => {
  const ctx = () => contextWithRules({ allow: [`Edit(/${REPO}/src/**)`] })

  test('a symlink out of the allowed tree is not auto-approved', () => {
    const result = checkWritePermissionForTool(
      editTool,
      { file_path: `${REPO}/src/link` },
      ctx(),
    )
    expect(result.behavior).not.toBe('allow')
  })

  test('an ordinary file inside the allowed tree stays allowed', () => {
    const result = checkWritePermissionForTool(
      editTool,
      { file_path: `${REPO}/src/ok.ts` },
      ctx(),
    )
    expect(result.behavior).toBe('allow')
  })

  test('a not-yet-created file inside the allowed tree stays allowed', () => {
    const result = checkWritePermissionForTool(
      editTool,
      { file_path: `${REPO}/src/brand-new.ts` },
      ctx(),
    )
    expect(result.behavior).toBe('allow')
  })

  test('platform symlink aliases do not trip the all-paths check', () => {
    // On macOS /tmp is a symlink to /private/tmp, so the resolved twin spells
    // the same directory differently. normalizeTrustedSymlink exists so that
    // does not read as an escape.
    const aliasCtx = contextWithRules({
      allow: ['Edit(//tmp/occ-allow-rule-scoping-test/repo/src/**)'],
    })
    const result = checkWritePermissionForTool(
      editTool,
      { file_path: '/tmp/occ-allow-rule-scoping-test/repo/src/ok.ts' },
      aliasCtx,
    )
    expect(result.behavior).toBe('allow')
  })
})

describe('dir/** allow rules are anchored to their root', () => {
  // Relative patterns resolve against the process cwd, so build the probe
  // paths from it rather than from the temp fixture.
  const cwd = process.cwd()

  test('Edit(dist/**) does not grant node_modules/<pkg>/dist', () => {
    const ctx = contextWithRules({ allow: ['Edit(dist/**)'] })
    expect(
      matchingRuleForInput(
        `${cwd}/node_modules/some-pkg/dist/index.js`,
        ctx,
        'edit',
        'allow',
      ),
    ).toBeNull()
  })

  test('Edit(dist/**) still grants the top-level dist', () => {
    const ctx = contextWithRules({ allow: ['Edit(dist/**)'] })
    const rule = matchingRuleForInput(
      `${cwd}/dist/index.js`,
      ctx,
      'edit',
      'allow',
    )
    expect(rule).not.toBeNull()
    expect(rule!.ruleValue.ruleContent).toBe('dist/**')
  })

  test('allow patterns that already contain a separator are unchanged', () => {
    const ctx = contextWithRules({ allow: ['Edit(src/generated/**)'] })
    expect(
      matchingRuleForInput(`${cwd}/src/generated/api.ts`, ctx, 'edit', 'allow'),
    ).not.toBeNull()
    expect(
      matchingRuleForInput(
        `${cwd}/vendor/src/generated/api.ts`,
        ctx,
        'edit',
        'allow',
      ),
    ).toBeNull()
  })

  test('deny keeps match-anywhere semantics — anchoring must not narrow it', () => {
    const ctx = contextWithRules({ deny: ['Edit(dist/**)'] })
    expect(
      matchingRuleForInput(
        `${cwd}/node_modules/some-pkg/dist/index.js`,
        ctx,
        'edit',
        'deny',
      ),
    ).not.toBeNull()
    expect(
      matchingRuleForInput(`${cwd}/dist/index.js`, ctx, 'edit', 'deny'),
    ).not.toBeNull()
  })
})
