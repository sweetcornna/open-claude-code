/**
 * Where an imported item lands, and the three write primitives that put it
 * there. Every path is derived from `src/config/paths.ts` — see the "路径与隔离
 * 不变式" section of CLAUDE.md; an import that wrote into `~/.claude` would be
 * writing into the OFFICIAL CLI's config directory.
 *
 * All three primitives are NO-CLOBBER. An existing target is reported as
 * skipped, never overwritten and never renamed, which is what makes
 * `occ import` safe to re-run and what stops a foreign config from silently
 * replacing something the user wrote themselves. The instructions primitive is
 * the one append path, and it is idempotent through a per-item marker rather
 * than through content comparison, so a user who edits the appended text does
 * not get a second copy on the next run.
 */

import { basename, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { occConfigPath, PROJECT_DIR_NAME } from 'src/config/paths.js'
import type { ApplyOptions, ApplyOutcome, ImportScope } from './types.js'
import {
  hasNoSymlinkComponent,
  isEnoent,
  MAX_IMPORT_FILE_BYTES,
} from './safety.js'

/** Root that user-scope items are written under. */
function userTargetRoot(): string {
  return occConfigPath()
}

/** Root that project-scope items are written under. */
function projectTargetRoot(cwd: string): string {
  return join(cwd, PROJECT_DIR_NAME)
}

export function commandTargetPath(
  scope: ImportScope,
  cwd: string,
  safeName: string,
): string {
  const root = scope === 'user' ? userTargetRoot() : projectTargetRoot(cwd)
  return join(root, 'commands', `${safeName}.md`)
}

export function agentTargetPath(
  scope: ImportScope,
  cwd: string,
  safeName: string,
): string {
  const root = scope === 'user' ? userTargetRoot() : projectTargetRoot(cwd)
  return join(root, 'agents', `${safeName}.md`)
}

/**
 * Memory file for imported instructions.
 *
 * Deliberately still called `CLAUDE.md`: the memory filename is a cross-tool
 * ecosystem convention that occ does NOT rename (CLAUDE.md, "故意保持不变的
 * 东西"). User-scope memory lives at the config-dir root, project memory at the
 * repository root — neither is under `PROJECT_DIR_NAME`.
 */
export function instructionsTargetPath(
  scope: ImportScope,
  cwd: string,
): string {
  return scope === 'user' ? occConfigPath('CLAUDE.md') : join(cwd, 'CLAUDE.md')
}

/**
 * The containment base a project-scope write must stay inside. User-scope
 * writes go to a directory occ owns, so they need no such check.
 */
function writeBase(scope: ImportScope, cwd: string): string | null {
  return scope === 'project' ? cwd : null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (isEnoent(error)) return false
    // EISDIR and friends still mean "something is there".
    return true
  }
}

/**
 * Create a file, or report why it was skipped. Never overwrites.
 *
 * @param label Untrusted name used only in the returned message; the caller
 *              is responsible for running it through `displayLabel()`.
 */
export async function writeNewFile(input: {
  label: string
  scope: ImportScope
  cwd: string
  targetPath: string
  contents: string
  options: ApplyOptions
}): Promise<ApplyOutcome> {
  const { label, scope, cwd, targetPath, contents, options } = input
  const base = writeBase(scope, cwd)
  if (
    base !== null &&
    (await hasNoSymlinkComponent(base, targetPath)) === null
  ) {
    return {
      skipped: `${label}: target is outside the repository or under a symlink — refusing project-scope write`,
    }
  }
  if (await fileExists(targetPath)) {
    return { skipped: `${label}: \`${targetPath}\` already exists` }
  }
  if (options.dryRun) return { applied: `would write \`${targetPath}\`` }
  await mkdir(join(targetPath, '..'), { recursive: true })
  // `wx` is the no-clobber guarantee: the existence check above races, this
  // does not.
  await writeFile(targetPath, contents, { encoding: 'utf8', flag: 'wx' })
  return { applied: `wrote \`${targetPath}\`` }
}

/**
 * Marker written above appended instructions. Presence of the exact marker for
 * THIS item id is what makes the append idempotent.
 */
function instructionsMarker(itemId: string): string {
  return `<!-- occ-import: ${itemId} -->`
}

/** Append foreign instructions to a memory file, once. */
export async function appendInstructions(input: {
  itemId: string
  label: string
  scope: ImportScope
  cwd: string
  sourcePath: string
  targetPath: string
  body: string
  options: ApplyOptions
}): Promise<ApplyOutcome> {
  const { itemId, label, scope, cwd, sourcePath, targetPath, body, options } =
    input
  const base = writeBase(scope, cwd)
  if (
    base !== null &&
    (await hasNoSymlinkComponent(base, targetPath)) === null
  ) {
    return {
      skipped: `${label}: target is outside the repository or under a symlink — refusing project-scope write`,
    }
  }

  const marker = instructionsMarker(itemId)
  let existing = ''
  try {
    existing = await readFile(targetPath, 'utf8')
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  if (existing.includes(marker)) {
    return {
      skipped: `${label}: already imported (marker present; not re-synced)`,
    }
  }
  if (existing.length + body.length > MAX_IMPORT_FILE_BYTES) {
    return {
      skipped: `${label}: \`${targetPath}\` would exceed the import size cap`,
    }
  }
  if (options.dryRun) {
    return {
      applied: `would append ${basename(sourcePath)} → \`${targetPath}\``,
    }
  }

  const separator =
    existing === '' || existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n'
  await mkdir(join(targetPath, '..'), { recursive: true })
  await writeFile(
    targetPath,
    `${existing}${separator}${marker}\n${body.trimEnd()}\n`,
    'utf8',
  )
  // Relative `@imports` inside the copied text resolved against the SOURCE
  // file's directory; after the move they resolve against the target's.
  const note = /(?:^|\s)@(?![/~@])(?:[^\s\\]|\\ )+/.test(body)
    ? ' — note: relative @imports in this file now resolve against the new location; convert them to absolute paths if they stop working'
    : ''
  return {
    applied: `appended ${basename(sourcePath)} → \`${targetPath}\`${note}`,
  }
}
