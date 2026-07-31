# 精简方案调研报告

> 生成于 2026-07-30。由 41 个 agent 并行调研 + 对抗验证得出，所有结论均带 `file:line` 证据。
> 第 1 档死代码已执行删除（见 git status）；本文档记录**尚未执行**的第 2/3 档，供决策。



---

# 第 2 档：独立服务

## `packages/remote-control-server/`（RCS）

### 是什么

一个**独立部署的自托管后端服务**，不是 CLI 的一部分。技术栈是 Bun + Hono（`src/index.ts:33` `new Hono()`），**纯内存存储**（`src/store.ts` 全是 `Map`，`src/index.ts:31` 打印 `[RCS] In-memory store ready (no SQLite)`，进程重启数据全丢），同时托管一个 React 19 + Vite + Radix UI 的 Web 控制台（`web/`，通过 `/code/*` 路径静态托管，见 `src/index.ts:55-71`）。它的角色是**中继站**：一端接 Claude Code CLI 的 bridge worker（HTTP 长轮询 + WebSocket ingress），一端接浏览器（SSE + HTTP POST），中间用 `src/transport/event-bus.ts` 的 per-session EventBus 转发消息。另外还接 ACP agent（`src/routes/acp/index.ts` + `src/transport/acp-ws-handler.ts` / `acp-relay-handler.ts`），供 `packages/acp-link/` 通过 `ACP_RCS_URL` 注册接入。定位与 `packages/cloud-artifacts/` 完全一样——workspace 里的独立服务，主 CLI 不 import。

### 干什么用（具体工作流）

1. 运维侧：把 RCS 跑在一台 CLI 和手机浏览器都能访问的机器上，设 `RCS_API_KEYS=sk-xxx`（`src/config.ts:5`）。
2. 开发机侧：`export CLAUDE_BRIDGE_BASE_URL=https://rcs.example.com` + `export CLAUDE_BRIDGE_OAUTH_TOKEN=sk-xxx`，然后跑 `claude remote-control`（或 REPL 里 `/remote-control`，命令定义在 `src/commands/bridge/index.ts:14`）。
3. CLI 侧的 `src/bridge/bridgeApi.ts:156` `POST {baseUrl}/v1/environments/bridge` 注册环境，服务端 `src/routes/v1/environments.ts:13` 建 environment + session，返回 `session_id` 和 JWT。
4. CLI 打印 URL：`src/constants/product.ts:87-90` 读到 `CLAUDE_BRIDGE_BASE_URL` 就拼成 `https://rcs.example.com/code/<sessionId>`。
5. 用户在浏览器/手机打开这个 URL，`web/src/App.tsx:87` 按 `/code/session_xxx` 路由进 `SessionDetail`，用 localStorage 里的匿名 UUID 认证（`src/auth/middleware.ts:159` `uuidAuth`，无账号系统）。
6. 之后就是双向操作：网页发消息走 `POST /web/sessions/:id/events`（`src/routes/web/sessions.ts` + `src/routes/web/control.ts:48`）→ EventBus outbound → `src/transport/ws-handler.ts:72` 推给 CLI；CLI 的 assistant/tool_use/权限请求走 WS 回来（`ingestBridgeMessage`，`ws-handler.ts:194`）→ SSE 推给网页。权限审批走 `POST /web/sessions/:id/control`，打断走 `/interrupt`（`control.ts:104`）。
7. 断线重连有 `getEventsSince(0)` 全量重放（`ws-handler.ts:59`）+ `Last-Event-ID` SSE 续传（`web/sessions.ts:141`）+ `src/services/disconnect-monitor.ts` 超时判死。

### 怎么启动

```bash
# A. 本地起后端（monorepo 根，唯一从外部引用本包的地方）
RCS_API_KEYS=test-my-key bun run rcs          # → scripts/rcs.ts → Bun.serve(server.default)

# B. 包内脚本（packages/remote-control-server/package.json）
bun run dev          # bun run --watch src/index.ts
bun run start        # bun run src/index.ts
bun run dev:web      # cd web && bunx vite（5173，代理 /web /v1 /v2 /acp 到 3000）
bun run build:web    # cd web && bunx vite build → web/dist（被根 .gitignore:3 忽略）
bun run typecheck

# C. Docker（README.md:17、docs/features/remote-control-self-hosting.md:46）
docker build -t rcs:latest -f packages/remote-control-server/Dockerfile .
docker run -d --name rcs -p 3000:3000 -e RCS_API_KEYS=sk-xxx -e RCS_BASE_URL=https://rcs.example.com rcs:latest
# 官方镜像：ghcr.io/claude-code-best/remote-control-server:latest，由 rcs-v* tag 触发 .github/workflows/release-rcs.yml

# D. ACP 模式（README.md:106）
ACP_RCS_URL=http://localhost:3000 ACP_RCS_TOKEN=test-my-key acp-link ccb-bun -- --acp
```

**坑**：`bun run rcs` 只起后端。`src/index.ts:57` 会检查 `web/dist/index.html`，不存在就 fallback 到未编译的 `web/`，而 `web/index.html:11` 引的是 `/src/main.tsx`，浏览器直接打开是白屏。本地要么先 `bun run build:web`，要么用 `bun run dev:web` 的 Vite dev server。

### 是否被主 CLI 引用

**完全没有。** 全仓 grep 结果：

- 唯一的代码引用来自 `scripts/rcs.ts:8` 和 `:14`（相对路径 import `../packages/remote-control-server/src/config` 和 `src/index.ts`）——这是个开发脚本，不在 CLI 里。
- `src/**` 下**零**引用：没有任何文件 import `@anthropic/remote-control-server`，也没有任何相对路径穿进这个包。`build.ts:20` 的 entrypoint 只有 `src/entrypoints/cli.tsx`，打包路径根本到不了。
- `tests/integration/dependency-overrides.test.ts:111` 用它的 `package.json` 当 `createRequire` 锚点去 resolve `streamdown`/`mermaid`——这是唯一的测试侧耦合。

三个同名东西必须区分开：

| 名字 | 位置 | 实际是什么 | 与本包关系 |
|---|---|---|---|
| **RCS 包** | `packages/remote-control-server/` | 独立 HTTP/WS 服务端 | 本体 |
| **`/remote-control-server` 斜杠命令**（别名 `/rcs`） | `src/commands/remoteControlServer/` | **纯粹重名，毫无关系**。它 `spawnCli(buildCliLaunch(['daemon','start',...]))`（`remoteControlServer.tsx:206`）拉起本地 daemon supervisor 进程，daemon 再 fork headless bridge worker。全程不碰这个包 | 零关系 |
| **`src/bridge/`**（35 文件 / 13470 LOC） | CLI 内部 | 是 RCS 的**客户端**。`bridgeConfig.ts:24` 读 `CLAUDE_BRIDGE_BASE_URL`，为空就打官方云端。`bridgeApi.ts` 打 `/v1/environments/bridge`、`/v1/environments/:id/work/poll`、`/v1/sessions/:id/events` 等 | **只有线上协议耦合，没有代码 import**。RCS 是这套私有 HTTP API 的一份自托管实现 |

不过 **precheck 会覆盖它**：根 `tsconfig.json:38` include 了 `packages/**/*.ts`（`:41` 只排除了 `web/`），所以 `bun run typecheck` 检查它的 `src/`；`bunfig.toml` 的 `root = "."` 让 `bun test` 跑它的测试——实测 `bun test packages/remote-control-server/` 是 **425 pass / 15 files / 3.44s**。

### 删掉会怎样

**会坏**：
- `bun run rcs` 直接崩（`scripts/rcs.ts:8` import 失败）；`scripts/rcs.ts` 也得一起删。
- `.github/workflows/release-rcs.yml` 整条 Docker 发布流水线失效（`file: packages/remote-control-server/Dockerfile`）。
- **自托管 Remote Control 能力归零**：`CLAUDE_BRIDGE_BASE_URL` 还能设，但没有任何服务实现那套 `/v1/environments/bridge` + `/v1/session_ingress/ws/:id` + `/web/*` 协议，只能回退到 Anthropic 官方云端。
- `tests/integration/dependency-overrides.test.ts` 的 `remote control markdown renderer resolves streamdown and mermaid` 用例失败。
- 少 425 个测试。
- `docs/features/remote-control-self-hosting.md`、`CLAUDE.md:175/189`、`AGENTS.md:168/180`、`codecov.yml:43` 全部变成悬空引用。

**照常工作**：
- `bun run build` / `dist/cli.js` **完全不受影响**，产物里本来就没有它一行代码。
- `/remote-control` 命令、`claude remote-control|rc|bridge` 快速路径（`src/entrypoints/cli.tsx:184-224`）、整个 `src/bridge/` 13470 LOC 照常编译运行，只是只能连官方云端。
- `/remote-control-server`（daemon）斜杠命令零影响。
- `packages/acp-link/` 独立可用，只是 `ACP_RCS_URL` 上游没有自托管目标可指。

### 规模

git 追踪文件 **150 个 / 25,308 LOC**：

| 部分 | 文件 | LOC |
|---|---|---|
| `src/`（非测试：路由/传输/服务/认证/store） | 39 | 4,620 |
| `src/__tests__/` | 13 | 5,674 |
| `web/`（React 前端 + 2 个测试） | 92 | 14,707 |
| 配置（`README.md` / `Dockerfile` / `package.json` / `tsconfig.json` / `components.json` / `.gitignore`） | 6 | 307 |

后端最大的几个文件：`src/store.ts` 438、`src/transport/acp-ws-handler.ts` 343、`src/transport/ws-handler.ts` 274、`src/transport/sse-writer.ts` 252、`src/services/session.ts` 245、`src/routes/acp/index.ts` 241。测试最大的是 `src/__tests__/routes.test.ts` 2230 行。注意**测试 LOC（5,674）比被测源码（4,620）还多**，前端 LOC 是后端的 3 倍。


## packages/cloud-artifacts/ 分析

### 1. 是什么

一个**独立部署的 Cloudflare Worker + R2 服务**，不是 CLI 的库。整包只有一个 Worker 入口 `/mnt/d/project/claude-code/packages/cloud-artifacts/src/index.ts`（119 行），职责是"收 HTML、存 R2、返回公开 URL"。它是 monorepo 的 workspace 包（根 `package.json:32-36` 的 `workspaces: ["packages/*"]` 自动识别），但**没有任何 src/ 或 packages/builtin-tools/ 的代码 import 它**——定位与 `packages/remote-control-server/` 相同：源码放在仓库里，运行在别处。README 第 200-202 行自己就写明了"不被主 CLI 引用"。生产出口是 `https://cloud-artifacts.claude-code-best.win`（`wrangler.toml:10` 的 `PUBLIC_URL`），实际链路是 Deno Deploy 边缘代理 → Cloudflare Worker → R2 bucket `cloud-artifacts`（`wrangler.toml:5-7`）。

### 2. 干什么用（运行时请求/响应流）

Worker 只有两条路由（`src/index.ts:18-30`）：

**`POST /upload`**（`handleUpload`, `src/index.ts:50-112`）按顺序做：
1. `Authorization: Bearer <TOKEN>` 与 secret 全等比对，否则 `401 {error:"unauthorized"}`（L55-59）
2. `Content-Type` 必须以 `text/html` 开头，否则 `415 unsupported_media_type`（L61-64）
3. 双重大小校验：先看 `Content-Length`，再看 `arrayBuffer().byteLength`，超 `MAX_BYTES`（默认 10MB）→ `413 payload_too_large`（L66-73, L98-100）
4. `?ttl=` 只允许 7 或 30，否则 `400 invalid_ttl`（L75-80）——因为 TTL 是靠 R2 prefix + lifecycle rule 实现的，Worker 不参与过期
5. `?hash=` 可选自定义 ID，正则 `^[A-Za-z0-9_-]{1,128}$`（L11, L85-88）；给了 hash 就**先删 `7d/<id>.html` 和 `30d/<id>.html` 两个旧 key 再写**（L89-92，覆盖语义）；没给就 `nanoid(21)`（L94）
6. `env.BUCKET.put("<ttl>d/<id>.html", body, {contentType: "text/html; charset=utf-8"})`（L102-105）
7. 返回 `{id, url: "${PUBLIC_URL}/${key}", expiresAt}`（L107-111）

**`GET /<7d|30d>/<id>.html`**（`handleGet`, `src/index.ts:33-48`）：路径正则 `GET_PATH_PATTERN`（L16）匹配 → R2 读 → 返回 `text/html; charset=utf-8` + `Cache-Control: public, max-age=86400`；R2 里没有则 404。**GET 完全无鉴权**，hash 本身就是唯一秘密（README L179）。

一个重要的协议怪癖：生产走 Deno Deploy 代理，代理会把上游 HTTP status 抹平成 200，只有 body 里的 `{error: "<code>"}` 保留（README L57-63）。客户端必须先解析 body 再看 status。

### 3. 谁调用它 / 部署服务是不是 ArtifactTool 的硬依赖

grep 结果（`src/` + `packages/builtin-tools/`）里 `cloud-artifacts` 字面量只出现在 5 处：

| 文件 | 性质 |
|------|------|
| `/mnt/d/project/claude-code/packages/builtin-tools/src/tools/ArtifactTool/config.ts:7` | **真正的调用方**：`ARTIFACTS_DEFAULT_URL = 'https://cloud-artifacts.claude-code-best.win'` |
| `/mnt/d/project/claude-code/packages/builtin-tools/src/tools/ArtifactTool/prompt.ts:4` | 只是 tool description 文案 |
| `.../ArtifactTool/__tests__/client.test.ts:25,37`、`__tests__/UI.test.tsx:28,62` | 测试 fixture 里的假 URL |
| `/mnt/d/project/claude-code/src/commands/artifacts/index.ts:7` | `/artifacts` 斜杠命令的描述文案 |

调用链：`src/tools.ts:65` import `ArtifactTool` → `src/tools.ts:211` 注册进工具表（无 feature flag，`isEnabled()` 恒 true，见 `ArtifactTool.ts:72-74`；但 `shouldDefer: true`，属于按需搜索加载的延迟工具，不在 `src/constants/tools.ts` 的 CORE_TOOLS 白名单里）→ `ArtifactTool.call()`（`ArtifactTool.ts:113-196`）读文件、`.md` 走 `markdown.ts` 转 HTML → 调 `uploadArtifact()`（`client.ts:15-59`）**直接 `fetch()` 打 `getUploadUrl()`**。

**关键：`ArtifactTool/` 目录里没有一行 import 指向 `packages/cloud-artifacts/`。** 它自带了独立的 HTTP 客户端（`client.ts`）和配置（`config.ts`），只共享"协议约定"（URL 形状、ttl∈{7,30}、hash 正则 `ArtifactTool.ts:25` 与 Worker `index.ts:11` 完全一致、Deno 200-抹平的解析逻辑 `client.ts:31-46`），不共享代码。

**部署服务是不是硬依赖：是。** `config.ts:5-6` 把 token（`'claude-code-best'`，硬编码明文默认值）和 URL 都写死为生产值，只能被 `CLAUDE_ARTIFACTS_TOKEN` / `CLAUDE_ARTIFACTS_URL` 环境变量覆盖。`call()` 里没有任何本地兜底路径——Worker 挂了就走 `ArtifactTool.ts:192-195` 的 catch，返回 `{error: message}`，工具结果被标为 `is_error`（`ArtifactTool.ts:97-104`）。整个功能是纯远程的。

（补充：`/artifacts` 斜杠命令 `src/commands/artifacts/scanner.ts` 是从会话消息里正则扒 `id:` / `expires:` / `.html` URL 来列历史上传记录的，不访问服务，离线也能用。）

### 4. 删掉包源码、Worker 还活着 → ArtifactTool 还能用吗

**能，完全不受影响。** 明确说：

- ArtifactTool 的运行时依赖是**那个已部署的 HTTP 端点**，不是这个目录的文件。删掉 `packages/cloud-artifacts/` 后，`ArtifactTool.ts` → `client.ts` → `fetch('https://cloud-artifacts.claude-code-best.win/upload')` 这条链一个字节都没变。
- 编译期也无影响：没有 import 边、不在 `dist` 构建图里（`build.ts` 入口是 `src/entrypoints/cli.tsx`）。唯一的形式关联是根 `tsconfig.json:35-40` 的 `include: ["packages/**/*.ts"]` 会把 Worker 源码纳入 `tsc --noEmit`——删了只是少检查两个文件，`bun run precheck` 照样过。`nanoid` 也不是根依赖，只在这个包的 `package.json:13` 里。

**代价是：失去对服务本身的控制权。** 删掉之后就没法再 `bun run deploy` 更新 Worker、没法 `bun run setup` 重建 bucket/lifecycle/secret、没法自建私有部署（`CLAUDE_ARTIFACTS_URL` 指向自己的实例时需要这份源码）、没法跑 `scripts/test.sh` 的 10 个契约用例。等于把一个可维护的服务变成一个只能读、不能改的黑盒 URL。反过来，**如果 Worker 下线，留着源码也救不了当前进程**——工具会对每次调用返回上传失败。

### 5. 规模

**10 个文件，841 行**（全部 git-tracked，无 node_modules）：

| 文件 | LOC | 说明 |
|------|-----|------|
| `README.md` | 202 | 架构图 + API 表 + 部署/排障 |
| `.gitignore` | 171 | 标准 Node 模板样板 |
| `scripts/test.sh` | 162 | 7 错误用例 + 3 成功用例 + R2 校验 |
| `src/index.ts` | 119 | **唯一的运行时逻辑** |
| `src/types.d.ts` | 104 | R2/Workers 类型 stub，`worker-configuration.d.ts` 缺失时兜底 |
| `scripts/setup.sh` | 30 | 建 bucket + lifecycle + secret |
| `package.json` | 19 | |
| `tsconfig.json` | 17 | |
| `wrangler.toml` | 16 | |
| `.dev.vars.example` | 1 | |

实际业务代码只有 **119 行 TypeScript**；去掉 `.gitignore` 样板和类型 stub 后，人写的有效内容约 550 行，其中一半是文档和测试脚本。


## `packages/weixin/` — 微信 Channel 集成

### 1. 是什么

`packages/weixin/` 是一个 **Bun workspace 包**（`@claude-code-best/weixin`，`packages/weixin/package.json:2`），实现了 Claude Code 的 **内置微信（WeChat）Channel**：它把微信官方 iLink Bot 开放接口（`https://ilinkai.weixin.qq.com`，见 `packages/weixin/src/accounts.ts:12`）封装成一个 **stdio MCP Server**，让运行中的 Claude Code 会话可以接收微信消息、回复文本/图片/文件、发送"正在输入"状态，甚至在微信里远程审批工具权限。它是纯"外围适配层"——**不 import `src/` 下任何代码**（权限回复正则等靠注释同步复制，见 `packages/weixin/src/monitor.ts:4-5` 与 `src/services/mcp/channelPermissions.ts:75`），唯一的外部依赖是 `qrcode`（终端二维码）和 hoist 上来的 `@modelcontextprotocol/sdk`。

### 2. 端到端能做什么

| 阶段 | 命令 / 机制 | 实现位置 |
|------|-------------|----------|
| **登录** | `ccb weixin login` — 拉 `/ilink/bot/get_bot_qrcode?bot_type=3`，用 `qrcode` 在终端画二维码，轮询 `/ilink/bot/get_qrcode_status` 直到 `confirmed`（过期自动刷新，最多 3 次，总超时 480s）；token 落盘到 `~/.claude/channels/weixin/account.json`，`chmod 0600` | `src/login.ts:27-134`、`src/cli.ts:27-83`、`src/accounts.ts:46-50` |
| **登出** | `ccb weixin login clear` — 删 `account.json` | `src/cli.ts:28-32`、`src/accounts.ts:52-57` |
| **配对授权** | 默认 policy 是 `pairing`。陌生微信用户首次发消息时，自动生成 **6 位配对码**（10 分钟有效）回给对方；运维在终端跑 `ccb weixin access pair <code>` 才把该 `userId` 写进 `access.json` 的 `allowFrom` | `src/pairing.ts:56-104`、`src/monitor.ts:234-248`、`src/cli.ts:85-98` |
| **会话启用** | `ccb --channels plugin:weixin@builtin`（启动参数），CLI 会 spawn `ccb weixin serve` 作为 stdio MCP server | `src/plugins/bundled/weixin.ts:5-19`、`docs/features/channels.md:26-28` |
| **收消息（monitor）** | `startPollLoop` 长轮询 `/ilink/bot/getupdates`（40s 超时），游标持久化到 `cursor.txt`；`errcode -14`（会话过期）暂停 30s；连续 3 次错误退避 30s。文本直接透传；图片/语音/文件/视频从 `novac2c.cdn.weixin.qq.com/c2c` 下载 → **AES-128-ECB 解密** → 写入 `$TMPDIR/weixin-media/`，路径以 `attachment_path` 附在 meta 上；语音带转写文本 | `src/monitor.ts:136-305`、`src/media.ts:58-70` |
| **入站送进会话** | server 发 `notifications/claude/channel`，主 CLI 的 `useManageMCPConnections` 收到后 `enqueue({mode:'prompt', priority:'next', isMeta:true})`，包成 `<channel source="plugin:weixin:weixin" chat_id=... sender_id=...>` | `packages/weixin/src/server.ts:326-340` → `src/services/mcp/useManageMCPConnections.ts:504-531` |
| **发消息（send）** | 暴露两个 MCP tool：`reply(chat_id, text, files?)` 和 `send_typing(chat_id)`。文本先经 `markdownToPlainText` 去 markdown（含手写非正则的 code-fence 剥离，注释明确说是防 ReDoS）；文件走 `getuploadurl` → AES-128-ECB 加密 → POST 到 CDN → 按扩展名判定 image/video/file 三种 item 类型 | `src/server.ts:68-232`、`src/send.ts:44-180`、`src/media.ts:80-143` |
| **远程权限审批** | 主 CLI 的 `interactiveHandler` 向所有 channel client 广播 `notifications/claude/channel/permission_request`；weixin server 收到后把工具名/理由/输入预览格式化成微信消息发给当前活跃聊天，用户回 `yes <5位id>` / `no <5位id>`；monitor 用 `/^\s*(y\|yes\|n\|no)\s+([a-km-z]{5})\s*$/i` 解析，校验 `chatId` 匹配后回 `notifications/claude/channel/permission` | `src/server.ts:37-50,256-286`、`src/monitor.ts:125-134,280-296`、`src/permissions.ts:50-78`；对端 `src/hooks/toolPermission/handlers/interactiveHandler.ts:429-441` |
| **进程生命周期** | `runWeixinMcpServer` 监听 stdin end/error + SIGINT/SIGTERM/SIGHUP，并每 5s `process.kill(ppid, 0)` 探活父进程，父进程死了自杀 | `src/server.ts:293-319` |

状态目录可用 `WEIXIN_STATE_DIR` 覆盖（`src/accounts.ts:24`），测试就是靠这个隔离的。

### 3. 如何接入主 CLI（三个挂钩点）

**a) CLI fast path — `src/entrypoints/cli.tsx:131-157`**

```ts
if (args[0] === 'weixin') {
  profileCheckpoint('cli_weixin_path');
  const { handleWeixinCli } = await import('@claude-code-best/weixin');
  ...
  await handleWeixinCli(args.slice(1), { enableConfigs, initializeAnalyticsSink,
    shutdownDatadog, shutdown1PEventLogging, logForDebugging,
    registerPermissionHandler(server, handler) { ... } }, MACRO.VERSION);
  return;
}
```

这是 **整个仓库唯一一处 `import '@claude-code-best/weixin'`**（grep 全库确认）。注意它 **没有 feature flag 包裹**——不像旁边的 `--acp`（`feature('ACP')`）或 `--computer-use-mcp`（`feature('CHICAGO_MCP')`），`weixin` 子命令永远可用。依赖注入方向是 **CLI → 包**：包定义 `WeixinServerDeps` 接口（`packages/weixin/src/server.ts:25-35`），CLI 把 analytics sink、debug logger、`ChannelPermissionRequestNotificationSchema` 塞进去，从而让包保持对 `src/` 零依赖。

**b) Builtin plugin 注册 — `src/plugins/bundled/weixin.ts`（全文 21 行）**

`registerWeixinBuiltinPlugin()` 用 `buildCliLaunch(['weixin', 'serve'])` 拼出重入自身 CLI 的命令，注册成 `defaultEnabled: true` 的 builtin plugin，暴露一个名叫 `weixin` 的 stdio mcpServer。调用链：`src/main.tsx:165` import → `src/main.tsx:2394` `initBuiltinPlugins()` → `src/plugins/bundled/index.ts:23`。**这是 `src/plugins/bundled/` 下唯一注册的 builtin plugin**（`index.ts` 只有这一个 `registerBuiltinPlugin` 调用）。

**c) Channel allowlist 硬编码放行 — `src/services/mcp/channelAllowlist.ts:72-74`**

```ts
if (marketplace === BUILTIN_MARKETPLACE_NAME && name === 'weixin') {
  return true
}
```

其他 channel 插件必须命中 GrowthBook `tengu_harbor_ledger` 里的 allowlist；weixin 因为是 builtin 被无条件放行。这里只是 **字符串比较，不 import 包**。注意这只是 UI 预筛选，真正的 gate 是 `gateChannelServer()`（`src/services/mcp/channelNotification.ts:213-263`），它检查 `experimental['claude/channel']` capability + `--channels` 会话白名单 + marketplace 匹配——weixin server 在 `packages/weixin/src/server.ts:56-61` 声明了 `claude/channel` 和 `claude/channel/permission` 两个 capability。

**d) 是否是 workspace 包？→ 是。**

- `package.json:33` workspaces glob `packages/*` 覆盖它
- `package.json:102` 根依赖 `"@claude-code-best/weixin": "workspace:*"`
- `tsconfig.json:25-26` 路径映射到 `./packages/weixin/src/index.ts`
- `bun.lock:38, 340-341, 611` 有对应 workspace 条目

⚠️ **`CLAUDE.md:182` 的表述"`packages/weixin/` | 微信集成（非 workspace 包）"是错的**，应改为 workspace 包（与 `packages/agent-tools`、`packages/mcp-client` 同级）。真正的非 workspace 辅助目录是 `langfuse-dashboard`、`shared-web-ui` 那批（它们没有 package.json）。

### 4. 删掉会怎样（精确破坏点）

**硬破坏（typecheck / install 直接失败）：**

| 位置 | 后果 |
|------|------|
| `src/entrypoints/cli.tsx:133` | `await import('@claude-code-best/weixin')` → TS2307 模块找不到，`bun run typecheck` 失败；运行时 `ccb weixin *` 抛错 |
| `package.json:102` | `"@claude-code-best/weixin": "workspace:*"` 指向不存在的包 → `bun install` 失败 |
| `bun.lock:38, 340-341, 611` | lockfile 与 package.json 不一致 |
| `tsconfig.json:25-26` | path 映射悬空（tsc 本身容忍，但配合上面的 import 就是 TS2307） |

**软破坏（能编译，运行时坏 / 变死代码）：**

| 位置 | 后果 |
|------|------|
| `src/plugins/bundled/weixin.ts:5` | 不 import 包，仍能编译，但 `buildCliLaunch(['weixin','serve'])` spawn 出的子进程会立刻失败 → `/plugin` 面板里出现一个永远连不上的 builtin plugin |
| `src/plugins/bundled/index.ts:17,23` | 这是唯一一个 builtin plugin；删掉 weixin 后 `initBuiltinPlugins()` 变成空函数，`src/plugins/bundled/` 整个目录失去存在意义 |
| `src/services/mcp/channelAllowlist.ts:72-74` | 纯字符串判断，变成永远走不到的死分支 |
| `docs/features/channels.md` | 第 15、27-28、45、49-78 行整节"微信内置 Channel"文档失效 |

**测试影响：**

- `packages/weixin/src/__tests__/` 6 个文件 36 个 test 随包消失（实测 `bun test packages/weixin/src/__tests__/` → 36 pass）
- `src/services/mcp/__tests__/channelAllowlist.test.ts:10-11`（`isChannelAllowlisted('weixin@builtin')`）、`src/components/LogoV2/__tests__/ChannelsNotice.test.ts:6-12`、`src/hooks/toolPermission/handlers/__tests__/interactiveHandler.test.ts:10-22`、`src/services/mcp/__tests__/channelPermissions.test.ts:170` —— **这四处都只用 `'weixin'` 字符串做 fixture，不 import 包，删包后仍然通过**（但 `channelAllowlist.test.ts` 会变成测试死分支）

**不受影响：** channels 机制本身（`channelNotification.ts` / `channelPermissions.ts` / `useManageMCPConnections.ts` / `ChannelsNotice.tsx`）全部是通用的，`ChannelsNotice.tsx` 用 `getBuiltinPlugins()` 而非硬编码 weixin（`src/components/LogoV2/ChannelsNotice.tsx:99-100`）。第三方 channel 插件（飞书/Telegram/Discord）照常工作。

### 5. 规模

| 类别 | 文件数 | LOC |
|------|-------|-----|
| 源码 `src/*.ts` | 12 | **1946** |
| 测试 `src/__tests__/*.ts` | 6 | 319 |
| 配置（`package.json` 11 + `tsconfig.json` 5） | 2 | 16 |
| **合计** | **20** | **2281** |

源码明细（LOC）：`server.ts` 355 · `monitor.ts` 305 · `send.ts` 180 · `types.ts` 178 · `media.ts` 161 · `api.ts` 148 · `login.ts` 134 · `cli.ts` 126 · `index.ts` 115 · `pairing.ts` 104 · `permissions.ts` 83 · `accounts.ts` 57。

外部接触面：CLI 侧仅 3 个文件（`src/entrypoints/cli.tsx` 27 行、`src/plugins/bundled/weixin.ts` 21 行、`src/plugins/bundled/index.ts` 25 行）+ `channelAllowlist.ts` 3 行硬编码，总计约 76 行胶水代码。


## 结论先行：任务前提有误

被要求调查的 7 个路径中，**6 个在当前工作区根本不存在**。这 6 个路径的唯一来源是 `/mnt/d/project/claude-code/CLAUDE.md:184` 和 `/mnt/d/project/claude-code/AGENTS.md:165` 两处**过期文档**，而非真实代码。

验证方式：
- `ls packages/` 实际只有 15 项：`@ant`、`acp-link`、`agent-tools`、`audio-capture-napi`、`builtin-tools`、`cloud-artifacts`、`color-diff-napi`、`image-processor-napi`、`mcp-client`、`modifiers-napi`、`remote-control-server`、`tsconfig.json`、`url-handler-napi`、`weixin`、`workflow-engine`
- `git ls-tree -r --name-only HEAD | grep -cE "^packages/(vscode-ide-bridge|pokemon)/"` → `0`
- `grep -rE "langfuse-dashboard|shared-web-ui|highlight-code|claude-pencil|vscode-ide-bridge|packages/pokemon" src/ scripts/ build.ts vite.config.ts package.json` → **零命中**

另外，CLAUDE.md 说这些是「无 package.json，非 workspace 包」——这一点对 `vscode-ide-bridge` 和 `pokemon` 也是错的，它们在各自分支上**都有 package.json**。

---

## 逐个说明

### 1. `src/services/langfuse/` — 唯一真实存在，且深度接入主 CLI

**是什么**：Langfuse LLM 可观测性追踪层，基于 OpenTelemetry。不是面板/dashboard，是 CLI 内部的埋点 SDK 封装。

**干什么用**：把每轮对话、每次 LLM 调用、每次工具执行上报成 trace/span。

**文件构成（5 个生产文件 + 2 个测试，共 7 文件 / 2832 LOC）**：

| 文件 | LOC | 职责 |
|---|---|---|
| `src/services/langfuse/tracing.ts` | 447 | trace/span 创建与上报核心 |
| `src/services/langfuse/convert.ts` | 352 | Anthropic 消息格式 → Langfuse observation |
| `src/services/langfuse/sanitize.ts` | 103 | 敏感数据脱敏（作为 `mask` 回调） |
| `src/services/langfuse/client.ts` | 86 | Processor/Provider 生命周期 |
| `src/services/langfuse/index.ts` | 23 | 统一导出面 |
| `__tests__/langfuse.test.ts` | 1119 | 测试 |
| `__tests__/langfuse.isolated.ts` | 702 | 隔离测试 |

生产代码 **1011 LOC**，测试 **1821 LOC**。

**怎么启动**：`src/entrypoints/init.ts:179` 调用 `initLangfuse()`，紧接着 `registerCleanup(shutdownLangfuse)`（第 180 行）。**没有 feature flag**，走的是环境变量开关 —— `client.ts:13-15`：

```ts
export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)
}
```

未配置双密钥时降级为 no-op（`client.ts:23-26`）。其余可调环境变量：`LANGFUSE_BASE_URL`（默认 `https://cloud.langfuse.com`）、`LANGFUSE_FLUSH_AT`、`LANGFUSE_FLUSH_INTERVAL`、`LANGFUSE_TRACING_ENVIRONMENT`、`LANGFUSE_EXPORT_MODE`、`LANGFUSE_TIMEOUT`。

**是否被主 CLI 引用**：**是，而且是全链路的**。共 **19 个生产文件**引用（不含自身与测试），覆盖最核心路径：

- 核心循环：`src/query.ts:128`、`src/Tool.ts:69`（`LangfuseSpan` 类型进了 Tool 接口）
- 入口：`src/entrypoints/init.ts:58`
- **全部 4 个 API provider**：`src/services/api/claude.ts:232-238`、`api/gemini/index.ts:24-29`、`api/grok/index.ts:33-38`、`api/openai/index.ts:51-56`
- 工具执行：`src/services/tools/toolExecution.ts:53`、`StreamingToolExecutor.ts:13-14`、`toolOrchestration.ts:7`
- 其他：`src/utils/sideQuery.ts:23-29`、`src/services/tokenEstimation.ts:33`、`src/services/awaySummary.ts:13`、`src/memdir/findRelevantMemories.ts:6`、`src/utils/permissions/yoloClassifier.ts:35`、`src/utils/hooks/skillImprovement.ts:14`、`src/components/agents/generateAgent.ts:21`
- 跨包引用：`packages/builtin-tools/src/tools/AgentTool/runAgent.ts:65`、`packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts:16`

依赖已在 `package.json:105-106` 声明（`@langfuse/otel`、`@langfuse/tracing` ^5.1.0）+ 一大批 `@opentelemetry/*`。

**删掉会怎样**：**编译直接崩**。19 个生产文件的 import 全断，`src/Tool.ts` 的类型定义、`src/query.ts` 的核心循环、4 个 provider 全部报错。这是不可删除的基础设施，绝非「辅助目录」。

---

### 2. `packages/vscode-ide-bridge/` — 不在主干，仅存于未合并 PR 分支

**当前状态**：`main`/HEAD 中不存在，磁盘上不存在。仅存在于远程分支 `remotes/origin/pr/suger-m/213`（`git branch -a --contains ea344ad0`）。

**是什么**（按分支快照 `ea344ad0`，2026-04-09）：VS Code 扩展，通过 WebSocket + lockfile 让 CLI 与编辑器互通。含 `src/extension.ts`、`src/server/bridgeServer.ts`、`diffController.ts`、`localIdeBridgeService.ts`、`lockfile.ts`、`protocol.ts`、`selectionPublisher.ts`、`serverWebSocketTransport.ts`、`terminalEnvironment.ts`、`workspaceInfo.ts`，以及 11 个 `test/` 文件。**有 `package.json`**（与 CLAUDE.md 描述矛盾）。

**规模**：31 文件 / 2178 LOC。

**是否被主 CLI 引用**：**否**。主干无任何引用。

**删掉会怎样**：主干无影响——它本来就不在主干。

---

### 3. `packages/pokemon/` — 不在主干，仅存于未合并 feature 分支

**当前状态**：HEAD 中不存在。仅存在于 `remotes/origin/feature/pokemon/battle`（最后提交 `4cf1a835`，2026-04-24 "test: 添加 PP 递减测试"）。

**是什么**（按分支快照）：一个完整的宝可梦对战引擎玩具项目——`src/battle/`（engine/ai/capture/settlement）、`src/core/`（creature/effort/egg/evolution/experience/gender/spriteCache/storage）、`src/dex/`（数据层，注：提交 `f22caf0e` 把 `data/` 改名 `dex/` 以规避 gitignore）、`scripts/`（fetch-pokedex-data / fetch-species-names / fetch-sprites）、15+ 个 `__tests__/`。分支上曾集成进 `BuddyPanel` 的 Battle tab。**有 `package.json`**。

**规模**：76 文件 / 约 10860 LOC（仅统计 ts/tsx/json/md，不含 sprite 二进制）。

**是否被主 CLI 引用**：**否**。

**删掉会怎样**：主干无影响。

---

### 4-7. `packages/langfuse-dashboard/`、`packages/shared-web-ui/`、`packages/highlight-code/`、`packages/claude-pencil/` — 从未存在

这 4 个路径在**整个 git 历史的任何分支上都从未被创建过**：

```
git log --all --oneline --name-only --diff-filter=A | grep -iE "langfuse-dashboard|shared-web-ui|highlight-code/|claude-pencil"
→ 零命中
```

`git log --all -- <path>` 对这 4 个路径同样零输出。它们纯属 `CLAUDE.md:184` 的杜撰/残留。

**唯一沾边的真实存在**：`src/components/HighlightedCode/Fallback.tsx`（81 LOC，单文件）——这可能是 CLAUDE.md 里「`highlight-code`（代码高亮）」想指的东西，但它在 `src/components/` 下，不在 `packages/`，也不是独立目录级模块。

---

## 汇总表

| 路径 | 是否存在 | 被主 CLI 引用 | 规模 |
|---|---|---|---|
| `src/services/langfuse/` | 是 | **是，19 个生产文件深度依赖** | 7 文件 / 2832 LOC（生产 1011） |
| `packages/vscode-ide-bridge/` | 否（仅 `origin/pr/suger-m/213`） | 否 | 31 文件 / 2178 LOC |
| `packages/pokemon/` | 否（仅 `origin/feature/pokemon/battle`） | 否 | 76 文件 / ~10860 LOC |
| `packages/langfuse-dashboard/` | **从未存在** | — | — |
| `packages/shared-web-ui/` | **从未存在** | — | — |
| `packages/highlight-code/` | **从未存在** | — | — |
| `packages/claude-pencil/` | **从未存在** | — | — |

## 建议修正

`CLAUDE.md:184` 那一整行「辅助目录（无 package.json，非 workspace 包）」应当删除或重写：其中 4 项虚构，2 项已不在主干（且都有 package.json），而唯一真实的 langfuse 代码在 `src/services/` 下、是核心依赖而非辅助目录。`AGENTS.md:165` 的 `packages/langfuse-dashboard/` 表格行同样需要移除。




---

# 第 3 档：大功能块

## Computer Use 栈（CHICAGO_MCP）

### 1) 是什么 / 用户能拿它干什么

一套「让 Claude 操作你本机桌面 GUI」的能力，以**内置 MCP server**（server 名固定为 `computer-use`，见 `src/utils/computerUse/common.ts:4`）的形式暴露给模型，工具名形如 `mcp__computer-use__screenshot`。

分层：

| 层 | 路径 | 职责 |
|---|---|---|
| 协议/策略层 | `packages/@ant/computer-use-mcp/` | 工具 schema（`tools.ts`）、全部动作分发与安全策略（`toolCalls.ts`，4474 行）、应用黑名单（`deniedApps.ts`）、哨兵应用（`sentinelApps.ts`）、系统快捷键黑名单（`keyBlocklist.ts`）、像素点击校验（`pixelCompare.ts`）、截图缩放（`imageResize.ts`） |
| 键鼠后端 | `packages/@ant/computer-use-input/` | dispatcher + `backends/{darwin,win32,linux}.ts` |
| 截图/应用后端 | `packages/@ant/computer-use-swift/` | dispatcher + `backends/{darwin,win32,linux}.ts` |
| CLI 宿主接入 | `src/utils/computerUse/` | `hostAdapter.ts`（宿主适配器单例）、`executor.ts`（macOS 执行器）、`executorCrossPlatform.ts`（非 macOS）、`wrapper.tsx`（`.call()` 覆写 + 权限 UI 触发）、`gates.ts`（GrowthBook 开关 `tengu_malort_pedway`）、`computerUseLock.ts`（跨会话互斥锁）、`platforms/`（统一平台抽象）、`win32/`（Windows 深度集成：UIAutomation、SendMessage、虚拟光标、COM Word/Excel、Python bridge） |
| 审批 UI | `src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx` | 应用授权对话框（由 `wrapper.tsx:359` 渲染） |

**用户可用的工具**（`packages/@ant/computer-use-mcp/src/tools.ts`，共 38 个定义）：

- 通用 24 个：`request_access`、`screenshot`、`zoom`、`left_click`/`double_click`/`triple_click`/`right_click`/`middle_click`、`type`、`key`、`hold_key`、`scroll`、`left_click_drag`、`mouse_move`、`left_mouse_down`/`left_mouse_up`、`cursor_position`、`wait`、`open_application`、`switch_display`、`list_granted_applications`、`read_clipboard`、`write_clipboard`、`computer_batch`
- **仅 Windows** 11 个（`tools.ts:420` 的 `caps.platform === 'win32'` 分支）：`window_management`、`click_element`、`type_into_element`、`open_terminal`、`bind_window`、`activate_window`、`prompt_respond`、`status_indicator`、`virtual_keyboard`、`virtual_mouse`、`mouse_wheel` — 这些走 SendMessage/PostMessage 绑定 HWND，**不抢焦点、不移动真实光标**
- teach 模式 3 个（`request_teach_access`/`teach_step`/`teach_batch`）在 CLI **不暴露**：`tools.ts:990` 需要 `caps.teachMode`，而 `src/utils/computerUse/common.ts:54` 的 `CLI_CU_CAPABILITIES` 没有设这个字段

安全模型：会话级应用白名单（模型必须先调 `request_access` 弹审批 UI），策略拒绝的应用类别（`deniedApps.ts`，553 行），系统键组合黑名单，跨会话进程锁（`computerUseLock.ts`），turn 结束/中断自动 unhide + 释放锁（`cleanup.ts`）。

### 2) 怎么进入

三条路径，全部被 `feature('CHICAGO_MCP')` 包住：

1. **子进程 MCP server 模式** — `src/entrypoints/cli.tsx:116`：
   ```
   } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
   ```
   → `runComputerUseMcpServer()`（`src/utils/computerUse/mcpServer.ts:86`），stdio transport。
2. **主流程自动注入（实际生效的路径）** — `src/main.tsx:2080`：
   ```
   if (feature('CHICAGO_MCP') && getPlatform() !== 'unknown' && !getIsNonInteractiveSession()) {
   ```
   → `getChicagoEnabled()`（`gates.ts:42`）→ `setupComputerUseMCP()`（`setup.ts:23`）把 `computer-use` 塞进 `dynamicMcpConfig` 并把工具名 push 进 `allowedTools`。
3. **实际不 spawn 子进程** — `setup.ts:35` 注释明说 `command/args are never spawned`；`src/services/mcp/client.ts:929-947` 按名字拦截，改用 in-process transport（`createComputerUseMcpServerForCli()` + `createLinkedTransportPair()`）。`--computer-use-mcp` 这条 CLI 路径是 Chrome MCP 的镜像备用入口。

额外门控：
- `computer-use` 在 `src/services/mcp/config.ts:1513` 的 `DEFAULT_DISABLED_BUILTINS` 里，**默认禁用**，需在 `/mcp` 里显式 `enabledMcpServers` 打开。
- GrowthBook 开关 `tengu_malort_pedway`（`gates.ts:29`），另有 `ALLOW_ANT_COMPUTER_USE_MCP=1` 逃生阀（`gates.ts:47-53`）。
- `computer-use` 是保留 server 名，用户自己加会被拒（`main.tsx:1946`、`config.ts:641`）。
- 非交互（`-p` print 模式）直接跳过。

### 3) 平台实现真实情况

**三平台都有真实实现，没有 macOS-only 的假 stub**，但实现深度差很多：

| 平台 | input 后端 | swift(截图/应用) 后端 | 实现手段 | 外部依赖 |
|---|---|---|---|---|
| macOS | `computer-use-input/src/backends/darwin.ts` (209行) | `computer-use-swift/src/backends/darwin.ts` (325行) | osascript / JXA / `screencapture` / `pbcopy`-`pbpaste` | 系统自带 |
| Windows | `backends/win32.ts` (305行) | `backends/win32.ts` (296行) | PowerShell + Win32 P/Invoke（SetCursorPos/SendInput/keybd_event）、System.Drawing 截图 | powershell（自带）；`win32/bridge.py` 需 python+mss |
| Linux | `backends/linux.ts` (245行) | `backends/linux.ts` (360行) | xdotool / xrandr / scrot / wmctrl / xdg-open | **需自行安装** xdotool、scrot、wmctrl |

关键证据：
- `packages/@ant/computer-use-input/src/index.ts:31-44` 三分支 require，无 macOS 硬编码。
- `packages/@ant/computer-use-swift/src/index.ts:65/72/75/81/84` 有 5 处 `throw new Error('@ant/computer-use-swift: macOS only')` — 但这是 **`loadBackend()` 返回 null 时的兜底**（即 `process.platform` 不是 darwin/win32/linux，或 require 抛错），不是 win32/linux 的 stub。
- `src/utils/computerUse/executor.ts:322-327`：非 darwin 直接整体委托 `createCrossPlatformExecutor()`（`executorCrossPlatform.ts`，1154 行）。
- `src/utils/computerUse/platforms/index.ts:29-40`：darwin/win32/linux 三分支，其余平台 `throw new Error('Computer Use not supported on ...')`。
- **Windows 功能最全**：只有 `platforms/win32.ts:850` 导出了 `windowManagement`（darwin.ts:158 / linux.ts:517 都只有 `{input, screenshot, display, apps}`），所以那 11 个窗口级工具是 Windows 独占。
- **macOS 截图过滤是唯一「native」**：`common.ts:55` — `screenshotFiltering: process.platform === 'darwin' ? 'native' : 'none'`，win/linux 截图会拍到全部窗口（`tools.ts:157` 的描述就明说了）。
- **降级点**：`hostAdapter.ts:87-102` — 原版靠 Swift `.node` 的 TCC 检查，本仓库没有 native 模块，退化为 JXA 探测（osascript + `screencapture -x -R 0,0,1,1`）；`hostAdapter.ts:115` `cropRawPatch: () => null` 意味着像素点击校验（pixelValidation）永远 skip（该 sub-gate 默认也是 false）。
- **一个已知隐患**：`src/utils/computerUse/win32/bridgeClient.ts:43/160` 用 `path.join(__dirname, 'bridge.py')` 加载 Python bridge，但 `build.ts` / `vite.config.ts` / `scripts/post-build.ts` 里 grep 不到任何 `bridge.py` 拷贝逻辑 → 打包产物里这个文件不存在，Windows 上 bridge 路径会走 `bridgeClient.ts:99` 的 `throw new Error('Python bridge not available')`。

### 4) 规模

| 目录 | 文件数 | LOC |
|---|---|---|
| `packages/@ant/computer-use-mcp/` | 14（12 ts + 2 json） | 7,902 |
| `packages/@ant/computer-use-input/` | 7（5 ts + 2 json） | 866 |
| `packages/@ant/computer-use-swift/` | 7（5 ts + 2 json） | 1,197 |
| `src/utils/computerUse/` | 35（34 ts/tsx + 1 py） | 9,160 |
| **小计（题目所列 4 个目录）** | **63** | **19,125** |
| 附：`src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx` | 1 | 252 |
| **含 UI 合计** | **64** | **19,377** |

单文件 Top3：`packages/@ant/computer-use-mcp/src/toolCalls.ts`(4474)、`src/utils/computerUse/executorCrossPlatform.ts`(1154)、`packages/@ant/computer-use-mcp/src/tools.ts`(1127)。

**测试覆盖：0 个测试文件**（`find . -name "*.test.ts*" | xargs grep -l "computerUse\|computer-use"` 无输出）。

### 5) 删掉会怎样 —— src/ 中的全部引用点

外部（非 `src/utils/computerUse/` 自身）引用一共 **9 个文件、14 处**：

**硬引用（删了直接编译/运行失败）**
| 文件:行 | 引用内容 |
|---|---|
| `src/entrypoints/cli.tsx:118` | `await import('../utils/computerUse/mcpServer.js')` → `runComputerUseMcpServer` |
| `src/main.tsx:1948` | `await import('src/utils/computerUse/common.js')` → `isComputerUseMCPServer`、`COMPUTER_USE_MCP_SERVER_NAME`（保留名校验） |
| `src/main.tsx:2082/2084` | `import('src/utils/computerUse/gates.js')` → `getChicagoEnabled`；`import('src/utils/computerUse/setup.js')` → `setupComputerUseMCP` |
| `src/services/mcp/client.ts:243-244` | `require('../../utils/computerUse/wrapper.js')` 懒加载 thunk |
| `src/services/mcp/client.ts:247-248` | `require('../../utils/computerUse/common.js').isComputerUseMCPServer` |
| `src/services/mcp/client.ts:939` | `await import('../../utils/computerUse/mcpServer.js')` → `createComputerUseMcpServerForCli`（in-process server 分支） |
| `src/services/mcp/client.ts:1998` | `computerUseWrapper!().getComputerUseMCPToolOverrides(tool.name)` |
| `src/services/mcp/config.ts:642-643` | `import('../../utils/computerUse/common.js')` → addMcpServer 保留名拒绝 |
| `src/services/mcp/config.ts:1517-1518` | `require('../../utils/computerUse/common.js').COMPUTER_USE_MCP_SERVER_NAME` → `DEFAULT_DISABLED_BUILTINS` |
| `src/services/analytics/metadata.ts:132-133` | 同上 → `BUILTIN_MCP_SERVER_NAMES`（遥测里区分内置 server） |
| `src/query.ts:1264` | `import('./utils/computerUse/cleanup.js')` → `cleanupComputerUseAfterTurn`（中断路径 A） |
| `src/query.ts:1686` | 同上（中断路径 B） |
| `src/query/stopHooks.ts:176` | `import('../utils/computerUse/cleanup.js')` → turn 结束清理 |
| `src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx:1-3` | `import {getSentinelCategory} from '@ant/computer-use-mcp/sentinelApps'`、`type {CuPermissionRequest,CuPermissionResponse}` + `DEFAULT_GRANT_FLAGS` from `@ant/computer-use-mcp/types` |

**软引用（删了不报错，只剩死字段）**
- `src/state/AppStateStore.ts:260-264`：`computerUseMcpState?` 字段的类型是**内联手写**的（注释明说「Types inlined，不从 `@ant/computer-use-mcp/types` import，好让外部 typecheck 在没有 ant-scoped 依赖时也能过」），删包不会破 typecheck，只会留下一个再没人写入的字段。
- `package.json:80-82` 三条 `workspace:*` 依赖需一并摘掉。
- `scripts/defines.ts:44` 的 `'CHICAGO_MCP'` 需从 `DEFAULT_BUILD_FEATURES` 移除（`build.ts` 和 `scripts/dev.ts` 都从这里读）。

**实际影响**：删除后 CLI 主流程只丢一段被 `try/catch` 包住的 MCP 注入（`main.tsx:2081-2094`，catch 里只 `logForDebugging`），以及 `query.ts`/`stopHooks.ts` 里同样被 `try{}catch{}` 吞掉的 turn 末清理。三处 `feature('CHICAGO_MCP')` 判定在 flag 关闭时本来就走不到。所以**功能上只损失 Computer Use 本身，不会连累其他子系统**——但因为这些 import 是静态可达的（`client.ts:244/248`、`config.ts:1518`、`metadata.ts:133` 是顶层 `require` 而非动态 import），必须同步删掉这 14 处引用，否则 typecheck 直接失败。


## Claude in Chrome（浏览器控制模块）

> **状态（2026-07-31）：已执行，但结论与本节的建议不同。** 这套扩展 + native host 链路
> 已整体删除，浏览器控制**没有被砍掉**，而是换成了 Google 官方的 `chrome-devtools-mcp`
> （stdio 子进程，`--chrome` 开启）。`--chrome` / `/chrome` / `CLAUDE_CODE_ENABLE_CFC`
> 全部保留并继续有效，保留名从 `claude-in-chrome` 变成 `chrome-devtools`。
> 下面的分析是删除前的现状快照，保留作为记录 —— **不要照着它的「功能性后果」一节做判断**。
> 当前实现见 `docs/features/chrome-devtools-mcp.md`。

### 1. 是什么 / 干什么用

**是什么**：Claude Code 控制用户**真实 Chrome 浏览器**的一整套链路，由两半组成：

- `packages/@ant/claude-for-chrome-mcp/` — 平台无关的 **MCP server 实现**（工具定义 + 三种传输通道），不依赖任何 `src/` 代码，被 CLI 和（注释里提到的）Desktop 复用。
- `src/utils/claudeInChrome/` — CLI 侧的**宿主胶水层**：注入 auth/config/analytics/日志的 `ClaudeForChromeContext`、Chrome native-messaging host 实现、扩展安装探测、system prompt、工具结果渲染。

**用户能做什么**：由 `packages/@ant/claude-for-chrome-mcp/src/browserTools.ts` 定义的 **20 个浏览器工具**（暴露为 `mcp__claude-in-chrome__*`），逐条列举（行号为该文件内 `name:` 所在行）：

| 工具 | 行 | 工具 | 行 |
|---|---|---|---|
| `javascript_tool` | 3 | `get_page_text` | 362 |
| `read_page` | 28 | `tabs_context_mcp` | 378 |
| `find` | 65 | `tabs_create_mcp` | 395 |
| `form_input` | 86 | `update_plan` | 406 |
| `computer`（点击/输入/截图） | 112 | `read_console_messages` | 429 |
| `navigate` | 212 | `read_network_requests` | 465 |
| `resize_window` | 233 | `shortcuts_list` | 496 |
| `gif_creator` | 257 | `shortcuts_execute` | 512 |
| `upload_image` | 323 | `switch_browser` | 537 |

即：导航、点页面元素、填表单、上传图片、执行 JS、截图/录 GIF、读 DOM/纯文本、读 console 与 network、管理标签页。关键差异点是它操作的是**用户已登录的真实浏览器会话**（不是 headless），所以能带着 OAuth/cookie 干活。

反向通道也有：`src/hooks/usePromptsFromClaudeInChrome.tsx:41-84` 监听扩展推来的 `notifications/message`，把用户在浏览器里输入的 prompt（可带 base64 图片）塞进 CLI 消息队列；`:87-96` 把 CLI 的权限模式同步回扩展（`bypassPermissions` → `skip_all_permission_checks`）。注意该 hook 的 prompt 部分被 `process.env.USER_TYPE !== 'ant'` 早退挡住，外部用户只有权限同步生效。

三种传输通道由 `packages/@ant/claude-for-chrome-mcp/src/mcpServer.ts:20-28` 选择：
1. **Bridge（WebSocket）** — `bridgeClient.ts`，连 `wss://bridge.claudeusercontent.com`（`src/utils/claudeInChrome/mcpServer.ts:53-74`），仅在 `USER_TYPE === 'ant'` 或 GrowthBook `tengu_copper_bridge` 开启时启用；
2. **Socket pool** — `mcpSocketPool.ts`，多 Chrome profile 时扫 `/tmp/claude-mcp-browser-bridge-<user>/*.sock`；
3. **单 socket** — `mcpSocketClient.ts`。

本地通道的另一端就是 native host：`src/utils/claudeInChrome/chromeNativeHost.ts` 用 Chrome native-messaging 协议（stdout 4 字节小端长度前缀，`sendChromeMessage` 在 `:50-57`）跟扩展通信，同时 `createServer()` 起一个 unix socket / Windows 命名管道（`getSecureSocketPath()` in `common.ts:481-487`：`/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` 或 `\\.\pipe\...`）供 MCP server 侧连入。

### 2. 怎么启动

**A. 隐藏子进程入口（不是给人敲的）**——`src/entrypoints/cli.tsx:106-115`，位于 `--version` 之后、绝大多数初始化之前：

```
if (process.argv[2] === '--claude-in-chrome-mcp')   → runClaudeInChromeMcpServer()  (src/utils/claudeInChrome/mcpServer.ts:250)
else if (process.argv[2] === '--chrome-native-host') → runChromeNativeHost()        (src/utils/claudeInChrome/chromeNativeHost.ts:59)
```

- `--claude-in-chrome-mcp`：以 stdio MCP server 身份跑，供外部 MCP 宿主 spawn。它被写进 MCP 配置里（`setup.ts:126-133` 和 `:153-161`），但**主 CLI 实际不会 spawn 它**——`src/services/mcp/client.ts:906-927` 命中 `isClaudeInChromeMCPServer(name)` 时改走**进程内**路径（`createChromeContext` + `createLinkedTransportPair`），注释写明"avoid spawning a ~325 MB subprocess"。
- `--chrome-native-host`：由 **Chrome 自己**拉起，不是用户敲的。`setup.ts:306-344` 的 `createWrapperScript()` 生成 `~/.claude/chrome/chrome-native-host[.bat]`（因为 native host manifest 的 `path` 字段不能带参数），`setup.ts:189-264` 的 `installChromeNativeHostManifest()` 把 manifest 写到各浏览器的 NativeMessagingHosts 目录，Windows 上还额外 `reg add`（`setup.ts:269-297`）。

**B. 用户可见的启用方式**（优先级见 `src/utils/claudeInChrome/setup.ts:39-68` 的 `shouldEnableClaudeInChrome`）：

1. `claude --chrome` / `claude --no-chrome` — 注册于 `src/main.tsx:1428-1429`，消费于 `:1990-2044`；
2. 环境变量 `CLAUDE_CODE_ENABLE_CFC=1`（`setup.ts:54-59`）；
3. 全局配置 `claudeInChromeDefaultEnabled`（`setup.ts:62-65`，字段声明 `src/utils/config.ts:501-502`、`:660-661`），可在 `/chrome` 菜单或 `/config`（`src/components/Settings/Config.tsx:964-975`）切换；
4. 非交互会话（SDK/CI）默认关闭，除非显式 `--chrome`（`setup.ts:41-43`）。

**C. `/chrome` 命令** — `src/commands/chrome/index.ts`（`name: 'chrome'`, `type: 'local-jsx'`, `isEnabled: () => !getIsNonInteractiveSession()`），注册在 `src/commands.ts:169` + `:279`。UI 在 `src/commands/chrome/chrome.tsx`，是个设置菜单：安装扩展 / 重连扩展 / 管理站点权限 / 切换默认启用，并显示连接状态与扩展检测状态。三个外链：`https://claude.ai/chrome`、`https://clau.de/chrome/permissions`、`https://clau.de/chrome/reconnect`（`chrome.tsx:14-16`）。**门槛在 `chrome.tsx:122`**：WSL 直接不支持，非 ant 用户必须是 claude.ai 订阅者。

**D. 自动启用（不加任何 flag）** — `shouldAutoEnableClaudeInChrome()`（`setup.ts:72-84`）在「交互式 + 缓存判定扩展已安装 + (ant 或 GrowthBook `tengu_chrome_auto_enable`)」时为真，于是 `src/skills/bundled/index.ts:59-61` 注册 `claude-in-chrome` bundled skill（`src/skills/bundled/claudeInChrome.ts`），`src/main.tsx:2028-2044` 只注入 MCP 配置 + skill 提示，工具靠 Skill 按需激活。

**E. 传播到子会话** — `src/main.tsx:1992` 存 `setChromeFlagOverride`，`src/utils/swarm/spawnUtils.ts:89-95` 把 `--chrome`/`--no-chrome` 透传给 tmux teammate。

**没有 feature flag**：grep 全仓无 `feature('CHROME...')` 之类门控，这套代码在任何构建里都编译进去（对比 Computer Use 走 `feature('CHICAGO_MCP')`）。

### 3. 是否需要浏览器扩展

**必须要，且是 Anthropic 官方的固定扩展 ID**。`src/utils/claudeInChrome/setup.ts:197-211` 的 manifest `allowed_origins` 硬编码：

```
chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/   // PROD_EXTENSION_ID
// USER_TYPE === 'ant' 时额外允许 DEV / ANT 两个 ID
```

没有扩展就没有 native-messaging 对端，也就没有任何浏览器工具可用。运行时的表现：

- `mcpServer.ts:118` 的 `onToolCallDisconnected` 直接返回提示语——要求安装扩展、用**同一个 claude.ai 账号**登录、首次安装后可能要重启 Chrome；
- `useChromeExtensionNotification.tsx:33-41` 在启动时探测不到扩展就弹 "Chrome extension not detected · https://claude.ai/chrome to install"；
- 扩展安装探测是**扫文件系统**而非握手：`setup.ts:389-398` → `setupPortable.ts` 遍历各 Chromium 浏览器 profile 的 Extensions 目录；结果缓存在 `cachedChromeExtensionInstalled`，且 `setup.ts:360-381` 明确**只缓存 true**（缓存 false 会在共享 `~/.claude.json` 的远程机器上永久毒化自动启用）。
- 额外前提：站点级权限由**扩展侧**管理，CLI 只能开链接过去（`chrome.tsx:169-172`）；`mcpServer.ts:112-116` 提示账号不匹配会认证失败。
- 扩展配对信息回写 CLI 配置：`mcpServer.ts:120-140` 的 `onExtensionPaired` 存 `chromeExtension.pairedDeviceId/Name`。

注：`docs/features/chrome-use-mcp.md` 描述的是**另一个东西**（第三方 `hangwin/mcp-chrome`，对应 `src/main.tsx:1869-1876` 里默认注册但默认禁用的 `mcp-chrome` HTTP server，端口 12306），跟本模块无关，别混淆。本模块当时的文档已重写为 `docs/features/chrome-devtools-mcp.md`。

### 4. 规模（文件数 + LOC）

| 部分 | 文件数 | LOC |
|---|---|---|
| `packages/@ant/claude-for-chrome-mcp/`（含 package.json / tsconfig.json） | 10（其中 src 下 8 个 .ts） | 3137（src .ts 部分 3124） |
| `src/utils/claudeInChrome/` | 7 | 2384 |
| **核心小计** | **17** | **5521** |
| 周边卫星代码（见下） | 6 | 474 |
| **合计** | **23** | **约 5995** |

拆细：

- 包内：`bridgeClient.ts` 1126、`browserTools.ts` 546、`mcpSocketClient.ts` 500、`mcpSocketPool.ts` 328、`toolCalls.ts` 304、`types.ts` 207、`mcpServer.ts` 95、`index.ts` 18。
- `src/utils/claudeInChrome/`：`common.ts` 540、`chromeNativeHost.ts` 527、`setup.ts` 398、`toolRendering.tsx` 308、`mcpServer.ts` 295、`setupPortable.ts` 233、`prompt.ts` 83。
- 卫星：`src/commands/chrome/chrome.tsx` 196、`src/hooks/usePromptsFromClaudeInChrome.tsx` 107、`src/components/ClaudeInChromeOnboarding.tsx` 70、`src/hooks/useChromeExtensionNotification.tsx` 54、`src/skills/bundled/claudeInChrome.ts` 34、`src/commands/chrome/index.ts` 13。

**测试：0 个**。`find`+grep 全仓 `*.test.ts*` 无一处引用 `claudeInChrome` 或 `claude-for-chrome`。

### 5. 删掉会怎样 —— 逐条会断的调用点

删 `packages/@ant/claude-for-chrome-mcp/` + `src/utils/claudeInChrome/` 后，以下位置**编译期直接报错**：

**入口与主流程**
- `src/entrypoints/cli.tsx:108` — `import('../utils/claudeInChrome/mcpServer.js')`
- `src/entrypoints/cli.tsx:113` — `import('../utils/claudeInChrome/chromeNativeHost.js')`
- `src/main.tsx:182-189` — 从 `prompt.js` 导入 `CLAUDE_IN_CHROME_SKILL_HINT` / `CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER`，从 `setup.js` 导入 `setupClaudeInChrome` / `shouldAutoEnableClaudeInChrome` / `shouldEnableClaudeInChrome`
- `src/main.tsx:271` — `CLAUDE_IN_CHROME_MCP_SERVER_NAME` / `isClaudeInChromeMCPServer`
- `src/main.tsx:1428-1429`（`--chrome`/`--no-chrome` 选项）、`:1944-1945`（保留名校验）、`:1993-2027`（启用分支）、`:2028-2044`（auto-enable 分支）、`:2770`（`enableClaudeInChrome` 传给 `showSetupScreens`）

**MCP 层**
- `src/services/mcp/client.ts:232`（import）、`:236-238`（`claudeInChromeToolRendering` 惰性 require）、`:911-916`（进程内 Chrome MCP server 启动）、`:1991`（`getClaudeInChromeMCPToolOverrides` 工具渲染覆写）
- `src/services/mcp/config.ts:9` + `:637-639`（拒绝用户添加名为 `claude-in-chrome` 的 MCP server）

**Prompt / 附件层**
- `src/services/api/claude.ts:167-168` + `:1427`（检测是否有 chrome 工具）+ `:1442`（注入 `CHROME_SEARCH_EXTRA_TOOLS_INSTRUCTIONS`）
- `src/utils/attachments.ts:178-179` + `:1623-1624`（mcp_instructions_delta 的客户端块）

**UI / Hook / 命令**
- `src/commands/chrome/chrome.tsx:8-9` → 整个 `src/commands/chrome/` 作废 → `src/commands.ts:169` 与 `:279` 的注册项必须删
- `src/hooks/useChromeExtensionNotification.tsx:3` → `src/screens/REPL.tsx:412` import + `:1020` 调用
- `src/hooks/usePromptsFromClaudeInChrome.tsx:8` → `src/screens/REPL.tsx:414` import + `:1053` 调用
- `src/components/ClaudeInChromeOnboarding.tsx:5` → `src/interactiveHelpers.tsx:294-295` 动态 import；连带 `:136` 的 `claudeInChrome?: boolean` 形参和 `:293` 的判断要清

**Skill**
- `src/skills/bundled/claudeInChrome.ts:1-3`（`BROWSER_TOOLS` + `BASE_CHROME_PROMPT` + `shouldAutoEnableClaudeInChrome`）
- `src/skills/bundled/index.ts:2`（import）、`:4`（import）、`:59-61`（`if (shouldAutoEnableClaudeInChrome()) registerClaudeInChromeSkill()`）

**配置 / 依赖**
- `package.json:79` — `"@ant/claude-for-chrome-mcp": "workspace:*"`
- `src/utils/config.ts:501-502`、`:660-661` — `hasCompletedClaudeInChromeOnboarding`、`claudeInChromeDefaultEnabled` 字段（不删只会留下死字段，不报错）
- `src/components/Settings/Config.tsx:964-975` — `claudeInChromeDefaultEnabled` 开关项（同上，读的是 config 不是 chrome 模块，不会编译失败但成了空开关）

**不会断但会失去意义**：`src/utils/swarm/spawnUtils.ts:6, 89-95` 只依赖 `src/bootstrap/state.ts:1225-1231` 的 `getChromeFlagOverride`，编译能过，但透传的 `--chrome` 会变成未知参数。`src/bootstrap/state.ts:1225-1231` 本身也变成死代码。

**功能性后果**：`--chrome` / `--no-chrome` / `/chrome` / `CLAUDE_CODE_ENABLE_CFC` 全部失效；`claude-in-chrome` 这个名字不再被保留，用户可以自己注册同名 MCP server；20 个 `mcp__claude-in-chrome__*` 工具消失；已安装的 native host manifest 和 `~/.claude/chrome/chrome-native-host` wrapper 会残留在磁盘上（代码里没有卸载路径，`setup.ts` 只有安装逻辑），Chrome 侧会指向一个再也不接受 `--chrome-native-host` 的二进制。

**删除代价评估**：无 feature flag 保护 + 零测试覆盖 + 25 处以上跨模块引用（横跨 entrypoint、main、MCP client/config、API prompt 构造、attachments、REPL hooks、skills、commands、config schema），属于"能删但拔线较多"的模块；相比之下 Computer Use 有 `feature('CHICAGO_MCP')` 包着，摘除成本低得多。


# 远程 / 分布式栈（一个集群，8 个子功能）

先给一张总账（`find` + `wc -l` 实测，源码与 `__tests__` 分开计）：

| 子功能 | 主目录 | 源文件 | 源 LOC | 测试文件 | 测试 LOC | Feature Flag |
|---|---|---|---|---|---|---|
| Bridge / 远程控制 | `src/bridge/` | 36 | 13,208 | 4 | 262 | `BRIDGE_MODE` |
| ACP agent（进程内） | `src/services/acp/` | 23 | 4,004 | 4 | 3,811 | `ACP` |
| ACP link（独立包） | `packages/acp-link/src/` | 27 | 3,944 | 3 | 642 | 无（独立 bin） |
| Daemon 守护进程 | `src/daemon/` | 3 | 697 | 2 | 246 | `DAEMON` |
| SSH 远程 | `src/ssh/` | 5 | 1,190 | 1 | 413 | `SSH_REMOTE` |
| Direct Connect | `src/server/` | 11 | 408 | 0 | 0 | `DIRECT_CONNECT` |
| Remote/CCR 会话客户端 | `src/remote/` | 4 | 1,141 | 0 | 0 | **无 flag，永远编进去** |
| CCR upstream 代理 | `src/upstreamproxy/` | 2 | 740 | 0 | 0 | **无 flag，靠环境变量** |
| 后台会话 | `src/cli/bg/` + `src/cli/bg.ts` | 6 | 608 | 3 | 60 | `BG_SESSIONS` |

这 6 个 flag（`BRIDGE_MODE`/`ACP`/`DAEMON`/`SSH_REMOTE`/`DIRECT_CONNECT`/`BG_SESSIONS`）**在 `scripts/defines.ts:38-119` 的 `DEFAULT_BUILD_FEATURES` 里全部默认开启**，dev 模式也全开。

---

## 1. `src/bridge/` — Remote Control / Bridge（`BRIDGE_MODE`）

**是什么**：把本机 CLI 注册成 Anthropic 控制面的一个「bridge 环境」，长轮询领任务、执行、回传。有 v1（env-based，`replBridge.ts` 2477 行）和 v2（env-less，`remoteBridgeCore.ts` 1055 行）两套实现并存。

**用户拿它干嘛**：在 claude.ai / 手机端 / 自建 RCS 上远程驱动这台机器的 Claude Code；权限请求弹到远端由用户批准（`bridgePermissionCallbacks.ts`）。

**怎么进**（三条口子）：
- CLI 快速路径：`claude remote-control` / `rc` / `remote` / `sync` / `bridge` → `src/entrypoints/cli.tsx:182-226` → `bridgeMain(args)`（`src/bridge/bridgeMain.ts:2001`）
- 交互会话内联开关：`--remote-control [name]` / `--rc [name]`（`src/main.tsx:4558-4571`，flag 门控）
- 斜杠命令：`/remote-control`（别名 `/rc`，`src/commands/bridge/index.ts:14-16`）和 `/remote-control-server`（别名 `/rcs`，`src/commands/remoteControlServer/index.ts`）

**规模的真实情况**：13.2k 行只是目录本身。它还有一圈卫星：`src/hooks/useReplBridge.tsx`(918)、`src/cli/transports/`(9 文件 3,309 行，`ccrClient.ts` 就 1012 行)、`src/commands/bridge/`(301)、`src/commands/remoteControlServer/`(310)、`src/components/BridgeDialog.tsx`、`src/commands/bridge-kick.ts`。**并且 `useReplBridge` 在 `src/screens/REPL.tsx:4652` 是无条件调用的**，`src/cli/print.ts:136-140` 也静态 import 了 4 个 bridge 模块。换句话说 bridge 已经长进主 REPL 和 headless 打印路径里了。

---

## 2. `src/services/acp/` — ACP agent（`ACP`）

**是什么**：把 Claude Code 变成一个符合 Agent Client Protocol 的 agent，走 stdio + NDJSON。`agent/`(9 文件) 是会话生命周期/prompt 流/权限模式，`bridge/`(8 文件) 是 Claude Code 消息 ↔ ACP 消息的双向翻译。

**用户拿它干嘛**：让 Zed 之类的 ACP 客户端把 Claude Code 当后端跑（见 `docs/features/acp-zed.md`）。

**怎么进**：只有一个口子 —— `claude --acp`，`src/entrypoints/cli.tsx:124-129` 命中后调 `runAcpAgent()`（`src/services/acp/entry.ts`）。没有斜杠命令，没有子命令。

**依赖**：实测把 `src/services/acp/` 全部 import 抽出来排重，外部依赖只有 `QueryEngine.js`、`Tool.js`、`tools.js`、`commands.js`、`bootstrap/state.js`、`state/AppStateStore.js`、`utils/*` 这些**核心模块**，**一条 `src/bridge/`、`src/remote/`、`src/daemon/` 的 import 都没有**。测试比源码还多（3,811 : 4,004）。

---

## 3. `packages/acp-link/` — ACP 代理服务器（独立包）

**是什么**：独立 npm 包（`package.json` 里 `"name": "acp-link"`，`bin: dist/cli/bin.js`），把 WebSocket 客户端桥到一个 ACP agent 子进程。自带 hono server、自签证书（`cert.ts`）、WS 鉴权（`ws-auth.ts`）、Manager Web UI（`manager/html.ts`）、以及往 RCS 注册的上游客户端（`rcs-upstream.ts`）。

**用户拿它干嘛**：`acp-link ccb-bun -- --acp` 起一个代理，让远端 Web 客户端或 RCS 连进来（`package.json` 的 dev 脚本就是这么写的）。

**怎么进**：**完全不经过主 CLI**。自己的 `bin`，flag 有 `--port/--host/--debug/--no-auth/--https/--manager/--group`（`packages/acp-link/src/cli/command.ts`）。

**关键事实**：在 `src/`、根 `package.json`、`build.ts`、`scripts/` 全量 grep `acp-link`，**只有一条注释命中**（`src/services/acp/agent/createSessionMethod.ts:109` 提到 "passed by RCS/acp-link"）。它是 workspace 成员但**不被主 CLI import**，定位跟 `packages/remote-control-server/` 一样是独立部署件。

---

## 4. `src/daemon/` — 守护进程（`DAEMON`）

**是什么**：只有 3 个源文件、697 行。`main.ts`(428) 是 supervisor（spawn worker + 指数退避重启 + 状态文件），`state.ts`(157) 读写 PID 文件，`workerRegistry.ts`(112) 是 worker 入口。

**用户拿它干嘛**：让一台机器常驻接远程控制任务，进程崩了自动拉起。

**怎么进**：
- `claude daemon [start|stop|status|ps|bg|attach|logs|kill]` → `src/entrypoints/cli.tsx:231-242` → `daemonMain()`
- 内部：`claude --daemon-worker=<kind>`（supervisor 自己 spawn 的，`cli.tsx:164-176`）
- 斜杠命令 `/daemon`（`src/commands/daemon/index.ts`）

**这是整个集群里耦合最硬的一处**：`src/daemon/workerRegistry.ts:2-6` 直接 `import { runBridgeHeadless, BridgeHeadlessPermanentError } from '../bridge/bridgeMain.js'`，而且 `main.ts:236-246` 里 supervisor 的 worker 列表**只有一个 kind：`'remoteControl'`**，`workerRegistry.ts:33-40` 的 switch 也只认这一个。**没有 bridge，daemon 就是个空壳 supervisor，什么都管不了。**

---

## 5. `src/ssh/` — SSH 远程（`SSH_REMOTE`）

**是什么**：5 个文件 1,190 行。`SSHProbe.ts` 探远端平台/架构、`SSHDeploy.ts` 把 dist 传过去、`SSHAuthProxy.ts` 在本地起认证代理、`createSSHSession.ts`(12.7KB) 用 `ssh -R` 反向隧道把认证打回本地、`SSHSessionManager.ts` 管 NDJSON 收发。

**用户拿它干嘛**：`claude ssh user@host /path` —— 远端不用装 ccb、不用登录，二进制自动部署，API 认证隧道回本机；UI 在本地 Ink 渲染，工具在远端执行（`docs/features/ssh-remote.md`）。

**怎么进**：`claude ssh <host> [dir]`。实际流程是 `src/main.tsx:865-...` 早期 argv 改写把 `ssh <host>` 吃掉，然后 `src/main.tsx:3775-3850` 分支建会话；`src/main.tsx:4768-4799` 只注册了个占位 command 让 `--help` 能显示。flag：`--permission-mode` / `--dangerously-skip-permissions` / `--remote-bin` / `--local`（e2e 测试模式）。不支持 `-p`。

**依赖**：`src/hooks/useSSHSession.ts:18-22` import 了 `../remote/remotePermissionBridge.js` 和 `../remote/sdkMessageAdapter.js`。**SSH 依赖 `src/remote/`，但不依赖 bridge/daemon/acp。**

---

## 6. `src/server/` — Direct Connect（`DIRECT_CONNECT`）

**是什么**：名字叫 server，**实际上服务端几乎全是桩**。408 行里，8 个文件是 `// Auto-generated stub`：`server.ts`(6)、`sessionManager.ts`(7)、`serverBanner.ts`(3)、`serverLog.ts`(3)、`lockfile.ts`(15)、`parseConnectUrl.ts`(7)、`connectHeadless.ts`(4)、`backends/dangerousBackend.ts`(5)。真代码只有 3 个：`directConnectManager.ts`(213，客户端 WebSocket)、`createDirectConnectSession.ts`(88，POST `/sessions`)、`types.ts`(57)。

**用户拿它干嘛**：理论上 `claude server` 起会话服务端、别人用 `cc://` URL 连进来。**当前 `claude server` 跑起来是无效的** —— `src/main.tsx:4692-4760` 那段 action 调的 `startServer`/`SessionManager`/`DangerousBackend` 全是空实现。客户端一侧（`claude open cc://...`）是真的。

**怎么进**：
- `claude server --port/--host/--auth-token/--unix/--workspace/--idle-timeout/--max-sessions`（`src/main.tsx:4681-4761`）
- `claude open <cc-url>`（`src/main.tsx:4804-...`，headless）
- 交互式：argv 里出现 `cc://` 或 `cc+unix://` 会被 `src/main.tsx:780-809` 提前截走改写

**依赖**：`src/server/directConnectManager.ts:8` import `../remote/RemoteSessionManager.js` 的类型；`src/hooks/useDirectConnect.ts:3-11` import 了 `src/remote/` 的三个模块。**依赖 `src/remote/`。**

---

## 7. `src/remote/` — CCR / Teleport 会话客户端（**没有 feature flag**）

**是什么**：4 个文件 1,141 行。`SessionsWebSocket.ts`(12.5KB，带重连/ping/close-code 处理)、`RemoteSessionManager.ts`(9.4KB)、`sdkMessageAdapter.ts`(9.5KB，SDKMessage ↔ 内部 Message)、`remotePermissionBridge.ts`(2.4KB)。

**用户拿它干嘛**：`claude --remote "任务描述"` 在 Claude Code Web（CCR）上开云端会话，`claude --teleport [session]` 恢复；`claude assistant` 附着到助手会话看历史。

**怎么进**：`--teleport [session]` 和 `--remote [description]`，注册在 `src/main.tsx:4552-4558`，**注意这两个 option 外面没有任何 `feature()` 包裹**，而且 `src/main.tsx:332` 是**静态 import** `createRemoteSessionConfig`。

**它是这个集群的公共底座**：被 `src/hooks/useRemoteSession.ts`(616)、`useDirectConnect.ts`(232)、`useSSHSession.ts`(243)、`useAssistantHistory.ts`、`src/server/directConnectManager.ts`、`src/screens/REPL.tsx:472` 共同引用。REPL 里三条远程通道最后汇到一行：`src/screens/REPL.tsx:1728` 的 `const activeRemote = sshRemote.isRemoteMode ? sshRemote : directConnect.isRemoteMode ? directConnect : remoteSession`。

---

## 8. `src/upstreamproxy/` — CCR 出网代理（**没有 feature flag**）

**是什么**：2 个文件 740 行。`upstreamproxy.ts`(9.8KB) 做容器侧装配：读 `/run/ccr/session_token`、`PR_SET_DUMPABLE(0)`、下载 MITM CA 拼进系统 bundle、删 token 文件、导出 `HTTPS_PROXY`/`SSL_CERT_FILE`；`relay.ts`(15KB) 是 CONNECT→WebSocket 中继（协议是 protobuf `UpstreamProxyChunk`）。

**用户拿它干嘛**：用户根本碰不到。只在 CCR 云容器里跑，让 `curl`/`gh`/`python` 走组织配置的上游并自动注入凭据。全链路 fail-open。

**怎么进**：没有 CLI 入口。双重环境变量门控 —— `src/entrypoints/init.ts:196` 先看 `CLAUDE_CODE_REMOTE` 真值才动态 import，进去后 `src/upstreamproxy/upstreamproxy.ts:85,92` 再检查 `CLAUDE_CODE_REMOTE` + `CCR_UPSTREAM_PROXY_ENABLED`。对主 CLI 的唯一反向连接是 `src/utils/subprocessEnv.ts:73` 的 `registerUpstreamProxyEnvFn` 回调注册（刻意用回调避免静态 import）。

---

## 9. `src/cli/bg/` — 后台会话（`BG_SESSIONS`）

**是什么**：最小的一块。`src/cli/bg.ts`(338) 是 ps/logs/attach/kill/start 五个 handler，`src/cli/bg/engine.ts`(约 50) 定义 `BgEngine` 接口，`engines/tmux.ts` 和 `engines/detached.ts` 两个后端，`engines/index.ts` 的 `selectEngine()` 按平台/tmux 可用性选（Windows 强制 detached），`tail.ts` 是跨平台 `watchFile` 轮询式日志跟随。

**用户拿它干嘛**：把一次 Claude Code 跑到后台，之后 attach 回去或看日志。detached 引擎没 TTY，所以强制要求 `-p`/`--print`/`--pipe`（`src/cli/bg.ts:287-306`）。

**怎么进**：
- `claude --bg` / `--background`（`src/entrypoints/cli.tsx:266-275`）
- `claude daemon bg|attach|logs|kill`（`src/daemon/main.ts:71-90` 全是 `await import('../cli/bg.js')`）
- 废弃别名 `claude ps|logs|attach|kill`（`cli.tsx:278-294`，会打 `[deprecated]`）
- 斜杠命令 `/daemon <sub>`

**依赖**：几乎为零。会话清单读的是共享注册表 `src/utils/concurrentSessions.ts`（`~/.claude/sessions/`），跟 bridge 的唯一接触点是 `src/cli/bg.ts:103` 打印一个可选的 `bridgeSessionId` 字段。

---

# 依赖总结

## 实测到的边（全部经 grep import 验证）

```
daemon ──硬依赖──▶ bridge          (workerRegistry.ts:2-6，唯一 worker kind = remoteControl)
daemon ──软依赖──▶ cli/bg          (main.ts:71-90，动态 import，缺了只是子命令报错)
bridge ──依赖───▶ cli/transports/  (ccrClient / SSETransport / HybridTransport)
ssh    ──依赖───▶ remote/          (useSSHSession.ts:18-22)
server ──依赖───▶ remote/          (directConnectManager.ts:8, useDirectConnect.ts:3-11)
remote ──依赖───▶ utils/teleport/api.ts  (但这是全项目共享的 HTTP 客户端，非本集群专有)

acp          ──▶ 只依赖核心（QueryEngine/tools/commands），零集群内依赖
acp-link     ──▶ 独立进程，零主 CLI 引用
upstreamproxy──▶ 只被 init.ts 动态 import，零集群内依赖
cli/bg       ──▶ 只依赖 utils/concurrentSessions（核心）
```

## 可以独立摘掉的（4 个）

- **`src/services/acp/`（ACP）** —— 最干净。删掉只需要拆 `cli.tsx:124-129` 一个 if。4,004 行源码 + 3,811 行测试一起走。
- **`packages/acp-link/`** —— 主 CLI 一行都没引用，整包删掉主 CLI 零感知。3,944 行。
- **`src/upstreamproxy/`** —— 删掉只需拆 `init.ts:196-211` 和 `utils/subprocessEnv.ts:64-85` 的注册钩子。740 行。
- **`src/cli/bg/` + `bg.ts`（BG_SESSIONS）** —— 独立，但 `daemon/main.ts` 有 4 个 case 动态 import 它，删了要一并处理。608 行。

## 必须打包一起走的（bundle）

**Bundle A：`bridge + daemon`（约 13.9k 行 + 卫星）**
`daemon` 的全部业务价值就是跑 `runBridgeHeadless`。先删 bridge，daemon 立刻失去唯一 worker；先删 daemon，bridge 只是少了常驻能力，仍能用 `claude remote-control` 前台跑。所以**方向是单向的：可以只删 daemon，不能只删 bridge**。

**Bundle B：`remote + ssh + server(DirectConnect)`（约 2.7k 行 + 1.1k 行 hooks）**
`src/remote/` 是 SSH 和 Direct Connect 共同的消息适配 + 权限桥 + WebSocket 层。删 `src/remote/` 会同时打断 `useSSHSession`、`useDirectConnect`、`useRemoteSession`、`useAssistantHistory` 和 `REPL.tsx:1728` 的三路 `activeRemote` 收敛点。反过来 **SSH 和 DirectConnect 彼此独立**，可以任意单删一个。

## 两个必须点名的现实约束

1. **`src/remote/` 没有 feature flag，且 `src/main.tsx:332` 是静态 import。** 它不是可选件，是永远编进产物的 REPL 基础设施。`--remote` / `--teleport` 两个 option（`main.tsx:4552-4558`）外面也没有 `feature()` 包裹。

2. **BRIDGE_MODE 名义上是 flag，实际已经渗进主路径。** `src/screens/REPL.tsx:4652` 无条件调 `useReplBridge`，`src/cli/print.ts:136-140` 静态 import 4 个 bridge 模块，另有 `Spinner.tsx`、`PromptInputFooter.tsx`、`Settings/Config.tsx`、`commands/login`、`commands/logout`、`commands/clear` 等 20+ 处引用（完整清单见上文 grep 结果）。把 `FEATURE_BRIDGE_MODE` 关掉能 DCE 掉重逻辑，但**物理删除 `src/bridge/` 目录会牵动整个 REPL/print/commands/components 层**，这是集群里成本最高的一次拆除。

**`src/server/` 额外提醒**：它 11 个文件里 8 个是 `// Auto-generated stub`，`claude server` 子命令目前是死的 —— 如果目标是精简，这块 408 行里真正有价值的只有客户端那 3 个文件（358 行）。


## 多 Agent Swarm / Coordinator 系统

### 1) 是什么 / 干什么用

这其实是**两套独立的多 Agent 机制**，共享 `AgentTool` 和 `src/tasks/` 运行时，但抽象完全不同。`docs/agent/coordinator-and-swarm.mdx` 明确写了：「Coordinator Mode 不是 Swarm 的特殊 Team Lead」。

**(A) Coordinator Mode（`src/coordinator/`，feature flag `COORDINATOR_MODE`）— 星型编排器**

把主 Claude 降级为「只编排、不动手」的协调者：

- `src/coordinator/coordinatorMode.ts:111` `getCoordinatorSystemPrompt()` 返回一份 ~250 行的编排者系统提示（替换默认系统提示），规定 coordinator 只能用 `Agent` / `SendMessage` / `TaskStop` 三个工具，worker 结果以 `<task-notification>` XML 的 user-role 消息回流。
- `src/coordinator/workerAgent.ts:41` 定义唯一的内置 agent `worker`，工具集 = `ASYNC_AGENT_ALLOWED_TOOLS` 减去 `TeamCreate/TeamDelete/SendMessage/SyntheticOutput`。
- 关键副作用：`packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts:33-41` — coordinator 模式开启时 `getBuiltInAgents()` **只返回 worker**，general-purpose / Explore / Plan 全部消失。
- 主线程工具被裁剪到 `COORDINATOR_MODE_ALLOWED_TOOLS`（`src/constants/tools.ts:124`，仅 4 个）：`src/utils/toolPool.ts:73` `applyCoordinatorToolFilter`。
- 用户拿它做：大任务拆分 → 并行 research → 自己 synthesize → 派 worker 实现 → 派 worker 验证。

**(B) Agent Teams / Swarm（`src/utils/swarm/`）— 团队型长生命周期队友**

- `TeamCreate` 建团 → 写 `~/.claude/teams/<team>/config.json`（`TeamCreateTool.ts:164-187`）+ 同名共享任务白板 `~/.claude/tasks/<team>/`（`:191-198`）。
- `Agent({ name, team_name, prompt })` 走 teammate 分支（`AgentTool.tsx:375-408`）→ `spawnTeammate()`（`packages/builtin-tools/src/tools/shared/spawnMultiAgent.ts:410`）。
- 后端由 `src/utils/swarm/backends/registry.ts:519` `getTeammateExecutor()` 选择，四种：`TmuxBackend` / `ITermBackend`（需 it2 CLI）/ `WindowsTerminalBackend`（wt.exe）/ `InProcessBackend`（同进程 AsyncLocalStorage，`src/utils/swarm/inProcessRunner.ts` 1600+ 行）。auto 模式下无 pane backend 就回落 in-process（`registry.ts:536-544`）。
- 队友之间靠 **mailbox** 通信（`src/utils/teammateMailbox.ts` 1461 行 + `SendMessageTool`），不是 `<task-notification>`。队友每轮结束自动 idle 并发通知（见 `TeamCreateTool/prompt.ts` 的 Team Workflow 段）。
- `TeamDelete` 收尾；`src/entrypoints/init.ts:224-229` 注册 session 结束时 `cleanupSessionTeams()` 兜底清理。
- `src/utils/teamDiscovery.ts:39` `getTeammateStatuses()` 只是个薄读取层，把 `config.json` 的 members 转成 UI 状态（running/idle/hidden/mode），给 `TeamsDialog.tsx:72` 和 `src/utils/autonomyStatus.ts:71` 用。

**(C) `src/tasks/` — 不是 swarm 专属**。它是通用后台运行时任务注册表（`src/tasks.ts` 注册 `LocalShellTask` / `LocalAgentTask` / `RemoteAgentTask` / `DreamTask` / `LocalWorkflowTask` / `MonitorMcpTask`）。其中**只有 `src/tasks/InProcessTeammateTask/`（2 文件 292 行）是 swarm 专属**，且它不在 `getAllTasks()` 里，由 `InProcessBackend.ts` 直接驱动。

### 2) 怎么启动

**Coordinator：两层门都要开**
- 构建/运行 gate：`feature('COORDINATOR_MODE')`（`scripts/defines.ts:64` 已在默认 build features 里；dev 模式全开）
- 进程 gate：`CLAUDE_CODE_COORDINATOR_MODE=1`
- 用户入口只有一个 slash command：`/coordinator`（`src/commands/coordinator.ts:16-61`，切换 env var 并注入 system-reminder）。注册在 `src/commands.ts:90-91,342`。
- 会话恢复时 `matchSessionMode()`（`coordinatorMode.ts:49`）按 transcript 里存的 mode 自动翻转 env var，调用点在 `src/cli/print.ts:5123,5328`、`src/screens/REPL.tsx:2119`、`src/screens/ResumeConversation.tsx:240`。
- 手动：`FEATURE_COORDINATOR_MODE=1 CLAUDE_CODE_COORDINATOR_MODE=1 bun run dev`（`docs/features/coordinator-mode.md:22`）。

**Swarm/Teams：默认开着，没有 feature flag，主要靠模型自己调工具**
- gate 是**反向**的：`src/utils/agentSwarmsEnabled.ts:11-17` — 只有设了 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_DISABLED` 才关，否则永远 `true`。
- `TeamCreateTool` / `TeamDeleteTool` / `SendMessageTool` 无条件注册进工具池（`src/tools.ts:232-234`），`TeamCreateTool.isEnabled()` 直接 `return true`（`:89-91`）。`shouldDefer: true`，所以走 tool-search 按需加载。
- 模型侧入口：`TeamCreate` 的 prompt 明确写「When in doubt about whether a task warrants a team, prefer spawning a team」（`TeamCreateTool/prompt.ts:6-11`），也就是**模型可以自主起团**，用户不需要敲任何命令。
- UI 入口：底部 footer 的 `teams` pill（`PromptInput.tsx:514,525,1936-1939`），仅当已有 team 时出现（`teamsFooterVisible = cachedTeams.length > 0`），打开 `TeamsDialog`。
- 被 spawn 出来的 teammate 进程通过隐藏 CLI flag 接身份：`--agent-id` / `--agent-name` / `--team-name` / `--agent-color` / `--teammate-mode` / `--agent-type` / `--plan-mode-required` / `--parent-session-id`（`src/main.tsx:4531-4542`；三个必填项必须同时给，`:1622-1630`）。
- 后端模式可在 `/config` 里选（`src/components/Settings/Config.tsx` → `teammateModeSnapshot.ts`），启动时由 `src/setup.ts:98-103` 快照一次。
- 附带：KAIROS 助手模式会**预建一个 in-process team**（`src/assistant/index.ts:52` `initializeAssistantTeam()`），让 `Agent(name:)` 不用先 `TeamCreate` 就能起队友。

### 3) 和普通 AgentTool subagent 的关系 —— 普通 subagent 不需要 swarm

**不需要。** `AgentTool.call()` 是三岔路，swarm 只占其中一条：

```
AgentTool.tsx:375   if (teamName && name)  → spawnTeammate()        ← swarm 路径
AgentTool.tsx:414   effectiveType = subagent_type ?? (fork? …)      ← fork 路径
AgentTool.tsx:443+  found = agents.find(...) → runAgent()           ← 普通 subagent 路径
```

- 进入 swarm 分支需要 **同时** 有 `name` 和 `teamName`。`resolveTeamName()`（`AgentTool.tsx:1603-1607`）在 `isAgentSwarmsEnabled()` 为 false 时直接返回 `undefined`，即整条分支被短路。
- 普通路径的执行器 `packages/builtin-tools/src/tools/AgentTool/runAgent.ts`（959 行）**零 swarm import** —— grep 只命中两条注释（`:286`、`:725`）。
- Coordinator 对普通 subagent 是**行为覆盖**而非依赖：`AgentTool.tsx:341` 强制忽略 `model` 参数、`:694-714` 强制 `shouldRunAsync`、`builtInAgents.ts:33` 把可选 agent 缩到只剩 `worker`。关掉 coordinator，这些覆盖全部消失，普通 subagent 恢复原样。
- 反向依赖是有的但很浅：普通 subagent 的**异步/后台**形态依赖 `src/tasks/LocalAgentTask/`（`AgentTool.tsx:17-32` 静态 import 13 个符号），而 `src/tasks/` 不是 swarm 专属模块。

一句话：**swarm 是 AgentTool 的一个可选出口，不是 subagent 的底座。**

### 4) 规模（文件数 + LOC）

题目点名的六块：

| 目标 | 文件数 | LOC |
|---|---|---|
| `src/utils/swarm/`（含 5 个测试文件） | 28 | 9294 |
| `src/utils/swarm/`（不含测试） | 23 | 8399 |
| `src/coordinator/` | 2 | 436 |
| `src/tasks/`（含 2 个测试；其中仅 `InProcessTeammateTask/` 2 文件 292 行属 swarm） | 16 | 4689 |
| `packages/builtin-tools/src/tools/shared/spawnMultiAgent.ts` | 1 | 415 |
| `TeamCreateTool/` + `TeamDeleteTool/` | 8 | 643 |
| `src/utils/teamDiscovery.ts` | 1 | 78 |
| **合计** | **56** | **15555** |

`src/utils/swarm/` 内部大头：`inProcessRunner.ts` 1600+ 行（57KB）、`permissionSync.ts`（26KB）、`teamHelpers.ts`（21KB）、`It2SetupPrompt.tsx`（10KB）、`backends/` 10 文件。

题目没点名、但同属这套系统、删掉必须一起处理的外围（约 25 文件 / ~6300 LOC）：
`SendMessageTool/`(4/863)、`src/utils/teammateMailbox.ts`(1461)、`src/hooks/useInboxPoller.ts`(969)、`src/components/teams/`(2/693)、`src/hooks/useSwarmPermissionPoller.ts`(330)、`src/utils/teammate.ts`(291)、`src/components/Spinner/TeammateSpinnerLine.tsx`(253)、`src/components/CoordinatorAgentStatus.tsx`(213)、`src/components/PromptInput/useSwarmBanner.ts`(161)、`src/components/tasks/InProcessTeammateDetailDialog.tsx`(160)、`swarmWorkerHandler.ts`(159)、`TeammateSpinnerTree.tsx`(110)、`inProcessTeammateHelpers.ts`(102)、`teammateContext.ts`(96)、`useSwarmInitialization.ts`(81)、`useTeammateShutdownNotification.ts`(78)、`mailbox.ts`(73)、`directMemberMessage.ts`(69)、`useTeammateViewAutoExit.ts`(63)、`src/commands/coordinator.ts`(63) 等。

**整个生态约 81 文件 / ~21,800 LOC。**

### 5) 删掉会怎样

#### 5.1 删 `src/coordinator/`（436 行）—— 影响可控

**静态 import，直接编译失败（4 处，无 feature gate）：**
- `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx:9` → 用于 `:341`（`const model = isCoordinatorMode() ? undefined : modelParam`）
- `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts:9` → `:34`
- `packages/builtin-tools/src/tools/AgentTool/resumeAgent.ts:4` → `:252`
- `src/components/tasks/BackgroundTasksDialog.tsx:4` → `:794`

**feature-gated lazy require（flag 关时被 DCE 掉，但 typecheck 仍会报）：**
- `src/main.tsx:119-121` → `:2714`、`:4404`、`:5525`
- `src/tools.ts:129` → `:288`、`:300`
- `src/cli/print.ts:367` → `:5123`、`:5173`、`:5328`、`:5373`
- `src/QueryEngine.ts:123-125` → `:289`
- `src/screens/REPL.tsx:200-204` → `:3440`；另 `:2119`、`:2277`
- `src/utils/systemPrompt.ts:68-72`
- `src/utils/toolPool.ts:73`
- `src/screens/ResumeConversation.tsx:240,279-282`
- `src/components/PromptInput/PromptInputFooterLeftSide.tsx:292`
- `src/commands/clear/conversation.ts:271-274`
- `src/commands/coordinator.ts:34`（整个命令随之删除）
- `packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts:36-39`（引 `workerAgent.js`）
- `src/utils/sessionRestore.ts:276-277` 只是结构化接口（`modeApi` 依赖注入），删掉后变成 dead field，不会编译失败

**普通 Agent 工具：完全正常。** 删完这些引用点后，`getBuiltInAgents()` 恢复返回 general-purpose/Explore/Plan，`model` 参数恢复生效，工具池不再被裁剪。

#### 5.2 删 `src/utils/swarm/` + Team 工具 + `spawnMultiAgent.ts` + `teamDiscovery.ts` —— 影响很大

**必须同步改的静态 import 点（全部无 feature gate，删了就编译不过）：**

工具层：
- `packages/builtin-tools/src/tools/shared/spawnMultiAgent.ts:15-33`（7 条 swarm import）
- `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx:71` → `:383-407` 整个 teammate 分支
- `TeamCreateTool/TeamCreateTool.ts:16-26`（5 条）、`TeamDeleteTool/TeamDeleteTool.ts`（6 条）
- `SendMessageTool/SendMessageTool.ts`（3 条）
- `src/tools.ts:71-79, 232-234`（三个工具的 lazy require + 注册）

启动/主流程：
- `src/main.tsx:113,115` + `reconnection.js`；`:1612-1650` 的 teammate CLI 选项处理；`:4531-4542` 的 flag 定义
- `src/setup.ts:98-103`（`captureTeammateModeSnapshot`）
- `src/entrypoints/init.ts:224-229`（`cleanupSessionTeams` cleanup 注册）
- `src/cli/print.ts:354`（`removeTeammateFromTeamFile`）
- `src/screens/REPL.tsx:86,92,111`
- `src/assistant/index.ts:8,15,16` —— **KAIROS 助手模式会一起坏**，`initializeAssistantTeam()` 无法建团

Hook / UI 层：
- `src/hooks/useInboxPoller.ts`（7 条）、`useSwarmInitialization.ts`（3 条）、`useSwarmPermissionPoller.ts`、`useReplBridge.tsx`、`useTypeahead.tsx:37`
- `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts`
- `src/components/PromptInput/PromptInput.tsx`、`PromptInputFooterLeftSide.tsx`、`useSwarmBanner.ts`
- `src/components/teams/TeamsDialog.tsx`（5 条）、`src/components/Settings/Config.tsx`、`src/components/tasks/BackgroundTasksDialog.tsx`
- `src/utils/teamDiscovery.ts:8-9` → 连带 `src/utils/autonomyStatus.ts:71` 失效
- `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` → `spawnInProcess.js`；`src/utils/swarm/backends/InProcessBackend.ts` 反向依赖 `InProcessTeammateTask`

**普通 Agent 工具：仍然可用**，前提是删掉 `AgentTool.tsx:71` 的 import 和 `:375-408` 的分支。因为 `runAgent.ts` 对 swarm 零依赖，同步 subagent、后台 subagent、fork subagent 三条路径都不经过 swarm。

#### 5.3 删 `src/tasks/` —— 不能删

这是通用后台任务运行时，**跟 swarm 无关的东西会大面积炸**：
- `src/tasks.ts:3-14` 注册表
- `AgentTool.tsx:17-32` 静态 import `LocalAgentTask` 的 13 个符号 → **普通异步 subagent 直接不可用**
- `AgentTool.tsx:33-39` import `RemoteAgentTask`
- `src/cli/print.ts:357-358`、`src/screens/REPL.tsx`、`src/components/Spinner.tsx`、`BackgroundTasksDialog.tsx`、`src/state/selectors.ts:6-7`、`src/commands/ultraplan.tsx`、`src/commands/autofix-pr/launchAutofixPr.ts`、`src/commands/review/reviewRemote.ts`、`src/commands/monitor.ts` 等数十处

如果只想去 swarm，**只删 `src/tasks/InProcessTeammateTask/`（2 文件 / 292 行）**，同时清掉约 20 处引用（`Spinner.tsx:25,28`、`REPL.tsx:98,343`、`useBackgroundTaskNavigation.ts:15-20`、`state/selectors.ts:6-7`、`tasks/types.ts:5,16,26` 等）。

### 结论速览

| 问题 | 答案 |
|---|---|
| Coordinator 必需吗 | 否，纯 opt-in，`/coordinator` 切换，删掉后普通 subagent 完全正常 |
| Swarm 必需吗 | 对普通 subagent 否；但它默认开着、深度渗入 UI/hooks/启动流程，删除成本远高于 coordinator |
| `src/tasks/` 必需吗 | **是**，普通异步 subagent 直接依赖 `LocalAgentTask` |
| 最小可删单元 | `src/coordinator/`（436 行，~20 处引用） |
| 最大牵连 | `src/utils/swarm/`（8399 行非测试代码，40+ 处静态 import，含 KAIROS 助手模式） |


# A. Workflow 引擎（`packages/workflow-engine/` + `src/workflow/`，flag `WORKFLOW_SCRIPTS`）

## 是什么

一套**确定性多 agent 编排引擎**，分成两层：

- **引擎层 `packages/workflow-engine/`** —— 独立可发布 npm 包 `@claude-code-best/workflow-engine`（`packages/workflow-engine/package.json`，version 0.1.0，MIT，`"sideEffects": false`，仅依赖 `ajv` + `zod`）。核心层零业务依赖，全部通过**端口适配器**（`src/ports.ts`）跟外界对话：agent runner、journal store、progress sink 都由宿主注入。
- **集成层 `src/workflow/`** —— 把引擎接到 Claude Code 真实会话体系上：真实子 agent 后端、进度总线、磁盘持久化、Ink 监控面板、权限 UI。

用户脚本是**普通 JS 脚本**，不是 YAML。注意 `scripts/defines.ts:61` 的注释 `// 工作流脚本（.claude/workflows/ 中的 YAML/MD）` 已过时——真实扩展名见 `packages/workflow-engine/src/constants.ts`：

```ts
export const WORKFLOW_SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs'] as const
```

脚本被当作 `new AsyncFunction` 的**函数体**执行（`packages/workflow-engine/src/engine/script.ts`），所以禁 `import`、禁 TS 类型语法（引擎不转译，`.ts` 里写类型注解会直接语法错），只允许一处 `export const meta = {...}` 纯字面量，靠顶层 `return` 返回结果。沙箱另外禁掉 `Date.now()` / `Math.random()` / 无参 `new Date()` 来保证 journal 可重放。

## 干什么用

给模型/用户一个"可确定性重放、可 resume、可审计"的多 agent 分解手段。注入到脚本里的原语（`packages/workflow-engine/src/engine/hooks.ts`）：

| 原语 | 语义 |
|------|------|
| `agent(prompt, opts?)` | 派发一个真实子 agent；带 `opts.schema` 时走结构化输出 |
| `parallel([...thunks])` | 并发 + barrier；单项抛错该项变 `null`，其余保留 |
| `pipeline(items, s1, s2…)` | 每 item 串过各 stage，item 之间无 barrier |
| `phase(title)` / `log(msg)` | 分组与进度日志（面板按 phase 分组） |
| `workflow(name, args?)` | 嵌套一层子 workflow（仅允许一层） |

硬上限在 `packages/workflow-engine/src/constants.ts`：`DEFAULT_MAX_CONCURRENCY = 3`、`MAX_CONCURRENCY_CAP = 16`、`MAX_TOTAL_AGENTS = 1000`、`MAX_ITEMS_PER_CALL = 4096`。

`agent()` 不是 stub —— `src/workflow/backends/claudeCodeBackend.ts` 直接 `import { runAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/runAgent.js'`，从 `toolUseContext.options.agentDefinitions.activeAgents` 解析 agentType，解析不到就回落到 `WORKFLOW_AGENT`（`claudeCodeBackend.ts:36`，agentType `'workflow-worker'`，`tools: ['*']`）。

## 用户要做什么（`.claude/workflows/`）

在项目根建 `.claude/workflows/<name>.js`（`WORKFLOW_DIR_NAME = '.claude/workflows'`），例如：

```js
export const meta = { name: 'review-changes', description: '...', phases: [{ title: 'Review' }] }
const results = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { phase: 'Review' })))
return results.filter(Boolean)
```

`src/workflow/namedWorkflowCommands.ts:10-33` 扫这个目录，为每个脚本合成一条 `type: 'prompt'`、`kind: 'workflow'` 的 `/<name>` 命令，其 prompt 文本就是让模型 `Run the "<name>" workflow now by calling the Workflow tool with name="<name>"`。

**注意：本仓库当前没有 `.claude/workflows/` 目录**（已确认不存在），所以开箱没有任何 `/<name>` 命令；只有 `.claude/workflow-runs/run-1|run-2/script.js`（内容都是 `return agent('x')`），是测试残留。

## 怎么启动（三个入口）

1. **`Workflow` 工具**（模型侧主入口）。`src/tools.ts:136-138`
   ```ts
   const WorkflowTool = feature('WORKFLOW_SCRIPTS')
     ? require('./workflow/wiring.js').createWorkflowToolCore()
     : null
   ```
   在 `src/tools.ts:237` 注入工具清单。入参见 `packages/workflow-engine/src/tool/schema.ts`：`script`（内联）/ `name` / `scriptPath` / `args` / `resumeFromRunId` / `maxConcurrency`。工具描述里明确要求：想把 `maxConcurrency` 调离 3 必须先走 `AskUserQuestion`（`packages/workflow-engine/src/tool/WorkflowTool.ts` 的 `WORKFLOW_TOOL_PROMPT`）。
   注意 `src/constants/tools.ts:172` 把 `WORKFLOW_TOOL_NAME` 放进了 `CORE_TOOLS`（不走 SearchExtraTools 延迟发现），同时 `src/constants/tools.ts:53` 把它加进 `ALL_AGENT_DISALLOWED_TOOLS` 防止子 agent 递归调 workflow。
2. **`/workflows` 命令**（监控面板）。`src/commands.ts:93-97` 条件加载 `src/commands/workflows/index.ts`，是个 `local-jsx` 命令，`load: () => import('../../workflow/panel/panelCall.js')` 懒加载 Ink 面板；在 `src/commands.ts:359` 注入命令列表。面板本体 `src/workflow/panel/WorkflowsPanel.tsx`（288 行）+ `PhaseSidebar/AgentList/TabsBar/useWorkflowKeyboard`。
3. **`/<name>` 命名命令**。`src/commands.ts:444-448` 条件加载 `getWorkflowCommands`，在 `src/commands.ts:500` 参与 `getCommands()`。
4. 另有 `/ultracode`（`src/skills/bundled/ultracode.ts`，235 行，经 `registerUltracodeSkill` 在 `src/skills/bundled/index.ts:13` 注册）——**纯知识 skill，零运行时副作用**，只把编排工作法注入上下文。

Flag 默认开：`scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES` 含 `'WORKFLOW_SCRIPTS'`，`build.ts:16` 取它，dev 模式全开。手动跑：`FEATURE_WORKFLOW_SCRIPTS=1 bun run dev`。

## 是否被主 CLI 引用

**是，深度引用，且部分引用不受 flag 保护。**

| 引用点 | 形式 |
|--------|------|
| `src/tools.ts:136` | feature-gated `require` |
| `src/commands.ts:93` / `:444` | feature-gated `require` |
| `src/tasks.ts:9-11` | feature-gated → `LocalWorkflowTask`（`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`，216 行，让 workflow 出现在 footer pill 与 Shift+Down 后台任务对话框） |
| `src/components/permissions/PermissionRequest.tsx:35,39` | feature-gated `require`（工具实例按引用匹配，所以 `createWorkflowToolCore()` 必须是单例，见 `src/workflow/wiring.ts:60-65`） |
| `src/components/tasks/BackgroundTasksDialog.tsx:110` | feature-gated |
| `src/utils/permissions/classifierDecision.ts:38-40` | feature-gated `require` |
| **`src/constants/tools.ts:35`** | **无条件顶层静态 import**：`import { WORKFLOW_TOOL_NAME } from '@claude-code-best/workflow-engine'` |
| **`packages/builtin-tools/src/index.ts:70`** | **无条件 re-export** `createWorkflowTool` / `WORKFLOW_TOOL_NAME` / `WorkflowToolDescriptor` |
| `tsconfig.json:27-30` | 路径别名 |

运行时产物：journal 与 run 状态落在 `${projectRoot}/.claude/workflow-runs/`（`src/workflow/persistence.ts:31 getRunsDir()`，`src/workflow/ports.ts:194 createFileJournalStore(runsDir)`），`KEEP_MAX_RUNS = 50`，面板开启时只 hydrate 最新 20 个（`LOAD_PERSISTED_LIMIT`）。

## 删掉会怎样

- **关 flag（`FEATURE_WORKFLOW_SCRIPTS` 不设）**：`Workflow` 工具、`/workflows`、`/<name>`、LocalWorkflowTask、权限 UI 全部不注册，主循环无感。这是设计好的降级路径。
- **物理删目录**：会**直接打断 typecheck/build**，因为 `src/constants/tools.ts:35` 和 `packages/builtin-tools/src/index.ts:70` 是无条件静态引用，跟 flag 无关；还要顺手改 `tsconfig.json` 别名、`packages/builtin-tools` 的公开 API（该文件 61-65 行已注明第三方需从新路径 import）。
- **测试损失**：`bun test packages/workflow-engine/src/__tests__/` = **178 pass / 21 文件**；`bun test src/workflow/__tests__/` = **129 pass / 12 文件**。合计 307 个测试直接消失。
- **功能损失**：失去唯一的"确定性可 resume 编排"能力（journal 重放让已完成 `agent()` 秒回）；`/ultracode` 手册会指向不存在的工具（该 skill 本身仍能加载，但内容失效）。
- `packages/workflow-engine/` 是可独立发布的包（有 LICENSE / README / `prepublishOnly`），删掉等于放弃一条对外产品线。

## 规模

| 部分 | 文件数 | LOC |
|------|--------|-----|
| `packages/workflow-engine/src/` 源码（非测试） | 21 | 1,899 |
| `packages/workflow-engine/src/__tests__/` | 21 | 3,368 |
| `packages/workflow-engine/examples/` + `scripts/` | 5 | ~833 |
| `src/workflow/` 源码（非测试） | 20 | 2,617 |
| `src/workflow/__tests__/` | 12 | 2,733 |
| 外围（LocalWorkflowTask + test、ultracode skill、commands/workflows） | 4 | 552 |
| **合计** | **≈83** | **≈12,000** |

---

# B. Voice Mode（`src/voice/` + `src/services/voice*.ts` + `doubaoSTT.ts` + `packages/audio-capture-napi/`，flag `VOICE_MODE`）

## 是什么

**Push-to-Talk 语音听写**：在 REPL 里按住空格（可改键位）录音 → 音频流式送到 STT → 实时中间转录显示在输入框 → 松手后最终文本落进输入框。**双 STT 后端**，靠 `settings.voiceProvider` 切换：

- `anthropic`（默认）—— `src/services/voiceStreamSTT.ts`（544 行），WebSocket 连 `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`（`VOICE_STREAM_PATH` 常量 + `getOauthConfig().BASE_API_URL` 把 https 换 wss，`src/constants/oauth.ts:85` 默认 `https://api.anthropic.com`）。用 `Authorization: Bearer <OAuth accessToken>` + `x-app: cli`。可用 `VOICE_STREAM_BASE_URL` 环境变量覆盖。
- `doubao`（豆包 ASR）—— `src/services/doubaoSTT.ts`（258 行），适配器把 npm 包 `doubaoime-asr` 的 `AsyncGenerator` 协议桥接成同一个 `VoiceStreamConnection` 接口（自建 `AudioChunkQueue` 实现 `AsyncIterable<Uint8Array>`）。

代码里有明确注释解释为什么打 `api.anthropic.com` 而不是 `claude.ai`（`voiceStreamSTT.ts:124-131`）：claude.ai 的 CF zone 会用 TLS 指纹拦非浏览器客户端。

## 干什么用 / 用户要做什么

| 操作 | 行为 |
|------|------|
| `/voice` | 开关语音模式（默认 anthropic 后端），写进 `settings.json` 的 `voiceEnabled` |
| `/voice doubao` | 启用并切到豆包 ASR |
| `/voice anthropic` | 切回 Anthropic STT |
| 长按空格 | 开始录音，footer 显示录音指示 + 实时中间转录 |
| 松开空格 | 停止录音，最终转录写入输入框 |

`/voice` 打开时会跑一串 pre-flight（`src/commands/voice/voice.ts:88-145`）：`checkRecordingAvailability()` → `isVoiceStreamAvailable()`（豆包跳过）→ `checkVoiceDependencies()` → `requestMicrophonePermission()`（提前把 OS 麦克风授权弹窗触发掉，而不是等用户第一次按住空格）。缺 SoX 时会按包管理器给出 `brew install sox` / `sudo apt-get install sox` / `sudo dnf install sox` / `sudo pacman -S sox`（`src/services/voice.ts:151-186`）。

键位可配：`voice:pushToTalk`。默认绑定在 `src/keybindings/defaultBindings.ts:96` —— `...(feature('VOICE_MODE') ? { space: 'voice:pushToTalk' } : {})`。`src/keybindings/validate.ts:223-240` 会对易踩坑的绑定告警（"绑到裸字符会在 warmup 期把字符打进输入框，建议用 space 或 meta+k"）。

## 怎么启动

Flag 默认开：`scripts/defines.ts:45` `'VOICE_MODE'` 在 `DEFAULT_BUILD_FEATURES` 里。手动：`FEATURE_VOICE_MODE=1 bun run dev`。

三层运行时门控在 `src/voice/voiceModeEnabled.ts`（61 行）：

```ts
isVoiceGrowthBookEnabled() = feature('VOICE_MODE')
  ? !getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)
  : false
hasVoiceAuth()      = isAnthropicAuthEnabled() && Boolean(getClaudeAIOAuthTokens()?.accessToken)
isVoiceModeEnabled()= hasVoiceAuth() && isVoiceGrowthBookEnabled()   // Anthropic 后端
isVoiceAvailable()  = isVoiceGrowthBookEnabled()                     // 豆包/命令可见性，跳过 OAuth
```

命令注册链：`src/commands.ts:84-86`（feature-gated `require('./commands/voice/index.js')`）→ `src/commands.ts:347` 注入；`src/commands/voice/index.ts` 的 `isEnabled`/`isHidden` 都读 `isVoiceAvailable()`。

REPL 挂载：`src/screens/REPL.tsx:174-185` feature-gated require `useVoiceIntegration` 与 `VoiceKeybindingHandler`，在 `REPL.tsx:4950` 调用；状态 Provider 在 `src/state/AppState.tsx:17-18,97`（feature-gated 的 `VoiceProvider`，来自 `src/context/voice.tsx`）。

## 需要什么外部服务 / 依赖

| 依赖 | 用途 | 适用后端 |
|------|------|----------|
| **Anthropic OAuth**（claude.ai 账号，**不接受 API key / Bedrock / Vertex / Foundry**） | `voice_stream` WS 鉴权 | anthropic |
| `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` | STT 服务端 | anthropic |
| **GrowthBook** `tengu_amber_quartz_disabled` | 紧急 kill-switch（默认 false = 可用） | 通用 |
| **GrowthBook** `tengu_cobalt_frost` | 开启后加 `use_conversation_engine=true` + `stt_provider=deepgram-nova3` | anthropic |
| **npm 包 `doubaoime-asr`** `^0.1.0`（`package.json:215`，传递依赖 `opus-encdec`/`protobufjs`/`ws`） | 豆包 ASR SDK，动态 `await import()` | doubao |
| **凭证文件 `~/.claude/tts/doubao/credentials.json`** | `new ASRConfig({ credentialPath })` + `config.ensureCredentials()`（`doubaoSTT.ts:167-186`） | doubao |
| **原生音频 `audio-capture.node`** 或 **SoX `rec`** 或 **ALSA `arecord`** | 采音 | 通用 |

采音优先级（`src/services/voice.ts:335-395`）：原生 napi → （Linux）`arecord`（需通过 `probeArecord()`）→ SoX `rec`。**Windows 没有回退**：原生模块拿不到就直接 `return false`（`voice.ts:376-379`）。

`packages/audio-capture-napi/`（181 行，`private: true`，`main` 直指 `src/index.ts`，无编译步骤）只是一个 **`.node` 加载器**：按 `AUDIO_CAPTURE_NODE_PATH` → `getVendorRoot()` → 4 个相对路径依次 `require`。真正的二进制在 `vendor/audio-capture/{arm64,x64}-{darwin,linux,win32}/audio-capture.node`，**6 个平台共 2.7MB**，由 `build.ts` Step 4 (`cp('vendor/audio-capture', dist/vendor/audio-capture')`) 和 `scripts/post-build.ts` 复制进产物。

`src/services/voiceKeyterms.ts`（106 行）给 Anthropic 后端拼 STT 关键词提升：13 个硬编码编码术语（`MCP`/`symlink`/`grep`/`worktree`…）+ 项目根目录名 + git 分支词 + 最近文件名，上限 `MAX_KEYTERMS = 50`，作为重复 `keyterms` query param 附在 WS URL 上。**豆包后端整段跳过**（`useVoice.ts:1029`）。

## 是否被主 CLI 引用

**是，但全部 feature-gated，且 25 个文件都用 `feature('VOICE_MODE') ? x : 常量` 的"正向三元"模式**（`src/voice/voiceModeEnabled.ts:17-19` 的注释解释了原因：负向 early-return 无法把字符串字面量从外部构建里消掉）。

引用清单（25 个文件）：`src/commands/voice/{index,voice}.ts`、`src/components/TextInput.tsx`、`src/components/LogoV2/VoiceModeNotice.tsx`、`src/components/PromptInput/{Notifications,PromptInputFooterLeftSide,VoiceIndicator}.tsx`、`src/context/voice.tsx`、`src/hooks/{useVoice,useVoiceEnabled,useVoiceIntegration}`、`src/keybindings/{defaultBindings,schema,validate}.ts`、`src/screens/REPL.tsx`、`src/services/{voice,voiceStreamSTT,doubaoSTT}.ts`、`src/state/AppState.tsx`、`src/utils/settings/types.ts:929-933`、`src/voice/voiceModeEnabled.ts`、`packages/audio-capture-napi/src/index.ts`、`packages/builtin-tools/src/tools/ConfigTool/{ConfigTool.ts:113,116,233,348, prompt.ts:24, supportedSettings.ts:144}`。

其中 **`src/keybindings/schema.ts:181` 的 `'voice:pushToTalk'` 是无条件写死在 action 联合类型里的**（不在 feature 三元内）。

## 删掉会怎样

- **关 flag**：`/voice` 命令不注册（且 `isHidden`），空格键回到普通输入，`VoiceProvider` 不挂载，`VoiceIndicator`/`VoiceModeNotice` 返回 `null`，ConfigTool 里 `voiceEnabled` 设置项消失。主循环、API 层、工具系统完全无感 —— **voice 不参与任何非 UI 路径**。
- **物理删文件**：需要同步改 9 处非 voice 目录的文件（keybindings schema/validate/defaultBindings、ConfigTool 三个文件、settings zod schema、REPL.tsx、AppState.tsx、TextInput.tsx、两个 PromptInput 组件、LogoV2），否则 typecheck 挂在 `'voice:pushToTalk'` 这类无条件符号上。
- **测试损失：零**。`find src packages -path '*__tests__*' -iname '*voice*|*doubao*|*audio*'` 无结果，`grep -rln "voiceModeEnabled|voiceKeyterms|useVoice" --include='*.test.ts*'` 也无结果 —— **整个 voice 模块 0 测试覆盖**（对比 workflow 的 307 个测试）。
- **能省的体积**：`vendor/audio-capture/` 2.7MB 二进制会从 `dist/vendor/` 里消失（build.ts Step 4 与 post-build.ts 都要改），`doubaoime-asr` 依赖可从 `package.json:215` 移除。
- **功能损失**：唯一的语音输入路径。没有替代实现。

## 规模

| 文件 | LOC |
|------|-----|
| `src/hooks/useVoice.ts` | 1,170 |
| `src/hooks/useVoiceIntegration.tsx` | 679 |
| `src/services/voiceStreamSTT.ts` | 544 |
| `src/services/voice.ts` | 525 |
| `src/services/doubaoSTT.ts` | 258 |
| `src/commands/voice/voice.ts` | 189 |
| `packages/audio-capture-napi/src/index.ts` | 181 |
| `src/services/voiceKeyterms.ts` | 106 |
| `src/context/voice.tsx` | 69 |
| `src/voice/voiceModeEnabled.ts` | 61 |
| `src/components/PromptInput/VoiceIndicator.tsx` | 60 |
| `src/components/LogoV2/VoiceModeNotice.tsx` | 51 |
| `src/hooks/useVoiceEnabled.ts` | 28 |
| `src/commands/voice/index.ts` | 16 |
| **专属文件合计** | **14 文件 / 3,937 LOC** |
| + `vendor/audio-capture/` 二进制 | 6 平台 / 2.7 MB |
| + 散落在 11 个共享文件里的 feature-gated 触点 | ~60 处 |

**注意 `src/voice/` 目录只有 1 个 61 行的文件**（`voiceModeEnabled.ts`，纯门控函数）——真正的实现全在 `src/services/` 和 `src/hooks/` 里，目录名有误导性。

---

# 对比小结

| 维度 | A. Workflow | B. Voice |
|------|-------------|----------|
| 规模 | ≈83 文件 / ≈12,000 LOC | 14 文件 / 3,937 LOC + 2.7MB 二进制 |
| 测试 | 307 pass（33 文件） | **0** |
| 外部服务 | 无（全靠已有会话体系跑本地子 agent） | Anthropic OAuth + `voice_stream` WS，或豆包 SDK + 本地凭证文件 |
| 与主循环耦合 | 深（工具/命令/任务/权限/CORE_TOOLS/agent 禁用表，且有 2 处无条件静态引用） | 浅（纯 UI + 输入层，全部 feature-gated） |
| 独立可发布 | 是（`@claude-code-best/workflow-engine`，MIT，有 README/LICENSE/prepublishOnly） | 否 |
| 关 flag 的代价 | 丢一条产品线 + 307 测试 | 丢语音输入，其它零影响 |


