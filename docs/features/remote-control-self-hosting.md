# Remote Control（基于 Happy over ACP）

occ 不再自带远程控制的传输层。它自带的是一个 **ACP agent**（`occ --acp`），客户端那一半交给 [Happy](https://github.com/slopus/happy)（MIT）——手机 App、Web 界面、端到端加密，以及一个可以自托管的中继服务。

```
┌─────────────────┐        E2E 加密        ┌──────────────┐      ACP over stdio      ┌─────────────┐
│  Happy 手机 App  │ ◄──────────────────► │ Happy Server │ ◄──────────────────────► │ occ --acp   │
│  / Happy Web    │                       │ (可自托管)    │                          │ (你的机器)   │
└─────────────────┘                       └──────────────┘                          └─────────────┘
```

occ 只负责一件事：把自己作为 ACP agent 交给 Happy。会话、推送、加密、多设备同步都是 Happy 的职责。

## 快速开始

```bash
# 1. 安装 Happy CLI
npm install -g happy-coder

# 2. 在项目目录里启动
occ remote-control
```

`occ remote-control` 会在 PATH 上找到 `happy`，然后执行等价于：

```bash
happy acp -- <occ 二进制> --acp
```

occ 那一半的命令行由 `buildCliLaunch()` 推导（和 daemon、后台会话、tmux 重启用的是同一套引导约定），所以打包安装和源码安装都能正确地重新调用自己。当前工作目录会原样传给 Happy，agent 因此看到的是你的项目。

别名：`occ rc`、`occ remote`、`occ sync`、`occ bridge` 都指向同一个命令。传给它的额外参数会转发给 `happy acp`（放在 `--` 之前）。

如果 `happy` 不在 PATH 上，occ 会打印安装指引、自托管提示，以及"编辑器可以直接走 ACP"的说明，然后以退出码 1 结束。

## 自托管

Happy 服务端可以自己部署，把 `HAPPY_SERVER_URL` 指向它即可，之后不会有流量经过官方中继：

```bash
export HAPPY_SERVER_URL=https://happy.example.com
occ remote-control
```

部署方式见 Happy 上游仓库。occ 这边不需要任何额外配置 —— 它只是被 Happy 拉起的一个子进程。

`occ autonomy status --deep` 的 **Remote Control** 段会显示当前状态：`happy` 是否可用、用的是自托管还是官方中继、agent 命令是什么。

## 编辑器直连（不需要 Happy）

支持 ACP 的编辑器（Zed、JetBrains 系）不需要 Happy，直接把 occ 当 agent 启动就行：

```json
{
  "agent_servers": {
    "occ": { "type": "custom", "command": "occ", "args": ["--acp"] }
  }
}
```

配置细节见 [ACP / Zed 集成文档](./acp-zed.md)。Happy 解决的是"人不在电脑前"的问题，编辑器集成解决的是"人在电脑前但想用编辑器 UI"的问题，两者用的是同一个 agent。

## 从旧版迁移

### 原来用自托管 Remote Control Server 的

`packages/remote-control-server/` 已经删除，`bun run rcs` 脚本、`.github/workflows/release-rcs.yml` 发布流程也一并移除。

- **已发布的 GHCR 镜像 `ghcr.io/<owner>/remote-control-server` 仍然可以拉取，但已冻结归档，不会再有新版本。** 旧版 occ 配合旧镜像可以继续跑，但不会再收到修复。
- 新的等价物是自托管的 Happy 服务端（`HAPPY_SERVER_URL`），它同时提供中继、Web UI 和手机端，并且是端到端加密的 —— RCS 不是。
- 旧的 `remoteControlAtStartup` 配置项、`--remote-control` / `--rc` 启动参数，以及 `/bridge`、`/remote-control-server`、`/bridge-kick` 斜杠命令都已删除。想要远程控制就显式跑 `occ remote-control`。

### 原来用 `acp-link` CLI 的

`packages/acp-link/` 已经删除。它做的两件事 —— 把 WebSocket 客户端桥接到 ACP agent、向 RCS 注册 —— 正好是 Happy 提供的能力。

| 旧写法 | 新写法 |
| --- | --- |
| `acp-link occ-bun -- --acp` | `occ remote-control`（即 `happy acp -- occ --acp`） |
| `ACP_RCS_URL=... ACP_RCS_TOKEN=... acp-link ...` | `HAPPY_SERVER_URL=... occ remote-control` |
| `acp-link <其他 agent> -- <args>` | `happy acp -- <其他 agent> <args>` |

最后一行值得单独说：`happy acp` 接受任意 ACP agent，不只是 occ。acp-link 里"通用代理"那部分能力在 Happy 里是完整保留的。

## 组织策略

`allow_remote_control` 策略仍然生效，并且在拉起 Happy **之前**检查。被组织策略禁用时 `occ remote-control` 会直接报错退出，无论传输层是谁。

## 相关

- Happy 上游：https://github.com/slopus/happy
- ACP agent 实现：`src/services/acp/`
- 启动器实现：`src/cli/remoteControlLauncher.ts`
