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
2. 选定本次更新使用的 registry（见下一节；已配置 registry 的用户直接沿用自己的）。
3. 从选定的 registry 查询 `@sweetcornna/open-claude-code@latest`。
4. 如果当前版本已是最新版本，则直接退出。
5. 若 registry 是 occ 自己竞速选出来的镜像，先过完整性校验；不通过就退回官方 registry。
6. 检测当前安装是否位于 Bun 的全局安装目录。
7. Bun 全局安装使用 `bun install -g`；其他安装使用 `npm install -g`，两者都带 `--registry=<选定的 registry>`。
8. 更新失败时打印等价的手动恢复命令。

包名来自 `src/constants/brand.ts` 的 `NPM_PACKAGE_NAME`，不是在更新器中重复维护的字符串。

## Registry 竞速与镜像加速

更新是纯网络开销，而瓶颈通常不在源站、在边缘。同一台机器、同一时刻，对**同一个** 8.3 MB tarball 实测：

| registry | 吞吐 | 下载 8.3 MB 需要 |
|---|---|---|
| `registry.npmjs.org` | 17,599 B/s | 约 8 分钟 |
| `registry.npmmirror.com` | 1,101,809 B/s | **7.6 秒** |

一次真实的 `bun install -g @sweetcornna/open-claude-code@2.38.1` 耗时 **347.93 秒**（user 0.19 / sys 0.42）——几乎全部时间在等网络。

所以 occ 会**并发**探测候选 registry，然后把**版本查询和安装两半**都发给最快的那个。实测同一次 `npm view` 直连 2.95 秒、经镜像 0.356 秒；完整安装（含 6 个依赖，约 20 MB）从 347.93 秒降到 42.3 秒。

**探测用什么。** 探测的是**真实 tarball 的前 64 KiB**（`Range` 请求，读满即中止），而不是 packument。原因有三：要衡量的是马上要搬运 8 MB 的那条通道，而镜像的元数据端点和 CDN 往往不是同一台主机（npmmirror 的 tarball 会 302 到 `cdn.npmmirror.com`）；packument 探测会把「元数据在本地、CDN 在天边」的 registry 排到前面；而且 tarball 探测顺带回答了「这个镜像到底有没有这个包」。64 KiB 是为了测**吞吐**而不是**握手延迟**——几 KB 的探测跑不出 TCP 慢启动。上限 3 秒，全部候选并发跑，一有赢家立刻中止其余（所以一次竞速的实际代价略多于 64 KiB）。全部失败或超时 = 退回官方 registry。

**候选清单**（`UPDATE_REGISTRY_CANDIDATES`，`src/services/autoUpdate/updateRegistry.ts`）只有三个，每一个都是 occ 可能把自我安装交出去的主机，所以门槛是「公开可达、免认证、全量镜像 npm、运营方可追溯」：

- `registry.npmjs.org` —— 源站。始终参赛，所以到 npm 链路健康的用户永远不会被重定向到别处。
- `registry.yarnpkg.com` —— 同一份 npm 内容、不同 CDN，由 Yarn 项目运营。收录它是因为要绕开的往往是**劣化的边缘**而不是劣化的源站，它用另一条路径取到同样的字节，且不含任何地域假设。
- `registry.npmmirror.com` —— 阿里云运营的 npm 全量公开镜像（前身 cnpm/taobao）。收录它是因为它是实测中**真正改变结果**的那一个：上面两家 37 KB/s 时它 1.6 MB/s。

**绝不动用户的 npm/bun 配置。** 不写 `~/.npmrc`、不写 `~/.bunfig.toml`、不改全局配置。选中的 registry 以 `--registry=<url>` 逐次传给子进程，只对那一个子进程生效；occ 的自我更新是唯一被重定向的流量。npm 11.16.0 与 bun 1.3.13 都验证过：把两者指向一个本地 registry，所有请求确实落在那里。

**用户显式配置过的 registry 优先，且完全不参与竞速。** 命中以下任意一条就直接沿用、连探测都不做：`npm_config_registry` / `NPM_CONFIG_REGISTRY` 环境变量、`npm config get registry` 返回值不等于默认值（即 `.npmrc` 链）、bunfig 的 `[install] registry`。理由很实际：那是用户自己的选择，很可能是一个私有镜像，而且可能是**唯一**装着这个包的地方——拿公开 registry 去和它竞速只会更糟。（bunfig 那一条不能省：`npm config` 看不见 bunfig.toml，漏掉就等于绕过了 bun 用户自己写下的配置。）

**完整性不是可选项。** 镜像是第三方，它说的话一律不采信：

1. occ 从**官方** registry 取即将安装的那个版本的单版本文档（约 7.5 KB，不是 253 KB 的 packument），拿到 `dist.integrity`，要求竞速胜出的镜像对**同一个版本**给出**同一个值**。对不上、没有这个版本、或者取不到，该镜像就在这里被丢弃，安装退回 `registry.npmjs.org`。
2. 随后 npm / bun 会把下载到的 tarball 与它们自己取到的 packument 里的 integrity 比对——而第 1 步刚刚把那个值钉死成官方值。这一条是**实测**而非假设的：让一个本地 registry 提供诚实的 `dist.integrity` 元数据配一个被篡改的 tarball，npm 11.16.0 报 `EINTEGRITY`、bun 1.3.13 报 `IntegrityCheckFailed`，两者都拒绝安装、什么也没留下。

合起来是一条可以明说的端到端性质：**即使字节来自镜像，最终解包的那份 tarball 的哈希仍然等于 npm 官方发布的值。**

**做不到的部分同样明说：没有安装后校验，用这两个包管理器也不可能有。** 它们解包完就丢弃 tarball，而 gzip 不可复现，所以装好的目录树无法反推回 `dist.integrity`；何况后台安装是一个**故意活得比会话久**的 detached 子进程，事后根本没有进程可以去校验。安装前的这道闸门就是 occ 能给出的全部承诺。残余风险是「镜像给 occ 一份 packument、几秒后给包管理器另一份」——那是定向攻击而非被动风险，也正是任何不确定情形都退回官方 registry 的原因。

这道闸门**只作用于 occ 自己竞速选出来的镜像**。用户自己配置的 registry 是用户的信任锚而不是 occ 的猜测，它完全可以合法地托管一个 npmjs 上根本没有的构建；拿公开哈希去卡它，恰好会卡死上一段要保护的那批用户。

**逃生舱**：`OCC_UPDATE_REGISTRY=official` 钉死官方 registry 并跳过竞速。同一个变量也接受显式 registry URL，同样直接采用、不竞速。

竞速结果按**进程**缓存：后台循环每 30 分钟醒一次，每轮重跑竞速只是反复回答一个在单次会话内通常不会变的问题，也会让盯着自己流量的用户每半小时看见一次莫名其妙的 registry 请求。新进程会重新竞速，所以网络变好了下次启动就能吃到。

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
| `OCC_UPDATE_REGISTRY` | 环境变量 | 未设置（竞速） | 逃生舱：`official` 钉死 `registry.npmjs.org` 并跳过 registry 竞速；也接受显式 registry URL，同样跳过竞速。见「Registry 竞速与镜像加速」 |
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
| `src/services/autoUpdate/updateRegistry.ts` | registry 竞速、用户已配置 registry 的检测、以及镜像安装前的完整性闸门 |
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
