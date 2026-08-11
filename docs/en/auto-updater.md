<!-- lang-switcher -->
**English** · [中文](/docs/zh/auto-updater) · [日本語](/docs/ja/auto-updater)

# Automatic Updates

## Current Policy

Open Claude Code is distributed through the npm package `@sweetcornna/open-claude-code` (the unscoped `open-claude-code` name is occupied by a third-party placeholder package). The currently supported update entry point is:

```bash
occ update
```

This command checks and updates only Open Claude Code itself. It does not install, uninstall, or overwrite Anthropic's official Claude Code.

The official CLI and occ can coexist:

| Product | Command | npm package | User configuration |
|---|---|---|---|
| Open Claude Code | `occ` / `occ-bun` | `@sweetcornna/open-claude-code` | `~/.occ/`, `~/.occ.json` |
| Anthropic Claude Code | `claude` | `@anthropic-ai/claude-code` | `~/.claude/`, `~/.claude.json` |

## Installation and Manual Updates

Install or update with npm:

```bash
npm install -g @sweetcornna/open-claude-code
occ update
```

Install or update with Bun:

```bash
bun install -g @sweetcornna/open-claude-code
occ-bun update
```

You can also bypass automatic detection and run the corresponding package-manager command directly:

```bash
npm install -g @sweetcornna/open-claude-code@latest
# or
bun install -g @sweetcornna/open-claude-code@latest
```

## How `occ update` Works

The implementation is in `src/cli/updateOcc.ts`. It performs the following steps:

1. Read the current version.
2. Choose the registry for this update (see the next section; users who configured one keep it).
3. Query the chosen registry for `@sweetcornna/open-claude-code@latest`.
4. Exit immediately if the current version is already the latest.
5. If the registry is a mirror occ raced into rather than one the user chose, run the integrity gate; fall back to the official registry if it does not pass.
6. Detect whether the current installation is in Bun's global installation directory.
7. Use `bun install -g` for a Bun global installation and `npm install -g` otherwise, both with `--registry=<chosen registry>`.
8. If the update fails, print the equivalent manual recovery command.

The package name comes from `NPM_PACKAGE_NAME` in `src/constants/brand.ts`; the updater does not maintain a duplicate string.

## Registry Racing

Updating is pure network cost, and the bottleneck is usually not the origin but the edge. Measured on one machine at one moment, against the **same** 8.3 MB tarball:

| registry | throughput | time for 8.3 MB |
|---|---|---|
| `registry.npmjs.org` | 17,599 B/s | ~8 minutes |
| `registry.npmmirror.com` | 1,101,809 B/s | **7.6 s** |

A real `bun install -g @sweetcornna/open-claude-code@2.38.1` took **347.93 s** wall (0.19 s user / 0.42 s sys) — essentially all of it waiting on the network.

So occ probes the candidate registries **concurrently** and sends **both halves** of the update — the version check and the install — to whichever answered fastest. Measured: the same `npm view` takes 2.95 s direct and 0.356 s through the mirror; a full install including all six dependencies (~20 MB) drops from 347.93 s to 42.3 s.

**What the probe reads.** The first 64 KiB of the **real tarball** (a `Range` request, cancelled as soon as enough has arrived), not the packument. Three reasons: the thing worth measuring is the path that is about to carry 8 MB, and on a mirror the metadata endpoint is often a different host from the CDN (npmmirror redirects tarballs to `cdn.npmmirror.com`); a packument probe would rank a registry whose metadata is nearby and whose CDN is not; and a tarball probe also answers "does this mirror carry this package at all". 64 KiB is chosen to measure **throughput** rather than **handshake latency** — a few-KB probe completes inside TCP slow start. The race is bounded at 3 s, all candidates run at once, and the losers are aborted the instant a winner appears (so a race costs a little over 64 KiB in practice). Every probe failing, or the timeout expiring, means falling back to the official registry.

**The candidate list** (`UPDATE_REGISTRY_CANDIDATES` in `src/services/autoUpdate/updateRegistry.ts`) has three entries. Each one is a host occ may hand a self-install to, so the bar is "publicly reachable, unauthenticated, mirrors the whole npm tree, operated by someone identifiable":

- `registry.npmjs.org` — the origin. Always in the race, so a user whose path to npm is healthy is never redirected anywhere else.
- `registry.yarnpkg.com` — the same npm content behind a different CDN, operated by the Yarn project. Included because the failure being worked around is usually a **degraded edge** rather than a degraded origin, and this reaches the same bytes by another path with no region-specific assumption.
- `registry.npmmirror.com` — Alibaba's public full mirror of npm (formerly cnpm/taobao). Included because it is the entry measured to actually change the outcome: 1.6 MB/s where the two above were at 37 KB/s.

**The user's npm/bun configuration is never modified.** Nothing writes `~/.npmrc`, `~/.bunfig.toml`, or any global config. The chosen registry is passed per invocation as `--registry=<url>`, scoped to that one child process; occ's self-update is the only traffic redirected. Verified against npm 11.16.0 and bun 1.3.13 by pointing both at a local registry and confirming every request arrived there.

**An explicitly configured registry wins and is never raced.** Any of these short-circuits before a single probe is attempted: the `npm_config_registry` / `NPM_CONFIG_REGISTRY` environment variables, a `npm config get registry` result other than the default (i.e. the `.npmrc` chain), or a bunfig `[install] registry`. The reason is practical: that is the user's own choice, quite possibly a private mirror that is the **only** host carrying the package, and racing it against public registries could only make things worse. (The bunfig case cannot be skipped: `npm config` cannot see bunfig.toml, so omitting it would race straight past what a bun user wrote down.)

**Integrity is not optional.** A mirror is a third party, so nothing it says is taken on faith:

1. occ reads the single-version document for the exact version about to be installed from the **official** registry (~7.5 KB, not the 253 KB packument), takes its `dist.integrity`, and requires the winning mirror to advertise the same value for the same version. A mirror that disagrees, that is missing the version, or that cannot be reached is discarded here, and the install falls back to `registry.npmjs.org`.
2. npm and bun then verify the downloaded tarball against the integrity in the packument they fetched — which step 1 has just pinned to the official value. This was **verified rather than assumed**: pointing each at a local registry serving honest `dist.integrity` metadata alongside a corrupted tarball, npm 11.16.0 refused with `EINTEGRITY` and bun 1.3.13 with `IntegrityCheckFailed`, and neither left anything installed.

Together those give an end-to-end property worth stating plainly: **the bytes that get unpacked hash to the value npm published, even though they came from a mirror.**

**What is not guaranteed, stated equally plainly: there is no post-install verification, and there cannot be one with these package managers.** Both unpack the tarball and discard it, and gzip is not reproducible, so the installed tree cannot be hashed back to `dist.integrity`; and the background install is a detached child that by design outlives the session that started it, so there is no process left to check afterwards. The pre-install gate is what occ can actually promise. The residual gap is a mirror that serves one packument to occ and a different one to the package manager moments later — a targeted attack rather than a passive risk, and the reason anything inconclusive falls back to the official registry.

The gate deliberately applies **only** to a mirror occ raced into. A registry the user configured is their trust anchor, not occ's guess, and may legitimately host a build that is not on npmjs at all; holding it to the public hash would break exactly the users the previous paragraph protects.

**Escape hatch**: `OCC_UPDATE_REGISTRY=official` pins `registry.npmjs.org` and skips racing entirely. The same variable also accepts an explicit registry URL, which is likewise used as-is without probing.

The race result is cached **per process**. The background loop wakes every 30 minutes, and re-racing on each pass would repeatedly answer a question whose answer does not usually change within one session — and would show a user watching their own traffic an unexplained registry request every half hour. A new process re-probes, so a network that improves is picked up at the next launch.

## Isolation from the Official Native Installer

The repository retains part of the native installer implementation recovered from upstream as a reference for code research and for building independent distribution infrastructure later. That implementation targets Anthropic's official binary distribution channel, not Open Claude Code's release channel, so **it is not a currently supported occ installation method**.

To keep the two products isolated:

- The root command does not register an `occ install [target]` native-installation entry point.
- The occ update entry point does not download Anthropic's official binary.
- occ does not uninstall `@anthropic-ai/claude-code`.
- occ does not delete or replace the `claude` command.
- occ does not treat `~/.claude` as its own writable installation directory.

Do not install occ by calling internal functions under `src/utils/nativeInstaller/` manually; those functions are not stable public interfaces.

## Silent Background Automatic Updates

One minute after an interactive session starts, occ performs its first background version check, and **repeats the check every 30 minutes** for the rest of the session. The first check is deliberately early — a session started right after a release should not wait out a full interval to find it — but not immediate: startup is the busiest moment in the process, and an `npm view` there competes with everything the user is actually waiting for. If it finds a new version it **installs it immediately**: it takes the cross-process update lock and spawns a detached `install -g`, which the session does not wait on. A subdued notice appears at the bottom of the REPL (`✓ Update vX.Y.Z installing · restart to apply`). On failure it writes only to the debug log and never interrupts the session.

**Why this used to be impossible.** occ ships as ~600 content-hashed chunks (the code split is what takes `--version` RSS from 966MB down to 35MB — see CLAUDE.md, "don't optimize the build back into a single file"), and a session `import()`s those chunks lazily for its entire life. `npm|bun install -g` *replaces* the whole package directory, and roughly **half the chunk filenames change between adjacent releases** (measured 2.21.0 → 2.22.0: 299 of 595 chunks disappear). Installing in place therefore erased half of the running session's remaining code from disk: every later lazy import threw `ERR_MODULE_NOT_FOUND`, and the symptom was not a crash but a **wedge** — the REPL stopped responding and even Ctrl+C never reached the exit path. Installs were consequently deferred until the last live session exited, which from the user's seat reads as auto-update simply not working: half an hour in a session, a release published, nothing happens.

**A session no longer reads its code from the directory the installer replaces.** At startup the entrypoint hard-links every file of `dist/` into `<config>/runtime/<version>-<fingerprint>/dist` and `import()`s the real entry from there (`src/services/autoUpdate/runtimeFarm.ts`). Hard links are the point: the same inodes, so the farm costs no extra disk while the package directory is intact — and because an inode outlives the removal of any one link, the farmed copy keeps existing and keeps being readable after `install -g` deletes the package tree. A process cannot re-root its own module resolution after the fact (chunks resolve relative to whichever module imported them), so this has to happen in the entrypoint, in-process, before the first chunk is touched.

The warm path costs **two `stat` calls**: one on `dist/cli.js` for the fingerprint (size and mtime), one on the farm's entry to see it is already there. No directory walk, no hashing. The cold path — the first launch of a given build — adds one pass of ~600 hard links: measured, `--version` goes from 0.04s to 0.17s, exactly once per version.

**If the farm cannot be built, the session degrades to the old behaviour.** A config dir on another volume (EXDEV, entirely plausible on Windows where npm's global prefix can sit on another drive) falls back to copying; if that fails too the session simply runs from the install tree, exactly as it did before this change — it loses the protection, nothing else. `OCC_DISABLE_RUNTIME_FARM=1` turns it off explicitly.

**Reclaiming farms.** Every installed version leaves one behind, and once the package directory has been replaced that farm holds the only remaining links to those inodes (~30MB). The sweep lives in `src/services/autoUpdate/runtimeFarmGc.ts` and runs once, 90 seconds into an interactive session. It removes only directories that no live session's dist root points at, that this process is not itself running from, and that are more than an hour old — the last rule covers the window between another session building its farm and registering its live-session lease. If any live session's tree cannot be identified, the whole round is skipped: leaving disk unreclaimed is always cheaper than deleting a tree somebody is still importing from.

**Several sessions coexist, but only one installs.** After finding a newer version the checker takes `~/.occ/.update.lock`; if another process holds it, an install is already running and this round does nothing. The same version is never installed twice within a session, and if a newer one ships mid-session the next round installs that instead and posts the notice again.

**The user still has to restart to get the new version.** A running process can never adopt a new build; what changed is only *when* the install happens — at discovery instead of at exit.

The implementation is the React-independent service module `src/services/autoUpdate/backgroundOccUpdate.ts`. `src/cli/program/rootAction.tsx` dynamically imports and schedules it on the interactive path (after the early return for `--print`). The UI notice enters the REPL notification queue through the registry in `src/services/autoUpdate/updateNotifier.ts` (the same pattern as `setEnvHookNotifier`).

The check does not run when any of the following conditions applies:

- `globalConfig.autoUpdates === false` (`~/.occ.json`)
- The `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` environment variable is set
- `NODE_ENV=test/development`
- The current copy is not installed globally: an npm global installation (classified as `npm-global` by doctorDiagnostic) uses `npm install -g`; an entry script under the `~/.bun/install/global` tree uses `bun install -g`; a source checkout, `npm-local` installation, Homebrew installation, or installation from any other package manager is skipped

The version query reuses the `occ update` path (`getLatestOccVersion` and `latestPackageSpec` from `src/cli/updateOcc.ts`, so the two paths can never drift to different package specs). The cross-process `.update.lock` is taken only *after* a newer version has been confirmed — acquiring it on every pass would leave a five-minute lock behind for a check that had nothing to install, starving the session that does. The child outlives us, so on success the lock is **deliberately never released**: its 5-minute staleness window *is* the install window. It is released only when the spawn itself fails.

**Two kinds of skip.** Conditions that cannot change inside this process (`NODE_ENV`, installation type) retire the loop outright; conditions the user can flip back mid-session (the `autoUpdates` config, the two environment variables above) keep it ticking. Previously every skip was final, so turning auto-updates back on with `/config` did nothing until the next launch. The reversible gates therefore run before the installation-type check, which may spawn `npm config get prefix` — keeping the loop alive on those skips has to stay cheap.

**Cancellable on exit.** The timers are `unref()`'d and never hold the process open, but the children they spawn do. `npm view` (10s cap) is bound to a session abort signal registered with `gracefulShutdown`, so Ctrl+C cancels the in-flight child and lets the event loop drain. Without it the process waited out the 5s shutdown failsafe and then hard-exited. The installer needs no such treatment: it is detached and `unref()`'d, so it never holds the event loop open.

**Fallback for a tree replaced underneath us.** A session normally runs from its farm, so this path should be unreachable. It stays because the farm is allowed to fail (another volume, a full disk, `OCC_DISABLE_RUNTIME_FARM=1`), and a session back on the install tree can still have it replaced by a manual `occ update` or a plain `npm install -g` from another terminal. The `uncaughtException` / `unhandledRejection` handlers in `gracefulShutdown` recognize that specific failure — error code `ERR_MODULE_NOT_FOUND` (a `ResolveMessage` under Bun) **and** a path inside `<distRoot>/chunks` — then print a one-line explanation and exit cleanly, instead of leaving a wedged UI that ignores Ctrl+C. Requiring the chunk path keeps ordinary resolution failures in plugins and MCP servers from killing the session; a source checkout has no `dist/chunks` at all, so it never fires in development.

The inherited component-based update route (`AutoUpdaterWrapper` / `AutoUpdater` / `PackageManagerAutoUpdater` / `NativeAutoUpdater`) was deleted along with the service rewrite described here — nothing had rendered it for a while. Do not reconnect the inherited native downloader or the official package-manager update prompt until occ has its own signed binary distribution source. Explicit `occ update` remains the manual update entry point.

## Background Plugin Updates

Installed plugin marketplaces use the same periodic scheduling, but their start time is **staggered** relative to the occ self-update: the first check runs three minutes after an interactive session starts, and every 30 minutes thereafter. The stagger keeps the two chains from hitting the network at the same moment, and since both run on the same interval it holds for the life of the session.

Each round does the following:

1. Walk the installed marketplaces and process only git and github sources; local-path marketplaces perform no network operations.
2. Run `git pull` on each source.
3. Rematerialize the corresponding plugin cache **only when `git pull` actually moved the repository**; a source whose HEAD did not change produces no writes at all.
4. When plugins were updated, post a notice at the bottom of the REPL stating that `/reload-plugins` is required for the new versions to take effect in the current session (unlike the occ self-update notice, this does not require restarting the process).

The off switches are shared with the occ self-update: `"autoUpdates": false` in `~/.occ.json`, or the `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` environment variable — any one of them stops both chains.

The cross-process lock is `<plugins>/.plugin-update.lock` (the plugin root defaults to `~/.occ/plugins` and can be overridden with `OCC_PLUGIN_CACHE_DIR`). It is independent of the occ self-update's `~/.occ/.update.lock`, so the two chains never block each other.

The implementation is `src/services/autoUpdate/backgroundPluginUpdate.ts`; notices reach the REPL notification queue through the registry in `src/services/autoUpdate/pluginUpdateNotifier.ts`.

## Check Interval and Cross-Instance Throttling

A single environment variable controls the period for both chains:

| Setting | Location | Default | Description |
|---|---|---|---|
| `OCC_UPDATE_CHECK_INTERVAL_MS` | Environment variable | `1800000` (30 minutes) | Overrides the periodic check interval for both the occ self-update and plugin updates (both chains share one value). Lower bound `60000` (1 minute); an invalid value falls back to the default |
| `OCC_UPDATE_REGISTRY` | Environment variable | unset (race) | Escape hatch: `official` pins `registry.npmjs.org` and skips registry racing; an explicit registry URL is also accepted and likewise skips racing. See "Registry Racing" |
| `lastBackgroundUpdateCheckAt` | `~/.occ.json` | — | Timestamp of the last background occ update check; internal field |
| `lastBackgroundPluginUpdateCheckAt` | `~/.occ.json` | — | Timestamp of the last background plugin update check; internal field |

Both timestamps are internal state; editing them by hand is neither necessary nor recommended. They exist to solve duplicate checking **across sessions and across concurrently open instances**: occ is often open in several windows at once, and if every instance kept its own five-minute beat, the request volume against the npm registry and the git remotes would multiply by the number of instances. So each round reads the corresponding timestamp first, and if less than one interval has elapsed since the last check (meaning another instance just ran one), this instance skips the round without issuing any request.

## Development Versions

Update a source workspace through Git and dependency installation rather than relying on the global CLI to update the current checkout:

```bash
git pull
bun install
bun run precheck
```

To verify release artifacts, run:

```bash
bun run build:vite
node dist/cli-node.js --version
bun dist/cli-bun.js --version
```

## Release Side (Maintainers)

Where user-visible versions come from: a maintainer runs `bun run release <version>`, which updates `package.json` and `CHANGELOG.md` together and creates a `v<version>` tag. After the tag is pushed, `publish-npm.yml` publishes to npm and creates the GitHub Release. See [“Release Process” in `CONTRIBUTING.md`](../../CONTRIBUTING.md#11-发布流程) for the complete procedure and constraints.

The “What's New” notice shown when occ starts comes from `CHANGELOG.md` on this repository's `main` branch (`src/utils/update/releaseNotes.ts` fetches the raw file and caches it as `cache/changelog.md` under the occ configuration directory). The release commit must therefore reach main before users can see the corresponding entries.

## Troubleshooting

If `occ update` cannot access the npm registry, query the package version directly:

```bash
npm view @sweetcornna/open-claude-code@latest version
```

If the global installation lacks write permission, correct the user-level global-directory configuration for npm or Bun. Do not work around the problem by deleting `~/.claude`, uninstalling the official Claude Code, or overwriting the `claude` command.

After an update, confirm that the two commands remain independent:

```bash
occ --version
claude --version
```

If the official Claude Code is not installed, the absence of the second command is expected.

## Key Files

| File | Responsibility |
|---|---|
| `src/constants/brand.ts` | Single source of truth for the occ command name and npm package name |
| `src/cli/updateOcc.ts` | Version check and npm/Bun update flow for `occ update`; exports the detection, package-spec, and silent-installation functions reused by background updates |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | Silent background automatic-update service for occ (periodic scheduling, gates, version comparison, and queueing) |
| `src/services/autoUpdate/updateRegistry.ts` | Registry racing, detection of a user-configured registry, and the integrity gate a mirror must pass before it may install |
| `src/services/autoUpdate/occInstaller.ts` | Spawns `install -g` detached; the session never waits on it |
| `src/services/autoUpdate/runtimeFarm.ts` | Enters the `<config>/runtime/<version>-<fingerprint>/` hard-link copy at startup, so replacing the package directory cannot strand a running session |
| `src/services/autoUpdate/runtimeFarmGc.ts` | Reclaims farms no live session is running from; also sweeps the retired `pending-updates/` directory |
| `src/services/autoUpdate/liveSessions.ts` | The `~/.occ/live-sessions/<pid>` registry (5-minute heartbeat, 30-minute TTL); farm reclamation reads it to learn who is still using which tree |
| `src/services/autoUpdate/updateNotifier.ts` | Registry that delivers update notices to the REPL notification queue |
| `src/services/autoUpdate/backgroundPluginUpdate.ts` | Periodic background update service for plugin marketplaces (`git pull` plus cache rematerialization) |
| `src/services/autoUpdate/pluginUpdateNotifier.ts` | Registry that delivers plugin-update notices to the REPL notification queue |
| `src/main.tsx` | Registers the root `occ update` command |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | Background self-update loop; must not connect to the official native downloader or package name |
| `src/utils/nativeInstaller/` | Inherited, non-public native installer implementation; not an occ distribution channel |
| `scripts/release.ts` | `bun run release <version>`: synchronizes version sources, runs release gates, commits, and creates the tag |
| `src/utils/update/releaseNotes.ts` | Fetches and parses `CHANGELOG.md` to drive the in-app “What's New” notice |
