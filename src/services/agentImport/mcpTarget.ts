/**
 * The only place `occ import` writes an MCP server definition.
 *
 * Two things make this safe to point at a foreign config file:
 *
 * 1. **Schema validation before the write.** The definition is parsed with the
 *    real `McpServerConfigSchema` — the same schema the MCP client validates
 *    against at connect time — so a malformed or hostile entry is rejected
 *    here, with a message, rather than landing in `~/.occ.json` and breaking
 *    every subsequent startup. Nothing from the foreign file reaches the config
 *    unparsed.
 * 2. **No-clobber.** An existing server of the same name is left alone.
 *
 * Secrets are stripped by the caller (see `stripImportedMcpSecrets`), not here,
 * so the definition this module validates is already secret-free and the
 * report can name what was dropped.
 */

import { McpServerConfigSchema } from 'src/services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config/config.js'
import { stripCredentialsFromMcpServers } from 'src/config/migrateFromClaude.js'
import type { ApplyOptions, ApplyOutcome, McpServerStore } from './types.js'
import { displayDetail } from './safety.js'

/**
 * The production store: occ's global config (`~/.occ.json`).
 *
 * A factory rather than a constant so `getGlobalConfig` is called at apply
 * time, not at module load — this module is imported during the scan, long
 * before the config system is necessarily open.
 */
function globalConfigMcpStore(): McpServerStore {
  return {
    has: name => getGlobalConfig().mcpServers?.[name] !== undefined,
    add: (name, config) =>
      saveGlobalConfig(current => ({
        ...current,
        mcpServers: { ...current.mcpServers, [name]: config },
      })),
  }
}

type StrippedMcpServer = {
  definition: Record<string, unknown>
  /** Human-readable note naming what was removed, if anything. */
  note: string | null
}

/**
 * Remove credential-bearing fields from a foreign MCP server definition.
 *
 * Deliberately reuses `occ migrate`'s rule rather than inventing a second one:
 * `env` and `headers` go wholesale, because unlike `settings.env` they are
 * free-form and server-specific, so there is no shape to classify against and
 * any heuristic eventually leaks a token. The keys are DELETED, not blanked —
 * an empty-string secret is indistinguishable from a real one to the server and
 * produces a confusing auth failure, while an absent one fails loudly.
 *
 * This is occ's one deliberate divergence from the official importer, which
 * copies `env`/`headers` through verbatim. The migrate command set the
 * precedent for this codebase and the foreign-config case is strictly weaker:
 * the user is importing from a tool they may have configured months ago.
 */
export function stripImportedMcpSecrets(
  name: string,
  definition: Record<string, unknown>,
): StrippedMcpServer {
  const result = stripCredentialsFromMcpServers({ [name]: definition })
  const stripped = result.servers[name]
  return {
    definition:
      stripped && typeof stripped === 'object' && !Array.isArray(stripped)
        ? (stripped as Record<string, unknown>)
        : {},
    note: result.stripped[0] ?? null,
  }
}

/**
 * Validate and add a user-scope MCP server. Returns the outcome; never throws
 * for an invalid definition (that is a skip, not a failure).
 */
export async function addUserMcpServer(input: {
  label: string
  name: string
  definition: Record<string, unknown>
  options: ApplyOptions
  /** Undefined means the real global config. */
  store?: McpServerStore
}): Promise<ApplyOutcome> {
  const { label, name, definition, options } = input
  const store = input.store ?? globalConfigMcpStore()

  const parsed = McpServerConfigSchema().safeParse(definition)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return {
      skipped: `${label}: definition failed schema validation — ${displayDetail(detail)}`,
    }
  }

  if (store.has(name)) {
    return { skipped: `${label}: MCP server already exists in user config` }
  }
  if (options.dryRun) {
    return { applied: `would add MCP server ${name} (user)` }
  }

  store.add(name, parsed.data)
  return { applied: `added MCP server ${name} (user)` }
}
