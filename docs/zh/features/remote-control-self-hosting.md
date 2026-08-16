<!-- lang-switcher -->
[English](/docs/en/features/remote-control-self-hosting) · **中文** · [日本語](/docs/ja/features/remote-control-self-hosting)

# Remote Control 与自托管 RCS

occ 内置原生 Remote Control bridge。它把**当前正在运行的 REPL 会话**同步到浏览器：远端看到同一份对话和实时工具输出，发回的消息进入同一条消息队列，权限审批和中断也作用于当前回合。

```
┌──────────────────┐   WebSocket / SSE + HTTP   ┌───────────────────────┐
│ occ 当前 REPL 会话 │ ◄────────────────────────► │ Remote Control Server │
│ 消息、权限、打断   │                            │ Web UI + 事件总线       │
└──────────────────┘                            └───────────────────────┘
```

这与 `occ --acp` 不同：ACP 是给编辑器或其他 ACP 客户端启动 agent 的协议入口；Remote Control 不会另起一个 ACP 会话来替代当前终端会话。

## 默认连到哪里

不配置任何环境变量时，occ 连接本项目运营的公共 RCS：**`https://rc.cornna.xyz`**（RCS 0.2.0，账号制，开放注册）。`/remote-control` 开箱即用，首次使用会弹出注册 / 登录对话框。

要换成自己的部署，设置 `OCC_REMOTE_CONTROL_URL`；优先级为 `OCC_REMOTE_CONTROL_URL` > `CLAUDE_BRIDGE_BASE_URL`（旧键名，继续支持）> 内置默认值。三者都可以写进 `settings.json` 的 `env` 块以便持久化。

### 用公共服务前请先了解

公共服务是一次**托管选择**，不是端到端加密通道：

- 会话流量经服务端中转并**存储在服务端**，每个会话保留最近约 5,000 条事件。消息内容、工具输出和文件片段都会经过它。
- 服务端只保存凭据摘要（密码为 Argon2id hash，各类 token 只存 HMAC 摘要），但这不改变上一条——**内容本身是服务端可读的**。
- 涉密代码库、客户数据或合规要求明确的场景，请自托管（见下文），或者干脆不开 Remote Control。
- 公共服务不提供任何可用性或数据保留承诺，也没有邮件找回流程。

## 控制当前会话

启动时直接启用：

```bash
occ --remote-control
# 可选名称
occ --remote-control "my session"
# --rc 是同义参数
```

也可以在已经聊了一段时间后启用：

```text
/remote-control
/remote-control my-session
```

连接账号制 RCS 0.2.0（公共服务与自托管都是）时，如果尚未认证，`/remote-control` 会在**当前 REPL** 中打开登录/注册对话框。只有服务端允许注册时才会提供注册入口，也可以直接指定流程：

```text
/remote-control login
/remote-control register
```

登录成功后，occ 只把标准化后的服务端 URL、用户名和**滚动换新的 refresh token** 存入操作系统 Keychain；系统 Keychain 不可用时则存入加密的 Local Vault。密码和短效 access token **永不落盘**，凭据按 RCS base URL 隔离。

无需退出 REPL 即可查看状态或退出账号：

```text
/remote-control status
/remote-control logout
```

`status` 显示连接状态和当前账号；`logout` 会断开 Remote Control、请求服务端撤销登录，并删除本地 refresh 凭据。

启用后，终端会输出当前 session 的 Web URL。浏览器打开该 URL 后可以：

- 查看启用前已经存在的对话和之后的实时输出；
- 向当前 REPL 发送新消息；
- 允许或拒绝工具权限请求；
- 中断当前生成；
- 在断线后重连并继续同一会话。

URL fragment 中包含一次性的 `#pair` 配对码。它在 **2 分钟**后过期，且只能兑换一次；兑换后浏览器得到带 `Secure`、`HttpOnly`、`SameSite=Strict` 属性的 `__Host-rcs_session` cookie。Web UI 会立即从浏览器历史中清除配对 fragment。配对码过期后请重新生成 URL 或二维码，不要转发尚未使用的配对 URL。

已连接时再次运行 `/remote-control`，会打开当前会话对话框，可查看 URL、生成新的二维码或断开。断开只关闭 bridge，不会结束本地 REPL。

在 `/config` 中将 **Enable Remote Control for all sessions** 设为 `true`，可让之后的交互会话默认启用；设为 `default` 会删除显式覆盖并恢复平台默认值。

## 作为远程环境运行

顶层子命令用于把当前目录作为可接收远程会话的环境运行：

```bash
occ remote-control
```

`occ rc`、`occ remote`、`occ sync` 和 `occ bridge` 是兼容别名。这个模式适合常驻机器；它与 REPL 内的 `/remote-control` 不是同一个入口。可用选项以 `occ remote-control --help` 为准，包括名称、权限模式、会话超时，以及启用后可用的多会话/工作树模式。

常驻环境同样使用账号认证。没有有效 refresh 凭据时，终端会提示登录或注册，不再要求共享 API key。

## 启动自托管 RCS

仓库内的 `packages/remote-control-server/` 提供基于账号的 RCS 0.2.0 Hono 后端和 React Web UI。开发环境可从仓库根目录启动：

```bash
RCS_BASE_URL="http://127.0.0.1:3000" bun run rcs
```

`bun run rcs` 会先构建 Web UI，再启动后端热重载。开发环境的默认 secret 仅供本地使用，不能用于部署。

生产环境应通过受保护的环境文件或 secret manager 注入 secret，并使用仓库中的 Dockerfile：

```bash
docker build -f packages/remote-control-server/Dockerfile -t occ-rcs .
docker run -d --name occ-rcs -p 3000:3000 \
  --env-file /secure/path/rcs.env \
  -v rcs-data:/app/data \
  --restart unless-stopped \
  occ-rcs
```

也可以跳过本地构建，直接使用预构建镜像。仓库推送 `rcs-v*` tag 时，`.github/workflows/release-rcs.yml` 会把镜像发布到 `ghcr.io/sweetcornna/remote-control-server`，并同时打上 `<version>`（例如 `0.2.0`）、`<major>.<minor>`（例如 `0.2`）和 `latest` 三个 tag；把上面的 `docker build` 换成 `docker pull ghcr.io/sweetcornna/remote-control-server:0.2.0` 即可。GHCR 上的 package 默认为私有，在仓库所有者将其改为 public 之前，拉取需要先执行 `docker login ghcr.io`。

受保护的环境中至少要包含：

```dotenv
RCS_BASE_URL=https://rcs.example.com
RCS_TOKEN_PEPPER=<不少于32字符的随机secret>
RCS_WORKER_JWT_SECRET=<另一个不少于32字符的随机secret>
```

`NODE_ENV=production` 时两个 secret 都是必填项。请在 secret manager 中生成彼此独立的值；不要把它们打印到日志或终端、提交到仓库、放进 URL，或烘焙进镜像。只有确实要开放公共注册时才设置 `RCS_ALLOW_REGISTRATION=1`。私有服务可以先在受控网络中短暂开启注册以创建首批账号，随后关闭并重启 RCS。

设置客户端端点，启动 occ，再执行斜杠命令：

```bash
export OCC_REMOTE_CONTROL_URL="https://rcs.example.com"
occ
```

```text
/remote-control
```

`CLAUDE_BRIDGE_BASE_URL` 是等价的旧键名，仍然支持，并在两者都设置时让位给 `OCC_REMOTE_CONTROL_URL`。

指向自己的服务后，occ 不再要求 claude.ai 订阅或远端 GrowthBook entitlement（默认的公共服务同理），但仍执行本地工作区信任和 `allow_remote_control` 组织策略检查。

### Docker 持久化与健康检查

RCS 使用 SQLite 保存账号、token 摘要、环境、session 和保留的事件。`RCS_DATABASE_PATH` 默认为 `/app/data/rcs.sqlite`，SQLite 运行在 WAL 模式。务必把 `/app/data` 挂载到命名 volume 或持久 bind mount；未挂载时，删除容器也会删除数据库。

镜像内置 Docker 健康检查，每 30 秒请求一次 `GET /health`；该端点返回服务状态和版本。编排器或外部监控也可以检查同一端点，但健康检查不能替代带认证的功能监控。

## RCS 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RCS_VERSION` | `0.2.0` | `GET /health` 返回的版本 |
| `RCS_PORT` | `3000` | HTTP/WebSocket 监听端口 |
| `RCS_HOST` | `0.0.0.0` | 监听地址 |
| `RCS_BASE_URL` | 自动 | 浏览器和 ingress URL 使用的外部地址；生产环境必须显式设为公开 HTTPS origin |
| `RCS_DATABASE_PATH` | `/app/data/rcs.sqlite` | 持久化 SQLite 数据库路径；启用 WAL |
| `RCS_TOKEN_PEPPER` | 仅开发环境有默认值 | 持久 opaque token 摘要使用的 HMAC pepper；生产必填且不少于 32 字符 |
| `RCS_WORKER_JWT_SECRET` | 仅开发环境有默认值 | worker JWT 签名 secret；生产必填、不少于 32 字符，且必须与 token pepper 不同 |
| `RCS_ALLOW_REGISTRATION` | `0` | 设为 `1` 才允许公共账号注册 |
| `RCS_TRUST_PROXY` | `0` | 只有位于会覆盖 `X-Forwarded-For` 的可信代理之后才设为 `1`；用于 IP 限流 |
| `RCS_LEGACY_API_KEY_AUTH` | `0` | 显式启用 0.1 共享 API key 兼容模式 |
| `RCS_API_KEYS` | 空 | 逗号分隔的旧版 key；只有开启旧版 API key 认证时才读取 |
| `RCS_MAX_ENVIRONMENTS_PER_ACCOUNT` | `50` | 每个账号最多保存的环境数 |
| `RCS_MAX_SESSIONS_PER_ACCOUNT` | `1000` | 每个账号最多保存的 session 数 |
| `RCS_MAX_EVENT_BYTES` | `262144` | 单个存储事件的最大序列化字节数；超出的事件返回 `413` |
| `RCS_REGISTRATION_RATE_LIMIT` | `5` | 单个窗口内，每个 IP 和每个用户名允许的注册尝试次数 |
| `RCS_REGISTRATION_RATE_WINDOW_SECONDS` | `3600` | 注册限流窗口（秒） |
| `RCS_LOGIN_RATE_LIMIT` | `10` | 单个窗口内，每个 IP 和每个用户名允许的登录尝试次数 |
| `RCS_LOGIN_RATE_WINDOW_SECONDS` | `900` | 登录限流窗口（秒） |
| `RCS_WEB_CORS_ORIGINS` | 空 | 逗号分隔的额外 Web Origin |
| `RCS_POLL_TIMEOUT` | `8` | 环境 work poll 超时（秒） |
| `RCS_HEARTBEAT_INTERVAL` | `20` | work heartbeat 间隔（秒） |
| `RCS_JWT_EXPIRES_IN` | `900` | worker JWT 有效期（秒），最大 `3600` |
| `RCS_DISCONNECT_TIMEOUT` | `300` | 无更新后把 session 标为 inactive 的秒数 |
| `RCS_WS_IDLE_TIMEOUT` | `30` | Bun WebSocket 空闲 ping 周期（秒） |
| `RCS_WS_KEEPALIVE_INTERVAL` | `20` | 服务端 keep-alive 数据帧间隔（秒） |

客户端侧的环境变量只有三个：

| 变量 | 说明 |
| --- | --- |
| `OCC_REMOTE_CONTROL_URL` | Remote Control 服务地址；不设置则用公共服务 `https://rc.cornna.xyz` |
| `CLAUDE_BRIDGE_BASE_URL` | 同上，旧键名；两者都设置时前者优先 |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | 单独覆盖 WebSocket/SSE 入口；默认与已解析的服务地址相同，通常不需要设置 |

## 反向代理与安全

生产部署必须使用 HTTPS，并让反向代理转发 WebSocket Upgrade。代理的空闲超时应大于 `RCS_WS_KEEPALIVE_INTERVAL`，否则会产生不必要的重连。`RCS_BASE_URL` 必须是浏览器实际访问的 HTTPS origin，才能生成正确的配对 URL 并通过同源检查。

直接暴露服务时保持 `RCS_TRUST_PROXY=0`。只有所有流量都经过可信代理，而且代理会清除外部传入的转发头并写入真实客户端 IP 时，才可开启；否则攻击者可以伪造 IP，绕过按 IP 执行的认证限流。

### 滥用防护与隐私

- 每个账号独占自己的环境、session、事件和凭据；账号 API 与 Web UI 的读写都会按所有者隔离。
- 密码保存为 Argon2id hash。opaque access、refresh、browser、pairing、environment 和 work token 只保存使用 `RCS_TOKEN_PEPPER` 生成的 HMAC-SHA-256 摘要，不保存明文。生产环境启动时校验 `RCS_TOKEN_PEPPER` 与 `RCS_WORKER_JWT_SECRET` 均不少于 32 字符**且互不相同**，否则拒绝启动。
- 每个 session 只保留最新 **5,000 条事件**。会话流量保存在服务端且不是端到端加密，因此数据库备份也应按敏感对话数据保护。
- 注册和登录分别按 IP 与标准化用户名限流；每账号环境/session 配额限制租户增长，可通过上表变量按部署规模调整。
- refresh token 每次使用都会轮换；重放已使用的 refresh token 会撤销该账号的全部活跃凭据（`token_reused`），被盗 token 无法持续续期。WebSocket 连接在**每一帧和每次保活心跳**上都会重新校验凭据本身（access token / browser cookie / worker JWT / environment 凭据）以及账号和 session 状态；token 被撤销或过期、账号被禁用、worker epoch 轮换，都会以 close code `4002` 关闭连接，reason 为 `token_revoked` / `token_expired` / `account_revoked` / `session_revoked`。
- 撤销是**主动**的：登出、refresh 重放、`disable-user`、改密和 epoch 轮换会立刻扫描在线连接并关闭受影响的那些，不必等到下一帧；空闲连接因此也会在毫秒级被驱逐。token 自然过期不产生事件，由每一帧和保活心跳兜底。
- 客户端不等这条 `4002`：occ 在 access token 到期前若干分钟主动换发，并平滑重建 session-ingress 连接（先暂存待发消息，换新连接后再排出），因此长会话不会每 15 分钟被强制断开一次。服务端的逐帧校验完全不变——它是安全边界，客户端只是不再依赖它当作续期信号。真正的撤销（登出、被禁用）仍然照常关闭连接。
- SSE 事件流（Web UI 的 `/web/sessions/:id/events`、worker 的 `/worker/events/stream`、ACP channel-group 的 `/events`）与 WebSocket 采用同一套校验：每投递一个事件、每 15 秒保活各校验一次，失效时先发一条 `event: closed`（带 reason）再结束流；撤销事件同样会主动关闭它们。
- worker JWT 绑定 session 的 `worker_epoch`，服务端在每次 bridge 注册时轮换；轮换前签发的 token 一律拒绝，`/work/{ack,heartbeat}` 等 bridge 路由也执行同一检查。ACP channel-group 事件总线按账号隔离，不同租户即使使用相同 group 名也不会共享事件。
- `disable-user` 在单个事务内撤销该账号的全部 auth token、把它的 environment 标记为 `deregistered` 并清除 work item 的凭据摘要；被保留下来的 environment 凭据或 work 凭据在账号禁用后无法继续 poll、ack 或 heartbeat。
- 每个存储事件受 `RCS_MAX_EVENT_BYTES` 上限约束，超限返回 `413` 而不是无界写库。凭据与 session 响应带 `Cache-Control: no-store`，服务端日志不包含消息内容。
- 浏览器认证只使用带 `Secure`、`HttpOnly`、`SameSite=Strict` 的 `__Host-rcs_session` cookie。配对凭据一次性、短效，只放在 URL fragment 中，并在应用挂载前清除。浏览器 ACP relay WebSocket 用同一 HttpOnly cookie 认证；由于 WebSocket 升级不受同源策略与 CORS 预检约束，**用 cookie 认证的升级还要求 `Origin` 与请求 origin、`RCS_BASE_URL` 或 `RCS_WEB_CORS_ORIGINS` 之一匹配**（Bearer/JWT 升级不受影响）。`NODE_ENV=production` 时不再默认给 `http://localhost:<port>`、`http://127.0.0.1:<port>` 发放带凭据的 CORS，除非它本身就是 `RCS_BASE_URL`。
- RCS 不收集邮箱，**没有邮件找回流程**。忘记密码只能由管理员执行 `reset-password`。

### 账号管理

生产镜像包含管理 CLI。命令必须连接与 RCS 相同的容器和数据库：

```bash
docker exec occ-rcs bun run dist/admin.js list-users
docker exec occ-rcs bun run dist/admin.js disable-user <username>
docker exec -it occ-rcs bun run dist/admin.js reset-password <username>
```

`reset-password` 会通过带遮罩的 TTY 输入并再次确认新密码；不要把密码作为命令行参数，也不要通过会进入 shell 历史的方式传入。密码长度必须为 12–128 字符。`disable-user` 会撤销该账号的活跃 token。系统没有邮件或自助找回入口。

### 备份、恢复与 secret 轮换

数据库和部署环境应配套备份：

1. 正常停止 RCS，让 WAL 完成 checkpoint，并确保备份期间没有写入。
2. 备份完整的持久化 `/app/data` volume，包括 `rcs.sqlite` 以及仍存在的 `-wal`/`-shm` sidecar。
3. 单独备份受保护的环境文件或 secret-manager 条目，并保持严格权限；不要提交备份。
4. 恢复时先停止 RCS，恢复数据 volume 和配套 secret，核对属主与权限，再启动 RCS，并检查 `GET /health` 和一次账号登录。

更换 `RCS_TOKEN_PEPPER` 后，所有已有 opaque token 摘要都无法再验证。账号和 Argon2id 密码 hash 仍然保留，但 CLI refresh/access 凭据、浏览器 cookie、配对码及 environment/work 凭据都必须重新签发；用户需要重新登录，bridge 需要重连或重新注册。只更换 `RCS_WORKER_JWT_SECRET` 会立即使活跃 worker JWT 失效，运行中的 worker 必须获取新 JWT 并重连。两类轮换都应安排维护窗口；旧 secret 只按回滚策略保留必要时间。

### 从 RCS 0.1 迁移

RCS 0.2 默认使用账号，`CLAUDE_BRIDGE_OAUTH_TOKEN` 不再是正常客户端凭据。让 `CLAUDE_BRIDGE_BASE_URL`（或改写为 `OCC_REMOTE_CONTROL_URL`）继续指向升级后的服务，然后运行 `/remote-control` 登录或注册。第一次账号登录成功后，occ 会删除本地旧版 `CLAUDE_BRIDGE_OAUTH_TOKEN` 设置，但保留已经配置的 base URL。

如必须让旧客户端短期并存，需要同时显式设置 `RCS_LEGACY_API_KEY_AUTH=1` 和 `RCS_API_KEYS`。旧版 API key 客户端共用一个服务端内部兼容租户；该租户没有公共账号登录入口，也看不到公共账号租户，公共账号租户同样看不到它。此模式只供迁移：不要把共享 key 租户作为公开多用户服务，并在所有客户端改用账号登录后把 `RCS_LEGACY_API_KEY_AUTH` 恢复为 `0`。

旧版租户中的 session 不会自动转移给新账号。升级前先做备份；如果需要保留旧历史，应把它作为独立的管理决策处理。

## 组织策略与故障排查

`allow_remote_control` 被禁用时，启动参数、斜杠命令和顶层子命令都会拒绝连接。

```bash
occ autonomy status --deep
```

Remote Control 段会显示端点类型（`default (public server)` / `self-hosted` / `official (claude.ai)`）、base URL、是否有凭据，以及 entitlement 的检查时机。当前 REPL 的连接与账号状态可用 `/remote-control status` 查看。服务端健康检查为 `GET /health`。CLI 侧可使用 `--debug-to-stderr` 或 `--debug-file` 查看 bridge 注册、session ingress 和重连日志；日志中绝不能出现密码、refresh/access token、配对码或服务端 secret。

## 相关实现

- 当前会话 hook：`src/hooks/useReplBridge.tsx`
- bridge 传输层：`src/bridge/`
- 自托管服务与 Web UI：`packages/remote-control-server/`
- `/remote-control`：`src/commands/bridge/`
- 顶层环境命令：`src/bridge/bridgeMain.ts`
