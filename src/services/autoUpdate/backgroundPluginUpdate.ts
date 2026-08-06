/**
 * Silent background update for installed plugin marketplaces.
 *
 * Same shape as backgroundOccUpdate.ts: a plain imperative service with one
 * recursive, unref'd timer loop per interactive session, gated hard on the
 * same autoupdate semantics, with every failure path logForDebugging-only.
 * The first delay is 3 minutes — deliberately offset from the occ
 * self-update's 1 so the two background jobs never contend for network/CPU at
 * the same moment. Both then run on the same interval, so the offset holds for
 * the life of the session.
 *
 * Relationship to the startup autoupdate path
 * (utils/plugins/pluginAutoupdate.ts, fired from backgroundHousekeeping):
 * that one runs once at launch and only touches marketplaces with autoUpdate
 * enabled (third-party marketplaces default to false). This one is the
 * mid-session sweep: it keeps every git-backed marketplace fresh for sessions
 * that stay open for hours, and only skips the ones the user *explicitly*
 * opted out of. Both converge on updatePluginsForMarketplaces + a green
 * "plugin updated · /reload-plugins" notice, so a user never sees two
 * different vocabularies for the same event.
 *
 * What it updates: materialized known marketplaces backed by a git clone
 * (source github/git, installLocation inside the marketplaces cache dir,
 * containing a .git). Each gets a fetch + fast-forward pull through the
 * shared marketplaceManager.gitPull — reused rather than reimplemented so the
 * background path inherits pinned-`ref` handling (fetch + checkout + pull on
 * that ref, not the remote default branch) and post-pull submodule sync. It
 * is called with a 30s per-invocation timeout (nothing user-visible waits on
 * this job, so a hung remote must not hold a git child for the normal 120s),
 * --ff-only (an unattended merge commit in a cache clone is never wanted),
 * and credential helpers disabled — background jobs must never pop a keychain
 * prompt.
 *
 * Excluded by the listing: non-git sources (url/file/directory/npm/settings),
 * seed-managed entries, entries the user set autoUpdate:false on, and entries
 * with a corrupted installLocation (gh-32793: a path outside the cache dir
 * could be the USER'S repo — pulling there is an incident). The official
 * marketplace is excluded in practice by the .git check: it is fetched from a
 * GCS mirror, so its cache dir is not a clone.
 *
 * A marketplace counts as updated only when its HEAD actually moved. When at
 * least one moved, caches are invalidated (marketplace memoize + plugin
 * loader caches) so subsequent loads re-read the refreshed manifests,
 * installed plugins from those marketplaces are re-materialized through the
 * existing updatePluginsForMarketplaces path, and one green "plugin updated"
 * notification goes out through pluginUpdateNotifier. Single-marketplace
 * failures never affect the others and never surface to the user.
 *
 * Concurrency: the whole pass is wrapped in a cross-process lock (the
 * autoUpdater lock primitive pointed at a plugins-dir lock file) so two occ
 * instances can never git-pull the same marketplace clone at once. It is a
 * different file from the self-update lock on purpose — a slow `npm install
 * -g` and a marketplace fetch guard different resources and must not starve
 * each other.
 *
 * Hard gates — all must pass, re-checked when the timer fires:
 *  - NODE_ENV is not test/development
 *  - DISABLE_AUTOUPDATER unset and no essential-traffic-only env var
 *    (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
 *  - globalConfig.autoUpdates !== false
 */
import { isEnvTruthy } from 'src/utils/config/envUtils.js'
import { registerCleanup } from 'src/utils/process/cleanupRegistry.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import * as updateInterval from './backgroundUpdateInterval.js'
import { emitPluginUpdateNotification } from './pluginUpdateNotifier.js'

const BACKGROUND_PLUGIN_UPDATE_DELAY_MS = 3 * 60 * 1000
const CHECK_THROTTLE_RATIO = 0.9
const PER_MARKETPLACE_GIT_TIMEOUT_MS = 30 * 1000
const MAX_NAMES_IN_NOTIFICATION = 3

type ClaimCheck = (checkedAt: number, minElapsedMs: number) => boolean

export type MarketplaceGitTarget = {
  name: string
  installLocation: string
  /** Pinned branch/tag from the marketplace source, if any. */
  ref?: string
  /** Sparse-checkout cone paths from the marketplace source, if any. */
  sparsePaths?: string[]
}

export type BackgroundPluginUpdateDeps = {
  env: NodeJS.ProcessEnv
  /** globalConfig.autoUpdates — only an explicit `false` disables. */
  getAutoUpdatesConfig: () => boolean | undefined
  getEssentialTrafficOnlyReason: () => string | null
  /**
   * Materialized, git-sourced marketplaces that are safe to pull in the
   * background. The default impl filters known_marketplaces.json to
   * github/git sources whose installLocation resolves inside the
   * marketplaces cache dir (excludes seed-managed and corrupted entries) and
   * that the user has not explicitly opted out of.
   */
  listGitMarketplaces: () => Promise<MarketplaceGitTarget[]>
  /** Whether installLocation is an actual git clone (has a .git). */
  isGitRepo: (dir: string) => boolean
  /** Resolved HEAD sha, or null when it cannot be read. Must never throw. */
  readHeadSha: (dir: string) => Promise<string | null>
  /**
   * Fetch + fast-forward the clone. Must never throw. `signal` cancels the git
   * child when the session is shutting down.
   */
  pull: (
    target: MarketplaceGitTarget,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; detail: string }>
  /**
   * Re-materialize installed plugins from the given (lowercased) marketplace
   * names — the existing updatePluginsForMarketplaces path, which keeps
   * installed_plugins.json versions and the plugin cache in sync.
   */
  updateInstalledPlugins: (marketplaceNames: Set<string>) => Promise<string[]>
  /** Drop marketplace memoize + plugin loader caches so loads re-read disk. */
  invalidateCaches: () => void
  /** Cross-process guard around the whole pass. */
  acquireLock: () => Promise<boolean>
  releaseLock: () => Promise<void>
  notify: (text: string) => void
  now: () => number
  claimUpdateCheck: ClaimCheck
}

export type BackgroundPluginUpdateOutcome =
  /** See resolveSkipReason — `permanent` decides whether the loop retires. */
  | { status: 'skipped'; reason: string; permanent: boolean }
  | { status: 'throttled' }
  | { status: 'no-marketplaces' }
  | { status: 'locked' }
  | { status: 'up-to-date'; checked: number }
  | { status: 'updated'; marketplaces: string[]; plugins: string[] }
  | { status: 'error' }

/**
 * Default deps are loaded lazily so that importing this module (rootAction
 * does it dynamically; Notifications.tsx only imports pluginUpdateNotifier)
 * never drags the plugin/marketplace chain into startup, and so tests can
 * exercise the full flow through injected deps without process-global
 * mock.module calls.
 */
async function loadDefaultDeps(): Promise<BackgroundPluginUpdateDeps> {
  const [
    fs,
    path,
    config,
    privacy,
    marketplaceManager,
    pluginDirectories,
    cacheUtils,
    autoupdate,
    autoUpdater,
    exec,
    git,
  ] = await Promise.all([
    import('fs'),
    import('path'),
    import('src/utils/config/config.js'),
    import('src/utils/auth/privacyLevel.js'),
    import('src/utils/plugins/marketplaceManager.js'),
    import('src/utils/plugins/pluginDirectories.js'),
    import('src/utils/plugins/cacheUtils.js'),
    import('src/utils/plugins/pluginAutoupdate.js'),
    import('src/utils/update/autoUpdater.js'),
    import('src/utils/process/execFileNoThrow.js'),
    import('src/utils/git/git.js'),
  ])
  // Lives next to the marketplace clones it guards, and is derived from
  // getPluginsDirectory() (→ occConfigPath) so it follows OCC_CONFIG_DIR /
  // OCC_PLUGIN_CACHE_DIR like every other plugin path.
  const lockPath = path.join(
    pluginDirectories.getPluginsDirectory(),
    '.plugin-update.lock',
  )
  return {
    env: process.env,
    getAutoUpdatesConfig: () => config.getGlobalConfig().autoUpdates,
    getEssentialTrafficOnlyReason: privacy.getEssentialTrafficOnlyReason,
    listGitMarketplaces: async () => {
      const known = await marketplaceManager.loadKnownMarketplacesConfigSafe()
      const declared = marketplaceManager.getDeclaredMarketplaces()
      const cacheDir = path.resolve(
        marketplaceManager.getMarketplacesCacheDir(),
      )
      const targets: MarketplaceGitTarget[] = []
      for (const [name, entry] of Object.entries(known)) {
        if (entry.source.source !== 'github' && entry.source.source !== 'git') {
          continue
        }
        // Explicit opt-out wins. Settings-declared autoUpdate takes precedence
        // over the JSON state, matching getAutoUpdateEnabledMarketplaces().
        // Only an explicit `false` excludes: unlike the startup path we do NOT
        // require opt-in, because keeping every marketplace fresh mid-session
        // is the whole point of this job — but a user who turned autoUpdate
        // off must never see a background git pull on that clone.
        const optOut = declared[name]?.autoUpdate ?? entry.autoUpdate
        if (optOut === false) {
          continue
        }
        // Safety guard (same as refreshMarketplace, gh-32793): a corrupted
        // installLocation outside the cache dir could point at the user's own
        // repository — a background `git pull` there is unacceptable. This
        // also excludes seed-managed entries (their installLocation lives in
        // the read-only seed dir, not the cache dir).
        const resolved = path.resolve(entry.installLocation)
        if (
          resolved !== cacheDir &&
          !resolved.startsWith(cacheDir + path.sep)
        ) {
          continue
        }
        targets.push({
          name,
          installLocation: resolved,
          ref: entry.source.ref,
          sparsePaths: entry.source.sparsePaths,
        })
      }
      return targets
    },
    isGitRepo: dir => fs.existsSync(path.join(dir, '.git')),
    readHeadSha: async dir => {
      const result = await exec.execFileNoThrowWithCwd(
        git.gitExe(),
        ['rev-parse', 'HEAD'],
        { cwd: dir, timeout: PER_MARKETPLACE_GIT_TIMEOUT_MS, stdin: 'ignore' },
      )
      return result.code === 0 ? result.stdout.trim() : null
    },
    pull: async (target, signal) => {
      const result = await marketplaceManager.gitPull(
        target.installLocation,
        target.ref,
        {
          disableCredentialHelper: true,
          sparsePaths: target.sparsePaths,
          timeoutMs: PER_MARKETPLACE_GIT_TIMEOUT_MS,
          ffOnly: true,
          abortSignal: signal,
        },
      )
      return { ok: result.code === 0, detail: result.stderr }
    },
    updateInstalledPlugins: names =>
      autoupdate.updatePluginsForMarketplaces(names),
    invalidateCaches: () => {
      marketplaceManager.clearMarketplacesCache()
      cacheUtils.clearAllPluginCaches()
    },
    acquireLock: () => autoUpdater.acquireUpdateLock(lockPath),
    releaseLock: () => autoUpdater.releaseUpdateLock(lockPath),
    notify: emitPluginUpdateNotification,
    now: Date.now,
    claimUpdateCheck: (checkedAt, minimumElapsedMs) => {
      let claimed = false
      config.saveGlobalConfig(current => {
        const previous = current.lastBackgroundPluginUpdateCheckAt
        const isRecent =
          previous !== undefined && checkedAt - previous < minimumElapsedMs
        if (isRecent) {
          return current
        }
        claimed = true
        return {
          ...current,
          lastBackgroundPluginUpdateCheckAt: checkedAt,
        }
      })
      return claimed
    },
  }
}

type PluginSkip = { reason: string; permanent: boolean }

/**
 * `permanent` marks a skip this process can never resolve, so the loop can
 * retire instead of ticking forever. Everything except NODE_ENV here is a
 * setting the user can flip mid-session, and treating those as final meant
 * re-enabling auto-updates did nothing until the next launch.
 */
function resolveSkipReason(
  deps: BackgroundPluginUpdateDeps,
): PluginSkip | null {
  const nodeEnv = deps.env.NODE_ENV
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    return { reason: `NODE_ENV=${nodeEnv}`, permanent: true }
  }
  if (isEnvTruthy(deps.env.DISABLE_AUTOUPDATER)) {
    return { reason: 'DISABLE_AUTOUPDATER is set', permanent: false }
  }
  const essentialOnly = deps.getEssentialTrafficOnlyReason()
  if (essentialOnly) {
    return { reason: `${essentialOnly} is set`, permanent: false }
  }
  if (deps.getAutoUpdatesConfig() === false) {
    return { reason: 'autoUpdates disabled in global config', permanent: false }
  }
  return null
}

/**
 * Fetch + fast-forward one marketplace clone. Returns whether HEAD moved.
 * Never throws: a failure here — including a throwing dependency — must cost
 * this marketplace only, never the rest of the pass.
 */
async function pullMarketplace(
  deps: BackgroundPluginUpdateDeps,
  target: MarketplaceGitTarget,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (!deps.isGitRepo(target.installLocation)) {
      logForDebugging(
        `backgroundPluginUpdate: ${target.name} is not a git clone, skipping`,
      )
      return false
    }

    const before = await deps.readHeadSha(target.installLocation)
    if (before === null) {
      logForDebugging(`backgroundPluginUpdate: ${target.name} rev-parse failed`)
      return false
    }

    const pull = await deps.pull(target, signal)
    if (!pull.ok) {
      logForDebugging(
        `backgroundPluginUpdate: ${target.name} pull failed: ${pull.detail}`,
      )
      return false
    }

    const after = await deps.readHeadSha(target.installLocation)
    if (after === null) {
      logForDebugging(
        `backgroundPluginUpdate: ${target.name} post-pull rev-parse failed`,
      )
      return false
    }

    return before !== after
  } catch (error) {
    logForDebugging(`backgroundPluginUpdate: ${target.name} failed: ${error}`)
    return false
  }
}

function formatNames(names: string[]): string {
  if (names.length <= MAX_NAMES_IN_NOTIFICATION) {
    return names.join(', ')
  }
  const shown = names.slice(0, MAX_NAMES_IN_NOTIFICATION).join(', ')
  return `${shown} +${names.length - MAX_NAMES_IN_NOTIFICATION} more`
}

/**
 * Plugin ids are "name@marketplace"; show just the name, matching
 * usePluginAutoupdateNotification (the startup path's notice).
 */
function pluginDisplayName(pluginId: string): string {
  const atIndex = pluginId.indexOf('@')
  return atIndex > 0 ? pluginId.slice(0, atIndex) : pluginId
}

function updateSuccessText(marketplaces: string[], plugins: string[]): string {
  // Prefer plugin names — that is what the user recognizes. Fall back to
  // marketplace names when the marketplace moved but no installed plugin
  // needed re-materializing.
  const names =
    plugins.length > 0 ? plugins.map(pluginDisplayName) : marketplaces
  return `✓ plugin updated: ${formatNames(names)} · Run /reload-plugins to apply`
}

/**
 * One full check-and-update pass over all eligible marketplaces. Never
 * throws; every failure downgrades to a logForDebugging line and a status
 * for tests.
 */
export async function runBackgroundPluginUpdateOnce(
  deps?: BackgroundPluginUpdateDeps,
  signal?: AbortSignal,
): Promise<BackgroundPluginUpdateOutcome> {
  try {
    const d = deps ?? (await loadDefaultDeps())

    const skip = resolveSkipReason(d)
    if (skip) {
      logForDebugging(`backgroundPluginUpdate: skipped (${skip.reason})`)
      return {
        status: 'skipped',
        reason: skip.reason,
        permanent: skip.permanent,
      }
    }

    const intervalMs = updateInterval.resolveBackgroundUpdateIntervalMs(d.env)
    if (!d.claimUpdateCheck(d.now(), intervalMs * CHECK_THROTTLE_RATIO)) {
      logForDebugging('backgroundPluginUpdate: throttled')
      return { status: 'throttled' }
    }

    const targets = await d.listGitMarketplaces()
    if (targets.length === 0) {
      logForDebugging('backgroundPluginUpdate: no git-backed marketplaces')
      return { status: 'no-marketplaces' }
    }

    // Take the lock only once there is real work to do, so the common
    // nothing-to-update case never touches the filesystem.
    if (!(await d.acquireLock())) {
      logForDebugging('backgroundPluginUpdate: another update is in progress')
      return { status: 'locked' }
    }
    try {
      // Sequential on purpose: one background git process at a time, and the
      // per-marketplace 30s timeout stays a real bound on each unit of work.
      const changed: string[] = []
      for (const target of targets) {
        // Stop between marketplaces once shutdown starts — the in-flight git
        // child is cancelled by the signal, and the queue behind it must not
        // start a new one.
        if (signal?.aborted) {
          break
        }
        if (await pullMarketplace(d, target, signal)) {
          changed.push(target.name)
          logForDebugging(`backgroundPluginUpdate: ${target.name} updated`)
        }
      }

      if (changed.length === 0) {
        logForDebugging(
          `backgroundPluginUpdate: all up to date (${targets.length} checked)`,
        )
        return { status: 'up-to-date', checked: targets.length }
      }

      // Invalidate BEFORE re-materializing plugins so the update ops read the
      // freshly-pulled manifests instead of session-start memoized ones.
      d.invalidateCaches()

      let updatedPlugins: string[] = []
      try {
        updatedPlugins = await d.updateInstalledPlugins(
          new Set(changed.map(name => name.toLowerCase())),
        )
      } catch (error) {
        // The marketplaces themselves DID update — keep going and notify.
        logForDebugging(
          `backgroundPluginUpdate: plugin re-materialization failed: ${error}`,
        )
      }

      // And again after: plugin update ops may have re-warmed loader caches
      // mid-write; the next load path must start clean.
      d.invalidateCaches()

      d.notify(updateSuccessText(changed, updatedPlugins))
      logForDebugging(
        `backgroundPluginUpdate: updated marketplaces [${changed.join(', ')}], plugins [${updatedPlugins.join(', ')}]`,
      )
      return {
        status: 'updated',
        marketplaces: changed,
        plugins: updatedPlugins,
      }
    } finally {
      await d.releaseLock()
    }
  } catch (error) {
    logForDebugging(`backgroundPluginUpdate: ${error}`)
    return { status: 'error' }
  }
}

let scheduledThisSession = false

type BackgroundPluginScheduleFn = (
  callback: () => Promise<void>,
  delayMs: number,
) => { unref: () => void }

/**
 * Abort the in-flight sweep when the session shuts down. The timers are
 * unref'd and never hold the process open, but a spawned `git fetch` against
 * an unreachable remote does — for up to the 30s per-marketplace timeout, once
 * per marketplace. Cancelling lets Ctrl+C drain the loop instead of waiting on
 * gracefulShutdown's failsafe.
 */
function registerShutdownAbort(controller: AbortController): void {
  registerCleanup(async () => {
    controller.abort()
  })
}

/**
 * Install the once-per-session background loop. Called from rootAction on the
 * interactive path only. Cheap env guards run here so no timer is created at
 * all in the common disabled cases; the full gate (config + privacy) runs
 * again on every pass. Returns whether the loop was installed.
 */
export function maybeScheduleBackgroundPluginUpdate(options?: {
  env?: NodeJS.ProcessEnv
  delayMs?: number
  run?: (signal: AbortSignal) => Promise<BackgroundPluginUpdateOutcome>
  scheduleFn?: BackgroundPluginScheduleFn
  /** Injected by tests; production registers one tied to graceful shutdown. */
  abortController?: AbortController
}): boolean {
  if (scheduledThisSession) {
    return false
  }
  const env = options?.env ?? process.env
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') {
    return false
  }
  if (isEnvTruthy(env.DISABLE_AUTOUPDATER)) {
    return false
  }
  scheduledThisSession = true
  const controller = options?.abortController ?? new AbortController()
  if (!options?.abortController) {
    registerShutdownAbort(controller)
  }
  const run =
    options?.run ??
    ((signal: AbortSignal) => runBackgroundPluginUpdateOnce(undefined, signal))
  const intervalMs = updateInterval.resolveBackgroundUpdateIntervalMs(env)
  const scheduleFn: BackgroundPluginScheduleFn =
    options?.scheduleFn ??
    ((callback, delayMs) =>
      setTimeout(() => {
        void callback()
      }, delayMs))
  const scheduleNext = (delayMs: number): void => {
    const timer = scheduleFn(async () => {
      if (controller.signal.aborted) {
        return
      }
      try {
        const outcome = await run(controller.signal)
        // Only a skip this process can never resolve retires the loop; a
        // reversible one keeps ticking so re-enabling takes effect live.
        if (outcome.status === 'skipped' && outcome.permanent) {
          logForDebugging(
            `backgroundPluginUpdate: loop retired (${outcome.reason})`,
          )
          return
        }
      } catch (error) {
        // The production runner never throws; keep overrides and future
        // edits from surfacing an unhandled rejection into the session.
        logForDebugging(
          `backgroundPluginUpdate: scheduled run failed: ${error}`,
        )
      }
      scheduleNext(intervalMs)
    }, delayMs)
    // Never keep the process alive just for a plugin update check.
    timer.unref()
  }
  scheduleNext(options?.delayMs ?? BACKGROUND_PLUGIN_UPDATE_DELAY_MS)
  return true
}

export function resetBackgroundPluginUpdateForTests(): void {
  scheduledThisSession = false
}
