import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import {
  getManagedAndUserConditionalRules,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
  type MemoryFileInfo,
} from '../session/claudemd.js'
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/filesystem/cwd.js'
import { logError } from '../telemetry/log.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { pathInAllowedWorkingPath } from '../permissions/filesystem.js'
import {
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
  type InstructionsMemoryType,
} from '../hooks.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Attachment } from './types.js'

/**
 * Computes the directories to process for nested memory file loading.
 * Returns two lists:
 * - nestedDirs: Directories between CWD and targetPath (processed for CLAUDE.md + all rules)
 * - cwdLevelDirs: Directories from root to CWD (processed for conditional rules only)
 *
 * @param targetPath The target file path
 * @param originalCwd The original current working directory
 * @returns Object with nestedDirs and cwdLevelDirs arrays, both ordered from parent to child
 */
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  // Build list of directories from original CWD to targetPath's directory
  const targetDir = dirname(resolve(targetPath))
  const nestedDirs: string[] = []
  let currentDir = targetDir

  // Walk up from target directory to original CWD
  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(originalCwd)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  // Reverse to get order from CWD down to target
  nestedDirs.reverse()

  // Build list of directories from root to CWD (for conditional rules only)
  const cwdLevelDirs: string[] = []
  currentDir = originalCwd

  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  // Reverse to get order from root to CWD
  cwdLevelDirs.reverse()

  return { nestedDirs, cwdLevelDirs }
}

/**
 * Converts memory files to attachments, filtering out already-loaded files.
 *
 * @param memoryFiles The memory files to convert
 * @param toolUseContext The tool use context (for tracking loaded files)
 * @returns Array of nested memory attachments
 */
function isInstructionsMemoryType(
  type: MemoryFileInfo['type'],
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

/** Exported for testing — regression guard for LRU-eviction re-injection. */
export function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    // Dedup: loadedNestedMemoryPaths is a non-evicting Set; readFileState
    // is a 100-entry LRU that drops entries in busy sessions, so relying
    // on it alone re-injects the same CLAUDE.md on every eviction cycle.
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      // Mark as loaded in readFileState — this provides cross-function and
      // cross-turn dedup via the .has() check above.
      //
      // When the injected content doesn't match disk (stripped HTML comments,
      // stripped frontmatter, truncated MEMORY.md), cache the RAW disk bytes
      // with `isPartialView: true`. Edit/Write see the flag and require a real
      // Read first; getChangedFiles sees real content + undefined offset/limit
      // so mid-session change detection still works.
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })

      // Fire InstructionsLoaded hook for audit/observability (fire-and-forget)
      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs
          ? 'path_glob_match'
          : memoryFile.parent
            ? 'include'
            : 'nested_traversal'
        void executeInstructionsLoadedHooks(
          memoryFile.path,
          memoryFile.type,
          loadReason,
          {
            globs: memoryFile.globs,
            triggerFilePath,
            parentFilePath: memoryFile.parent,
          },
        )
      }
    }
  }

  return attachments
}

/**
 * Loads nested memory files for a given file path and returns them as attachments.
 * This function performs directory traversal to find CLAUDE.md files and conditional rules
 * that apply to the target file path.
 *
 * Processing order (must be preserved):
 * 1. Managed/User conditional rules matching targetPath
 * 2. Nested directories (CWD → target): CLAUDE.md + unconditional + conditional rules
 * 3. CWD-level directories (root → CWD): conditional rules only
 *
 * @param filePath The file path to get nested memory files for
 * @param toolUseContext The tool use context
 * @param appState The app state containing tool permission context
 * @returns Array of nested memory attachments
 */
export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    // Early return if path is not in allowed working path
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    // Phase 1: Process Managed and User conditional rules
    const managedUserRules = await getManagedAndUserConditionalRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    // Phase 2: Get directories to process
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_paper_halyard',
      false,
    )

    // Phase 3: Process nested directories (CWD → target)
    // Each directory gets: CLAUDE.md + unconditional rules + conditional rules
    for (const dir of nestedDirs) {
      const memoryFiles = (
        await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths)
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
      )
    }

    // Phase 4: Process CWD-level directories (root → CWD)
    // Only conditional rules (unconditional rules are already loaded eagerly)
    for (const dir of cwdLevelDirs) {
      const conditionalRules = (
        await getConditionalRulesForCwdLevelDirectory(
          dir,
          filePath,
          processedPaths,
        )
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath),
      )
    }
  } catch (error) {
    logError(error)
  }

  return attachments
}

/**
 * Processes paths that need nested memory attachments and checks for nested CLAUDE.md files
 * Uses nestedMemoryAttachmentTriggers field from ToolUseContext
 */
export async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Check triggers first — getAppState() waits for a React render cycle,
  // and the common case is an empty trigger set.
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []

  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()

  return attachments
}
