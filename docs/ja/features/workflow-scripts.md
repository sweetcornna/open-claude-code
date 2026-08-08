<!-- lang-switcher -->
[English](/docs/en/features/workflow-scripts) · [中文](/docs/zh/features/workflow-scripts) · **日本語**

# WORKFLOW_SCRIPTS — 決定論的なマルチエージェントワークフローのオーケストレーション

> Feature Flag: `FEATURE_WORKFLOW_SCRIPTS=1`
> エンジンパッケージ: `@open-claude-code/workflow-engine`（`packages/workflow-engine/`、決定論的な JS スクリプトによるオーケストレーション、コア層の実行時依存はゼロ）
> 統合層: `src/workflow/`

## 1. 機能概要

WORKFLOW_SCRIPTS を使うと、Claude Code は**決定論的な JavaScript スクリプト**で複数のサブエージェントを編成できます。タスクの分解と並列化、複数視点による確信度の向上、単一コンテキストを超える規模への対応、resume と監査が可能です。

- **オーケストレーションのプリミティブ**: `agent` / `parallel` / `pipeline` / `phase` / `log` / `workflow`（エンジンパッケージを参照）。
- **決定性**: スクリプトは制限付きサンドボックス内で実行され、`Date.now()` / `Math.random()` / 引数なしの `new Date()` は無効化されます。これにより journal を再生できます。
- **深層バックエンド**: 単一の `claude-code` AgentAdapter が現在のセッションシステム（provider / model / agentType / ツール）に接続し、workflow 内の `agent()` が実際のサブエージェントを呼び出します。
- **監視パネル**: `/workflows` のリアルタイム 2 ペインパネル（§6 を参照）。
- **オーケストレーション手引き**: `/ultracode` がオーケストレーションの進め方を注入します（§7 を参照）。

> 経緯: 初期バージョンは YAML/JSON DSL と全面的な Stub 実装（`WorkflowDetailDialog` など）でしたが、現在はエンジン駆動の JS 方式へ全面的に書き直されています。

## 2. 実装アーキテクチャ

```
   .occ/workflows/<name>.ts           Workflow ツール（name/script/scriptPath/args/resumeFromRunId）
            │                                       │
            ▼                                       ▼
   namedWorkflowCommands.ts              src/workflow/wiring.ts (createWorkflowToolCore)
   （/<name> コマンドの検出）                         │
                                                   ▼
                                      WorkflowService（ファサード: launch/kill/subscribe/listRuns/listNamed）
                                                   │
                                  ┌────────────────┼─────────────────┐
                                  ▼                ▼                 ▼
                          ports.ts            registry.ts        progress/
                       （port の集約）    （AgentAdapterRegistry）  bus + store
                                  │                │
                                  ▼                ▼
                      hostHandle.ts        backends/claudeCodeBackend.ts
                     （不透明な host）       （セッションシステムを深く参照し、実際の agent を実行）
                                  │
                                  ▼
                  @open-claude-code/workflow-engine
                  （runWorkflow / hooks / journal / budget / 並行処理 セマフォ）
```

### 2.1 モジュール一覧

| 層 | ファイル | 責務 |
|----|------|------|
| エンジン | `packages/workflow-engine/src/` | 決定論的スクリプトの サンドボックス + hooks + journal + budget + セマフォ。`createWorkflowTool` を export する |
| ツールの組み立て | `src/workflow/wiring.ts` | `createWorkflowToolCore()` — `WorkflowService.ports` から `Workflow` ツールを組み立てる |
| サービス ファサード | `src/workflow/service.ts` | `WorkflowService` シングルトン: `launch` / `kill` / `subscribe` / `listRuns` / `listNamed` / `getWorkflowService()` |
| port | `src/workflow/ports.ts` | `createWorkflowPorts()` がすべての port（agentRunner/registry/progress/task/journal/permission/logger/hostFactory）を集約する |
| バックエンド登録 | `src/workflow/registry.ts` | `buildRegistry()` が `claude-code` バックエンドを登録してデフォルトに設定する |
| 深層バックエンド | `src/workflow/backends/claudeCodeBackend.ts` | AgentAdapter: `agentType`/`model` に従ってセッションシステムを解決し、実際のサブエージェントを実行して構造化出力を返す |
| Host ハンドル | `src/workflow/hostHandle.ts` | `buildHostBundle()` が `toolUseContext`/`canUseTool`/`parentMessage` を不透明にラップする |
| 進捗 bus | `src/workflow/progress/bus.ts` | Set ベースで進捗イベントを発行する |
| 進捗状態 | `src/workflow/progress/store.ts` | reducer: `agentId` によって `agent_done` を正確に関連付ける（並行処理の競合を修正） |
| 監視パネル | `src/workflow/panel/*.tsx` | `/workflows` の 2 ペイン UI（§6 を参照） |
| 名前付きコマンド | `src/workflow/namedWorkflowCommands.ts` | `.occ/workflows/` を走査して `/<name>` コマンドを生成する |
| 権限リクエスト | `src/workflow/WorkflowPermissionRequest.tsx` | workflow 起動時の権限 UI |

### 2.2 登録ポイント

| 場所 | 内容 |
|------|------|
| `packages/builtin-tools/src/registry.ts` | `feature('WORKFLOW_SCRIPTS')` 配下で `src/workflow/wiring.js` を require し、`Workflow` ツールを登録する |
| `src/commands.ts`（`workflowsCmd`） | `/workflows` コマンド（local-jsx、`panelCall.js` を読み込む） |
| `src/skills/bundled/ultracode.ts` + `index.ts` | `/ultracode` の知識 skill（`registerBundledSkill`） |

## 3. オーケストレーションのプリミティブ

workflow スクリプト内で利用できる hook（詳細な意味論はエンジンパッケージの `engine/hooks.ts` を参照）:

| プリミティブ | 意味論 |
|------|------|
| `agent(prompt, opts?)` | 1 つのサブエージェントを dispatch する。最終テキスト、または `opts.schema` 指定時は構造化オブジェクトを返す。opts: `model` / `agentType` / `label` / `phase` / `schema` |
| `parallel([() => …])` | thunk の配列を並行実行する。すべての完了を待つ **barrier**。1 項目が例外を投げるとその項目は `null` になり、ほかは保持される |
| `pipeline(items, s1, s2, …)` | 各 item を各 stage に順番に通す。**item 間に barrier はなく**、stage は item ごとに直列。ある item の stage が例外を投げると、その item は `null` になる |
| `phase(title)` | phase を記録する（パネルはこれに従ってグループ表示する） |
| `log(msg)` | 進捗ログ（パネルに表示するが、状態は変更しない） |
| `workflow(name \| { scriptPath }, args?)` | 1 階層のサブ workflow を入れ子にする（1 階層のみ許可） |

**ハードリミット**: 1 回の `parallel`/`pipeline` は `MAX_ITEMS_PER_CALL`（4096）以下。1 workflow の agent 総数は `MAX_TOTAL_AGENTS`（1000）以下。並行処理の cap はデフォルトで `DEFAULT_MAX_CONCURRENCY`（6）であり、Workflow ツールの `maxConcurrency` 引数で上書きできます。絶対上限は `MAX_CONCURRENCY_CAP`（16）です。

## 4. workflow の作成

スクリプトを `.occ/workflows/<name>.js|.mjs` に置くと（`.ts` も受け付けますが、**エンジンは TS をトランスパイルしない**ため、型注釈があると構文エラーになります。`.js`/`.mjs` を推奨）、自動的に `/<name>` コマンドになります。

```js
// .occ/workflows/review-changes.js
export const meta = {
  name: 'review-changes',
  description: '変更を観点別にレビューし、敵対的に検証する',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: '正しさに関するバグを探す' },
  { key: 'perf', prompt: 'パフォーマンス上の問題を探す' },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review' }),
  review => parallel(
    (review.findings || []).map(f => () =>
      agent(`敵対的に検証: ${f.title}`, { phase: 'Verify' })
    )
  )
)
return results.flat().filter(Boolean)
```

**スクリプト実行時の制約**（エンジンの実行モデル。違反すると即座にエラー）:

スクリプトは `new AsyncFunction` の**関数本体**であり、ESM モジュールではありません。

- **`import` 禁止**: `agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` と `args`/`budget` は引数として注入されるため、そのまま使用します。
- **TS 構文禁止**: 型注釈（`x: number`）、`interface`、`enum`、`as`、ジェネリクスは使用できません。エンジンはトランスパイルしないため、ファイルが `.ts` でもそのまま構文エラーになります。
- **`export const meta = {...}` は 1 か所だけ許可**（エンジンが正規表現で抽出して除去）。ほかの `export` や `export default` は使用できません。
- **トップレベルの `return`** で結果を返します。

**決定性の制約**（違反すると resume が無効）:
- `Date.now()` / `Math.random()` / 引数なしの `new Date()` は禁止（サンドボックス が強制的に例外を投げます）。timestamp や乱数 seed が必要なら `args` で渡します。
- `export const meta = { ... }` は**純粋なリテラル**でなければなりません（変数、関数呼び出し、template interpolation は不可）。読み込み時に評価され、違反すると `ScriptError` を投げます。

## 5. Workflow ツール

モデルは `Workflow` ツールで workflow を起動します（input schema はエンジンパッケージの `tool/schema.ts` を参照）。

| フィールド | 説明 |
|------|------|
| `script` | inline script の文字列 |
| `name` | 名前付き workflow の名前（`.occ/workflows/<name>` に対応） |
| `scriptPath` | スクリプトファイルのパス |
| `args` | スクリプトの `args` へそのまま渡す（任意の JSON 値） |
| `resumeFromRunId` | 既存の runId から再生する（成功した `agent()` はキャッシュから即座に返る。**失敗（dead）した項目は再実行**。分岐点以降はその場で再実行する） |
| `maxConcurrency` | run 単位の並行処理の上書き（`[1, 16]` に clamp）。省略時は `OCC_WORKFLOW_MAX_CONCURRENCY`、それも無ければエンジンのデフォルト 6 |

## 6. 監視パネル: `/workflows`

`/workflows` は 3 つのフォーカス領域を持つ全画面パネル（local-jsx）を開きます。

- **上部の tabs**: run ごとに 1 つの tab（状態を示す丸 + workflow 名 + `#runId短縮コード`）。同じ名前のスクリプトを複数回実行すると複数の tab ができます。
- **左側の phase sidebar**: `All` + meta で宣言された phase（未開始は `○` pending の灰色）と実際の phase（`●` running / `✓` done）を統合して表示します。選択した phase が右ペインの filter を決めます。
- **右側の agent 一覧**: 選択した phase で絞り込み、さらに状態で filter します（`f` で all → running → done → failed と循環。all 以外ではタイトル末尾に `· <filter> only` を追加）。各行は、状態の色付きマーク + label（**表示幅** 28 桁、`#N` suffix は保持）+ `model · Nk tok` + 右寄せの経過時間列です。モデル名は短縮されます（`us.anthropic.claude-sonnet-5-20260101` → `sonnet-5`）。**行ごとのツール呼び出し回数は agent 詳細へ移動済み**です。列幅は label に使うほうが有用なためです。
  - **マークの意味**: `●`（spinner）running · `✓` done·ok · `✗` done·dead（エンジンが判定した失敗）· `⊘` skipped（ユーザーによるスキップ）· `⊘` **stopped**。最後のものは、run 自体が終了状態に達した時点でまだ実行中だったため `run_done` に回収された agent です（`run-killed` / `run-failed` / `run-ended`）。結果は生成していませんが自分の落ち度で死んだわけでもなく、赤い `✗ failed` として描画することは、`K` を押したばかりのユーザーに「あなたの kill が失敗した」と伝えるのと同じです。
  - **リトライ状態**: エンジンが backoff 中は、行頭の spinner が `↻` で固定され、右側の `model · Nk tok` が `↻ n/m <reason>` に置き換わります（上限 m 回中 n 回目の試行。理由は 14 桁で切り詰め）。backoff の窓は `retryingSince + retryDelayMs` と実時刻の比較で判定します。store が報告するのは backoff の**開始**だけで、終了は決して報告しないためです。backoff が明けると通常表示に戻ります。リトライ履歴の全体は agent 詳細の `retries` 欄にあります。
  - **filter の範囲**: `failed` バケットは `resultKind === 'dead'` なので、`⊘ stopped` の回収された agent も**含みます**（述語を狭めると、それらがどの filter からも消えてしまいます）。タイトルはそれに合わせて `· failed/stopped only` と表示します。
  - **行高の不変条件**: 各行は必ず 1 行です。両方の列が `truncate-end` を宣言しているため、狭い端末ではまず label が、次に meta が幅を譲り、折り返しは起きません。折り返すと選択行の背景色が 2 行とも塗ってしまい、ハイライトが 2 つに割れて見えます。phase sidebar も同じ規則です。
- **右側の agent 詳細**: agent 一覧で `↵` または `→` を押すと、右ペイン全体が選択した agent の状態ビューに切り替わります。status / phase / model / elapsed / context tok / output tok / tool calls / **retries**（`2/3 (api-error)`。実際にリトライが起きた場合のみ表示し、`lastFailureDetail` があれば別行で添えます）を表示します。失敗時は、さらに**失敗理由**（エンジンの `no-structured-output`、`prompt-too-long`、`api-error` などを平易な表現に変換）、`retryable:false` に対する「決定論的な失敗であり、同じ呼び出しを再実行しても成功しない」という警告、エンジンの detail を表示します。run に回収された agent は、赤い `Failure` ではなく中立的な **`Stopped`** ブロックになり、workflow と一緒に停止したことを明示します。backoff 中は末尾の案内が「カウントはリアルタイム更新」から「リトライ待機中 — n/m 回目の試行は Xs の backoff 後に開始」に切り替わります。backoff 中はカウントが凍結しているためです。成功時は返り値のプレビュー（オブジェクトまたはテキスト。store 側で 400 文字に切り詰める）を表示します。詳細画面では `↑`/`↓` で前後の agent に直接移動でき、一覧に戻る必要はありません。

**キーバインド**: `Tab`/`Shift+Tab` で run を切り替え · `←`/`→` で phases → agents → agent 詳細の間を移動 · `↵` で選択中の agent の詳細を開く · `↑`/`↓` で領域内を移動 · `f` で状態 filter を切り替え · `r` で resume · `x` で選択中の agent を kill · `K` で workflow 全体を kill · `n` で新規プロンプト · `q`/`Esc` で終了。

> `←` は**1 階層だけ戻り**（詳細 → 一覧 → phase sidebar）、phase sidebar で止まります。パネルを閉じることはありません。パネルを閉じるのは `Esc`/`q` の役目です。`f` で filter を切り替えると選択項目を 0 行目にリセットします。残る行の集合が変わるため、以前の index をそのまま使うと、`x` が気付かないうちに別の agent を指してしまいます。

**外観**: 内側の枠線はなく、左右を 1 本の縦線で区切ります。フォーカス中の列タイトルは太字のオレンジです。選択行またはカーソル行はオレンジの背景（`backgroundColor`）で塗り、文字色は変えません。

進捗はエンジンの `agentId` によって `agent_done` と正確に関連付けられます（並行処理時の LIFO 競合を解消）。pending phase は `run_started` イベントが持つ `meta.phases` から取得し、store が `declaredPhases` に保存して、パネルの `mergePhases` が統合します。`useSyncExternalStore` で `WorkflowService` を購読し、安定した snapshot を使うため、変更がなければ再描画しません。

### バックグラウンドタスク画面の workflow 詳細

`/tasks`（Shift+↓）のバックグラウンドタスク一覧で workflow 項目を選ぶと、`WorkflowDetailDialog`（`src/components/tasks/WorkflowDetailDialog.tsx`）が開きます。パネルと同じデータソース（同一の `ProgressStore`）を使うリアルタイムの単一カラム表示です。状態 header + phase 行（`○/●/✓` + done/total）+ agent ごとの行（パネルの `AgentList` を再利用するため、マークとリトライ状態の意味は §6 とまったく同じです。`model · Nk tok`、backoff 中は `↻ n/m reason`。行ごとのツール呼び出し回数は詳細ビューにあります）で構成されます。agent 一覧は選択項目を中心に sliding window を作ります（`MAX_VISIBLE_AGENTS=10`。折りたたみ行には `… N earlier/more` を表示）。

このダイアログは**自前の枠線を描きません**。内側の `Dialog` が描画する `Pane` の上端の罫線が唯一の枠です。それをさらに `borderStyle` で包むと、端末幅いっぱいの区切り線が「枠線 + padding」で桁を消費した箱の中で溢れて折り返し、タイトルの上に切れた横線が 1 本現れて枠線がずれます。ルートの `Box` には `autoFocus` が必須です。ink はキーを `focusManager.activeElement`（無ければルートノード）にのみ配送して上方向へバブルさせるため、タスク一覧から入るとその一覧が unmount され `activeElement` は null になります。これが無いと `onKeyDown` のキーマップ全体（`←`/`↑`/`↓`/`↵`/`K`/`y`/`n`）が届かなくなり、グローバル登録の `x` と `Esc` だけが反応する状態になります。

`↵`/`→` で選択した agent の詳細へ同様に入れます（`/workflows` パネルの `AgentDetail` を再利用）。2 つの画面は同じ run を描画するため、navigation gesture が競合してはなりません。

**キーバインド**: `↑`/`↓` で agent を選択 · `↵`/`→` で agent 詳細へ移動 · `x` で選択中の agent を kill（設定可能な `taskDetail:kill` を使用）· `K` で workflow 全体を kill · どちらも `y`/`n` による確認が必要 · `←` で 1 階層戻る（詳細 → 一覧 → dialog を閉じる）· `Esc` で直接閉じる。データとキー操作の projection 層は `workflowDetailData.ts` にあり、React-free で単体テストできます。

## 7. `/ultracode` skill

`/ultracode`（`src/skills/bundled/ultracode.ts`）はマルチエージェント workflow オーケストレーションの進め方を注入します。使用する場合と使用しない場合、プリミティブのクイックリファレンス、品質パターン集（adversarial-verify / judge-panel / loop-until-dry / multi-modal-sweep / completeness-critic）、決定性の制約、バックエンドの routing、resume/budget、ファイルとコマンドを扱います。

**知識のみを提供する prompt skill**です。実行時の副作用はなく、メインループを変更せず、挙動のスイッチも切り替えません。呼び出すと手引きがコンテキストへ注入されます。

## 8. resume / journal / budget / エラー回復

- **journal**: 各 run を `.occ/workflow-runs/<runId>/journal.jsonl` に記録します。`resumeFromRunId` は journal を再生します。成功した結果はキャッシュから即座に返します。**dead 項目は「記録済みの失敗」とみなし、再生時にその場で再実行します**。失敗を繰り返すのではなく再試行することが、checkpoint から再開する目的だからです。再実行の結果は同じ `seq` で追記し、`read()` は seq 単位で重複を除去して**最後の 1 件を保持**するため、新しい結果が以前の失敗を上書きします。
- **journal の破損処理**: 1 行ずつ解析し、検証済みの有効な prefix を保持します。**ファイル末尾にあり、末尾の改行がない**不完全な行（プロセスの強制終了で残るもの）だけを無視して警告します。途中の行が壊れている、または構造が不正な場合は `JournalCorruptionError` を投げ、「履歴なし」として黙って扱うことはありません。そうするとすべての checkpoint を失って最初から再実行し、料金と外部副作用が重複するためです。`ENOENT` 以外の I/O エラーも通常どおり投げます。
- **journal の分岐と `script.js`**: agent key が分岐した場合は、有効な prefix を atomically にディスクへ書き戻してから新しいレコードを追記します。`truncate()` が消去するのは **`journal.jsonl` だけ**で、同じディレクトリの inline `script.js` は保持します（inline → 編集 → `scriptPath` resume という経路を成立させるため）。ディレクトリ全体の消去は独立した `deleteRun()` が担当します。
- **`resumeFromRunId` の形式制約**: `^[A-Za-z0-9_-]{1,128}$` だけを受け付け、schema と storage 層の両方で検証します。これは runs ディレクトリのパス断片として使われ、`deleteRun()` はそのディレクトリを再帰的に削除します。検証しなければ、「workflow の復元」が任意ディレクトリの削除になります。
- **agent のインプレース再試行**: dead または abort 以外の例外を最大 `AGENT_MAX_RETRIES`（3）回まで再試行します。待機時間は `AGENT_RETRY_BACKOFF_MS`（2s）× 2^(n-1) に最大 25% の jitter を加えた値です（`retryDelayMs()`。abort で中断可能。jitter は `parallel` のバッチ全体が同じ過負荷のエンドポイントへ足並みを揃えて再突入するのを防ぎます）。**`retryable:false` の決定論的な失敗は再試行しません**（`prompt-too-long`: context に収まらない。`worktree-failed` の**大半**: git リポジトリでない・ディスク不足・ブランチ名が使用済みなど）。同じ呼び出しを再送しても必ず再び失敗するためです。唯一の例外が **git のロック競合**（`index.lock': File exists` / `cannot lock ref`）です。同時に isolation へ入る複数の agent が同じ base ref を fetch/作成しようとしますが、その間に排他制御は一切なく、負けた側がロックで死にます。**並行度を 3 から 6 に上げたことでこの衝突はむしろ増える**ため、ここは再試行可能のままにします（detail から `isGitLockContention()` で判定）。`AGENT_MAX_RETRIES_BY_REASON` は死因ごとに予算を絞ります。`no-structured-output` は 1 回（再試行の単位が「**すでに token を使い切った完全な agent の実行**」であり、2 回続けて schema を外すのは運ではなく prompt/schema の問題だからです）。`worktree-failed` も 1 回（ロックは 1 回の backoff で空くか、さもなければ誰かが握り続けているかのどちらかです）。
- **再試行の可観測性**: 再試行のたびに **`agent_retry` イベント**（`{agentId, attempt, limit, reason, detail, delayMs}`）を emit します。2 本目の `agent_started` では**ありません**。`agent_started` を再送すると store の `startedAt` がリセットされ、すでに 14s 再試行している agent が「開始直後」として描画されてしまい、何も出さないより悪化します。store は `agent_retry` を受けても `startedAt` を保持し（経過時間は再試行チェーン全体を通して積算）、`retryCount`/`retryLimit`/`lastFailureReason`/`retryingSince`/`retryDelayMs` だけを更新してパネルに渡します。`agent_started` の再スタート分岐は run 単位の journal resume 専用です（新しい context では agentId が 0 から振り直されます）。進捗イベントは一時的なもので **journal には入らない**ため、resume には影響しません。
- **エンジン側が 3 回だけである理由**: API のトランスポート層は一過性のネットワークエラーを独自の exponential backoff で再試行しており、2 つの予算は**掛け算**になります。エンジン側に 2 桁の予算を持たせると、詰まったエンドポイント 1 つが「生きているように見えて何も進まない workflow」を数十分続けることになります。この 3 回が担うのは、トランスポート層からは見えない失敗（通常のメッセージとして包まれた最終的なエラー、adapter 自身が投げた例外）です。
- **run 単位の自動 checkpoint resume**: スクリプトの実行が失敗した場合（多くは dead agent の `null` がスクリプト内で TypeError を起こした場合）、journal から**自動的に 1 回 resume して再試行**します。成功した agent はすべてキャッシュから即座に返り、失敗したものだけを再実行します。`WorkflowError`（設定または上限に関する決定論的エラー）と `BudgetExhaustedError`（新しい context では spent がリセットされ、超過するため）は対象外です。`autoRetryOnFailure:false` で無効化できます。
- **API エラーの分類**（`claudeCodeBackend`）: query 層は最終的な API エラーを `isApiErrorMessage` の assistant message に包み、例外を投げません。backend はこれを明示的に識別し、`dead` として `reason: 'prompt-too-long'`（`retryable:false`）または `'api-error'`（一過性で再試行可能）を設定します。この修正前は、schema を使わないモードでエラーテキストが agent の正常な出力として扱われていました。529 overload は API 層が exponential backoff 付きで再試行します（`'workflow'` は `FOREGROUND_529_RETRY_SOURCES` に追加済み）。
- **budget**: `budget.total` は token のハード上限（デフォルトの `null` は無制限）。`budget.spent()` / `budget.remaining()` はリアルタイムの消費量を返し、使い切った後の `agent()` 呼び出しは例外を投げます。
- **並行処理**: エンジンの `Semaphore` はデフォルトで 6 つの permit を持ちます（`DEFAULT_MAX_CONCURRENCY`。2026-08 に 3 から引き上げ。3 では典型的な fan-out（8〜20 項目の `parallel`）が実時間の大半を semaphore 待ちで過ごす一方、本当の上限は上流にあります。Agent ツール自身の同時 spawn 予算 20 と provider のレート制限です）。優先順位は `maxConcurrency` 引数 > `OCC_WORKFLOW_MAX_CONCURRENCY`（host 側で読み取り。エンジンパッケージは `process.env` を一切参照しません）> デフォルト値で、いずれも `clampMaxConcurrency` で `[1, MAX_CONCURRENCY_CAP=16]` に clamp されます。ツールの prompt は**実効**デフォルト値を提示します（`buildWorkflowToolPrompt` が descriptor ごとに算出）。schema の describe はモジュールレベルの singleton なので、コンパイル時の定数しか示せません。
- **再試行は spawn 予算を消費します**: エンジンの再試行は実際の subagent spawn であり、host の session 累計予算（`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`、**設定時のみ有効・既定は無制限**）と同時実行上限（デフォルト 20）を Agent ツールと共有します。失敗し続ける fan-out は agent 数の最大 4 倍の枠を消費し得ます。
- **run 終了時のスイープ**: `run_done` が届くと、store はまだ `running` の agent をまとめて終端状態にします（`resultKind:'dead'`、`failureReason:'run-killed'`/`'run-failed'`/`'run-ended'`）。kill された run は agent の実行中（再試行の backoff 中であっても）にエンジンを破棄するため、それらの agent は自分の `agent_done` を受け取れず、放置するとパネル上で永久に回り続けタイマーだけが伸びていきます。
- **エラー**: スクリプトの構文または meta エラー → `parseScript` が即座にエラーを返す（バックグラウンドには入らない）。agent の例外 → `kind:'dead'` → `null` となり workflow は継続する（`parallel`/`pipeline` はエラーを許容するが、**`WorkflowAbortedError` は貫通する**。kill は run を終了させる必要がある）。`WorkflowAbortedError` → `killed`。

## 9. ファイル索引

| ファイル | 責務 |
|------|------|
| `src/workflow/wiring.ts` | `Workflow` ツールの組み立て（`createWorkflowToolCore`） |
| `src/workflow/service.ts` | `WorkflowService` ファサード |
| `src/workflow/ports.ts` | port の集約（`createWorkflowPorts`） |
| `src/workflow/registry.ts` | `AgentAdapterRegistry` + デフォルトのバックエンド |
| `src/workflow/backends/claudeCodeBackend.ts` | 深層バックエンドの AgentAdapter |
| `src/workflow/hostHandle.ts` | 不透明な host ハンドル（`buildHostBundle`） |
| `src/workflow/progress/bus.ts` | 進捗イベント bus |
| `src/workflow/progress/store.ts` | 進捗 reducer（`agentId` による関連付け） |
| `src/workflow/panel/*.tsx` | `/workflows` の 2 ペインパネル |
| `src/workflow/namedWorkflowCommands.ts` | `/<name>` コマンドの検出 |
| `src/workflow/WorkflowPermissionRequest.tsx` | 起動時の権限 UI |
| `src/components/tasks/WorkflowDetailDialog.tsx` | バックグラウンドタスク画面の workflow 詳細（agent ごとのリアルタイム状態 + kill 操作） |
| `src/components/tasks/workflowDetailData.ts` | 詳細 dialog の window/key projection 層（React-free） |
| `src/skills/bundled/ultracode.ts` | `/ultracode` の知識 skill |
| `packages/builtin-tools/src/registry.ts` | ツール登録（feature-gated require） |
| `src/commands.ts` | `/workflows` コマンドの登録 |
| `packages/workflow-engine/` | エンジンパッケージ（hooks / journal / budget / 並行処理） |
