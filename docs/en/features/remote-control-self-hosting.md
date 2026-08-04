<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/remote-control-self-hosting) · [日本語](/docs/ja/features/remote-control-self-hosting)

# Remote Control (based on Happy over ACP)

occ no longer includes its own remote-control transport layer. It includes an **ACP agent** (`occ --acp`), while [Happy](https://github.com/slopus/happy) (MIT) provides the client side: the mobile app, the web interface, end-to-end encryption, and a self-hostable relay service.

```
┌──────────────────┐        E2E encryption      ┌──────────────┐      ACP over stdio      ┌─────────────┐
│ Happy Mobile App │ ◄────────────────────────► │ Happy Server │ ◄──────────────────────► │ occ --acp   │
│ / Happy Web      │                            │ (self-hosted)│                          │ (your host) │
└──────────────────┘                            └──────────────┘                          └─────────────┘
```

occ has one responsibility: provide itself to Happy as an ACP agent. Happy owns sessions, notifications, encryption, and multi-device synchronization.

## Quick start

```bash
# 1. Install the Happy CLI
npm install -g happy-coder

# 2. Start it in the project directory
occ remote-control
```

`occ remote-control` finds `happy` on PATH and then executes the equivalent of:

```bash
happy acp -- <occ binary> --acp
```

`buildCliLaunch()` derives the command line for the occ side, using the same bootstrap conventions as the daemon, background sessions, and tmux restarts. Packaged and source installations can therefore both reinvoke themselves correctly. The current working directory passes through to Happy unchanged, so the agent sees your project.

The aliases `occ rc`, `occ remote`, `occ sync`, and `occ bridge` all refer to the same command. Additional arguments pass through to `happy acp` before `--`.

If `happy` is not on PATH, occ prints installation instructions, a self-hosting note, and an explanation that editors can connect directly over ACP, then exits with status code 1.

## Self-hosting

You can deploy the Happy server yourself and point `HAPPY_SERVER_URL` to it. No traffic will then pass through the official relay:

```bash
export HAPPY_SERVER_URL=https://happy.example.com
occ remote-control
```

See the upstream Happy repository for deployment instructions. occ requires no additional configuration; it is only a child process launched by Happy.

The **Remote Control** section of `occ autonomy status --deep` shows the current state: whether `happy` is available, whether the configured relay is self-hosted or official, and the agent command.

## Direct editor connection (Happy not required)

Editors that support ACP, including Zed and JetBrains IDEs, do not require Happy. Start occ directly as an agent:

```json
{
  "agent_servers": {
    "occ": { "type": "custom", "command": "occ", "args": ["--acp"] }
  }
}
```

See the [ACP / Zed integration documentation](/docs/zh/features/acp-zed) for configuration details. Happy addresses the case where the user is away from the computer; editor integration addresses the case where the user is at the computer but wants to use the editor UI. Both use the same agent.

## Migrating from an earlier version

### If you previously used a self-hosted Remote Control Server

`packages/remote-control-server/` has been deleted, together with the `bun run rcs` script and the `.github/workflows/release-rcs.yml` release workflow.

- **The published GHCR image `ghcr.io/<owner>/remote-control-server` remains available for pull, but it is frozen and archived and will receive no new releases.** An older occ version can continue to run with the old image, but it will receive no further fixes.
- The new equivalent is a self-hosted Happy server (`HAPPY_SERVER_URL`). It provides the relay, web UI, and mobile client and uses end-to-end encryption; RCS did not.
- The old `remoteControlAtStartup` setting, the `--remote-control` / `--rc` startup options, and the `/bridge`, `/remote-control-server`, and `/bridge-kick` slash commands have all been removed. Run `occ remote-control` explicitly when you need remote control.

### If you previously used the `acp-link` CLI

`packages/acp-link/` has been deleted. Its two responsibilities—bridging a WebSocket client to an ACP agent and registering with RCS—are exactly the capabilities that Happy provides.

| Previous syntax | New syntax |
| --- | --- |
| `acp-link occ-bun -- --acp` | `occ remote-control` (that is, `happy acp -- occ --acp`) |
| `ACP_RCS_URL=... ACP_RCS_TOKEN=... acp-link ...` | `HAPPY_SERVER_URL=... occ remote-control` |
| `acp-link <other agent> -- <args>` | `happy acp -- <other agent> <args>` |

The final row is worth emphasizing: `happy acp` accepts any ACP agent, not only occ. Happy fully preserves the generic-agent capability that existed in acp-link.

## Organization policy

The `allow_remote_control` policy remains effective and is checked **before** Happy starts. If an organization policy disables remote control, `occ remote-control` reports an error and exits regardless of the transport layer.

## Related resources

- Happy upstream: https://github.com/slopus/happy
- ACP agent implementation: `src/services/acp/`
- Launcher implementation: `src/cli/remoteControlLauncher.ts`
