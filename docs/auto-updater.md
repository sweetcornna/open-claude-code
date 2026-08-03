# 自动更新

## 当前策略

Open Claude Code 通过 npm 包 `@sweetcornna/open-claude-code` 发布（无 scope 的 `open-claude-code` 已被第三方占位包占用）。当前受支持的更新入口是：

```bash
occ update
```

该命令只检查并更新 Open Claude Code 自己，不会安装、卸载或覆盖 Anthropic 官方 Claude Code。

官方 CLI 与 occ 可以并存：

| 产品 | 命令 | npm 包 | 用户配置 |
|---|---|---|---|
| Open Claude Code | `occ` / `occ-bun` | `@sweetcornna/open-claude-code` | `~/.occ/`、`~/.occ.json` |
| Anthropic Claude Code | `claude` | `@anthropic-ai/claude-code` | `~/.claude/`、`~/.claude.json` |

## 安装与手动更新

使用 npm 安装或更新：

```bash
npm install -g @sweetcornna/open-claude-code
occ update
```

使用 Bun 安装或更新：

```bash
bun install -g @sweetcornna/open-claude-code
occ-bun update
```

也可以绕过自动检测，直接运行对应包管理器命令：

```bash
npm install -g @sweetcornna/open-claude-code@latest
# 或
bun install -g @sweetcornna/open-claude-code@latest
```

## `occ update` 的执行流程

实现位于 `src/cli/updateOcc.ts`，流程如下：

1. 读取当前版本。
2. 从 npm registry 查询 `@sweetcornna/open-claude-code@latest`。
3. 如果当前版本已是最新版本，则直接退出。
4. 检测当前安装是否位于 Bun 的全局安装目录。
5. Bun 全局安装使用 `bun install -g @sweetcornna/open-claude-code@latest`；其他安装使用 `npm install -g @sweetcornna/open-claude-code@latest`。
6. 更新失败时打印等价的手动恢复命令。

包名来自 `src/constants/brand.ts` 的 `NPM_PACKAGE_NAME`，不是在更新器中重复维护的字符串。

## 与官方原生安装器的隔离

仓库保留了一部分从上游恢复的原生安装器实现，供代码研究和后续独立发行基础设施建设参考。它所指向的是 Anthropic 的官方二进制分发渠道，不是 Open Claude Code 的发布渠道，因此 **不属于 occ 当前支持的安装方式**。

为保证两个产品互不干扰：

- 根命令不注册 `occ install [target]` 原生安装入口。
- occ 的更新入口不会下载 Anthropic 官方二进制。
- occ 不会卸载 `@anthropic-ai/claude-code`。
- occ 不会删除或替换 `claude` 命令。
- occ 不会把 `~/.claude` 当作自己的可写安装目录。

不要通过手工调用 `src/utils/nativeInstaller/` 下的内部函数安装 occ；这些函数不是稳定的公共接口。

## 后台静默自动更新

交互式会话在启动后约 5 分钟自动做一次后台版本检查（每会话至多一次），发现新版本时静默执行全局安装，成功后在 REPL 底部显示一条低调提示（`✓ Updated to vX.Y.Z · Restart to apply`），失败只写调试日志、绝不打断会话。实现是无 React 依赖的服务模块 `src/services/autoUpdate/backgroundOccUpdate.ts`，由 `src/cli/program/rootAction.tsx` 在交互路径（`--print` 提前返回之后）动态 import 并调度；UI 提示通过 `src/services/autoUpdate/updateNotifier.ts` 注册表送入 REPL 通知队列（与 `setEnvHookNotifier` 同模式）。

以下任一条件成立时完全不跑：

- `globalConfig.autoUpdates === false`（`~/.occ.json`）
- 环境变量 `DISABLE_AUTOUPDATER` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- `NODE_ENV=test/development`
- 当前运行副本不是全局安装：npm 全局安装（doctorDiagnostic 判定为 `npm-global`）走 `npm install -g`，入口脚本位于 `~/.bun/install/global` 树内走 `bun install -g`；源码 checkout、`npm-local`、Homebrew 等包管理器安装一律跳过

安装命令复用 `occ update` 的链路（`src/cli/updateOcc.ts` 的版本查询与 `installOccGloballySilent`，输出捕获而非透传），并与 `installGlobalPackage()` 共享 `.update.lock` 跨进程锁。

`src/components/AutoUpdaterWrapper.tsx` 中继承的组件式更新路由仍未挂载，也不再路由到 `NativeAutoUpdater`。在 occ 建立自己的签名二进制发布源之前，不应重新接通继承的原生下载器或官方包管理器更新提示；显式 `occ update` 仍然是手动更新入口。

## 开发版本

源码工作区应通过 Git 和依赖安装更新，而不是依赖全局 CLI 更新当前 checkout：

```bash
git pull
bun install
bun run precheck
```

需要验证发布产物时运行：

```bash
bun run build:vite
node dist/cli-node.js --version
bun dist/cli-bun.js --version
```

## 发布侧（维护者）

用户看到的新版本从哪来：维护者跑 `bun run release <version>`，它同时改齐 `package.json`、`CHANGELOG.md` 并打 `v<version>` tag，push tag 后由 `publish-npm.yml` 发 npm 与 GitHub Release。完整步骤与约束见 [`CONTRIBUTING.md` 的「发布流程」](../CONTRIBUTING.md#11-发布流程)。

occ 启动时显示的「更新说明」来自本仓库 `main` 分支的 `CHANGELOG.md`（`src/utils/update/releaseNotes.ts` 拉取原始文件并缓存到 occ 配置目录下的 `cache/changelog.md`），所以发布提交必须先到 main，用户才看得到对应条目。

## 故障排查

如果 `occ update` 无法访问 npm registry，可直接检查包版本：

```bash
npm view @sweetcornna/open-claude-code@latest version
```

如果全局安装缺少写权限，修复 npm/Bun 的用户级全局目录配置；不要通过删除 `~/.claude`、卸载官方 Claude Code 或覆盖 `claude` 命令来解决。

更新后可确认两个命令仍彼此独立：

```bash
occ --version
claude --version
```

未安装官方 Claude Code 时，第二条命令不存在是正常情况。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/constants/brand.ts` | occ 命令名和 npm 包名的唯一真源 |
| `src/cli/updateOcc.ts` | `occ update` 的版本检查与 npm/Bun 更新流程；导出后台更新复用的检测与静默安装函数 |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | 后台静默自动更新服务（调度、门禁、安装编排） |
| `src/services/autoUpdate/updateNotifier.ts` | 更新成功提示进入 REPL 通知队列的注册表 |
| `src/main.tsx` | 注册 `occ update` 根命令 |
| `src/components/AutoUpdaterWrapper.tsx` | 未挂载的后台更新路由；不得连接官方原生下载器 |
| `src/utils/nativeInstaller/` | 继承的非公共原生安装器实现，不是 occ 发布渠道 |
| `scripts/release.ts` | `bun run release <version>`：版本源改齐、跑发布门禁、提交打 tag |
| `src/utils/update/releaseNotes.ts` | 拉取并解析 `CHANGELOG.md`，驱动应用内「更新说明」 |
