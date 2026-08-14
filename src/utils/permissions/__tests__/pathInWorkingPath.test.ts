/**
 * Tests for pathInWorkingPath's per-call `caseFold` option and for the one
 * call site that must turn it off.
 *
 * The behaviour under test is about case-sensitive filesystems, and this suite
 * has to be meaningful on macOS (which is not one). So every assertion goes
 * through the pure comparison — absolute literal paths that never exist on
 * disk, compared as strings — rather than through anything that would ask the
 * real filesystem how it treats case. `expandPath` only normalises, and
 * `getPathsForPermissionCheck` falls back to the literal input for a path it
 * cannot stat, so a nonexistent `/nonexistent/...` tree exercises the same code
 * on every platform.
 */
import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../Tool.js'
import { pathInAllowedWorkingPath, pathInWorkingPath } from '../filesystem.js'

const WORKING = '/nonexistent/home/u/proj'

function makeContext(additional: string[] = []): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(
      additional.map(d => [d, { path: d, source: 'cliArg' as const }]),
    ),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
  }
}

describe('pathInWorkingPath', () => {
  describe('agreement between the two modes', () => {
    test('an exactly-cased child is inside either way', () => {
      expect(pathInWorkingPath(`${WORKING}/src/x.ts`, WORKING)).toBe(true)
      expect(
        pathInWorkingPath(`${WORKING}/src/x.ts`, WORKING, { caseFold: false }),
      ).toBe(true)
    })

    test('the working path is inside itself either way', () => {
      expect(pathInWorkingPath(WORKING, WORKING)).toBe(true)
      expect(pathInWorkingPath(WORKING, WORKING, { caseFold: false })).toBe(
        true,
      )
    })

    test('a sibling directory is outside either way', () => {
      const sibling = '/nonexistent/home/u/other/x.ts'
      expect(pathInWorkingPath(sibling, WORKING)).toBe(false)
      expect(pathInWorkingPath(sibling, WORKING, { caseFold: false })).toBe(
        false,
      )
    })

    test('a prefix-sharing sibling is not a child either way', () => {
      // `/…/proj-evil` starts with `/…/proj` as a STRING but is not under it.
      const lookalike = '/nonexistent/home/u/proj-evil/x.ts'
      expect(pathInWorkingPath(lookalike, WORKING)).toBe(false)
      expect(pathInWorkingPath(lookalike, WORKING, { caseFold: false })).toBe(
        false,
      )
    })

    test('traversal back out is rejected either way', () => {
      const escape = `${WORKING}/../other/x.ts`
      expect(pathInWorkingPath(escape, WORKING)).toBe(false)
      expect(pathInWorkingPath(escape, WORKING, { caseFold: false })).toBe(
        false,
      )
    })
  })

  describe('caseFold: true (the default)', () => {
    test('a re-cased child still counts as inside', () => {
      expect(
        pathInWorkingPath('/nonexistent/home/u/PROJ/src/x.ts', WORKING),
      ).toBe(true)
    })

    test('a re-cased dangerous directory is still recognised', () => {
      // The reason folding is the default: isClaudeConfigFilePath() uses this
      // to decide "always ask", so `.cLauDe` must not slip past by re-casing.
      expect(
        pathInWorkingPath(
          `${WORKING}/.cLauDe/settings.local.json`,
          `${WORKING}/.claude`,
        ),
      ).toBe(true)
    })

    test('omitting the options object folds', () => {
      expect(pathInWorkingPath('/nonexistent/home/u/PROJ/x.ts', WORKING)).toBe(
        true,
      )
    })

    test('passing an empty options object still folds', () => {
      // `{}` must not read as "case-sensitive". Upstream's default-destructured
      // signature has exactly that hole; occ resolves the flag with `?? true`.
      expect(
        pathInWorkingPath('/nonexistent/home/u/PROJ/x.ts', WORKING, {}),
      ).toBe(true)
    })

    test('the /private/tmp rewrite tolerates re-casing too', () => {
      expect(pathInWorkingPath('/PRIVATE/TMP/work/x.ts', '/tmp/work')).toBe(
        true,
      )
    })
  })

  describe('caseFold: false', () => {
    test('a re-cased directory is NOT inside on a case-sensitive filesystem', () => {
      // The headline case. `/nonexistent/home/u/PROJ` and
      // `/nonexistent/home/u/proj` are two different directories on Linux, and
      // only the lowercase one is in the session.
      expect(
        pathInWorkingPath('/nonexistent/home/u/PROJ/src/x.ts', WORKING, {
          caseFold: false,
        }),
      ).toBe(false)
    })

    test('a single re-cased segment anywhere in the path is enough', () => {
      expect(
        pathInWorkingPath('/nonexistent/HOME/u/proj/x.ts', WORKING, {
          caseFold: false,
        }),
      ).toBe(false)
    })

    test('a re-cased dangerous directory is treated as a distinct path', () => {
      expect(
        pathInWorkingPath(
          `${WORKING}/.cLauDe/settings.local.json`,
          `${WORKING}/.claude`,
          { caseFold: false },
        ),
      ).toBe(false)
    })

    test('the /private/tmp rewrite is case-sensitive too', () => {
      expect(
        pathInWorkingPath('/private/tmp/work/x.ts', '/tmp/work', {
          caseFold: false,
        }),
      ).toBe(true)
      expect(
        pathInWorkingPath('/PRIVATE/TMP/work/x.ts', '/tmp/work', {
          caseFold: false,
        }),
      ).toBe(false)
    })
  })
})

describe('pathInAllowedWorkingPath does not fold', () => {
  test('an exactly-cased path under a working directory is allowed', () => {
    expect(
      pathInAllowedWorkingPath(`${WORKING}/src/x.ts`, makeContext([WORKING])),
    ).toBe(true)
  })

  test('a re-cased path is NOT auto-allowed', () => {
    // Before the caseFold option existed this returned true: the auto-allow
    // gate folded, so a differently-cased directory outside the session was
    // edited without a prompt on any case-sensitive filesystem.
    expect(
      pathInAllowedWorkingPath(
        '/nonexistent/home/u/PROJ/src/x.ts',
        makeContext([WORKING]),
      ),
    ).toBe(false)
  })

  test('an unrelated path is still outside', () => {
    expect(
      pathInAllowedWorkingPath(
        '/nonexistent/home/u/other/x.ts',
        makeContext([WORKING]),
      ),
    ).toBe(false)
  })
})
