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
2. Query the npm registry for `@sweetcornna/open-claude-code@latest`.
3. Exit immediately if the current version is already the latest.
4. Detect whether the current installation is in Bun's global installation directory.
5. Use `bun install -g @sweetcornna/open-claude-code@latest` for a Bun global installation; use `npm install -g @sweetcornna/open-claude-code@latest` for other installations.
6. If the update fails, print the equivalent manual recovery command.

The package name comes from `NPM_PACKAGE_NAME` in `src/constants/brand.ts`; the updater does not maintain a duplicate string.

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

One minute after an interactive session starts, occ performs its first background version check, and **repeats the check every 30 minutes** for the rest of the session. The first check is deliberately early — a session started right after a release should not wait out a full interval to find it — but not immediate: startup is the busiest moment in the process, and an `npm view` there competes with everything the user is actually waiting for. If it finds a new version, it silently performs a global installation. On success, the REPL displays a subdued notice at the bottom (`✓ Updated to vX.Y.Z · Restart to apply`). On failure, it writes only to the debug log and never interrupts the session.

Two consequences of the periodic behavior: if another new version ships while the session is still open, the next check installs it and posts the notice again (a long-running session no longer stays pinned to whatever version was current at startup); and the same version is never installed twice — an already-installed version is skipped on later rounds.

The implementation is the React-independent service module `src/services/autoUpdate/backgroundOccUpdate.ts`. `src/cli/program/rootAction.tsx` dynamically imports and schedules it on the interactive path (after the early return for `--print`). The UI notice enters the REPL notification queue through the registry in `src/services/autoUpdate/updateNotifier.ts` (the same pattern as `setEnvHookNotifier`).

The check does not run when any of the following conditions applies:

- `globalConfig.autoUpdates === false` (`~/.occ.json`)
- The `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` environment variable is set
- `NODE_ENV=test/development`
- The current copy is not installed globally: an npm global installation (classified as `npm-global` by doctorDiagnostic) uses `npm install -g`; an entry script under the `~/.bun/install/global` tree uses `bun install -g`; a source checkout, `npm-local` installation, Homebrew installation, or installation from any other package manager is skipped

The installation command reuses the `occ update` path (the version query and `installOccGloballySilent` from `src/cli/updateOcc.ts`, with output captured rather than passed through) and shares the cross-process `.update.lock` with `installGlobalPackage()`.

**Two kinds of skip.** Conditions that cannot change inside this process (`NODE_ENV`, installation type) retire the loop outright; conditions the user can flip back mid-session (the `autoUpdates` config, the two environment variables above) keep it ticking. Previously every skip was final, so turning auto-updates back on with `/config` did nothing until the next launch. The reversible gates therefore run before the installation-type check, which may spawn `npm config get prefix` — keeping the loop alive on those skips has to stay cheap.

**Cancellable on exit.** The timers are `unref()`'d and never hold the process open, but the children they spawn do. `npm install -g` (120s cap) and `npm view` (10s) are bound to a session abort signal registered with `gracefulShutdown`, so Ctrl+C cancels the in-flight child and lets the event loop drain. Without it the process waited out the 5s shutdown failsafe and then hard-exited, orphaning the installer mid-write.

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
| `src/cli/updateOcc.ts` | Version check and npm/Bun update flow for `occ update`; exports the detection and silent-installation functions reused by background updates |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | Silent background automatic-update service for occ (periodic scheduling, gates, and installation orchestration) |
| `src/services/autoUpdate/updateNotifier.ts` | Registry that delivers successful-update notices to the REPL notification queue |
| `src/services/autoUpdate/backgroundPluginUpdate.ts` | Periodic background update service for plugin marketplaces (`git pull` plus cache rematerialization) |
| `src/services/autoUpdate/pluginUpdateNotifier.ts` | Registry that delivers plugin-update notices to the REPL notification queue |
| `src/main.tsx` | Registers the root `occ update` command |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | Background self-update loop; must not connect to the official native downloader or package name |
| `src/utils/nativeInstaller/` | Inherited, non-public native installer implementation; not an occ distribution channel |
| `scripts/release.ts` | `bun run release <version>`: synchronizes version sources, runs release gates, commits, and creates the tag |
| `src/utils/update/releaseNotes.ts` | Fetches and parses `CHANGELOG.md` to drive the in-app “What's New” notice |
