<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/daemon) · [日本語](/docs/ja/features/daemon)

# DAEMON — Background Daemon Process

> Feature Flag: `FEATURE_DAEMON=1`
> Implementation status: the Supervisor and remoteControl Worker are implemented
> References: 3

## I. Feature Overview

DAEMON runs occ as a background daemon. The main process, the supervisor, manages the lifecycle of multiple worker child processes and communicates through filesystem state files.

> **The `remoteControl` supervisor worker is registered.** It uses `runBridgeHeadless()` to connect to the official endpoint or a self-hosted RCS and accept remote sessions. The supervisor owns crash restarts, exponential backoff, and permanent-error parking. Background-session subcommands (`daemon bg` / `attach` / `logs` / `kill`), gated by `BG_SESSIONS`, remain independent of this worker.

## II. Implementation Architecture

### 2.1 Module Status

| Module | File | Status |
|------|------|------|
| Daemon main process | `src/daemon/main.ts` | **Implemented** — Supervisor with subcommands, Worker lifecycle management, and exponential-backoff restarts |
| Worker registration | `src/daemon/workerRegistry.ts` | **Implemented** — registers `remoteControl` and runs `runBridgeHeadless()` |
| Daemon state | `src/daemon/state.ts` | **Implemented** — reads, writes, and queries PID/state files |
| CLI routing | `src/entrypoints/cli.tsx` | **Wired** — `--daemon-worker` and the `daemon` subcommand |
| Command registration | `src/commands.ts` | **Wired** — DAEMON gating |

### 2.2 CLI Entry Points

```
# Start the daemon
occ daemon start

# Show status (default subcommand)
occ daemon status
occ daemon ps

# Stop the daemon
occ daemon stop

# Start as a worker (invoked automatically by the supervisor)
occ --daemon-worker=remoteControl

# Manage background sessions
occ daemon bg
occ daemon attach <session>
occ daemon logs <session>
occ daemon kill <session>
```

### 2.3 Architecture

```
Supervisor (daemonMain)
      │
      ├── Worker: remoteControl
      │   └── runBridgeHeadless() — remote-control headless mode
      │       Receive remote sessions, process messages, approve permissions
      │
      ▼
Filesystem state file (daemon-state.json)
  - PID, CWD, start time, Worker type
  - queryDaemonStatus() / stopDaemonByPid()
```

### 2.4 Worker Lifecycle Management

The Supervisor provides the following behavior for every worker:
- **Exponential-backoff restart**: starts at 2s, capped at 120s, multiplier ×2
- **Rapid-failure detection**: 5 consecutive crashes within 10s cause parking, with no further restarts
- **Permanent-error exit code**: 78 (EXIT_CODE_PERMANENT) causes immediate parking
- **Graceful shutdown**: SIGTERM/SIGINT → abort signal → forced SIGKILL after 30s

### 2.5 Registering a New Worker

Add the kind name to `DAEMON_WORKER_KINDS` in `src/daemon/workerRegistry.ts`, then handle it in `runDaemonWorker()`. The supervisor spawns `occ --daemon-worker=<kind>` for each entry in that list. Backoff, parking, graceful shutdown, and state-file handling then apply automatically.

## III. Key Design Decisions

1. **Multi-process architecture**: one supervisor plus multiple workers provides process isolation
2. **Filesystem state communication**: processes share state through `daemon-state.json`, not a Unix domain socket
3. **Worker-supervisor decoupling**: worker kinds live in an extensible registry, and the supervisor has no knowledge of specific workers
4. **CLI subcommand routing**: `cli.tsx` routes both the `daemon` subcommand and the `--daemon-worker` argument
5. **Worker environment variables**: the supervisor passes configuration to workers through `DAEMON_WORKER_*` environment variables

## IV. Usage

```bash
# Enable daemon mode
FEATURE_DAEMON=1 bun run dev

# Start the daemon
occ daemon start

# Show status
occ daemon status

# Stop the daemon
occ daemon stop

# Start as a specific worker (normally invoked automatically by the supervisor)
occ --daemon-worker=remoteControl
```

## V. File Index

| File | Responsibility |
|------|------|
| `src/daemon/main.ts` | Supervisor main process: subcommand dispatch, Worker lifecycle management, backoff restarts |
| `src/daemon/workerRegistry.ts` | Worker entry point: remoteControl worker implementation |
| `src/daemon/state.ts` | Daemon state management: PID file I/O and status queries |
| `src/entrypoints/cli.tsx` | CLI routing |
| `src/commands.ts` | Command registration (two gates) |
