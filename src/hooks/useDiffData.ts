import chokidar, { type FSWatcher } from 'chokidar'
import type { StructuredPatchHunk } from 'diff'
import { relative, sep } from 'path'
import { useEffect, useMemo, useState } from 'react'
import { PROJECT_DIR_NAME } from '../config/paths.js'
import { getCwd } from '../utils/filesystem/cwd.js'
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  type GitDiffResult,
  type GitDiffStats,
} from '../utils/git/gitDiff.js'

const MAX_LINES_PER_FILE = 400
const DIFF_REFRESH_DEBOUNCE_MS = 150

type DiffWatcher = {
  watcher: FSWatcher
  ready: Promise<void>
}

type DiffWatcherDependencies = {
  watch: (path: string, onChange: () => void) => DiffWatcher
}

const DEFAULT_DIFF_WATCHER_DEPENDENCIES: DiffWatcherDependencies = {
  watch: (path, onChange) => {
    const watcher = chokidar.watch(path, {
      persistent: false,
      ignoreInitial: true,
      ignored: watchedPath => {
        const relativePath = relative(path, watchedPath)
        return relativePath
          .split(sep)
          .some(part => part === '.git' || part === PROJECT_DIR_NAME)
      },
      ignorePermissionErrors: true,
    })
    watcher.on('add', onChange)
    watcher.on('change', onChange)
    watcher.on('unlink', onChange)
    return {
      watcher,
      ready: new Promise(resolve => watcher.once('ready', resolve)),
    }
  },
}

export type DiffFile = {
  path: string
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isLargeFile: boolean
  isTruncated: boolean
  isNewFile?: boolean
  isUntracked?: boolean
}

export type DiffData = {
  stats: GitDiffStats | null
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
}

/** Fetch current git diff data and refresh it while the view remains mounted. */
export function useDiffData(): DiffData {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  const [hunks, setHunks] = useState<Map<string, StructuredPatchHunk[]>>(
    new Map(),
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let loadingNow = false
    let refreshPending = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = (): void => {
      if (cancelled) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void loadDiffData()
      }, DIFF_REFRESH_DEBOUNCE_MS)
    }

    async function loadDiffData(): Promise<void> {
      if (loadingNow) {
        refreshPending = true
        return
      }
      loadingNow = true
      try {
        const [statsResult, hunksResult] = await Promise.all([
          fetchGitDiff(),
          fetchGitDiffHunks(),
        ])

        if (!cancelled) {
          setDiffResult(statsResult)
          setHunks(hunksResult)
          setLoading(false)
        }
      } catch (_error) {
        if (!cancelled) {
          setDiffResult(null)
          setHunks(new Map())
          setLoading(false)
        }
      } finally {
        loadingNow = false
        if (refreshPending && !cancelled) {
          refreshPending = false
          scheduleRefresh()
        }
      }
    }

    const { watcher, ready } = DEFAULT_DIFF_WATCHER_DEPENDENCIES.watch(
      getCwd(),
      scheduleRefresh,
    )
    void loadDiffData()
    // Chokidar does not deliver events until `ready`. Always refresh once after
    // that boundary so edits between the initial read and readiness are covered.
    void ready.then(() => {
      if (!cancelled) scheduleRefresh()
    })

    return () => {
      cancelled = true
      if (refreshTimer) clearTimeout(refreshTimer)
      void watcher.close()
    }
  }, [])

  return useMemo(() => {
    if (!diffResult) {
      return { stats: null, files: [], hunks: new Map(), loading }
    }

    const { stats, perFileStats } = diffResult
    const files: DiffFile[] = []

    // Iterate over perFileStats to get all files including large/skipped ones
    for (const [path, fileStats] of perFileStats) {
      const fileHunks = hunks.get(path)
      const isUntracked = fileStats.isUntracked ?? false

      // Detect large file (in perFileStats but not in hunks, and not binary/untracked)
      const isLargeFile = !fileStats.isBinary && !isUntracked && !fileHunks

      // Detect truncated file (total > limit means we truncated)
      const totalLines = fileStats.added + fileStats.removed
      const isTruncated =
        !isLargeFile && !fileStats.isBinary && totalLines > MAX_LINES_PER_FILE

      files.push({
        path,
        linesAdded: fileStats.added,
        linesRemoved: fileStats.removed,
        isBinary: fileStats.isBinary,
        isLargeFile,
        isTruncated,
        isUntracked,
      })
    }

    files.sort((a, b) => a.path.localeCompare(b.path))

    return { stats, files, hunks, loading: false }
  }, [diffResult, hunks, loading])
}
