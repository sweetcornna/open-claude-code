/**
 * Deterministic scan of an OpenAI Codex setup (`~/.codex`, `<repo>/.codex`).
 *
 * "Deterministic" is the whole design: the model is never asked to read the
 * foreign agent's config and decide what to do with it. This module produces a
 * fixed list of typed items with a content hash, and the only thing a confirm
 * can do is run the `apply()` closures that were built here.
 *
 * TWO DELIBERATE DIVERGENCES FROM THE OFFICIAL IMPORTER
 *
 * - **Skills are never copied.** Codex `[[skills.config]]` points at an
 *   arbitrary directory whose contents become live instructions (and bundled
 *   scripts) the moment they land in occ's skills tree. The official importer
 *   copies them behind sixteen guards and still leaves them unchecked in its
 *   picker; occ reports them as unmappable with the path, which is the same
 *   end state for anyone who does not opt in, minus the copy machinery.
 * - **`approval_policy` is never applied.** It maps onto occ's permission
 *   mode, i.e. onto how much the agent may do without asking. Taking that from
 *   a file another tool wrote is a privilege change, so occ reports the exact
 *   mapping and lets the user make it themselves.
 *
 * Both are reported, never silently dropped.
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
  agentTargetPath,
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

export const CODEX_SOURCE_ID = 'codex'
export const CODEX_DISPLAY_NAME = 'OpenAI Codex'

function codexUserDir(context: ScanContext): string {
  return context.userConfigDir ?? join(homedir(), '.codex')
}

/** Cheap existence probe that never throws and never opens the file. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch {
    return false
  }
}

export async function detectCodex(context: ScanContext): Promise<boolean> {
  const userDir = codexUserDir(context)
  return (
    (await exists(join(userDir, 'config.toml'))) ||
    (await exists(join(userDir, 'AGENTS.md'))) ||
    (await directoryExists(join(userDir, 'prompts'))) ||
    (await exists(join(context.cwd, '.codex', 'config.toml')))
  )
}

function asTable(
  value: TomlValue | undefined,
): Record<string, TomlValue> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, TomlValue>
}

function asStringArray(value: TomlValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(entry => typeof entry === 'string')
    ? (value as string[])
    : null
}

/**
 * Keys occ understands but cannot map, with the reason shown to the user.
 * Anything not listed and not consumed below becomes "Unrecognised
 * config.toml key" — silence would be worse than a slightly noisy report.
 */
const CODEX_UNMAPPABLE_KEYS: Record<string, string> = {
  sandbox_mode:
    'Sandbox models differ. Review the `sandbox` keys in settings.json if you relied on this.',
  web_search:
    'occ enables WebSearch through permissions; there is no global toggle.',
  project_doc_fallback_filenames:
    'occ hardcodes CLAUDE.md / AGENTS.md discovery.',
  project_doc_max_bytes: 'occ hardcodes CLAUDE.md / AGENTS.md discovery.',
  hooks:
    'Hook event names differ between Codex and occ. Re-add them under the `hooks` key in settings.json.',
  features: 'Product-specific toggles with no occ equivalent.',
  model:
    'Model selection is per-provider in occ — use `/model` or `/model-settings`.',
  model_reasoning_effort:
    'Reasoning effort is per-tier in occ — use `/effort` or `/model-settings`.',
}

const CODEX_CONSUMED_KEYS = new Set([
  'mcp_servers',
  'agents',
  'skills',
  'approval_policy',
])

/**
 * How a Codex `approval_policy` maps onto occ's permission mode. Reported, not
 * applied — see the module header.
 */
const APPROVAL_POLICY_MAPPING: Record<string, string> = {
  suggest: '`permissions.defaultMode: default` (ask before each write)',
  untrusted: '`permissions.defaultMode: default` (ask before each write)',
  'on-request': '`permissions.defaultMode: default` (ask before each write)',
  'auto-edit':
    '`permissions.defaultMode: acceptEdits` (edits applied without per-write prompts)',
  'on-failure':
    '`permissions.defaultMode: auto` (occ decides what runs without asking)',
  'full-auto':
    '`permissions.defaultMode: auto` (occ decides what runs without asking)',
  never:
    '`permissions.defaultMode: auto` — Codex `never` relies on Codex’s own sandbox, which occ has no equivalent for',
}

export async function scanCodex(
  context: ScanContext,
): Promise<SourceScanResult> {
  const items: ImportItem[] = []
  const unmappable: UnmappableItem[] = []
  const userDir = codexUserDir(context)

  await scanCodexConfigToml(userDir, 'user', context, items, unmappable)
  await scanCodexPrompts(userDir, context, items, unmappable)
  await scanCodexInstructions(userDir, 'user', context, items, unmappable)

  const projectDir = join(context.cwd, '.codex')
  if (projectDir !== userDir) {
    // A symlinked project config dir can point anywhere, including back at the
    // user's real home; refuse to read through it rather than resolve it.
    if ((await containedRealPath(context.cwd, '.codex')) === null) {
      if (await directoryExists(projectDir)) {
        unmappable.push({
          scope: 'project',
          label: '.codex/',
          reason:
            'Is (or is under) a symlink — skipping project-scope read for safety.',
        })
      }
    } else {
      await scanCodexConfigToml(
        projectDir,
        'project',
        context,
        items,
        unmappable,
      )
    }
  }
  await scanCodexInstructions(
    context.cwd,
    'project',
    context,
    items,
    unmappable,
  )

  return { items, unmappable }
}

async function scanCodexConfigToml(
  baseDir: string,
  scope: ImportScope,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): Promise<void> {
  const configPath = join(baseDir, 'config.toml')
  let raw: string
  try {
    raw = await readCappedText(configPath)
  } catch (error) {
    if (isEnoent(error)) return
    unmappable.push({
      scope,
      label: `${scope === 'user' ? '~/.codex' : '.codex'}/config.toml`,
      reason: 'Could not read. Review it manually.',
    })
    return
  }

  let parsed: Record<string, TomlValue>
  try {
    parsed = parseToml(raw)
  } catch (error) {
    unmappable.push({
      scope,
      label: `${scope === 'user' ? '~/.codex' : '.codex'}/config.toml`,
      reason:
        error instanceof TomlParseError
          ? `Could not parse (${displayDetail(error.message)}). Review it manually.`
          : 'Could not parse. Review it manually.',
    })
    return
  }

  scanCodexMcpServers(parsed, scope, context, items, unmappable)
  scanCodexAgents(parsed, scope, context, items, unmappable)
  scanCodexSkills(parsed, scope, unmappable)
  scanCodexApprovalPolicy(parsed, scope, unmappable)

  for (const key of Object.keys(parsed)) {
    if (CODEX_CONSUMED_KEYS.has(key)) continue
    unmappable.push({
      scope,
      label: `config.toml key \`${key}\``,
      reason: CODEX_UNMAPPABLE_KEYS[key] ?? 'Unrecognised config.toml key.',
    })
  }
}

function scanCodexMcpServers(
  parsed: Record<string, TomlValue>,
  scope: ImportScope,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): void {
  const servers = asTable(parsed.mcp_servers)
  if (parsed.mcp_servers !== undefined && servers === null) {
    unmappable.push({
      scope,
      label: '[mcp_servers]',
      reason:
        'Has an unexpected shape (expected a table of named entries). Review it manually.',
    })
    return
  }
  if (servers === null) return

  for (const [rawName, rawDefinition] of Object.entries(servers)) {
    const definition = asTable(rawDefinition)
    if (definition === null) {
      unmappable.push({
        scope,
        label: `MCP server "${rawName}"`,
        reason:
          'Entry in config.toml has an unexpected shape. Review it manually.',
      })
      continue
    }
    const url = typeof definition.url === 'string' ? definition.url : undefined
    const command =
      typeof definition.command === 'string' ? definition.command : undefined
    if (url === undefined && command === undefined) {
      unmappable.push({
        scope,
        label: `MCP server "${rawName}"`,
        reason:
          'Has neither a url nor a command — nothing to import. Review it manually.',
      })
      continue
    }

    const name = toSafeName(rawName)
    const args = asStringArray(definition.args) ?? []
    const rawConfig: Record<string, unknown> = url
      ? {
          type: 'sse',
          url,
          headers: asTable(definition.http_headers) ?? undefined,
        }
      : {
          type: 'stdio',
          command,
          args,
          env: asTable(definition.env) ?? undefined,
        }
    // `bearer_token_env_var` names an environment variable rather than holding
    // a token, but it only makes sense alongside the header it belongs to, and
    // the header is about to be stripped. Report it instead of half-importing.
    const bearerVar =
      typeof definition.bearer_token_env_var === 'string'
        ? definition.bearer_token_env_var
        : undefined
    const { definition: safeDefinition, note } = stripImportedMcpSecrets(
      name,
      rawConfig,
    )

    const notes: string[] = []
    if (note) notes.push(note)
    if (bearerVar) {
      notes.push(
        `MCP ${name}: bearer_token_env_var ${bearerVar} not imported — add the Authorization header yourself`,
      )
    }

    items.push({
      id: `codex:${scope}:mcp:${name}`,
      kind: 'mcp',
      scope,
      label: `MCP server "${rawName}"`,
      description: url ?? command,
      warning:
        scope === 'project'
          ? 'Repo-authored MCP server — connecting runs its command or sends requests to its url. Review the config before importing.'
          : undefined,
      note: notes.length > 0 ? notes.join(' · ') : undefined,
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
}

function scanCodexAgents(
  parsed: Record<string, TomlValue>,
  scope: ImportScope,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): void {
  const agents = asTable(parsed.agents)
  if (parsed.agents !== undefined && agents === null) {
    unmappable.push({
      scope,
      label: '[agents]',
      reason:
        'Has an unexpected shape (expected a table of named entries). Review it manually.',
    })
    return
  }
  if (agents === null) return

  // `[agents]` is BOTH a registry of named subagents and the place Codex keeps
  // its own agent-runtime settings (`enabled`, `default_subagent_model`, …).
  // Only the table-valued entries are subagents; reporting the scalars one by
  // one produced four lines of `Subagent "enabled"` nonsense against a real
  // `~/.codex/config.toml`.
  const settingKeys = Object.entries(agents)
    .filter(([, value]) => asTable(value) === null)
    .map(([key]) => key)
  if (settingKeys.length > 0) {
    unmappable.push({
      scope,
      label: `[agents] settings: ${settingKeys.join(', ')}`,
      reason:
        'Codex agent-runtime settings with no occ equivalent (occ configures subagents per file under `agents/`).',
    })
  }

  for (const [rawName, rawDefinition] of Object.entries(agents)) {
    const definition = asTable(rawDefinition)
    if (definition === null) continue
    const instructions =
      typeof definition.instructions === 'string' ? definition.instructions : ''
    const description =
      typeof definition.description === 'string' ? definition.description : ''
    if (instructions === '' && description === '') {
      unmappable.push({
        scope,
        label: `Subagent "${rawName}"`,
        reason:
          'Has neither instructions nor a description — nothing to import.',
      })
      continue
    }
    if (hasShellExecMarker(instructions)) {
      unmappable.push({
        scope,
        label: `Subagent "${rawName}"`,
        reason:
          'Instructions contain a shell-exec marker (inert in Codex, live in occ) — port it manually.',
      })
      continue
    }

    const name = toSafeName(rawName)
    const tools = asStringArray(definition.tools) ?? []
    const body = [
      '---',
      `name: ${name}`,
      ...(description
        ? [`description: ${JSON.stringify(safeFrontmatterText(description))}`]
        : []),
      '---',
      '',
      instructions.trimEnd(),
      '',
    ].join('\n')

    items.push({
      id: `codex:${scope}:subagent:${name}`,
      kind: 'subagent',
      scope,
      label: `Subagent "${rawName}"`,
      description: description || undefined,
      warning:
        tools.length > 0
          ? 'Codex tool restrictions are dropped (tool names differ); the imported agent can use every occ tool. Review before enabling.'
          : undefined,
      fingerprint: JSON.stringify([body, tools]),
      apply: options =>
        writeNewFile({
          label: `Subagent "${name}"`,
          scope,
          cwd: context.cwd,
          targetPath: agentTargetPath(scope, context.cwd, name),
          contents: body,
          options,
        }),
    })
  }
}

function scanCodexSkills(
  parsed: Record<string, TomlValue>,
  scope: ImportScope,
  unmappable: UnmappableItem[],
): void {
  const skills = asTable(parsed.skills)
  if (parsed.skills !== undefined && skills === null) {
    unmappable.push({
      scope,
      label: '[skills]',
      reason:
        'Has an unexpected shape (expected `[[skills.config]]` entries). Review it manually.',
    })
    return
  }
  if (skills === null) return
  const configs = skills.config
  if (!Array.isArray(configs)) {
    unmappable.push({
      scope,
      label: '[skills]',
      reason:
        'Has an unexpected shape (expected `[[skills.config]]` entries). Review it manually.',
    })
    return
  }
  for (const entry of configs) {
    const table = asTable(entry)
    const path = table && typeof table.path === 'string' ? table.path : null
    unmappable.push({
      scope,
      label: path ? `Skill at "${path}"` : '[[skills.config]] entry',
      reason: path
        ? 'occ does not copy skill directories on import: a skill body and its bundled scripts become live instructions the moment they land. Copy it into the skills directory yourself after reviewing SKILL.md.'
        : 'Missing or non-string `path`. Review it manually.',
    })
  }
}

function scanCodexApprovalPolicy(
  parsed: Record<string, TomlValue>,
  scope: ImportScope,
  unmappable: UnmappableItem[],
): void {
  const policy = parsed.approval_policy
  if (policy === undefined) return
  if (typeof policy !== 'string') {
    unmappable.push({
      scope,
      label: 'approval_policy',
      reason:
        'Has an unexpected shape (expected a string). Review it manually.',
    })
    return
  }
  const mapping =
    APPROVAL_POLICY_MAPPING[policy] ??
    '`permissions.defaultMode: auto` (unrecognised source policy)'
  unmappable.push({
    scope,
    label: `approval_policy = "${policy}"`,
    reason: `Maps to ${mapping}. occ does not import permission modes — importing one would change what the agent may do without asking. Set it yourself with /permissions if you want it.`,
  })
}

async function scanCodexPrompts(
  userDir: string,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): Promise<void> {
  const promptsDir = join(userDir, 'prompts')
  let entries: string[]
  try {
    entries = (await readdir(promptsDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
  } catch {
    return
  }

  for (const entry of entries.sort()) {
    const sourcePath = join(promptsDir, entry)
    let body: string
    try {
      body = await readCappedText(sourcePath)
    } catch (error) {
      unmappable.push({
        scope: 'user',
        label: `Command /${basename(entry, '.md')}`,
        reason: `Could not read (${displayDetail(
          error instanceof Error ? error.message : String(error),
        )}). Review it manually.`,
      })
      continue
    }
    if (hasShellExecMarker(body)) {
      unmappable.push({
        scope: 'user',
        label: `Command /${basename(entry, '.md')}`,
        reason:
          'Contains a shell-exec marker (inert in Codex, live in occ) — port it manually.',
      })
      continue
    }

    const name = toSafeName(basename(entry, '.md'))
    // A leading `---` in a Codex prompt is prose, not frontmatter. occ would
    // parse it as frontmatter, so push it down a line.
    const contents = /^\s*---/.test(body) ? `\n${body}` : body
    items.push({
      id: `codex:user:command:${name}`,
      kind: 'command',
      scope: 'user',
      label: `Command /${name}`,
      description: `→ ${commandTargetPath('user', context.cwd, name)}`,
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

async function scanCodexInstructions(
  baseDir: string,
  scope: ImportScope,
  context: ScanContext,
  items: ImportItem[],
  unmappable: UnmappableItem[],
): Promise<void> {
  for (const [fileName, suffix] of [
    ['AGENTS.md', 'instructions'],
    ['AGENTS.override.md', 'override'],
  ] as const) {
    const sourcePath = join(baseDir, fileName)
    let body: string
    try {
      body = await readCappedText(sourcePath)
    } catch (error) {
      if (isEnoent(error)) continue
      unmappable.push({
        scope,
        label: fileName,
        reason: 'Could not read. Review it manually.',
      })
      continue
    }
    if (body.trim() === '') continue

    const id = `codex:${scope}:${suffix}`
    // A project-scope override lands in CLAUDE.local.md rather than CLAUDE.md:
    // the override is the user's personal layer in Codex too, and CLAUDE.md is
    // usually committed.
    const targetPath =
      suffix === 'override' && scope === 'project'
        ? join(context.cwd, 'CLAUDE.local.md')
        : instructionsTargetPath(scope, context.cwd)
    items.push({
      id,
      kind: 'instructions',
      scope,
      label: fileName,
      description: `→ ${targetPath}`,
      fingerprint: body,
      apply: options =>
        appendInstructions({
          itemId: id,
          label: fileName,
          scope,
          cwd: context.cwd,
          sourcePath,
          targetPath,
          body,
          options,
        }),
    })
  }
}
