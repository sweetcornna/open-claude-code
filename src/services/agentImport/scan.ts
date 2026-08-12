/**
 * Scan orchestration for `occ import` / `/import`.
 *
 * Sources are detected, scanned and sorted here so both surfaces see exactly
 * the same list in exactly the same order — the scan digest depends on it.
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  CODEX_DISPLAY_NAME,
  CODEX_SOURCE_ID,
  detectCodex,
  scanCodex,
} from './codex.js'
import {
  detectGemini,
  GEMINI_DISPLAY_NAME,
  GEMINI_SOURCE_ID,
  scanGemini,
} from './gemini.js'
import { compareImportItems } from './types.js'
import type {
  AgentImportScan,
  ImportSourceId,
  McpServerStore,
  ScanContext,
  SourceScan,
  SourceScanResult,
} from './types.js'

type SourceDefinition = {
  id: ImportSourceId
  displayName: string
  detect: (context: ScanContext) => Promise<boolean>
  scan: (context: ScanContext) => Promise<SourceScanResult>
  /** Where this agent keeps its user-level config, for the "nothing found" hint. */
  userDirHint: string
}

/** Registration order also decides report order. */
const IMPORT_SOURCES: readonly SourceDefinition[] = [
  {
    id: CODEX_SOURCE_ID,
    displayName: CODEX_DISPLAY_NAME,
    detect: detectCodex,
    scan: scanCodex,
    userDirHint: '~/.codex',
  },
  {
    id: GEMINI_SOURCE_ID,
    displayName: GEMINI_DISPLAY_NAME,
    detect: detectGemini,
    scan: scanGemini,
    userDirHint: '~/.gemini',
  },
]

export const IMPORT_SOURCE_IDS = IMPORT_SOURCES.map(source => source.id)

export type ScanOptions = {
  /** `[source]` argument. Undefined scans every detected agent. */
  from?: string
  /** Test seam. Undefined means the real home directory. */
  homeDir?: string
  /** Test seam. Defaults to the process working directory. */
  cwd?: string
  /** Test seam. Undefined means occ's global config. */
  mcpStore?: McpServerStore
}

/**
 * Detect and scan. Never throws for a bad source name — that is returned as
 * `error` so the surfaces can print it without a stack trace.
 */
export async function scanAgentConfigs(
  options: ScanOptions = {},
): Promise<AgentImportScan> {
  const warnings: string[] = []
  const cwd = resolve(options.cwd ?? process.cwd())

  let selected = IMPORT_SOURCES
  if (options.from !== undefined && options.from !== '') {
    const requested = options.from.toLowerCase()
    const match = IMPORT_SOURCES.find(source => source.id === requested)
    if (!match) {
      return {
        scans: [],
        warnings,
        error: `Unknown import source "${options.from}". Supported: ${IMPORT_SOURCE_IDS.join(', ')}.`,
      }
    }
    selected = [match]
  }

  // A redirected home makes "~/.codex" ambiguous, and a config root that
  // resolves inside the repository would let a cloned repo dictate what the
  // user-scope import writes. Report it rather than guessing.
  if (options.homeDir === undefined && !isPlausibleHome(homedir())) {
    warnings.push(
      'The home directory could not be determined reliably; user-scope config may not have been found.',
    )
  }

  const scans: SourceScan[] = []
  for (const source of selected) {
    const context: ScanContext = {
      cwd,
      mcpStore: options.mcpStore,
      userConfigDir: options.homeDir
        ? resolve(options.homeDir, `.${source.id}`)
        : undefined,
    }
    if (!(await source.detect(context))) continue
    const result = await source.scan(context)
    if (result.items.length === 0 && result.unmappable.length === 0) continue
    result.items.sort(compareImportItems)
    scans.push({
      sourceId: source.id,
      displayName: source.displayName,
      result,
    })
  }

  return { scans, warnings }
}

function isPlausibleHome(home: string): boolean {
  return home.trim() !== '' && home !== '/' && !home.startsWith('\\\\')
}
