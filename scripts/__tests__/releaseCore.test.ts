/**
 * Pure-logic tests for the release script. No mocks: releaseCore.ts has no
 * side effects and no imports beyond itself, which is the whole reason it was
 * split out of release.ts.
 */
import { describe, expect, test } from 'bun:test'
import {
  compareSemver,
  draftEntriesFromCommits,
  extractChangelogSection,
  formatReleaseDate,
  hasChangelogSection,
  insertChangelogSection,
  isValidSemver,
  normalizeVersionArg,
  parseSemver,
  readPackageVersion,
  replacePackageVersion,
  validateReleaseVersion,
} from '../releaseCore.ts'
// The in-app parser the CHANGELOG format has to satisfy.
import { parseChangelog } from '../../src/utils/update/releaseNotes.ts'

const CHANGELOG = `# Changelog

前言段落，不属于任何版本。

## 2.9.0 - 2026-08-02

- 首个对外发布版本。

## 2.8.0

- 更早的东西。
`

describe('parseSemver / isValidSemver', () => {
  test('accepts release and prerelease versions', () => {
    expect(parseSemver('2.10.0')).toEqual({
      major: 2,
      minor: 10,
      patch: 0,
      prerelease: [],
    })
    expect(parseSemver('2.10.0-rc.1')).toEqual({
      major: 2,
      minor: 10,
      patch: 0,
      prerelease: ['rc', '1'],
    })
  })

  test('rejects the shapes a human typo actually produces', () => {
    for (const bad of [
      'v2.10.0', // the leading v belongs to the tag, not the version
      '2.10',
      '2.10.0.1',
      '02.10.0',
      '2.10.0-',
      'latest',
      '',
      ' 2.10.0 ',
    ]) {
      expect(isValidSemver(bad)).toBe(false)
    }
  })

  test('normalizeVersionArg strips the tag prefix', () => {
    expect(normalizeVersionArg('v2.10.0')).toBe('2.10.0')
    expect(normalizeVersionArg('  2.10.0 ')).toBe('2.10.0')
  })
})

describe('compareSemver', () => {
  test('orders by numeric field, not lexicographically', () => {
    // The case that motivates the whole check: "2.10.0" < "2.9.0" as strings.
    expect(compareSemver('2.10.0', '2.9.0')).toBe(1)
    expect(compareSemver('2.9.0', '2.10.0')).toBe(-1)
    expect(compareSemver('2.9.0', '2.9.0')).toBe(0)
    expect(compareSemver('3.0.0', '2.99.99')).toBe(1)
    expect(compareSemver('2.9.1', '2.9.0')).toBe(1)
  })

  test('prerelease sorts below its release, and by identifier', () => {
    expect(compareSemver('2.10.0-rc.1', '2.10.0')).toBe(-1)
    expect(compareSemver('2.10.0', '2.10.0-rc.1')).toBe(1)
    expect(compareSemver('2.10.0-rc.2', '2.10.0-rc.1')).toBe(1)
    expect(compareSemver('2.10.0-rc.10', '2.10.0-rc.2')).toBe(1)
    expect(compareSemver('2.10.0-alpha', '2.10.0-beta')).toBe(-1)
    expect(compareSemver('2.10.0-rc', '2.10.0-rc.1')).toBe(-1)
  })

  test('build metadata is ignored for precedence', () => {
    expect(compareSemver('2.10.0+build.1', '2.10.0')).toBe(0)
  })

  test('throws on invalid input instead of guessing', () => {
    expect(() => compareSemver('2.10', '2.9.0')).toThrow()
  })
})

describe('validateReleaseVersion', () => {
  test('accepts a strictly greater version and strips the v prefix', () => {
    expect(validateReleaseVersion('v2.10.0', '2.9.0')).toEqual({
      ok: true,
      version: '2.10.0',
    })
  })

  test('rejects a version that is not greater than the current one', () => {
    const same = validateReleaseVersion('2.9.0', '2.9.0')
    expect(same.ok).toBe(false)
    const lower = validateReleaseVersion('1.0.0', '2.9.0')
    expect(lower.ok).toBe(false)
    // The reason matters more than the wording: a non-increasing publish locks
    // installed clients on "already up to date" forever.
    if (!lower.ok) expect(lower.error).toContain('up to date')
  })

  test('rejects a version that only looks greater as a string', () => {
    expect(validateReleaseVersion('2.9.0', '2.10.0').ok).toBe(false)
  })

  test('rejects malformed input on either side', () => {
    expect(validateReleaseVersion('2.10', '2.9.0').ok).toBe(false)
    expect(validateReleaseVersion('2.10.0', 'nightly').ok).toBe(false)
  })
})

describe('hasChangelogSection / extractChangelogSection', () => {
  test('finds a section with or without a date suffix', () => {
    expect(hasChangelogSection(CHANGELOG, '2.9.0')).toBe(true)
    expect(hasChangelogSection(CHANGELOG, '2.8.0')).toBe(true)
    expect(hasChangelogSection(CHANGELOG, 'v2.9.0')).toBe(true)
    expect(hasChangelogSection(CHANGELOG, '2.10.0')).toBe(false)
  })

  test('extracts only that version body, stopping at the next heading', () => {
    expect(extractChangelogSection(CHANGELOG, '2.9.0')).toBe(
      '- 首个对外发布版本。',
    )
    expect(extractChangelogSection(CHANGELOG, '2.8.0')).toBe('- 更早的东西。')
    expect(extractChangelogSection(CHANGELOG, '2.7.0')).toBeNull()
  })

  test('does not match a version that is a prefix of another', () => {
    const content = '# Changelog\n\n## 2.10.0\n\n- a\n'
    expect(hasChangelogSection(content, '2.1')).toBe(false)
    expect(hasChangelogSection(content, '2.10.0')).toBe(true)
  })

  test('returns null for a section with no entries', () => {
    expect(extractChangelogSection('# C\n\n## 2.10.0\n\n', '2.10.0')).toBeNull()
  })
})

describe('insertChangelogSection', () => {
  test('inserts above the newest section, preserving the preamble', () => {
    const { content, inserted } = insertChangelogSection(
      CHANGELOG,
      '2.10.0',
      ['第一条', '第二条'],
      '2026-08-03',
    )
    expect(inserted).toBe(true)
    expect(content).toContain('## 2.10.0 - 2026-08-03')
    expect(content.indexOf('## 2.10.0')).toBeLessThan(
      content.indexOf('## 2.9.0'),
    )
    expect(content.startsWith('# Changelog')).toBe(true)
    expect(content).toContain('前言段落')
    expect(extractChangelogSection(content, '2.10.0')).toBe(
      '- 第一条\n- 第二条',
    )
  })

  test('is idempotent — a second run leaves the file byte-identical', () => {
    const first = insertChangelogSection(
      CHANGELOG,
      '2.10.0',
      ['第一条'],
      '2026-08-03',
    )
    const second = insertChangelogSection(
      first.content,
      '2.10.0',
      ['完全不同的条目'],
      '2026-09-09',
    )
    expect(second.inserted).toBe(false)
    expect(second.content).toBe(first.content)
  })

  test('skips a hand-written section instead of overwriting it', () => {
    const handEdited = '# Changelog\n\n## 2.10.0\n\n- 人工润色过的说明\n'
    const { content, inserted } = insertChangelogSection(
      handEdited,
      '2.10.0',
      ['原始 commit subject'],
      '2026-08-03',
    )
    expect(inserted).toBe(false)
    expect(content).toBe(handEdited)
  })

  test('appends when the file has no sections yet', () => {
    const { content, inserted } = insertChangelogSection(
      '# Changelog\n\n说明。\n',
      '1.0.0',
      ['首个版本'],
      '2026-08-03',
    )
    expect(inserted).toBe(true)
    expect(extractChangelogSection(content, '1.0.0')).toBe('- 首个版本')
  })

  test('output stays parseable by the in-app changelog parser', () => {
    const { content } = insertChangelogSection(
      CHANGELOG,
      '2.10.0',
      ['第一条', '第二条'],
      '2026-08-03',
    )
    const parsed = parseChangelog(content)
    expect(parsed['2.10.0']).toEqual(['第一条', '第二条'])
    expect(parsed['2.9.0']).toEqual(['首个对外发布版本。'])
    // The preamble must not become a phantom version.
    expect(Object.keys(parsed).sort()).toEqual(['2.10.0', '2.8.0', '2.9.0'])
  })
})

describe('draftEntriesFromCommits', () => {
  test('drops merges, release commits and duplicates', () => {
    expect(
      draftEntriesFromCommits([
        'feat: 甲',
        'Merge branch main',
        'chore(release): v2.9.0',
        'feat: 甲',
        '   ',
        'fix: 乙',
      ]),
    ).toEqual(['feat: 甲', 'fix: 乙'])
  })

  test('never returns an empty draft', () => {
    expect(draftEntriesFromCommits([]).length).toBe(1)
    expect(draftEntriesFromCommits(['Merge x']).length).toBe(1)
  })
})

describe('package.json version rewriting', () => {
  const pkg =
    '{\n  "name": "x",\n  "version": "2.9.0",\n  "type": "module"\n}\n'

  test('reads the version', () => {
    expect(readPackageVersion(pkg)).toBe('2.9.0')
  })

  test('rewrites only the version, byte-for-byte otherwise', () => {
    const next = replacePackageVersion(pkg, '2.10.0')
    expect(next).toBe(
      '{\n  "name": "x",\n  "version": "2.10.0",\n  "type": "module"\n}\n',
    )
  })

  test('throws rather than silently no-op when there is no version field', () => {
    expect(() => replacePackageVersion('{"name":"x"}', '2.10.0')).toThrow()
    expect(() => readPackageVersion('{"name":"x"}')).toThrow()
  })
})

describe('formatReleaseDate', () => {
  test('formats local date as YYYY-MM-DD with padding', () => {
    expect(formatReleaseDate(new Date(2026, 7, 3))).toBe('2026-08-03')
    expect(formatReleaseDate(new Date(2026, 11, 25))).toBe('2026-12-25')
  })
})
