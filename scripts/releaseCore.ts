/**
 * Pure logic behind `bun run release` — no git, no fs, no process.
 *
 * Split out from release.ts so the parts that are easy to get wrong (semver
 * ordering, CHANGELOG section insertion/idempotency, section extraction) are
 * unit-testable without touching a repo. release.ts owns every side effect.
 *
 * The CHANGELOG format these functions produce and consume is not free-form:
 * it must stay parseable by `parseChangelog` in
 * src/utils/update/releaseNotes.ts, which powers the in-app "what's new" feed.
 * That parser splits on `^## ` lines, takes the text before ` - ` as the
 * version, and collects only lines whose trimmed form starts with `- `.
 */

/** Matches `## <version>` / `## <version> - <date>` heading lines. */
const HEADING_RE = /^##\s+(\S+)/

export interface SemverParts {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers, empty when this is a final release. */
  prerelease: string[]
}

/**
 * Strict semver parse. Deliberately does not accept partial versions ("2.10"),
 * a leading `v`, or leading zeroes — a release version is typed by hand and a
 * typo here becomes a published npm version that cannot be taken back.
 */
export function parseSemver(version: string): SemverParts | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.exec(
      version,
    )
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null
}

/** Accepts both `2.10.0` and `v2.10.0` on the command line. */
export function normalizeVersionArg(arg: string): string {
  return arg.trim().replace(/^v/, '')
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A version without prerelease identifiers outranks one that has them.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue

    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Semver precedence comparison. Returns -1 / 0 / 1.
 * Invalid input throws: callers validate first, and silently treating a typo
 * as "equal" would defeat the monotonicity check below.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) {
    throw new Error(`not a semver version: ${!left ? a : b}`)
  }
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export type VersionCheck =
  | { ok: true; version: string }
  | { ok: false; error: string }

/**
 * The version must be valid semver and strictly greater than what is in
 * package.json.
 *
 * Not a style rule: `occ update` compares the installed version against the
 * npm registry with a semver `gt`. Publishing a version that does not sort
 * above the previous one makes every already-installed client conclude it is
 * "already up to date" — permanently, for that user, with no way to recover
 * short of a manual reinstall.
 */
export function validateReleaseVersion(
  next: string,
  current: string,
): VersionCheck {
  const version = normalizeVersionArg(next)
  if (!isValidSemver(version)) {
    return {
      ok: false,
      error: `"${next}" is not a valid semver version (expected e.g. 2.10.0 or 2.10.0-rc.1)`,
    }
  }
  if (!isValidSemver(current)) {
    return {
      ok: false,
      error: `package.json version "${current}" is not valid semver — fix it before releasing`,
    }
  }
  if (compareSemver(version, current) <= 0) {
    return {
      ok: false,
      error:
        `${version} is not greater than the current version ${current}. ` +
        'Release versions must increase monotonically: `occ update` uses a ' +
        'semver comparison, so a non-increasing publish leaves already-' +
        'installed clients permanently believing they are up to date.',
    }
  }
  return { ok: true, version }
}

interface SectionRange {
  /** Index of the `## <version>` line. */
  headingLine: number
  /** Exclusive end line index (start of the next `## ` heading, or EOF). */
  endLine: number
}

function findSection(lines: string[], version: string): SectionRange | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const match = HEADING_RE.exec(line)
    if (!match || match[1] === undefined) continue
    if (normalizeVersionArg(match[1]) !== normalizeVersionArg(version)) continue

    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (next !== undefined && HEADING_RE.test(next)) {
        end = j
        break
      }
    }
    return { headingLine: i, endLine: end }
  }
  return null
}

export function hasChangelogSection(content: string, version: string): boolean {
  return findSection(content.split('\n'), version) !== null
}

/**
 * Returns the body of a version's section (everything under the heading),
 * trimmed, or null when the version has no section. Used by the publish
 * workflow to build GitHub Release notes from the same text users see in-app.
 */
export function extractChangelogSection(
  content: string,
  version: string,
): string | null {
  const lines = content.split('\n')
  const range = findSection(lines, version)
  if (!range) return null
  const body = lines.slice(range.headingLine + 1, range.endLine).join('\n')
  const trimmed = body.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface InsertResult {
  content: string
  /** False when the version already had a section — the insert is a no-op. */
  inserted: boolean
}

/**
 * Inserts a new version section above the newest existing one, keeping the
 * file in newest-first order. Idempotent: re-running against a CHANGELOG that
 * already documents this version leaves it byte-identical, so a re-run after a
 * partial release never duplicates or clobbers hand-edited notes.
 */
export function insertChangelogSection(
  content: string,
  version: string,
  entries: string[],
  date: string,
): InsertResult {
  const normalized = normalizeVersionArg(version)
  const lines = content.split('\n')
  if (findSection(lines, normalized)) {
    return { content, inserted: false }
  }

  const section = [
    `## ${normalized} - ${date}`,
    '',
    ...entries.map(entry => `- ${entry}`),
    '',
  ].join('\n')

  const firstHeading = lines.findIndex(line => HEADING_RE.test(line))
  if (firstHeading === -1) {
    // No release sections yet: append after the preamble.
    const prefix = content.replace(/\s*$/, '')
    return { content: `${prefix}\n\n${section}`, inserted: true }
  }

  // Normalize the gap to exactly one blank line. `join('\n')` never yields a
  // trailing newline, so concatenating it straight onto the section swallowed
  // the separator — and the damage compounded: the first insert left the
  // heading directly under the preamble text, and the next one, finding no
  // blank line to consume, glued `## <version>` onto the end of that line.
  // A heading that is not at the start of a line is invisible to
  // parseChangelog(), so the whole section silently vanished from the in-app
  // release notes and the GitHub Release body.
  const beforeLines = lines.slice(0, firstHeading)
  while (
    beforeLines.length > 0 &&
    beforeLines[beforeLines.length - 1]?.trim() === ''
  ) {
    beforeLines.pop()
  }
  const before = beforeLines.length > 0 ? `${beforeLines.join('\n')}\n\n` : ''
  const after = lines.slice(firstHeading).join('\n')
  return { content: `${before}${section}\n${after}`, inserted: true }
}

/** Commit subjects that must never become release-note drafts. */
const SKIPPED_SUBJECT_RE =
  /^(Merge\b|chore\(release\)|Revert "chore\(release\))/

/**
 * Turns raw `git log --pretty=%s` subjects into draft CHANGELOG entries.
 *
 * Deliberately dumb — it strips noise and dedupes, nothing more. The script
 * does not pretend it can write release notes; the draft exists so a human has
 * something to rewrite instead of a blank section.
 */
export function draftEntriesFromCommits(subjects: string[]): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const raw of subjects) {
    const subject = raw.trim()
    if (!subject) continue
    if (SKIPPED_SUBJECT_RE.test(subject)) continue
    if (seen.has(subject)) continue
    seen.add(subject)
    entries.push(subject)
  }
  if (entries.length === 0) {
    entries.push('（无可用提交，请手工填写本次发布内容）')
  }
  return entries
}

/** `YYYY-MM-DD` in local time, matching the existing headings. */
export function formatReleaseDate(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Rewrites only the top-level `"version"` field, leaving the rest of the file
 * byte-identical. JSON.parse + stringify would reformat package.json (key
 * order survives, but indentation and the trailing newline do not) and produce
 * a noisy release diff.
 */
export function replacePackageVersion(
  packageJson: string,
  version: string,
): string {
  let replaced = false
  const next = packageJson.replace(
    /("version"\s*:\s*")([^"]*)(")/,
    (_match, prefix: string, _old: string, suffix: string) => {
      replaced = true
      return `${prefix}${version}${suffix}`
    },
  )
  if (!replaced) {
    throw new Error('package.json has no "version" field to update')
  }
  return next
}

export function readPackageVersion(packageJson: string): string {
  const match = /"version"\s*:\s*"([^"]*)"/.exec(packageJson)
  if (!match || match[1] === undefined) {
    throw new Error('package.json has no "version" field')
  }
  return match[1]
}
