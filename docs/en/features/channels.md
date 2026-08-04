<!-- lang-switcher -->
**English** · [中文](/docs/zh/features/channels) · [日本語](/docs/ja/features/channels)

# Channels — Ingesting messages from external channels

> Startup options: `--channels` / `--dangerously-load-development-channels`
> Status: The feature flag and OAuth restrictions have been removed; this feature is available directly

## Overview

A Channel is an MCP server that pushes external events into a running Claude Code session so that Claude can respond while you are away from the terminal. For detailed usage instructions, see the following documentation:

- **Official documentation**: [Push events to a running session with channels](https://code.claude.com/docs/zh-CN/channels)
- **Feishu plugin**: [claude-code-feishu-channel](https://github.com/whobot-ai/claude-code-feishu-channel) — the first community Feishu Channel plugin, with bidirectional messaging, pairing authentication, group chat, and file attachments

## Quick start

```bash
# Enable channel listening (plugin format)
occ --channels plugin:feishu@claude-code-feishu-channel

# Enable channel listening (server format)
occ --channels server:my-slack-bridge

# Enable multiple channels at the same time
occ --channels plugin:feishu@claude-code-feishu-channel --channels server:discord-bot

# Development mode (skip the allowlist check to test a custom channel)
occ --dangerously-load-development-channels server:my-custom-channel
```

## Supported Channels

| Channel | Description | Source |
|---------|------|------|
| **Telegram** | Official Telegram Bot integration | `/plugin install telegram@claude-plugins-official` |
| **Discord** | Official Discord Bot integration | `/plugin install discord@claude-plugins-official` |
| **iMessage** | Native macOS messaging | `/plugin install imessage@claude-plugins-official` |
| **Feishu (Feishu/Lark)** | Bidirectional messaging, group chat, and file attachments | `/plugin install feishu@claude-code-feishu-channel` |

## Related files

| File | Responsibility |
|------|------|
| `src/services/mcp/channelNotification.ts` | Channel gate logic and message wrapping |
| `src/services/mcp/channelAllowlist.ts` | Channel switch (enabled by default) |
| `src/services/mcp/useManageMCPConnections.ts` | Channel registration in MCP connection management |
| `src/components/LogoV2/ChannelsNotice.tsx` | Channel status notice at startup |
| `src/main.tsx` | `--channels` argument parsing |
| `src/interactiveHelpers.tsx` | Development channels confirmation dialog |

## References

- [Official Channels documentation](https://code.claude.com/docs/zh-CN/channels) — complete usage instructions, security guidance, and Enterprise controls
- [Feishu Channel plugin](https://github.com/whobot-ai/claude-code-feishu-channel) — installation and configuration tutorial, MCP tools, and Skill command reference
