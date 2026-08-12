/**
 * Shared shapes for `occ import` / `/import`.
 *
 * Carries one type-only import (the MCP server shape) and no runtime ones, so
 * the scanners, the digest and the report renderer can all be unit-tested
 * without a filesystem or a config system.
 */

import type { McpServerConfig } from 'src/services/mcp/types.js'

export type ImportScope = 'user' | 'project'

/**
 * Where user-scope MCP servers are read from and written to.
 *
 * Injected rather than reached for. This was the last place in `agentImport`
 * that touched process-global state (occ's global config module), and that one
 * ambient dependency was enough to make the apply test order-dependent: under a
 * full `bun test src/` run some earlier suite replaces `config.ts` in Bun's
 * process-global mock registry, so the write went somewhere the assertion could
 * not see it. Everything else here already takes its paths explicitly; this
 * closes the gap.
 */
export type McpServerStore = {
  has(name: string): boolean
  add(name: string, config: McpServerConfig): void
}

/**
 * Everything a scanner is allowed to know about the machine.
 *
 * Every field is injected rather than read from `os`/`process` inside the
 * scanners so the whole scan is testable against a fixture tree — which is what
 * makes "deterministic scan" an assertable property rather than a claim.
 */
export type ScanContext = {
  /**
   * The SOURCE AGENT's user-level config directory (`~/.codex`, `~/.gemini`),
   * not the user's home. Undefined means "derive it from the real home".
   */
  userConfigDir?: string
  /** Repository root for the project-scope half of the scan. */
  cwd: string
  /** Undefined means occ's global config. */
  mcpStore?: McpServerStore
}

/**
 * Categories of importable configuration, in the order the report lists them.
 * Mirrors the official implementation's sort table.
 */
export type ImportKind =
  | 'instructions'
  | 'setting'
  | 'subagent'
  | 'command'
  | 'mcp'
  | 'skill'

const IMPORT_KIND_ORDER: Record<ImportKind, number> = {
  instructions: 0,
  setting: 1,
  subagent: 2,
  command: 3,
  mcp: 4,
  skill: 5,
}

export type ImportSourceId = 'codex' | 'gemini'

export type ApplyOptions = {
  /** Report what would happen without touching the filesystem or config. */
  dryRun: boolean
}

/**
 * The result of applying one item. `skipped` is the ordinary outcome for a
 * target that already exists — import NEVER overwrites and NEVER renames, so
 * re-running it is safe. A thrown error means the apply failed.
 */
export type ApplyOutcome = { applied: string } | { skipped: string }

export type ImportItem = {
  /** `${source}:${scope}:${kind}:${name}` — stable across scans. */
  id: string
  kind: ImportKind
  scope: ImportScope
  /**
   * Human-readable name. UNTRUSTED: copied out of the foreign agent's config,
   * so every render path must go through `displayLabel()`.
   */
  label: string
  /** Untrusted, same handling as `label`. */
  description?: string
  /**
   * Set when importing this item would change occ's behaviour in a way the
   * user should look at first. Warned items are never auto-applied.
   *
   * Distinct from `note` on purpose. Conflating the two once meant every MCP
   * server that merely had its `env` stripped was treated as risky and held
   * back, which silently reduced the feature to "imports servers that need no
   * configuration".
   */
  warning?: string
  /**
   * Something the user should know about this item that does NOT justify
   * holding it back — most often which secret-bearing keys were stripped and
   * therefore have to be re-added by hand.
   */
  note?: string
  /**
   * Content hash input. Feeds the scan digest so a `--yes=<digest>` confirm is
   * bound to exactly the configuration the user was shown.
   */
  fingerprint: string
  apply: (options: ApplyOptions) => Promise<ApplyOutcome>
}

/** Something found in the source config that has no occ equivalent. */
export type UnmappableItem = {
  scope: ImportScope
  /** Untrusted. */
  label: string
  reason: string
}

export type SourceScanResult = {
  items: ImportItem[]
  unmappable: UnmappableItem[]
}

export type SourceScan = {
  sourceId: ImportSourceId
  displayName: string
  result: SourceScanResult
}

export type AgentImportScan = {
  scans: SourceScan[]
  /** Set when the requested `[source]` argument was not recognised. */
  error?: string
  /** Non-fatal notes (stripped secrets, redirected roots, …). */
  warnings: string[]
}

/**
 * Whether an item may be applied by a non-interactive confirm (`--yes`).
 *
 * User scope only, nothing flagged, and never a skill. occ holds skills back
 * unconditionally — see the header of `codex.ts`.
 */
export function isAutoApplicable(item: ImportItem): boolean {
  return item.scope === 'user' && !item.warning && item.kind !== 'skill'
}

/** Why an item is held back from `--yes`, or null when it is not. */
export function heldBackReason(item: ImportItem): 'project' | 'warned' | null {
  if (item.scope === 'project') return 'project'
  if (item.warning || item.kind === 'skill') return 'warned'
  return null
}

/** Report order: kind, then project before user, then label. */
export function compareImportItems(a: ImportItem, b: ImportItem): number {
  const byKind = IMPORT_KIND_ORDER[a.kind] - IMPORT_KIND_ORDER[b.kind]
  if (byKind !== 0) return byKind
  if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
  return a.label.localeCompare(b.label)
}
