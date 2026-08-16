<!-- lang-switcher -->
[English](/docs/en/features/daemon) · **中文** · [日本語](/docs/ja/features/daemon)

# DAEMON — 后台守护进程

> Feature Flag: `FEATURE_DAEMON=1`
> 实现状态：Supervisor 和 remoteControl Worker 已实现
> 引用数：3

## 一、功能概述

DAEMON 将 occ 变为后台守护进程。主进程（supervisor）管理多个 worker 子进程的生命周期，通过文件系统状态文件进行通信。

> **当前注册了 `remoteControl` supervisor worker。** 它通过 `runBridgeHeadless()` 连接官方端点或自托管 RCS，接收远程 session，并由 supervisor 负责崩溃重启、指数退避和永久错误 parking。后台会话子命令（`daemon bg` / `attach` / `logs` / `kill`，由 `BG_SESSIONS` 门控）与该 worker 独立。

## 二、实现架构

### 2.1 模块状态

| 模块 | 文件 | 状态 |
|------|------|------|
| 守护主进程 | `src/daemon/main.ts` | **已实现** — Supervisor 含子命令、Worker 生命周期管理、指数退避重启 |
| Worker 注册 | `src/daemon/workerRegistry.ts` | **已实现** — 注册 `remoteControl` 并运行 `runBridgeHeadless()` |
| Daemon 状态 | `src/daemon/state.ts` | **已实现** — PID/状态文件的读写与查询 |
| CLI 路由 | `src/entrypoints/cli.tsx` | **布线** — `--daemon-worker` 和 `daemon` 子命令 |
| 命令注册 | `src/commands.ts` | **布线** — DAEMON 门控 |

### 2.2 CLI 入口

```
# 启动守护进程
occ daemon start

# 查看状态（默认子命令）
occ daemon status
occ daemon ps

# 停止守护进程
occ daemon stop

# 以 worker 身份启动（由 supervisor 自动调用）
occ --daemon-worker=remoteControl

# 后台会话管理
occ daemon bg
occ daemon attach <session>
occ daemon logs <session>
occ daemon stop <session>    # 优雅停止（SIGTERM，不升级），对话保留可 resume
occ daemon kill <session>    # 强制（SIGTERM → 2s → SIGKILL）
occ daemon rm <session>      # 删除已停止会话的 job 记录与受管日志

# 终态动词也有顶层写法（与官方 CLI 对齐）
occ stop <session>
occ rm <session>
```

> `daemon stop` 按参数个数分流：**不带参数**停 supervisor（历史语义不变），
> **带参数**停那个后台会话。顶层 `occ stop <id>` 直接走会话分支，不经过
> supervisor。`occ respawn` 尚未实现（Phase 3），命中时会打印替代做法。

### 2.3 架构

```
Supervisor (daemonMain)
      │
      ├── Worker: remoteControl
      │   └── runBridgeHeadless() — 远程控制 headless 模式
      │       接收远程会话、处理消息、权限审批
      │
      ▼
文件系统状态文件 (daemon-state.json)
  - PID、CWD、启动时间、Worker 类型
  - queryDaemonStatus() / stopDaemonByPid()
```

### 2.4 Worker 生命周期管理

Supervisor 为每个 worker 实现：
- **指数退避重启**：初始 2s，上限 120s，倍数 ×2
- **快速失败检测**：10s 内连续崩溃 5 次则 parking（不再重启）
- **永久错误退出码**：78 (EXIT_CODE_PERMANENT) 导致直接 parking
- **优雅关闭**：SIGTERM/SIGINT → abort signal → 30s 强制 SIGKILL

### 2.5 注册新的 worker

在 `src/daemon/workerRegistry.ts` 的 `DAEMON_WORKER_KINDS` 里加上 kind 名，并在 `runDaemonWorker()` 里处理它。supervisor 会按这个列表 spawn `occ --daemon-worker=<kind>`，其余（退避、parking、优雅关闭、状态文件）自动生效。

## 三、关键设计决策

1. **多进程架构**：一个 supervisor + 多个 worker，进程隔离
2. **文件系统状态通信**：通过 `daemon-state.json` 文件进行状态共享（非 Unix 域套接字）
3. **worker 与 supervisor 解耦**：worker kind 是一张可扩展的注册表，supervisor 不认识任何具体 worker
4. **CLI 子命令路由**：`daemon` 子命令和 `--daemon-worker` 参数在 `cli.tsx` 中路由
5. **Worker 环境变量**：supervisor 通过环境变量（`DAEMON_WORKER_*`）向 worker 传递配置

## 四、使用方式

```bash
# 启用守护进程模式
FEATURE_DAEMON=1 bun run dev

# 启动守护进程
occ daemon start

# 查看状态
occ daemon status

# 停止守护进程
occ daemon stop

# 以特定 worker 启动（通常由 supervisor 自动调用）
occ --daemon-worker=remoteControl
```

## 五、文件索引

| 文件 | 职责 |
|------|------|
| `src/daemon/main.ts` | Supervisor 主进程：子命令分发、Worker 生命周期管理、退避重启 |
| `src/daemon/workerRegistry.ts` | Worker 入口：remoteControl worker 实现 |
| `src/daemon/state.ts` | Daemon 状态管理：PID 文件读写、状态查询 |
| `src/entrypoints/cli.tsx` | CLI 路由 |
| `src/commands.ts` | 命令注册（双重门控） |
