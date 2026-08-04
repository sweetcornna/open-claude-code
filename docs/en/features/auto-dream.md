<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/auto-dream) · [日本語](/docs/ja/features/auto-dream)

# Auto Dream — Automatic Memory Consolidation

## Overview

Auto Dream is Claude Code's background memory-consolidation mechanism. Between sessions, it automatically reviews, organizes, and prunes persistent memory files so that future sessions can acquire accurate context quickly.

The memory system is stored on the file system (by default at `~/.occ/projects/<project-slug>/memory/`) and consists of a `MEMORY.md` index plus topic files such as `user_language.md` and `project_overview.md`. As sessions accumulate, memories can become stale, redundant, or contradictory. Dream consolidates and cleans up this accumulated state.

## Architecture

### Core modules

| Module | Path | Responsibility |
|------|------|------|
| Scheduler | `src/services/autoDream/autoDream.ts` | Applies time/session/lock gates and launches a forked agent |
| Configuration | `src/services/autoDream/config.ts` | Reads the `isAutoDreamEnabled()` setting |
| Prompt | `src/services/autoDream/consolidationPrompt.ts` | Builds the four-phase consolidation prompt |
| Lock file | `src/services/autoDream/consolidationLock.ts` | PID lock with mtime serving as `lastConsolidatedAt` |
| Task UI | `src/tasks/DreamTask/DreamTask.ts` | Registers the background task, visible through the footer pill and Shift+Down |
| Manual entry point | `src/skills/bundled/dream.ts` | `/dream` command, always available |

### Memory path resolution

Precedence (`src/memdir/paths.ts`):

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` environment variable, which overrides the entire path
2. `autoMemoryDirectory` setting in `settings.json`, with `~/` expansion
3. Default: `<memoryBase>/projects/<sanitized-git-root>/memory/`

Here, `memoryBase` is `CLAUDE_CODE_REMOTE_MEMORY_DIR` or `~/.occ`.

## Trigger mechanism

### Automatic trigger (Auto Dream)

At the end of each conversation turn, `executeAutoDream()` checks three gates in order:

```
┌─────────────────────────────────────────────────────┐
│  Gate 1: global settings                            │
│  isAutoMemoryEnabled() && isAutoDreamEnabled()      │
│  Excludes: KAIROS mode / Remote mode                │
├─────────────────────────────────────────────────────┤
│  Gate 2: time                                       │
│  hoursSince(lastConsolidatedAt) >= minHours         │
│  Default: 24 hours                                  │
├─────────────────────────────────────────────────────┤
│  Gate 3: sessions                                   │
│  sessionsTouchedSince(lastConsolidatedAt) >= minSessions │
│  Default: 5 sessions (excluding the current one)    │
├─────────────────────────────────────────────────────┤
│  Lock: PID lock file                                │
│  .consolidate-lock (mtime = lastConsolidatedAt)     │
│  Dead-process detection + 1-hour expiry             │
└─────────────────────────────────────────────────────┘
```

After all gates pass, the consolidation task runs as a **forked agent** with restricted capabilities:

- The Bash tool is limited to read-only commands such as `ls`, `grep`, and `cat`
- It may read and write files only within the memory directory
- The user can inspect progress or terminate the task in the Shift+Down background-task panel

### Manual trigger (`/dream` command)

The `/dream` command triggers consolidation at any time without applying the gates:

- It runs in the main loop rather than as a forked agent and has full tool permissions
- The user can observe operations in real time
- It updates the lock file's mtime automatically before execution

### Configuration settings

| Setting | Location | Effect |
|------|------|------|
| `autoDreamEnabled` | `settings.json` | Explicit `true`/`false` setting |
| `autoMemoryEnabled` | `settings.json` | Master setting; disabling it disables all memory features |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Environment variable | `1`/`true` disables all memory features |
| `tengu_onyx_plover` | GrowthBook | Official remote configuration controlling `enabled`/`minHours`/`minSessions` |

Defaults when GrowthBook is unavailable:

```typescript
minHours: 24      // at least 24 hours since the previous consolidation
minSessions: 5    // at least 5 new sessions
```

## Consolidation process (four phases)

The prompt executed by the Dream agent contains four phases:

### Phase 1 — Orient

- Run `ls` on the memory directory to inspect existing files
- Read the `MEMORY.md` index
- Review existing topic files to avoid creating duplicates

### Phase 2 — Gather

Collect new information in this priority order:

1. **Log files** (`logs/YYYY/MM/YYYY-MM-DD.md`, append-only logs in KAIROS mode)
2. **Stale memories** — facts that contradict the current codebase state
3. **Session records** — grep JSONL files with narrow keywords rather than reading them in full

### Phase 3 — Consolidate

- Merge new signals into existing topic files instead of creating near-duplicates
- Convert relative dates such as "yesterday" and "last week" to absolute dates
- Remove disproven facts

### Phase 4 — Prune and index

- Keep `MEMORY.md` within 200 lines and 25KB
- Keep each index entry on one line and within 150 characters
- Remove stale, incorrect, or superseded pointers

## Memory types

The memory system uses four types (`src/memdir/memoryTypes.ts`):

| Type | Purpose | Example |
|------|------|------|
| `user` | User role, preferences, and knowledge | The user is a senior backend engineer and prefers communicating in Chinese |
| `feedback` | Guidance about working methods | Do not mock database tests; use bundled PR for code review |
| `project` | Project context that cannot be derived from code | The merge freeze starts on March 5; the authentication rewrite is a compliance requirement |
| `reference` | Pointer to an external system | The Linear INGEST project tracks pipeline bugs |

**Content not stored**: code patterns, architecture, or file paths that can be derived from the code; Git history, for which `git log` is authoritative; debugging approaches already captured in the code.

## Lock-file mechanism

The `.consolidate-lock` file resides in the memory directory:

- **File contents**: the holder's PID
- **mtime**: the `lastConsolidatedAt` timestamp
- **Expiry**: 1 hour, to guard against PID reuse
- **Race handling**: when two processes write concurrently, each verifies the PID by reading it back, and the loser exits
- **Rollback**: if the forked agent fails or the user terminates it, mtime is restored to its value before lock acquisition

## Use cases

### Use case 1: automatic consolidation during daily development

A developer uses Claude Code for different tasks across multiple days. After at least 5 sessions have accumulated and 24 hours have passed since the previous consolidation, Auto Dream triggers automatically and combines user preferences and project decisions scattered across those sessions.

### Use case 2: manual memory consolidation

The user notices that Claude repeatedly makes the same mistake or forgets a prior decision. Entering `/dream` triggers consolidation immediately without waiting for the automatic trigger interval.

### Use case 3: fast context in a new session

At the start of a new session, `MEMORY.md` is loaded into the context. Memory files consolidated by Dream have clear structure and accurate information, allowing Claude to understand the user and project quickly.

### Use case 4: log distillation in KAIROS mode

In KAIROS, the persistent-assistant mode, the agent appends to dated log files. Dream distills these logs into topic files and the `MEMORY.md` index.

## Relationship to other systems

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│ Session     │────▶│ Memory write │────▶│ MEMORY.md     │
│ (main agent)│     │ (immediate)  │     │ + topic files │
└─────────────┘     └──────────────┘     └───────┬───────┘
                                               │
       ┌───────────────────────────────────────┘
       ▼
┌──────────────┐     ┌──────────────┐
│ Auto Dream   │────▶│ Consolidate  │
│ (background) │     │ prune/dedupe │
└──────────────┘     └──────────────┘
       ▲
┌──────────────┐
│ /dream       │
│ (manual)     │
└──────────────┘
```

- **extractMemories** (`src/services/extractMemories/`): extracts new memories from the conversation at the end of each turn and writes them. Dream does not extract; it only consolidates.
- **CLAUDE.md**: project-level instruction file loaded into context but not part of the memory system.
