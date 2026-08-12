/**
 * Deterministic scan of a Google Gemini CLI setup (`~/.gemini`, `<repo>`).
 *
 * Same contract as `codex.ts`: fixed typed items with a content hash, no model
 * in the loop, and every write goes through the no-clobber primitives in
 * `targets.ts`.
 *
 * THE ONE SUBTLE PART — `!{cmd}` SHELL EXEC
 *
 * Gemini commands may embed `!{cmd}`, which Gemini runs and substitutes. occ's
 * equivalent marker is `` !`cmd` ``. Translating between them is where the
 * official importer spends most of its guard budget, because the two products
 * disagree about escaping: Gemini shell-escapes `{{args}}` inside `!{…}` and
 * occ's `$ARGUMENTS` substitution does not, so a mechanical translation can
 * turn a safe command into an injection.
 *
 * occ does not translate. A command containing `!{…}` is reported as
 * unmappable with the reason, and the user ports it deliberately. That gives up
 * an automatic import of a minority of commands to remove the entire class of
 * bug, which is the right trade for a feature whose input is a file the user
 * may not have looked at in months.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { parseToml, TomlParseError, type TomlValue } from './toml.js'
import {
  containedRealPath,
  displayDetail,
  hasShellExecMarker,
  isEnoent,
  readCappedText,
  safeFrontmatterText,
  toSafeName,
} from './safety.js'
import {
  appendInstructions,
  commandTargetPath,
  instructionsTargetPath,
  writeNewFile,
} from './targets.js'
import { addUserMcpServer, stripImportedMcpSecrets } from './mcpTarget.js'
import type {
  ImportItem,
  ImportScope,
  ScanContext,
  SourceScanResult,
  UnmappableItem,
} from './types.js'

export const GEMINI_SOURCE_ID = 'gemini'
export const GEMINI_DISPLAY_NAME = 'Google Gemini CLI'

function geminiUserDir(context: ScanContext): string {
  return context.userConfigDir ?? join(homedir(), '.gemini')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function detectGemini(context: ScanContext): Promise<boolean> {
  const userDir = geminiUserDir(context)
  return (
    (await exists(join(userDir, 'settings.json'))) ||
    (await exists(join(userDir, 'GEMINI.md'))) ||
    (await exists(join(userDir, 'commands'))) ||
    (await exists(join(context.cwd, 'GEMINI.md'))) ||
    (await exists(join(context.cwd, '.gemini')))
  )
}

/**
 * Parse Gemini's `settings.json`, which is JSON with comments in practice.
 *
 * Comments are stripped with a small state machine rather than a regex: a
 * regex that removes `//` sequences would corrupt every `https://` inside a
 * string value, and those are exactly the MCP server URLs we came for.
 */
export function parseJsonWithComments(source: string): unknown {
  let out = ''
  let index = 0
  let inString = false
  while (index < source.length) {
    const character = source[index] ?? ''
    if (inString) {
      out += character
      if (character === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (character === '"') inString = false
      index++
      continue
    }
    if (character === '"') {
      inString = true
      out += character
      index++
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        index++
      }
      index += 2
      continue
    }
    out += character
    index++
  }
  // Trailing commas are legal in Gemini's reader and not in JSON.parse.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/** `settings.json` keys occ can act on. Everything else is reported. */
const GEMINI_CONSUMED_SETTINGS = new Set(['mcpServers', 'model'])

export async function scanGemini(
  context: ScanContext,
): Promise<SourceScanResult> {
  const items: ImportItem[] = []
  const unmappable: UnmappableItem[] = []
  const userDir = geminiUserDir(context)

  await scanGeminiSettings(userDir, context, items, unmappable)
  await scanGeminiCommands(userDir, context, items, unmappable)
  await scanGeminiInstructions(userDir, 'user', context, items, unmappable)
  await scanGeminiInstructions(
    context.cwd,
    'project',
    context,
    items,
    unmappable,
  )

  const projectDir = join(context.cwd, '.gemini')
  if (projectDir !== userDir && (await exists(projectDir))) {
    if ((await containedRealPath(context.cwd, '.gemini')) === null) {
      unmappable.push({
        scope: 'project',
        label: '.gemini/',
        reason:
          'Is (or is under) a symlink — skipping project-scope read for safety.',
      })
    } else {
      if (await exists(join(projectDir, 'settings.json'))) {
        unmappable.push({
          scope: 'project',
          label: '.gemini/settings.json',
          reason:
            'Project-level Gemini settings are not auto-imported. Review the file manually.',
        })
      }
      if (await exists(join(projectDir, 'system.md'))) {
        unmappable.push({
          scope: 'project',
          label: '.gemini/system.md',
          reason:
            'Gemini system.md REPLACES the system prompt; occ output-styles only augment it. Review it and add an output-style manually if you want it.',
        })
      }
    }
  }
  if (await exists(join(context.cwd, 'gemini-extension.json'))) {
    unmappable.push({
      scope: 'project',
      label: 'gemini-extension.json',
      reason: 'Gemini extensions map to occ plugins. Not auto-converted.',
    })
  }

  return { items, unmappable }
}

async function scanGeminiSettings(
  userDir: string,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): Promise<void> {
  const settingsPath = join(userDir, 'settings.json')
  let raw: string
  try {
    raw = await readCappedText(settingsPath)
  } catch (error) {
    if (isEnoent(error)) return
    unmappable.push({
      scope: 'user',
      label: '~/.gemini/settings.json',
      reason: 'Could not read. Review it manually.',
    })
    return
  }

  let parsed: Record<string, unknown> | null
  try {
    parsed = asRecord(parseJsonWithComments(raw))
  } catch (error) {
    unmappable.push({
      scope: 'user',
      label: '~/.gemini/settings.json',
      reason: `Could not parse (${displayDetail(
        error instanceof Error ? error.message : String(error),
      )}). Review it manually.`,
    })
    return
  }
  if (parsed === null) {
    unmappable.push({
      scope: 'user',
      label: '~/.gemini/settings.json',
      reason:
        'Has an unexpected shape (expected an object). Review it manually.',
    })
    return
  }

  const servers = asRecord(parsed.mcpServers)
  if (servers !== null) {
    for (const [rawName, rawDefinition] of Object.entries(servers)) {
      const definition = asRecord(rawDefinition)
      if (definition === null) {
        unmappable.push({
          scope: 'user',
          label: `MCP server "${rawName}"`,
          reason: 'Entry has an unexpected shape. Review it manually.',
        })
        continue
      }
      const httpUrl =
        typeof definition.httpUrl === 'string' ? definition.httpUrl : undefined
      const url =
        typeof definition.url === 'string' ? definition.url : undefined
      const command =
        typeof definition.command === 'string' ? definition.command : undefined
      if (httpUrl === undefined && url === undefined && command === undefined) {
        unmappable.push({
          scope: 'user',
          label: `MCP server "${rawName}"`,
          reason:
            'Has neither a url, httpUrl nor a command — nothing to import. Review it manually.',
        })
        continue
      }

      const name = toSafeName(rawName)
      const args = Array.isArray(definition.args)
        ? definition.args.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : []
      const rawConfig: Record<string, unknown> = httpUrl
        ? {
            type: 'http',
            url: httpUrl,
            headers: asRecord(definition.headers) ?? undefined,
          }
        : url
          ? {
              type: 'sse',
              url,
              headers: asRecord(definition.headers) ?? undefined,
            }
          : {
              type: 'stdio',
              command,
              args,
              env: asRecord(definition.env) ?? undefined,
            }
      const { definition: safeDefinition, note } = stripImportedMcpSecrets(
        name,
        rawConfig,
      )

      items.push({
        id: `gemini:user:mcp:${name}`,
        kind: 'mcp',
        scope: 'user',
        label: `MCP server "${rawName}"`,
        description: httpUrl ?? url ?? command,
        note: note ?? undefined,
        fingerprint: JSON.stringify(safeDefinition),
        apply: options =>
          addUserMcpServer({
            label: `MCP server "${name}"`,
            name,
            definition: safeDefinition,
            options,
            store: context.mcpStore,
          }),
      })
    }
  } else if (parsed.mcpServers !== undefined) {
    unmappable.push({
      scope: 'user',
      label: 'settings.json `mcpServers`',
      reason:
        'Has an unexpected shape (expected an object). Review it manually.',
    })
  }

  const otherKeys = Object.keys(parsed).filter(
    key => !GEMINI_CONSUMED_SETTINGS.has(key),
  )
  if (otherKeys.length > 0) {
    unmappable.push({
      scope: 'user',
      label: `settings.json keys: ${otherKeys.join(', ')}`,
      reason:
        'No direct occ equivalent, or cosmetic. Review them manually if you relied on them.',
    })
  }
}

async function scanGeminiCommands(
  userDir: string,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): Promise<void> {
  const commandsDir = join(userDir, 'commands')
  let entries: string[]
  const namespaced: string[] = []
  try {
    const dirEntries = await readdir(commandsDir, { withFileTypes: true })
    for (const entry of dirEntries) {
      if (entry.isDirectory()) namespaced.push(entry.name)
    }
    entries = dirEntries
      .filter(entry => entry.isFile() && entry.name.endsWith('.toml'))
      .map(entry => entry.name)
  } catch {
    return
  }

  if (namespaced.length > 0) {
    unmappable.push({
      scope: 'user',
      label: `namespaced commands (${namespaced.sort().join(', ')})`,
      reason: 'Subdirectory-organised commands are not auto-imported.',
    })
  }

  for (const entry of entries.sort()) {
    const sourcePath = join(commandsDir, entry)
    const displayName = basename(entry, '.toml')
    let parsed: Record<string, TomlValue>
    try {
      parsed = parseToml(await readCappedText(sourcePath))
    } catch (error) {
      unmappable.push({
        scope: 'user',
        label: `Command /${displayName}`,
        reason:
          error instanceof TomlParseError
            ? `Could not parse as TOML (${displayDetail(error.message)}). Review it manually.`
            : 'Could not read. Review it manually.',
      })
      continue
    }

    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : null
    if (prompt === null) {
      unmappable.push({
        scope: 'user',
        label: `Command /${displayName}`,
        reason:
          "Doesn't match the expected command format (needs a `prompt` string). Review it manually.",
      })
      continue
    }
    if (prompt.includes('!{')) {
      unmappable.push({
        scope: 'user',
        label: `Command /${displayName}`,
        reason:
          'Uses Gemini `!{cmd}` shell exec. occ does not translate it: Gemini shell-escapes `{{args}}` inside the block and occ’s `$ARGUMENTS` substitution does not, so a mechanical rewrite can turn a safe command into an injection. Port it manually.',
      })
      continue
    }
    if (hasShellExecMarker(prompt)) {
      unmappable.push({
        scope: 'user',
        label: `Command /${displayName}`,
        reason:
          'Already contains an occ shell-exec marker, which would become live on import — port it manually.',
      })
      continue
    }

    const name = toSafeName(displayName)
    const description =
      typeof parsed.description === 'string' ? parsed.description : ''
    const contents = [
      ...(description
        ? [
            '---',
            `description: ${JSON.stringify(safeFrontmatterText(description))}`,
            '---',
            '',
          ]
        : []),
      prompt.trimEnd(),
      '',
    ].join('\n')

    items.push({
      id: `gemini:user:command:${name}`,
      kind: 'command',
      scope: 'user',
      label: `Command /${name}`,
      description:
        description || `→ ${commandTargetPath('user', context.cwd, name)}`,
      fingerprint: contents,
      apply: options =>
        writeNewFile({
          label: `Command /${name}`,
          scope: 'user',
          cwd: context.cwd,
          targetPath: commandTargetPath('user', context.cwd, name),
          contents,
          options,
        }),
    })
  }
}

async function scanGeminiInstructions(
  baseDir: string,
  scope: ImportScope,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): Promise<void> {
  const sourcePath = join(baseDir, 'GEMINI.md')
  let body: string
  try {
    body = await readCappedText(sourcePath)
  } catch (error) {
    if (isEnoent(error)) return
    unmappable.push({
      scope,
      label: 'GEMINI.md',
      reason: 'Could not read. Review it manually.',
    })
    return
  }
  if (body.trim() === '') return

  const id = `gemini:${scope}:instructions`
  const targetPath = instructionsTargetPath(scope, context.cwd)
  items.push({
    id,
    kind: 'instructions',
    scope,
    label: 'GEMINI.md',
    description: `→ ${targetPath}`,
    fingerprint: body,
    apply: options =>
      appendInstructions({
        itemId: id,
        label: 'GEMINI.md',
        scope,
        cwd: context.cwd,
        sourcePath,
        targetPath,
        body,
        options,
      }),
  })
}
