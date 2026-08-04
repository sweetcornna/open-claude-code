<!-- lang-switcher -->
[English](/docs/en/features/remote-control-self-hosting) · [中文](/docs/zh/features/remote-control-self-hosting) · **日本語**

# Remote Control（Happy over ACP ベース）

occ はリモートコントロールの転送層を内蔵しなくなりました。内蔵するのは **ACP agent**（`occ --acp`）であり、クライアント側は [Happy](https://github.com/slopus/happy)（MIT）が担います。Happy はモバイルアプリ、Web インターフェース、エンドツーエンド暗号化、セルフホスト可能なリレーサービスを提供します。

```
┌─────────────────┐       E2E 暗号化       ┌──────────────┐      ACP over stdio      ┌─────────────┐
│ Happy モバイルアプリ │ ◄──────────────────► │ Happy Server │ ◄──────────────────────► │ occ --acp   │
│ / Happy Web     │                       │（セルフホスト可）│                          │（自分のマシン）│
└─────────────────┘                       └──────────────┘                          └─────────────┘
```

occ が担うのは 1 つだけです。自身を ACP agent として Happy に渡します。セッション、プッシュ通知、暗号化、複数デバイス間の同期は Happy の責務です。

## クイックスタート

```bash
# 1. Happy CLI をインストール
npm install -g happy-coder

# 2. プロジェクトディレクトリで起動
occ remote-control
```

`occ remote-control` は PATH 上で `happy` を見つけ、次と同等のコマンドを実行します。

```bash
happy acp -- <occ バイナリ> --acp
```

occ 側のコマンドラインは `buildCliLaunch()` から導出されます。daemon、バックグラウンドセッション、tmux の再起動と同じブートストラップ規約を使うため、パッケージ版でもソースからのインストールでも自身を正しく再実行できます。現在の作業ディレクトリはそのまま Happy に渡されるので、agent にはユーザーのプロジェクトが見えます。

別名の `occ rc`、`occ remote`、`occ sync`、`occ bridge` はすべて同じコマンドを指します。追加の引数は `happy acp` へ転送されます（`--` より前に置きます）。

`happy` が PATH 上にない場合、occ はインストール手順、セルフホストに関する案内、「エディターは ACP に直接接続できる」という説明を表示し、終了コード 1 で終了します。

## セルフホスト

Happy サーバーは自分でデプロイできます。`HAPPY_SERVER_URL` をそのサーバーへ向けると、それ以降のトラフィックは公式リレーを経由しません。

```bash
export HAPPY_SERVER_URL=https://happy.example.com
occ remote-control
```

デプロイ方法については Happy の upstream リポジトリを参照してください。occ 側に追加設定は不要です。occ は Happy が起動する子プロセスにすぎません。

`occ autonomy status --deep` の **Remote Control** セクションには現在の状態が表示されます。`happy` を利用できるか、セルフホストか公式リレーか、agent コマンドが何かを確認できます。

## エディターからの直接接続（Happy は不要）

ACP 対応エディター（Zed、JetBrains 系）は Happy を必要としません。occ を agent として直接起動します。

```json
{
  "agent_servers": {
    "occ": { "type": "custom", "command": "occ", "args": ["--acp"] }
  }
}
```

設定の詳細は [ACP / Zed 連携ドキュメント](/docs/zh/features/acp-zed)を参照してください。Happy は「ユーザーがコンピューターの前にいない」場合の問題を解決し、エディター連携は「ユーザーがコンピューターの前にいるが、エディターの UI を使いたい」場合の問題を解決します。両者は同じ agent を使います。

## 旧バージョンからの移行

### セルフホストの Remote Control Server を使用していた場合

`packages/remote-control-server/` は削除済みです。`bun run rcs` スクリプトと `.github/workflows/release-rcs.yml` のリリースフローも削除されています。

- **リリース済みの GHCR イメージ `ghcr.io/<owner>/remote-control-server` は引き続き pull できますが、凍結されアーカイブ済みで、新しいバージョンは提供されません。** 旧バージョンの occ と旧イメージの組み合わせは引き続き動作しますが、修正は提供されません。
- 新しい同等機能はセルフホストした Happy サーバー（`HAPPY_SERVER_URL`）です。リレー、Web UI、モバイルクライアントを同時に提供し、エンドツーエンドで暗号化されます。RCS にはこの暗号化がありませんでした。
- 旧 `remoteControlAtStartup` 設定、`--remote-control` / `--rc` 起動引数、および `/bridge`、`/remote-control-server`、`/bridge-kick` スラッシュコマンドはすべて削除済みです。リモートコントロールが必要な場合は、`occ remote-control` を明示的に実行してください。

### `acp-link` CLI を使用していた場合

`packages/acp-link/` は削除済みです。これが担っていた 2 つの処理、つまり WebSocket クライアントと ACP agent のブリッジ、および RCS への登録は、どちらも Happy が提供します。

| 旧形式 | 新形式 |
| --- | --- |
| `acp-link occ-bun -- --acp` | `occ remote-control`（つまり `happy acp -- occ --acp`） |
| `ACP_RCS_URL=... ACP_RCS_TOKEN=... acp-link ...` | `HAPPY_SERVER_URL=... occ remote-control` |
| `acp-link <他の agent> -- <args>` | `happy acp -- <他の agent> <args>` |

最後の行は特に重要です。`happy acp` は occ だけでなく、任意の ACP agent を受け付けます。acp-link にあった「汎用プロキシ」の機能は Happy に完全な形で残っています。

## 組織ポリシー

`allow_remote_control` ポリシーは引き続き有効で、Happy を起動する**前**にチェックされます。組織ポリシーで無効にされている場合、転送層にかかわらず `occ remote-control` は直ちにエラーを返して終了します。

## 関連情報

- Happy upstream：https://github.com/slopus/happy
- ACP agent の実装：`src/services/acp/`
- ランチャーの実装：`src/cli/remoteControlLauncher.ts`
