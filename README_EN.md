# Open Claude Code (occ)

[![GitHub Stars](https://img.shields.io/github/stars/sweetcornna/open-claude-code?style=flat-square&logo=github&color=yellow)](https://github.com/sweetcornna/open-claude-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/sweetcornna/open-claude-code?style=flat-square&color=orange)](https://github.com/sweetcornna/open-claude-code/issues)
[![Last Commit](https://img.shields.io/github/last-commit/sweetcornna/open-claude-code?style=flat-square&color=blue)](https://github.com/sweetcornna/open-claude-code/commits/main)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)

> An open-source terminal AI coding assistant that coexists with official Claude Code.

[中文文档](./README.md)

**open-claude-code** (`occ`) is a full restoration of Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code), extended with Goal-driven execution, multi-agent orchestration, Artifacts and ACP support — and **fully isolated from official Claude Code**, so both can be installed on the same machine without interfering.

## Isolation from official Claude Code

This is the main difference from other forks. Before isolation, the fork shared `~/.claude`, `~/.claude.json`, the cache tree — **and the same macOS keychain entry**, so signing in to either CLI overwrote the other's OAuth token. Now they are separate:

| | open-claude-code | Official Claude Code |
| --- | --- | --- |
| User config | `~/.occ/` | `~/.claude/` |
| Global state | `~/.occ.json` | `~/.claude.json` |
| Project assets | `.occ/` | `.claude/` |
| Cache | `~/.cache/occ-nodejs/` | `~/.cache/claude-cli-nodejs/` |
| Credentials (macOS) | `Open Claude Code-credentials-<hash>` | `Claude Code-credentials` |
| Enterprise policy | `/etc/occ`, `win.open-claude-code.occ` | `/etc/claude-code`, `com.anthropic.claudecode` |
| Env override | `OCC_CONFIG_DIR` | `CLAUDE_CONFIG_DIR` (still honoured) |

**Deliberately shared:** the `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` memory filenames are unchanged, because they are a cross-tool convention and renaming them would lose context in every existing repository. Child processes still receive `CLAUDECODE=1` (many user hook scripts gate on it) plus `OCC=1`. IDE lockfiles are searched in both roots, since the marketplace extension is Anthropic's and writes to `~/.claude/ide`.

### Migrating from official Claude Code

```sh
occ migrate --dry-run   # show what would be copied
occ migrate             # do it
```

Copies settings, skills, agents, commands, output-styles, workflows, plugins, rules and MCP server definitions.

**Credentials and session history are never copied.** Credentials are shared with the official CLI, so copying them would reintroduce exactly the coupling being removed — run `/login` once instead. `~/.claude` is read-only throughout: nothing is written, moved or deleted there.

## Quick start (published package)

```sh
npm i -g open-claude-code

occ           # run on Node.js
occ-bun       # run on Bun
occ update    # update to the latest version
```

> The pre-2.8 `ccb` / `ccb-bun` names have been removed — scripts still calling them must switch to `occ` / `occ-bun`.

## Quick start (from source)

### Requirements

Use the latest Bun — older versions cause a lot of strange bugs.

- [Bun](https://bun.sh/) >= 1.3.11

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Already installed
bun upgrade
```

### Install and run

```bash
cd /path/to/open-claude-code
bun install

bun run dev      # development mode
bun run build    # build
```

The build uses code splitting; output lands in `dist/` and runs under both Bun and Node.js.

### First-time `/login`

Run `/login` in the REPL and pick **Anthropic Compatible** to use any third-party compatible service — no Anthropic account required. OpenAI, Gemini and Grok have their own sections.

| Field | Description | Example |
| --- | --- | --- |
| Base URL | API endpoint | `https://api.example.com/v1` |
| API Key | Auth key | `sk-xxx` |
| Haiku Model | Fast model ID | `claude-haiku-4-5-20251001` |
| Sonnet Model | Balanced model ID | `claude-sonnet-4-6` |
| Opus Model | High-capability model ID | `claude-opus-4-6` |

**Tab / Shift+Tab** moves between fields, **Enter** confirms; Enter on the last field saves.

## Features

| Feature | Description | Docs |
| --- | --- | --- |
| **Goal-driven execution** | `/goal <objective>` drives the agent across turns until done, with a token budget, completion/blocked audit and `pause`/`resume`/`continue`/`clear` | [`src/commands/goal/`](./src/commands/goal/) |
| **Ultracode multi-agent orchestration** | `/ultracode` plus the `Workflow` tool runs deterministic JS scripts (`agent`/`pipeline`/`parallel`/`phase`); `/workflows` gives a live panel, with journal replay and a concurrency cap | [docs](./docs/features/workflow-scripts.md) |
| **Artifacts** | The model uploads HTML/dashboards/reports to a public URL (7d/30d expiry). Cloudflare Worker + R2, self-hostable | [docs](./packages/cloud-artifacts/README.md) |
| **ACP protocol** | Connect Zed, Cursor and other IDEs, with session resume, Skills and permission bridging | [docs](./docs/features/acp-zed.md) |
| **Remote Control** | `occ remote-control` hands the session to [Happy](https://github.com/slopus/happy) (phone / web / end-to-end encrypted) over occ's own ACP agent; the server is self-hostable | [docs](./docs/features/remote-control-self-hosting.md) |
| **Langfuse monitoring** | Inspect every agent loop in detail, export to a dataset in one click | [docs](./docs/features/langfuse-monitoring.md) |
| **Web search** | Built-in search via Bing / Brave | [docs](./docs/features/web-browser-tool.md) |
| **Poor mode** | Disables memory extraction and typing suggestions to cut concurrent requests | `/poor` |
| **Channels** | MCP servers push external messages into the session (Feishu/Slack/Discord…) | [docs](./docs/features/channels.md) |
| **Custom providers** | OpenAI / Anthropic / Gemini / Grok compatible | [docs](./docs/features/all-features-guide.md) |
| Voice mode | Voice input, including Doubao (`/voice doubao`) | [docs](./docs/features/voice-mode.md) |
| Computer Use | Screenshots, keyboard and mouse control | [docs](./docs/features/computer-use.md) |
| **Chrome browser tools** | `occ --chrome` attaches Google's `chrome-devtools-mcp`: navigate, click, snapshot, console/network, performance traces. Anything that changes the page asks first | [docs](./docs/features/chrome-devtools-mcp.md) |
| Chrome Use (third-party) | A separate option: the `hangwin/mcp-chrome` extension | [docs](./docs/features/chrome-use-mcp.md) |
| `/dream` | Automatic memory consolidation | [docs](./docs/features/auto-dream.md) |

## Feature flags

Enable with `FEATURE_<FLAG_NAME>=1`:

```bash
FEATURE_BUDDY=1 FEATURE_FORK_SUBAGENT=1 bun run dev
```

The 34 flags on by default are in `DEFAULT_BUILD_FEATURES` in [`scripts/defines.ts`](./scripts/defines.ts); anything else needs the env var. Per-feature notes live in [`docs/features/`](./docs/features/).

## Debugging in VS Code

TUI (REPL) mode needs a real terminal, so use **attach mode**:

```bash
bun run dev:inspect     # prints ws://localhost:8888/xxxx
```

Set breakpoints under `src/`, then F5 → **"Attach to Bun (TUI debug)"**.

## Development

```bash
bun run precheck      # typecheck + lint fix + test — must pass with zero errors
bun run typecheck
bun run test
bun run build:vite
```

Architecture, the module map, the path/isolation invariants and the testing rules are in [`CLAUDE.md`](./CLAUDE.md) — **read it before touching any path-related code**.

## Acknowledgements

- [doubaoime-asr](https://github.com/starccy/doubaoime-asr) — Doubao ASR SDK, which gives Voice Mode a speech input path that needs no Anthropic OAuth

## License

This project is for study and research purposes only. All rights to Claude Code belong to [Anthropic](https://www.anthropic.com/).
