<!-- lang-switcher -->
[English](/docs/en/auto-updater) · **中文** · [日本語](/docs/ja/auto-updater)

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

交互式会话在启动 **1 分钟**后做第一次后台版本检查，此后**每 30 分钟周期检查一次**，直到会话结束。首查刻意靠前：紧跟在一次发布之后启动的会话不该等满一个周期才发现；但也不为零，启动是进程最忙的时刻，一次 `npm view` 会和用户真正在等的东西抢资源。发现新版本就**立刻装**：拿到跨进程更新锁后 spawn 一个 detached 的 `install -g` 子进程，会话本身不等它。REPL 底部显示一条低调提示（`✓ Update vX.Y.Z installing · restart to apply`）。失败只写调试日志、绝不打断会话。

**为什么以前不能立刻装。** occ 的产物被切成约 600 个内容哈希命名的 chunk（这是把 `--version` 的 RSS 从 966MB 压到 35MB 的原因，见 CLAUDE.md「不要把构建优化回单文件」），会话在整个生命周期里持续 `import()` 这些 chunk。而 `npm|bun install -g` 会**替换掉**整个包目录，相邻两个版本之间大约**半数 chunk 的文件名会变**（实测 2.21.0 → 2.22.0：595 个 chunk 里 299 个消失）。于是原地安装等于把正在运行的会话剩余一半的代码从磁盘上抹掉：之后任何一次惰性 import 都抛 `ERR_MODULE_NOT_FOUND`，症状不是崩溃而是**卡死** —— REPL 不再响应，Ctrl+C 也走不到退出路径。为此安装曾被推迟到「最后一个活会话退出」，而从用户视角这就是「自动更新坏了」：坐在会话里半小时，新版早已发布，什么也没发生。

**现在会话不再从被替换的那棵树上读代码。** 启动时入口脚本先把 `dist/` 的每个文件**硬链接**进 `<配置目录>/runtime/<版本>-<指纹>/dist`，再从那里 `import()` 真正的入口（`src/services/autoUpdate/runtimeFarm.ts`）。硬链接是关键：同一个 inode，包目录还在时不额外占盘；而 inode 的生命周期与「还有几个链接指向它」绑定，所以 `install -g` 删掉包目录之后，farm 里那份仍然存在、仍然可读。进程无法在启动后给自己换模块解析根（chunk 是相对导入它的模块解析的），所以这件事必须在入口脚本里、在加载第一个 chunk 之前、在同一个进程内完成。

热路径的代价是**两次 stat**：一次 `dist/cli.js`（取尺寸与 mtime 算指纹），一次 farm 入口（在不在）。不遍历目录、不做哈希。冷路径（一个版本第一次启动）多一次约 600 个文件的硬链接，实测 `--version` 从 0.04s 变成 0.17s，仅此一次。

**farm 建不出来就退回原来的行为。** 跨卷（EXDEV，Windows 上 npm 全局前缀在另一个盘很常见）先退回复制；复制也失败就直接从安装树运行 —— 也就是这次改造之前的样子，用户不损失任何东西，只是失去这层保护。`OCC_DISABLE_RUNTIME_FARM=1` 可显式关掉。

**farm 的回收。** 每个装过的版本留下一个 farm，包目录被替换之后那份 farm 就是那批 inode 仅剩的引用（约 30MB），不清理会一个版本攒一个。回收在 `src/services/autoUpdate/runtimeFarmGc.ts`，交互式会话启动 90 秒后跑一次：只删「没有任何活会话的 dist 根指向它」且「不是本进程正在跑的那个」且「创建超过 1 小时」的目录。最后一条挡的是「另一个会话刚建好 farm、还没来得及登记 live-session 租约」的窗口。活会话集合本身如果有任何一条读不出来，整轮直接跳过 —— 少回收一点磁盘，总好过删掉别人正在 import 的那棵树。

**多开互不影响，但同一时刻只有一个装。** 发现新版本后先拿 `~/.occ/.update.lock`；拿不到说明已经有进程在装，这一轮什么都不做。同一个版本在一个会话里不会装第二次；会话期间上游若再发更新的版本，下一轮检查会装那个并再提示一次。

**用户还是要重启才用得上新版。** 运行中的进程无法采用新版本，这一点没变 —— 变的只是「装完的时刻」从退出后提前到了发现的那一刻。

实现是无 React 依赖的服务模块 `src/services/autoUpdate/backgroundOccUpdate.ts`，由 `src/cli/program/rootAction.tsx` 在交互路径（`--print` 提前返回之后）动态 import 并调度；UI 提示通过 `src/services/autoUpdate/updateNotifier.ts` 注册表送入 REPL 通知队列（与 `setEnvHookNotifier` 同模式）。

以下任一条件成立时完全不跑：

- `globalConfig.autoUpdates === false`（`~/.occ.json`）
- 环境变量 `DISABLE_AUTOUPDATER` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
- `NODE_ENV=test/development`
- 当前运行副本不是全局安装：npm 全局安装（doctorDiagnostic 判定为 `npm-global`）走 `npm install -g`，入口脚本位于 `~/.bun/install/global` 树内走 `bun install -g`；源码 checkout、`npm-local`、Homebrew 等包管理器安装一律跳过

版本查询复用 `occ update` 的链路（`src/cli/updateOcc.ts` 的 `getLatestOccVersion` 与 `latestPackageSpec`，包名规格两条路径同源）。跨进程锁 `.update.lock` 只在**确认有新版本之后**才取（不然每轮空跑的检查都会留下一把 5 分钟的锁，饿死真正要装的那个会话）；子进程会活过我们，所以这把锁**故意不释放**，靠它 5 分钟的过期窗口充当安装窗口。spawn 失败才释放。

**跳过分两种。** 本进程内无法再变的条件（`NODE_ENV`、安装方式）会让循环直接退休，不再排下一轮；可以被用户中途改回来的条件（`autoUpdates` 配置、上面那两个环境变量）则继续按周期空转 —— 早先所有跳过都终结循环，于是会话中途用 `/config` 把自动更新打开根本不生效，必须重启。为此可逆的那几道门排在安装方式判定之前，那一步可能 spawn `npm config get prefix`，让循环活着的前提是这次检查必须足够便宜。

**退出时可中止。** 定时器是 `unref()` 的、从不吊住进程，但它 spawn 的子进程会。`npm view`（10 秒上限）绑定了会话中止信号（经 `registerCleanup` 挂在 `gracefulShutdown` 上），Ctrl+C 会取消在飞的子进程让事件循环自然排空；否则要等满 5 秒 failsafe 再硬退。安装器不需要这层处理：它是 detached + `unref()` 的，本来就不吊住事件循环。

**安装树被换掉时的兜底。** 正常情况下会话跑在 farm 里，这条路径已经打不到了。它保留下来是因为 farm 允许失败（跨卷、磁盘满、`OCC_DISABLE_RUNTIME_FARM=1`），那时会话回到安装树上，另一个终端里手工跑 `occ update` 或直接 `npm install -g` 仍然会把它换掉。`gracefulShutdown` 的 `uncaughtException` / `unhandledRejection` 处理器会识别这一种失败——错误码 `ERR_MODULE_NOT_FOUND`（Bun 下是 `ResolveMessage`）**且**路径落在 `<distRoot>/chunks` 内——然后打印一行说明并干净退出，而不是留下一个卡死、Ctrl+C 也没反应的界面。只认 chunk 路径是为了不误伤插件、MCP server 那些正常的解析失败；源码 checkout 根本没有 `dist/chunks`，所以开发时不会触发。

继承自官方的组件式更新路由（`AutoUpdaterWrapper` / `AutoUpdater` / `PackageManagerAutoUpdater` / `NativeAutoUpdater`）已随本节所述的服务化改造删除 —— 它们早已没有任何地方渲染。在 occ 建立自己的签名二进制发布源之前，不应重新接通继承的原生下载器或官方包管理器更新提示；显式 `occ update` 仍然是手动更新入口。

## 插件后台自动更新

已安装的插件 marketplace 走同一套周期调度，但起始时间与 occ 自更新**错开**：交互式会话启动 3 分钟后做第一次检查，此后同样每 30 分钟一轮。错开是为了避免两条链在同一时刻一起打网络——两条用同一个间隔，所以这个错位在整个会话期间都保持。

每一轮的动作：

1. 遍历已安装的 marketplace，只处理 git / github 类型的源；本地路径类 marketplace 不做任何网络操作。
2. 对每个源执行 `git pull`。
3. 只有 `git pull` 让仓库**真正发生移动**时，才重新物化对应的插件缓存；HEAD 没变的源不产生任何写入。
4. 有插件被更新时，在 REPL 底部提示，并说明需要运行 `/reload-plugins` 才能让新版本在当前会话生效（与 occ 自更新提示「重启生效」不同，插件不需要重启进程）。

关闭开关与 occ 自更新共用：`~/.occ.json` 的 `"autoUpdates": false`、环境变量 `DISABLE_AUTOUPDATER` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 任一生效，两条链都不跑。

跨进程锁是 `<plugins>/.plugin-update.lock`（插件根目录默认 `~/.occ/plugins`，可由 `OCC_PLUGIN_CACHE_DIR` 覆盖），与 occ 自更新的 `~/.occ/.update.lock` 是两把互相独立的锁，两条链不会互相阻塞。

实现是 `src/services/autoUpdate/backgroundPluginUpdate.ts`，提示经 `src/services/autoUpdate/pluginUpdateNotifier.ts` 注册表进入 REPL 通知队列。

## 检查间隔与跨实例节流

两条链的周期长度由同一个环境变量控制：

| 配置项 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| `OCC_UPDATE_CHECK_INTERVAL_MS` | 环境变量 | `1800000`（30 分钟） | 覆盖 occ 自更新与插件更新的周期检查间隔（两条链共用同一个值）。下限 `60000`（1 分钟）；非法值回落到默认值 |
| `lastBackgroundUpdateCheckAt` | `~/.occ.json` | — | occ 自更新上一次后台检查的时间戳，内部字段 |
| `lastBackgroundPluginUpdateCheckAt` | `~/.occ.json` | — | 插件上一次后台检查的时间戳，内部字段 |

两个时间戳是内部状态，不需要也不建议手工编辑。它们解决的是**跨会话、多开实例**的重复检查问题：occ 常被同时开好几个窗口，如果每个实例各按自己的节奏打点，npm registry 和 git 远端承受的请求量会按实例数翻倍。因此每轮检查前先读对应的时间戳，若距上次检查还不到一个间隔（说明另一个实例刚查过），本实例这一轮直接跳过，不发请求。

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

用户看到的新版本从哪来：维护者跑 `bun run release <version>`，它同时改齐 `package.json`、`CHANGELOG.md` 并打 `v<version>` tag，push tag 后由 `publish-npm.yml` 发 npm 与 GitHub Release。完整步骤与约束见 [`CONTRIBUTING.md` 的「发布流程」](../../CONTRIBUTING.md#11-发布流程)。

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
| `src/cli/updateOcc.ts` | `occ update` 的版本检查与 npm/Bun 更新流程；导出后台更新复用的检测、包名规格与静默安装函数 |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | occ 后台静默自动更新服务（周期调度、门禁、版本比较与立即安装） |
| `src/services/autoUpdate/occInstaller.ts` | detached spawn `install -g`，会话不等它 |
| `src/services/autoUpdate/runtimeFarm.ts` | 启动时进入 `<配置目录>/runtime/<版本>-<指纹>/` 硬链接副本；包目录被替换也不影响正在跑的会话 |
| `src/services/autoUpdate/runtimeFarmGc.ts` | 回收没有活会话在用的 farm；顺带清掉已废弃的 `pending-updates/` 目录 |
| `src/services/autoUpdate/liveSessions.ts` | `~/.occ/live-sessions/<pid>` 活会话登记表（心跳 5 分钟、TTL 30 分钟），farm 回收据此判定谁还在读哪棵树 |
| `src/services/autoUpdate/updateNotifier.ts` | 更新提示进入 REPL 通知队列的注册表 |
| `src/services/autoUpdate/backgroundPluginUpdate.ts` | 插件 marketplace 的后台周期更新服务（`git pull` + 缓存重新物化） |
| `src/services/autoUpdate/pluginUpdateNotifier.ts` | 插件更新提示进入 REPL 通知队列的注册表 |
| `src/main.tsx` | 注册 `occ update` 根命令 |
| `src/services/autoUpdate/backgroundOccUpdate.ts` | 后台自更新循环；不得连接官方原生下载器或官方包名 |
| `src/utils/nativeInstaller/` | 继承的非公共原生安装器实现，不是 occ 发布渠道 |
| `scripts/release.ts` | `bun run release <version>`：版本源改齐、跑发布门禁、提交打 tag |
| `src/utils/update/releaseNotes.ts` | 拉取并解析 `CHANGELOG.md`，驱动应用内「更新说明」 |
