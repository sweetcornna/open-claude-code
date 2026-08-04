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

Approximately five minutes after an interactive session starts, occ performs one background version check (at most once per session). If it finds a new version, it silently performs a global installation. On success, the REPL displays a subdued notice at the bottom (`✓ Updated to vX.Y.Z · Restart to apply`). On failure, it writes only to the debug log and never interrupts the session. The implementation is the React-independent service module `src/services/autoUpdate/backgroundOccUpdate.ts`. `src/cli/program/rootAction.tsx` dynamically imports and schedules it on the interactive path (after the early return for `--print`). The UI notice enters the REPL notification queue through the registry in `src/services/autoUpdate/updateNotifier.ts` (the same pattern as `setEnvHookNotifier`).

The check does not run when any of the following conditions applies:

- `globalConfig.autoUpdates === false` (`~/.occ.json`)
- The `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` environment variable is set
- `NODE_ENV=test/development`
- The current copy is not installed globally: an npm global installation (classified as `npm-global` by doctorDiagnostic) uses `npm install -g`; an entry script under the `~/.bun/install/global` tree uses `bun install -g`; a source checkout, `npm-local` installation, Homebrew installation, or installation from any other package manager is skipped

The installation command reuses the `occ update` path (the version query and `installOccGloballySilent` from `src/cli/updateOcc.ts`, with output captured rather than passed through) and shares the cross-process `.update.lock` with `installGlobalPackage()`.

The inherited component-based update route in `src/components/AutoUpdaterWrapper.tsx` remains unmounted and no longer routes to `NativeAutoUpdater`. Do not reconnect the inherited native downloader or the official package-manager update prompt until occ has its own signed binary distribution source. Explicit `occ update` remains the manual update entry point.

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
| `src/services/autoUpdate/backgroundOccUpdate.ts` | Silent background automatic-update service (scheduling, gates, and installation orchestration) |
| `src/services/autoUpdate/updateNotifier.ts` | Registry that delivers successful-update notices to the REPL notification queue |
| `src/main.tsx` | Registers the root `occ update` command |
| `src/components/AutoUpdaterWrapper.tsx` | Unmounted background update route; must not connect to the official native downloader |
| `src/utils/nativeInstaller/` | Inherited, non-public native installer implementation; not an occ distribution channel |
| `scripts/release.ts` | `bun run release <version>`: synchronizes version sources, runs release gates, commits, and creates the tag |
| `src/utils/update/releaseNotes.ts` | Fetches and parses `CHANGELOG.md` to drive the in-app “What's New” notice |
