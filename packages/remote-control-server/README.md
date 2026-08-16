# Remote Control Server (RCS)

Remote Control Server 0.2.0 是 occ 的账号制远程控制后端。它提供浏览器 Web UI，用于远程查看和操作当前 occ REPL，也可以管理由 `occ remote-control` 启动的常驻远程环境。

## 功能

- **当前会话控制** — 浏览器与当前 occ REPL 共享对话、工具输出、权限审批和中断
- **账号隔离** — environment、session、event 和凭据按账号隔离
- **实时消息流** — WebSocket / SSE + HTTP 双向传输，并支持断线重连
- **持久化** — SQLite + WAL 保存账号、环境、session 和每个 session 最新 5,000 条事件
- **认证安全** — Argon2id 密码 hash、HMAC token 摘要、滚动 refresh token、短效 worker JWT
- **浏览器配对** — 一次性 2 分钟 `#pair` code 换取安全的 HttpOnly cookie

## 快速开始

### Docker 部署（推荐）

先在 secret manager 或权限受限的环境文件中准备配置。生产环境必须设置不同的 `RCS_TOKEN_PEPPER` 与 `RCS_WORKER_JWT_SECRET`，两者都不少于 32 字符。不要打印、提交或把 secret 烘焙进镜像。

```dotenv
RCS_BASE_URL=https://rcs.example.com
RCS_TOKEN_PEPPER=<不少于32字符的随机secret>
RCS_WORKER_JWT_SECRET=<另一个不少于32字符的随机secret>
```

构建并启动：

```bash
docker build -f packages/remote-control-server/Dockerfile -t occ-rcs .
docker run -d \
  --name occ-rcs \
  -p 3000:3000 \
  --env-file /secure/path/rcs.env \
  -v rcs-data:/app/data \
  --restart unless-stopped \
  occ-rcs
```

`/app/data` 必须挂载到持久 volume；否则删除容器也会删除 SQLite 数据库。镜像内置健康检查，每 30 秒访问一次 `GET /health`。

### 预构建镜像（GHCR）

不想本地构建时可以直接拉取。仓库推送 `rcs-v*` tag 会触发 `.github/workflows/release-rcs.yml`，把镜像发布到 `ghcr.io/sweetcornna/remote-control-server`，并同时打上 `<version>`（例如 `0.2.0`）、`<major>.<minor>`（例如 `0.2`）和 `latest` 三个 tag：

```bash
docker pull ghcr.io/sweetcornna/remote-control-server:0.2.0
```

GHCR 上的 package 默认为私有。在仓库所有者把它改为 public 之前，拉取需要先 `docker login ghcr.io`（用 GitHub 用户名和有 `read:packages` 权限的 PAT）。

`RCS_ALLOW_REGISTRATION` 默认为 `0`。只有确实要开放公共注册时才设为 `1`。私有实例可在受控网络中短暂开启注册，创建首批账号后关闭并重启服务。

## 环境变量

### 服务器与认证

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RCS_VERSION` | `0.2.0` | `/health` 返回的服务版本 |
| `RCS_PORT` | `3000` | HTTP/WebSocket 监听端口 |
| `RCS_HOST` | `0.0.0.0` | 监听地址 |
| `RCS_BASE_URL` | 自动 | 浏览器和 ingress 使用的外部 URL；生产环境应显式设置为公开 HTTPS origin |
| `RCS_DATABASE_PATH` | `/app/data/rcs.sqlite` | SQLite 数据库路径；启用 WAL |
| `RCS_TOKEN_PEPPER` | 仅开发环境有默认值 | opaque token 摘要的 HMAC pepper；生产必填且不少于 32 字符 |
| `RCS_WORKER_JWT_SECRET` | 仅开发环境有默认值 | worker JWT 签名 secret；生产必填、不少于 32 字符，且必须与 pepper 不同 |
| `RCS_ALLOW_REGISTRATION` | `0` | 设为 `1` 才允许公共账号注册 |
| `RCS_TRUST_PROXY` | `0` | 只有位于会覆盖 `X-Forwarded-For` 的可信代理之后才设为 `1` |
| `RCS_LEGACY_API_KEY_AUTH` | `0` | 显式启用 RCS 0.1 共享 API key 兼容模式 |
| `RCS_API_KEYS` | 空 | 逗号分隔的旧版 key；只有开启旧版认证时才读取 |
| `RCS_WEB_CORS_ORIGINS` | 空 | 逗号分隔的额外 Web Origin |

### 配额与认证限流

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RCS_MAX_ENVIRONMENTS_PER_ACCOUNT` | `50` | 每账号最多保存的 environment 数 |
| `RCS_MAX_SESSIONS_PER_ACCOUNT` | `1000` | 每账号最多保存的 session 数 |
| `RCS_REGISTRATION_RATE_LIMIT` | `5` | 每个窗口内，按 IP 和用户名分别计算的注册尝试上限 |
| `RCS_REGISTRATION_RATE_WINDOW_SECONDS` | `3600` | 注册限流窗口（秒） |
| `RCS_LOGIN_RATE_LIMIT` | `10` | 每个窗口内，按 IP 和用户名分别计算的登录尝试上限 |
| `RCS_LOGIN_RATE_WINDOW_SECONDS` | `900` | 登录限流窗口（秒） |

### 超时与心跳

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RCS_POLL_TIMEOUT` | `8` | environment work poll 超时（秒） |
| `RCS_HEARTBEAT_INTERVAL` | `20` | work heartbeat 间隔（秒） |
| `RCS_JWT_EXPIRES_IN` | `900` | worker JWT 有效期（秒），最大 `3600` |
| `RCS_DISCONNECT_TIMEOUT` | `300` | 无更新后把 session 标为 inactive 的秒数 |
| `RCS_WS_IDLE_TIMEOUT` | `30` | Bun WebSocket 空闲 ping 周期（秒） |
| `RCS_WS_KEEPALIVE_INTERVAL` | `20` | 服务端 keep-alive 数据帧间隔（秒） |

## occ 客户端配置

### 连接到自托管服务器

occ 默认连接本项目的公共 Remote Control 服务器 `https://rc.cornna.xyz`。要改用自建实例，在 occ 所在环境设置服务端地址：

```bash
export OCC_REMOTE_CONTROL_URL="https://rcs.example.com"
occ
```

`CLAUDE_BRIDGE_BASE_URL` 是改名前的旧键名，仍然兼容；两者同时存在时 `OCC_REMOTE_CONTROL_URL` 优先。

然后在当前 REPL 中运行：

```text
/remote-control
```

未认证时，`/remote-control` 会在当前 REPL 打开登录/注册界面；只有服务端允许注册时才提供注册选项。也可以直接执行：

```text
/remote-control login
/remote-control register
/remote-control status
/remote-control logout
```

登录成功后，occ 只把标准化后的 base URL、用户名和**滚动换新的 refresh token** 保存到 OS Keychain；Keychain 不可用时保存到加密 Local Vault。密码和短效 access token 永不落盘。`logout` 会断开当前 Remote Control、请求服务端撤销登录，并删除本地 refresh 凭据。

也可以在启动时直接连接：

```bash
occ --remote-control
occ --remote-control "my session"
```

`occ remote-control` 则用于运行常驻 headless 远程环境，它与当前 REPL 内的 `/remote-control` 不同。ACP 编辑器客户端使用独立的 `occ --acp` 入口。

### 浏览器配对

RCS 为当前 session 生成带 `#pair` fragment 的 Web URL。配对码只能使用一次，并在 **2 分钟**后过期；浏览器将它兑换成带 `Secure`、`HttpOnly`、`SameSite=Strict` 属性的 `__Host-rcs_session` cookie。Web UI 会在应用挂载前从浏览器历史中清除 pairing fragment。

不要共享未使用的 pairing URL。配对码过期后，在已连接 REPL 的 `/remote-control` 对话框中重新生成 URL 或二维码。

### 客户端环境变量参考

| 变量 | 说明 |
| --- | --- |
| `OCC_REMOTE_CONTROL_URL` | RCS 服务器地址（推荐）；账号登录后仍保留。未设置时默认公共服务器 `https://rc.cornna.xyz` |
| `CLAUDE_BRIDGE_BASE_URL` | 同上，改名前的旧键名；仅在未设置 `OCC_REMOTE_CONTROL_URL` 时生效 |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | 可选的 WebSocket/SSE 入口地址；通常与 base URL 相同 |
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | 仅供 RCS 0.1 共享 token 迁移使用；RCS 0.2 账号模式不需要 |

## Docker Compose 示例

以下 Compose 配置从受保护的宿主环境注入 secret，不包含可直接使用的生产 secret：

```yaml
services:
  rcs:
    build:
      context: ../..
      dockerfile: packages/remote-control-server/Dockerfile
    ports:
      - "3000:3000"
    environment:
      RCS_BASE_URL: ${RCS_BASE_URL:?required}
      RCS_TOKEN_PEPPER: ${RCS_TOKEN_PEPPER:?required}
      RCS_WORKER_JWT_SECRET: ${RCS_WORKER_JWT_SECRET:?required}
      RCS_ALLOW_REGISTRATION: ${RCS_ALLOW_REGISTRATION:-0}
    volumes:
      - rcs-data:/app/data
    restart: unless-stopped

volumes:
  rcs-data:
```

不要提交 Compose 使用的 `.env` 或 secret 文件。`RCS_DATABASE_PATH` 如指向其他路径，也必须为该路径配置持久存储。

## 连接 occ

开发环境可以先启动 RCS，再指向本地端点：

```bash
RCS_BASE_URL="http://127.0.0.1:3000" bun run rcs
```

```bash
OCC_REMOTE_CONTROL_URL="http://127.0.0.1:3000" occ
```

在 REPL 中执行 `/remote-control` 并登录。开发模式内置的 secret fallback 只能用于本机测试；任何生产部署仍必须显式注入两个 32 字符以上的独立 secret。

## 反向代理配置

生产环境必须使用 HTTPS，并支持 WebSocket Upgrade。代理空闲超时应大于 `RCS_WS_KEEPALIVE_INTERVAL`。`RCS_BASE_URL` 必须与浏览器访问的 HTTPS origin 一致，否则 pairing URL 和同源检查会出错。

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name rcs.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
    }
}
```

只有代理可信、会清除外部伪造的转发头并写入真实客户端 IP 时，才设置 `RCS_TRUST_PROXY=1`。直接暴露服务时保持默认 `0`，否则攻击者可能伪造 IP 绕过认证限流。

Caddy 会自动处理 WebSocket：

```
rcs.example.com {
    reverse_proxy localhost:3000
}
```

## 安全、隐私与运维

### 滥用防护与数据边界

- 所有 account API、Web UI 查询和传输路径都按账号隔离 environment、session、event 与凭据。
- 密码只保存 Argon2id hash；access、refresh、browser、pairing、environment 和 work token 只保存由 `RCS_TOKEN_PEPPER` 生成的 HMAC-SHA-256 摘要。生产环境要求 `RCS_TOKEN_PEPPER` 与 `RCS_WORKER_JWT_SECRET` 各自 ≥32 字符且互不相同，否则拒绝启动。
- 每个 session 只保留最新 **5,000 条事件**。数据并非端到端加密，数据库及备份都应按敏感会话数据保护。
- 注册/登录分别按 IP 与标准化用户名限流；environment/session 配额限制单个账号的资源增长。超配额时 WebSocket 注册返回 `{"type":"error"}` 帧，不会中断服务进程。
- 长连接持续校验凭据：WebSocket 在每一帧与每次保活心跳、SSE 在每次事件投递与 15s 保活上，重新校验凭据本身（access token / cookie / worker JWT / environment 凭据）以及账号与 session 状态；撤销、过期、账号禁用、worker epoch 轮换都会以 `4002` 关闭连接。登出、refresh 重放、`disable-user`、改密、epoch 轮换会立刻主动清扫在线连接。
- `disable-user` 在单个事务内撤销全部 auth token、把 environment 置为 `deregistered` 并清除 work 凭据摘要，保留下来的 environment/work 凭据无法继续 poll、ack 或 heartbeat。
- 浏览器只使用 `__Host-rcs_session` Secure/HttpOnly/SameSite=Strict cookie；一次性 pairing code 不写入 cookie 以外的持久浏览器存储。用 cookie 认证的 WebSocket 升级还要求 `Origin` 匹配请求 origin、`RCS_BASE_URL` 或 `RCS_WEB_CORS_ORIGINS`；`NODE_ENV=production` 下 loopback origin 不再默认获得带凭据的 CORS。
- RCS 不收集邮箱，**没有邮件找回**。忘记密码必须联系管理员。

### 账号管理命令

生产镜像包含 `dist/admin.js`：

```bash
docker exec occ-rcs bun run dist/admin.js list-users
docker exec occ-rcs bun run dist/admin.js disable-user <username>
docker exec -it occ-rcs bun run dist/admin.js reset-password <username>
```

`reset-password` 通过带遮罩的 TTY 两次读取密码，不能把密码放在命令参数中；密码长度为 12–128 字符。`disable-user` 会禁用账号并撤销活跃 token。系统没有邮件或自助恢复入口。

### 数据库与环境备份/恢复

1. 正常停止 RCS，确保 WAL 已 checkpoint 且没有并发写入。
2. 备份完整的 `/app/data` volume，包括 `rcs.sqlite` 及仍存在的 `-wal`、`-shm` sidecar。
3. 单独备份受保护的部署环境或 secret-manager 条目，并保持严格权限；不要提交备份。
4. 恢复时先停止服务，同时恢复 data volume 和对应 secret，核对文件属主/权限后启动，再检查 `GET /health` 和一次账号登录。

### secret 轮换影响

更换 `RCS_TOKEN_PEPPER` 会让所有已有 opaque token 摘要失效。账号与 Argon2id 密码 hash 仍保留，但 CLI refresh/access 凭据、浏览器 cookie、pairing code、environment/work 凭据都需要重新签发；用户要重新登录，bridge 要重连或重新注册。

只更换 `RCS_WORKER_JWT_SECRET` 会立即使当前 worker JWT 失效，运行中的 worker 必须获取新 JWT 并重连。两类操作都应安排维护窗口；旧 secret 只按回滚策略保留必要时间。

### 从 RCS 0.1 迁移

RCS 0.2 默认使用账号，不再把共享 `CLAUDE_BRIDGE_OAUTH_TOKEN` 当作正常凭据。保持 `OCC_REMOTE_CONTROL_URL`（或旧键名 `CLAUDE_BRIDGE_BASE_URL`）指向升级后的服务，并在 REPL 中运行 `/remote-control` 登录或注册。第一次账号登录成功后，occ 会删除本地旧 token 设置，但保留 base URL。

如需短期兼容旧客户端，必须同时显式设置：

```dotenv
RCS_LEGACY_API_KEY_AUTH=1
RCS_API_KEYS=<旧版共享key列表>
```

旧版 key 客户端共用内部兼容租户。该租户没有公共账号登录入口，也看不到公共账号租户；公共账号租户同样看不到它。旧租户的 session 不会自动转移到新账号。此模式只供迁移，不应作为公开多用户服务；迁移完成后把 `RCS_LEGACY_API_KEY_AUTH` 恢复为 `0` 并移除旧 key。

## 架构概览

```
┌──────────────┐  WebSocket / SSE + HTTP  ┌──────────────────────┐
│ occ REPL /   │ ◄──────────────────────► │ Remote Control       │
│ remote host  │                          │ Server               │
└──────────────┘                          │ ┌──────────────────┐ │
                                          │ │ Account-scoped   │ │
┌──────────────┐  HTTPS + secure cookie   │ │ event bus        │ │
│ Browser Web  │ ◄──────────────────────► │ └──────────────────┘ │
│ UI (/code/*) │                          │ ┌──────────────────┐ │
└──────────────┘                          │ │ SQLite + WAL     │ │
                                          │ └──────────────────┘ │
                                          └──────────────────────┘
```

- **传输层**：WebSocket，以及 SSE + HTTP POST
- **存储**：`RCS_DATABASE_PATH` 指向的 SQLite 数据库，WAL 模式
- **认证**：账号 access/rotating refresh token、browser cookie、短效 worker JWT
- **隔离**：账号拥有自己的 environment、session、event 和 credential
- **前端**：React + Vite SPA，通过 `/code/*` 访问
- **健康检查**：`GET /health`

## 开发

```bash
# 在 monorepo 根安装依赖
bun install

# 在 packages/remote-control-server 中构建前端并启动后端（后端热重载）
bun run dev

# 也可以从 monorepo 根启动同一开发流程
bun run rcs

# 类型检查
bun run typecheck

# 运行测试
bun test packages/remote-control-server/
```

`bun run dev` 和根目录的 `bun run rcs` 都会先将 React/Vite 前端构建到 `web/dist`，再由后端通过 `/code/*` 提供构建产物。仅修改前端时需重新运行启动命令；如需 Vite 前端热更新，可另行运行 `bun run dev:web`。
