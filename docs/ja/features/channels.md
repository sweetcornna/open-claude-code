<!-- lang-switcher -->
[English](/docs/en/features/channels) · [中文](/docs/zh/features/channels) · **日本語**

# Channels — 外部チャネルからのメッセージ受信

> 起動引数：`--channels` / `--dangerously-load-development-channels`
> 状態：feature flag と OAuth の制限を解除済み。直接利用可能

## 概要

Channel は、実行中の Claude Code セッションへ外部イベントをプッシュする MCP サーバーです。これにより、ユーザーがターミナルを離れている間も Claude がイベントに反応できます。詳しい使用方法については、次のドキュメントを参照してください。

- **公式ドキュメント**：[channels を使用して実行中のセッションへイベントをプッシュする](https://code.claude.com/docs/zh-CN/channels)
- **Feishu プラグイン**：[claude-code-feishu-channel](https://github.com/whobot-ai/claude-code-feishu-channel) — コミュニティ初の Feishu Channel プラグイン。双方向メッセージ、ペアリング認証、グループチャット、ファイル添付に対応

## クイックスタート

```bash
# チャネルのリッスンを有効化（plugin 形式）
occ --channels plugin:feishu@claude-code-feishu-channel

# チャネルのリッスンを有効化（server 形式）
occ --channels server:my-slack-bridge

# 複数のチャネルを同時に有効化
occ --channels plugin:feishu@claude-code-feishu-channel --channels server:discord-bot

# 開発モード（allowlist チェックを省略し、カスタム channel のテストに使用）
occ --dangerously-load-development-channels server:my-custom-channel
```

## 対応する Channel

| Channel | 説明 | 提供元 |
|---------|------|------|
| **Telegram** | 公式 Telegram Bot 連携 | `/plugin install telegram@claude-plugins-official` |
| **Discord** | 公式 Discord Bot 連携 | `/plugin install discord@claude-plugins-official` |
| **iMessage** | macOS ネイティブメッセージ | `/plugin install imessage@claude-plugins-official` |
| **Feishu (Feishu/Lark)** | 双方向メッセージ、グループチャット、ファイル添付 | `/plugin install feishu@claude-code-feishu-channel` |

## 関連ファイル

| ファイル | 責務 |
|------|------|
| `src/services/mcp/channelNotification.ts` | チャネルの gate ロジックとメッセージのラップ |
| `src/services/mcp/channelAllowlist.ts` | チャネルのスイッチ（デフォルトで有効） |
| `src/services/mcp/useManageMCPConnections.ts` | MCP 接続管理でのチャネル登録 |
| `src/components/LogoV2/ChannelsNotice.tsx` | 起動時のチャネル状態表示 |
| `src/main.tsx` | `--channels` 引数の解析 |
| `src/interactiveHelpers.tsx` | Dev channels の確認ダイアログ |

## 参考リンク

- [公式 Channels ドキュメント](https://code.claude.com/docs/zh-CN/channels) — 詳細な使用方法、セキュリティ、Enterprise 制御
- [Feishu Channel プラグイン](https://github.com/whobot-ai/claude-code-feishu-channel) — インストールと設定の手順、MCP ツール、Skill コマンドのリファレンス
