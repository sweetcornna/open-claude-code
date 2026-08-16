<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/remote-control-self-hosting) · [日本語](/docs/ja/features/remote-control-self-hosting)

# Remote Control and self-hosted RCS

occ includes a native Remote Control bridge. It synchronizes the **currently running REPL session** with a browser: the remote client sees the same conversation and live tool output, remote messages enter the same queue, and permission decisions and interrupts affect the current turn.

```
┌──────────────────┐   WebSocket / SSE + HTTP   ┌───────────────────────┐
│ Current occ REPL │ ◄────────────────────────► │ Remote Control Server │
│ messages/control │                            │ Web UI + event bus    │
└──────────────────┘                            └───────────────────────┘
```

This differs from `occ --acp`. ACP is a protocol entry point that starts an agent for an editor or another ACP client. Remote Control does not replace the current terminal conversation with a separate ACP session.

## Where it connects by default

With no environment configured, occ connects to the project-operated public RCS at **`https://rc.cornna.xyz`** (RCS 0.2.0, account-based, open registration). `/remote-control` works out of the box; the first use opens the register/login dialog.

To use your own deployment, set `OCC_REMOTE_CONTROL_URL`. Resolution order is `OCC_REMOTE_CONTROL_URL` > `CLAUDE_BRIDGE_BASE_URL` (the older key, still supported) > the built-in default. Any of them can live in the `env` block of `settings.json` to persist it.

### Before you use the public server

The public server is a hosting choice, not an end-to-end-encrypted channel:

- Session traffic is relayed through and **stored on the server**, retaining roughly the 5,000 most recent events per session. Message content, tool output and file excerpts all pass through it.
- The server stores only credential digests (Argon2id password hashes, HMAC digests for every token), but that does not change the point above — **the content itself is readable server-side**.
- For confidential repositories, customer data or an explicit compliance requirement, self-host it (below) or leave Remote Control off.
- The public server carries no availability or retention guarantee, and there is no email recovery flow.

## Control the current session

Enable it at startup:

```bash
occ --remote-control
# Optional session name
occ --remote-control "my session"
# --rc is an alias
```

You can also enable it after a conversation has already started:

```text
/remote-control
/remote-control my-session
```

Against any account-based RCS 0.2.0 server — the public one and self-hosted alike — `/remote-control` opens the login/register dialog in the current REPL when authentication is required. Registration is offered only if the server enables it. You can also request either flow directly:

```text
/remote-control login
/remote-control register
```

After a successful login, occ stores only the normalized server URL, username, and **rotating refresh token** in the OS Keychain or encrypted Local Vault fallback. It never stores the password or short-lived access token. Credentials are scoped to the RCS base URL.

Use the account and connection commands without leaving the REPL:

```text
/remote-control status
/remote-control logout
```

`status` reports the connection and signed-in account. `logout` disconnects Remote Control, asks the server to revoke the login, and removes the local refresh credential.

The terminal prints the current session's Web URL. From that page, a browser can:

- view the conversation that existed before connection and all subsequent live output;
- send messages to the current REPL;
- allow or deny tool permission requests;
- interrupt the active turn;
- reconnect and continue the same session.

The URL contains a one-time `#pair` code in its fragment. The code expires after **2 minutes** and is exchanged once for a `__Host-rcs_session` cookie with `Secure`, `HttpOnly`, and `SameSite=Strict`. The Web UI removes the pairing fragment from browser history immediately. Generate a new URL or QR code if the code expires; do not share an unused pairing URL.

Running `/remote-control` again while connected opens the current-session dialog, where you can inspect the URL, generate a fresh QR code, or disconnect. Disconnecting closes only the bridge; the local REPL remains active.

Set **Enable Remote Control for all sessions** to `true` in `/config` to enable future interactive sessions by default. Selecting `default` removes the explicit override and restores the platform default.

## Run a remote environment

The top-level subcommand serves the current directory as an environment that can accept remote sessions:

```bash
occ remote-control
```

`occ rc`, `occ remote`, `occ sync`, and `occ bridge` are compatibility aliases. This mode is intended for a persistent host and is separate from `/remote-control` inside a REPL. Run `occ remote-control --help` for the supported name, permission, timeout, multi-session, and worktree options.

Account authentication is also used by the persistent environment. If no valid refresh credential exists, the terminal prompts for login or registration rather than requiring a shared API key.

## Start a self-hosted RCS

`packages/remote-control-server/` contains the account-based RCS 0.2.0 Hono backend and React Web UI. Start the development server from the repository root:

```bash
RCS_BASE_URL="http://127.0.0.1:3000" bun run rcs
```

`bun run rcs` builds the Web UI before starting the backend in watch mode. Development-only secret fallbacks are not suitable for deployment.

For production, inject secrets through a protected environment file or secret manager and use the repository Dockerfile:

```bash
docker build -f packages/remote-control-server/Dockerfile -t occ-rcs .
docker run -d --name occ-rcs -p 3000:3000 \
  --env-file /secure/path/rcs.env \
  -v rcs-data:/app/data \
  --restart unless-stopped \
  occ-rcs
```

You can also skip the local build and use the prebuilt image. Pushing an `rcs-v*` tag runs `.github/workflows/release-rcs.yml`, which publishes to `ghcr.io/sweetcornna/remote-control-server` under three tags: `<version>` (for example `0.2.0`), `<major>.<minor>` (for example `0.2`), and `latest`. Replace the `docker build` above with `docker pull ghcr.io/sweetcornna/remote-control-server:0.2.0`. GHCR packages are private by default, so until the repository owner marks the package public, pulling requires `docker login ghcr.io` first.

The protected environment must include:

```dotenv
RCS_BASE_URL=https://rcs.example.com
RCS_TOKEN_PEPPER=<random-secret-of-at-least-32-characters>
RCS_WORKER_JWT_SECRET=<different-random-secret-of-at-least-32-characters>
```

Both secrets are required when `NODE_ENV=production`. Generate independent values in a secret manager; never print them to logs or terminals, commit them, put them in a URL, or bake them into an image. Set `RCS_ALLOW_REGISTRATION=1` only when public signup is intended. For a private server, briefly enable registration on a controlled network to create the first accounts, then disable it and restart RCS.

Set the client endpoint, start occ, and run the slash command:

```bash
export OCC_REMOTE_CONTROL_URL="https://rcs.example.com"
occ
```

```text
/remote-control
```

`CLAUDE_BRIDGE_BASE_URL` is the equivalent older key. It is still supported, and yields to `OCC_REMOTE_CONTROL_URL` when both are set.

Pointed at your own server — as with the default public one — occ requires neither a claude.ai subscription nor the remote GrowthBook entitlement, but local workspace trust and the `allow_remote_control` organization policy still apply.

### Docker persistence and health checks

RCS stores accounts, token digests, environments, sessions, and retained events in SQLite. `RCS_DATABASE_PATH` defaults to `/app/data/rcs.sqlite`, and SQLite runs in WAL mode. Mount `/app/data` on a named volume or durable bind mount; without that mount, deleting the container deletes the database.

The image includes a Docker health check that requests `GET /health` every 30 seconds. The endpoint returns server status and version. Configure an orchestrator or external monitor to check the same endpoint, and do not use health as a substitute for authenticated functional monitoring.

## RCS environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `RCS_VERSION` | `0.2.0` | Version reported by `GET /health` |
| `RCS_PORT` | `3000` | HTTP/WebSocket listen port |
| `RCS_HOST` | `0.0.0.0` | Listen address |
| `RCS_BASE_URL` | automatic | Public external URL used for browser and ingress URLs; set this explicitly to the HTTPS origin in production |
| `RCS_DATABASE_PATH` | `/app/data/rcs.sqlite` | Persistent SQLite database path; WAL is enabled |
| `RCS_TOKEN_PEPPER` | development only | HMAC pepper for stored opaque-token digests; required in production and at least 32 characters |
| `RCS_WORKER_JWT_SECRET` | development only | Worker JWT signing secret; required in production, at least 32 characters, and different from the token pepper |
| `RCS_ALLOW_REGISTRATION` | `0` | Set to `1` to allow public account registration |
| `RCS_TRUST_PROXY` | `0` | Set to `1` only behind a trusted proxy that overwrites `X-Forwarded-For`; used for IP rate limits |
| `RCS_LEGACY_API_KEY_AUTH` | `0` | Explicitly enables the 0.1 shared-API-key compatibility mode |
| `RCS_API_KEYS` | empty | Comma-separated legacy keys; ignored unless legacy API-key authentication is enabled |
| `RCS_MAX_ENVIRONMENTS_PER_ACCOUNT` | `50` | Maximum stored environments per account |
| `RCS_MAX_SESSIONS_PER_ACCOUNT` | `1000` | Maximum stored sessions per account |
| `RCS_MAX_EVENT_BYTES` | `262144` | Maximum serialized bytes per stored session event; larger events are rejected with `413` |
| `RCS_REGISTRATION_RATE_LIMIT` | `5` | Registration attempts allowed per IP and per username in one window |
| `RCS_REGISTRATION_RATE_WINDOW_SECONDS` | `3600` | Registration rate-limit window in seconds |
| `RCS_LOGIN_RATE_LIMIT` | `10` | Login attempts allowed per IP and per username in one window |
| `RCS_LOGIN_RATE_WINDOW_SECONDS` | `900` | Login rate-limit window in seconds |
| `RCS_WEB_CORS_ORIGINS` | empty | Additional comma-separated Web origins |
| `RCS_POLL_TIMEOUT` | `8` | Environment work-poll timeout in seconds |
| `RCS_HEARTBEAT_INTERVAL` | `20` | Work heartbeat interval in seconds |
| `RCS_JWT_EXPIRES_IN` | `900` | Worker JWT lifetime in seconds; capped at `3600` |
| `RCS_DISCONNECT_TIMEOUT` | `300` | Seconds without updates before a session becomes inactive |
| `RCS_WS_IDLE_TIMEOUT` | `30` | Bun WebSocket idle-ping interval in seconds |
| `RCS_WS_KEEPALIVE_INTERVAL` | `20` | Server keep-alive data-frame interval in seconds |

The client side has exactly three environment variables:

| Variable | Description |
| --- | --- |
| `OCC_REMOTE_CONTROL_URL` | Remote Control server address; defaults to the public server `https://rc.cornna.xyz` |
| `CLAUDE_BRIDGE_BASE_URL` | The same thing under the older name; the one above wins when both are set |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | Separately overrides the WebSocket/SSE ingress URL; defaults to the resolved server address and normally does not need to be set |

## Reverse proxy and security

Use HTTPS in production and configure the reverse proxy to forward WebSocket upgrades. Its idle timeout must exceed `RCS_WS_KEEPALIVE_INTERVAL`, or clients will reconnect unnecessarily. `RCS_BASE_URL` must be the browser-visible HTTPS origin so pairing URLs and same-origin checks are correct.

Leave `RCS_TRUST_PROXY=0` for direct exposure. Enable it only when all traffic arrives through a trusted proxy that removes untrusted forwarding headers and writes the real client IP; otherwise attackers can spoof IPs and bypass per-IP authentication rate limits.

### Abuse resistance and privacy

- Every account owns an isolated set of environments, sessions, events, and credentials. Account APIs and the Web UI scope reads and writes to that owner.
- Passwords are stored as Argon2id hashes. Opaque access, refresh, browser, pairing, environment, and work tokens are stored as HMAC-SHA-256 digests using `RCS_TOKEN_PEPPER`, not as plaintext. In production, startup verifies that `RCS_TOKEN_PEPPER` and `RCS_WORKER_JWT_SECRET` are each at least 32 characters **and differ from each other**, and refuses to boot otherwise.
- Only the newest **5,000 events per session** are retained. Session traffic is stored on the server and is not end-to-end encrypted, so protect database backups as sensitive conversation data.
- Registration and login are limited independently per IP and per normalized username. Per-account environment and session quotas limit tenant growth; tune the documented variables for the deployment.
- Refresh tokens rotate on every use. Replaying an already-used refresh token revokes every active credential of that account (`token_reused`), so a stolen token cannot silently keep renewing a session. WebSocket connections re-check the credential itself (access token, browser cookie, worker JWT, or environment secret) along with account and session state **on every frame and every keepalive tick**; a revoked or expired token, a disabled account, or a rotated worker epoch closes the socket with close code `4002` and reason `token_revoked` / `token_expired` / `account_revoked` / `session_revoked`.
- Revocation is **proactive**: logout, refresh replay, `disable-user`, password reset, and epoch rotation immediately sweep live connections and close the affected ones instead of waiting for their next frame, so even an idle socket is evicted within milliseconds. Natural token expiry raises no event and is caught by the per-frame and keepalive checks.
- The client does not wait for that `4002`: occ refreshes its access token a few minutes before expiry and rebuilds the session-ingress connection gracefully (outbound messages are held, then drained onto the new socket), so a long session is no longer force-disconnected every 15 minutes. The server's per-frame check is unchanged — it is the security control; the client simply stops relying on it as a renewal signal. Genuine revocation (logout, a disabled account) still closes the connection as before.
- SSE streams (the Web UI's `/web/sessions/:id/events`, the worker's `/worker/events/stream`, and the ACP channel-group `/events`) run the same check as WebSockets: once per delivered event and once per 15-second keepalive. On failure the stream emits a final `event: closed` carrying the reason and ends, and revocation events close it proactively too.
- Worker JWTs are bound to the session's `worker_epoch`, which the server rotates on every bridge registration; tokens minted before a rotation are rejected, including on the bridge `/work/{ack,heartbeat}` routes. ACP channel-group event buses are isolated per account, so equal channel-group names across tenants never share events.
- `disable-user` revokes every auth token, marks the account's environments `deregistered`, and clears work-item credential digests in a single transaction, so a retained environment or work credential cannot keep polling, acking, or sending heartbeats after the account is disabled.
- Every stored session event is capped at `RCS_MAX_EVENT_BYTES`; oversized events are rejected with `413` instead of growing the database unboundedly. Credential and session responses carry `Cache-Control: no-store`, and server logs never include message payloads.
- Browser authentication uses only the `__Host-rcs_session` Secure/HttpOnly/SameSite=Strict cookie. Pairing credentials are one-time, short-lived, carried in a URL fragment, and scrubbed before the application mounts. Browser ACP relay WebSockets authenticate with the same HttpOnly cookie; because WebSocket upgrades are exempt from the same-origin policy and CORS preflight, **a cookie-authenticated upgrade additionally requires an `Origin` matching the request origin, `RCS_BASE_URL`, or one of `RCS_WEB_CORS_ORIGINS`** (Bearer/JWT upgrades are unaffected). Under `NODE_ENV=production`, `http://localhost:<port>` and `http://127.0.0.1:<port>` no longer receive credentialed CORS unless one of them is the configured `RCS_BASE_URL`.
- RCS does not collect email addresses and has **no email recovery flow**. Password recovery requires an administrator to run `reset-password`.

### Account administration

The production image contains the administrative CLI. Run it against the same container and database as RCS:

```bash
docker exec occ-rcs bun run dist/admin.js list-users
docker exec occ-rcs bun run dist/admin.js disable-user <username>
docker exec -it occ-rcs bun run dist/admin.js reset-password <username>
```

`reset-password` reads and confirms the new password through masked TTY input; do not pass a password as a command-line argument or pipe it through shell history. Passwords must be 12–128 characters. `disable-user` revokes the account's active tokens. There is no email-based or self-service recovery path.

### Backup, restore, and secret rotation

Back up the SQLite data and deployment environment together:

1. Stop RCS cleanly so WAL contents are checkpointed and no writes occur.
2. Back up the complete persistent `/app/data` volume, including `rcs.sqlite` and any `-wal`/`-shm` sidecar files that remain.
3. Back up the protected environment or secret-manager entries separately, preserving restrictive permissions. Never commit the backup.
4. To restore, stop RCS, restore the data volume and matching secrets, verify ownership and permissions, then start RCS and check `GET /health` plus an account login.

Changing `RCS_TOKEN_PEPPER` makes every existing opaque-token digest unverifiable. Accounts and Argon2id password hashes remain, but CLI refresh/access credentials, browser cookies, pairing codes, and environment/work credentials must be reissued; users must log in again and bridges must reconnect or re-register. Changing only `RCS_WORKER_JWT_SECRET` immediately invalidates active worker JWTs, so running workers must obtain new JWTs and reconnect. Plan either rotation as a maintenance event and retain the previous secrets only as long as the rollback policy requires.

### Migrating from RCS 0.1

RCS 0.2 uses accounts by default; `CLAUDE_BRIDGE_OAUTH_TOKEN` is no longer the normal client credential. Keep `CLAUDE_BRIDGE_BASE_URL` (or rewrite it as `OCC_REMOTE_CONTROL_URL`) pointed at the upgraded server and run `/remote-control` to log in or register. On the first successful account login, occ removes the legacy local `CLAUDE_BRIDGE_OAUTH_TOKEN` setting while preserving the configured base URL.

If old clients must overlap temporarily, set both `RCS_LEGACY_API_KEY_AUTH=1` and `RCS_API_KEYS` explicitly. Legacy API-key clients share an internal compatibility tenant with no public account login and no visibility into public account tenants. Account tenants likewise cannot see it. This mode exists only for migration: do not expose a shared-key tenant as a public multi-user service, and return `RCS_LEGACY_API_KEY_AUTH` to `0` after all clients have moved to account login.

Legacy tenant sessions are not reassigned to new accounts. Back up the deployment before upgrading, and treat any required legacy history as a separate administrative retention decision.

## Organization policy and diagnostics

If `allow_remote_control` is disabled, the startup option, slash command, and top-level subcommand all refuse the connection.

```bash
occ autonomy status --deep
```

The Remote Control section reports the endpoint kind (`default (public server)`, `self-hosted` or `official (claude.ai)`), its base URL, whether a credential is present, and when entitlement is checked. Use `/remote-control status` for the current REPL connection and account. The server health endpoint is `GET /health`. Use `--debug-to-stderr` or `--debug-file` on the CLI to inspect bridge registration, session ingress, and reconnect logs; logs must never include passwords, refresh tokens, access tokens, pairing codes, or server secrets.

## Related implementation

- Current-session hook: `src/hooks/useReplBridge.tsx`
- Bridge transport: `src/bridge/`
- Self-hosted server and Web UI: `packages/remote-control-server/`
- `/remote-control`: `src/commands/bridge/`
- Top-level environment command: `src/bridge/bridgeMain.ts`
