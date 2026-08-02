> **本文档已被接续。** S6/S7/S8 的完成情况见 [`handoff-2026-08-02-refactor.md`](handoff-2026-08-02-refactor.md)。
> 下面这份保留为历史记录 —— 它描述的是 2026-08-01 那一刻的状态，其中「立即卡口」「后续任务清单」等章节**已经过时**，不要照着执行。

# 交接文档 — open-claude-code 全仓库解耦/模块化/重构工程

> 交接时间：2026-08-01
> 来源：WSL(Ubuntu) 上运行的 Claude Code 会话 `073b77f0-1b71-4d5b-ad19-2c09bd9ece3a`
> （2026-07-31 00:49 UTC 起，至 2026-08-01 15:25 UTC 进程退出中断）
> 会话记录：`~/.claude/projects/-mnt-d-project-claude-code/073b77f0-*.jsonl`（37 MB，WSL 内）
> 工作目录：WSL `/mnt/d/project/claude-code` = Windows `D:\project\claude-code`（同一个仓库）

---

## 0. 一页速览

| 项 | 值 |
|---|---|
| 总任务 | 全仓库解耦合 + 模块化 + 重构 + 修 bug + 补规范文档 → 与官方 Claude Code 环境隔离 → 改名 open-claude-code / `occ` |
| 执行计划 | 九个 Stage：**S0–S5 已完成**，**S6 进行中**，**S7/S8 未开始** |
| 主线状态 | 本地 `main` = `eb4b4d3b`，**领先 `occ/main` 4 个提交（未推送）** |
| 立即卡口 | 这 4 个提交会让 `bun run check:cycles` 失败，必须先重基线（见 §4.1） |
| 在途丢失的工作 | `analytics facade`（codex lane）随进程退出丢失，worktree 无任何产出，**需重跑** |
| 独立未完成议题 | WSL 里 Claude Code 频繁崩溃（OOM）—— 调查刚起了个头，见 §6 |

**接手者第一件事**：读 §4「当前仓库状态与立即动作」，把本地 4 个提交安全推上去，再按 §5 继续。

---

## 1. 背景与目标

这个仓库是 Anthropic Claude Code CLI 的逆向/反编译社区版。本轮工程由用户在 2026-07-31 批准的计划驱动，目标四条：

1. **全仓库解耦合、模块化、重构复杂代码块、修 bug、代码优化**
2. **补齐开发规范文档**
3. **与官方 Claude Code 完全环境隔离** —— 配置、skill、MCP 配置等全部互不干扰，社区版成为独立主体
4. **改名 `open-claude-code`（简称 occ）**，CLI 入口为 `occ`，其余 `ccb` 标识全部切断

其中 3、4 在本轮之前/之初已完成并写入 `CLAUDE.md`（「路径与隔离不变式」一节是本轮产物，改路径相关代码前必读）。

### 完整计划正文在哪

计划主体（Part 1 结构解耦 / Part 2 子系统替代 / Part 3 快车道 / Part 4 协议升级 + 九 Stage 执行序列）保存在会话记录的 ExitPlanMode 调用里。提取命令：

```bash
# 在 WSL 中
jq -r 'select(.type=="assistant") | .message.content
       | if type=="array" then (map(select(.type=="tool_use" and (.name=="ExitPlanMode"))
         | .input.plan) | join("\n\n=====\n")) else empty end | select(length>0)' \
  ~/.claude/projects/-mnt-d-project-claude-code/073b77f0-1b71-4d5b-ad19-2c09bd9ece3a.jsonl \
  > /tmp/plan.md
```

仓库内相关的既有设计文档：

- `docs/trim-plan.md`（107 KB）—— 瘦身/删除计划
- `docs/acp-refactor-plan.md` —— **本轮所有拆分遵循的打法模板**（<500 行模块目录 + re-export barrel 精确保留导出面、不改既有测试、每 commit precheck 绿）
- `docs/agent/sur-loop-scheduled-oom.md` —— Windows OOM 真因与修复 diff（已 shipped）
- `docs/features/mcp-2026.md` —— 本轮新写，MCP 2026-07-28 支持状态

---

## 2. 执行模型（怎么干活的，接手后建议延续）

| 角色 | 模型 | 职责 |
|---|---|---|
| 主编排 | Fable 5 | 只做决策/规格/审查/合并/推送，**不亲自 fan out 同模型** |
| 判断密集型 lane | Opus 5（Agent tool） | API 设计、跨模块手术、接口提取、monolith 拆分 |
| 机械密集型 lane | Codex `gpt-5.6-sol` effort `xhigh` | 规格明确的搬迁/codemod/移植；主编排写 spec → 后台 `codex exec` → 主编排验收 |
| 并行编排 | Workflow 工具 | 确定性并行，每 lane 一个独立 worktree |

**硬约束（用户明确指示）**：不要一个 agent 一个个串行做；用 workflow 并行；fan out 只能是 Opus 5 和 Codex，不能是主模型自己。

**lane 纪律**：每条 lane 在自己的 worktree 里只跑 `bun run typecheck` + 自己新增的测试；**全量 `bun run precheck` 由主编排在合并时统一跑一次**（4 路并发跑 precheck 会互相拖垮）。

---

## 3. 已完成的工作（S0–S5 + S6 部分 + S7 首件）

推送目标是 `occ` 远端（`https://github.com/sweetcornna/open-claude-code.git`），**不是** `origin`（`claude-code-best/claude-code`，旧上游，已落后一百多个提交，不要往那里推）。

| Stage | 内容 | 结果 |
|---|---|---|
| **S0** | ink 5 个显示 bug、GC 阈值 + provider 首方判定修复、品牌全切断（`ccb`/`ccb-bun`/`ccbMode`/`claude-cli://`/归属邮箱）、cloud-artifacts token 轮换、Windows CI job + madge 环数 ratchet | 完成 |
| **S1** | Sleep 工具移除（Monitor `wait_seconds` 替代）、sur-loop OOM 修复核实已 shipped | 完成 |
| **S2** | workflow 运行状态常驻可见（footer pill + 后台任务对话框）、`bootstrap/state.ts` 拆 9 叶子模块 | 完成 |
| **S3** | prompt 纯叶子化破巨环（启动成本 bug 灭除，环 −347）、`@ant/ink` 内部环 22→0 | 完成 |
| **S4** | artifacts 双后端（`ArtifactStore` 接口 + rustypaste）、Chrome 换官方 `chrome-devtools-mcp`（**删 6.1k 行**）、远控换 Happy/ACP（**删 48k 行**）、Computer Use 模块化（`toolCalls.ts` 4400 → 265 行 barrel + 19 模块） | 完成 |
| **S5** | MCP 升级到 spec 2026-07-28：SDK v2 依赖、serve 双纪元、4 个自定义 transport 移植、client 迁移 + `MCP_2026` 编译 flag（默认关）、MRTR 多轮 UX + 轮次超限降级、OAuth 加固（RFC 9207 `iss` 校验 / 凭据按 issuer 分槽 / DCR native）、computer-use 服务器移植、skills frontmatter 透传、v1 SDK 退役、文档 | 完成 |
| **S6** | tool-runtime 依赖反转 —— **Wave A 完成**（6 模块 137 处）、**Wave B 完成**（Tool 契约 123 处）、**Wave C1 完成**（registry 入包） | **进行中** |
| **S7** | monolith 拆分 —— **4a `messages.ts` 拆分完成但未推送** | **刚开始** |
| **S8** | 收尾 —— 只有 4 处「矛盾修复」提前由 codex 做掉了（Bun 版本统一 1.3.11、删空 workspaces glob、`check:bundle` 进 CI + `check:unused` 非阻断、codecov 休眠标注 + workflow-runs gitignore） | **未开始** |

### 量化净效果

- 仓库瘦身约 **54k 行**，同时功能是**增强**的：浏览器控制从 fail-closed 死态恢复可用、远控获得移动端 + E2E 加密、workflow 状态免命令可见
- 循环依赖：runtime 480 → **463**，total 2648 → **2181**
- `builtin-tools` 反向 import：1211 → **920**
- 测试：约 5829 通过 / 0 失败（最后一次成功推送时）

---

## 4. 当前仓库状态与立即动作

### 4.0 状态快照

```
本地 main            eb4b4d3b  （ahead of occ/main by 4）
occ/main             9166757c  refactor(builtin-tools): consume slow operations from tool-runtime
工作区               干净
```

领先的 4 个提交 = S7-4a `messages.ts` 拆分（5931 行 → 141 行 barrel + 18 模块）：

```
e485917b refactor(messages): extract the text and predicate leaves
c61ce468 refactor(messages): extract constructors and system messages
d8ad6092 refactor(messages): extract lookups, filters and pairing
eb4b4d3b refactor(messages): extract normalization and streaming; finish the barrel
```

拆分质量已由 lane 验证：56 个搬移块**字节级相同**，105 个运行时导出面**原样不变**（153 个 importer 零改动，零测试改动），37/37 characterization 测试绿。

### 4.1 卡口：环数 ratchet 会失败（必须先处理）

`scripts/cycle-budget.json` 当前是 `{"runtime": 463, "total": 2181}`，而当前 `main` 实测为 **runtime 469（+6）/ total 2186（+5）**。已在 `eb4b4d3b` 上实跑确认：

```
[cycles] FAIL total: 2186 cycles, budget is 2181 (+5).
[cycles] This change introduced new import cycles. Break the cycle,
[cycles] or raise "total" in scripts/cycle-budget.json deliberately.
error: script "check:cycles" exited with code 1
```

ratchet 是双向严格的（超预算 fail、低于预算也 fail），所以 CI 的 `check:cycles` 步骤现在是红的。

这个 +6/+5 是**表示性**的、不是新耦合：既有的 `messages ↔ services/api ↔ tools ↔ components` 环族因为 barrel 多了一跳（`messages.ts → messages/apiNormalize.ts → services/api/errors.ts → …`），在更细粒度下多枚举出几条简单环。

按仓库自己的协议处理：

```bash
bun run scripts/check-cycles.ts --update   # 重基线
git add scripts/cycle-budget.json && git commit -m "chore: re-baseline cycle counts after the messages split"
bun run precheck                            # 必须零错误
git push occ main
```

> 提示：`bun run check:cycles` / madge 全量导出耗时数分钟，放后台跑。

### 4.2 遗留 worktree（两个，都需要收尾）

`git worktree list` 显示两个外部 worktree，位于 WSL 路径 `/mnt/d/project/occ-wt/`：

| worktree | 分支 | HEAD | 状态 |
|---|---|---|---|
| `occ-wt/messages-split` | `wt/messages-split` | `57df6b6f` | 产出已 cherry-pick 进 main，**可删** |
| `occ-wt/facade-analytics` | `wt/facade-analytics` | `9166757c` | **零提交、零未提交改动 —— 这条 lane 什么都没产出** |

> ⚠️ 这两个 worktree 的 `.git` 文件里写的是 Linux 路径，**只能在 WSL 里操作**；在 Windows 侧 `git -C D:\project\occ-wt\...` 会报 `fatal: not a git repository`。

清理（在 WSL 中）：

```bash
cd /mnt/d/project/claude-code
git worktree remove /mnt/d/project/occ-wt/messages-split
git branch -d wt/messages-split
# facade-analytics 确认无产出后同样处理
```

### 4.3 丢失的在途工作

会话最后一条动作是在排查：**analytics facade 的 codex 任务随上一个 Claude Code 进程退出而失联**，没有完成记录。已核实其 worktree `HEAD` 停在 `9166757c`（即派发时的 main），`git status` 干净 —— **该任务零产出，需要按 §5.1 重新派发**。

---

## 5. 后续任务清单

### 5.1 S6 剩余 —— Wave C2（依赖反转长尾，可作为尾流推进，不阻塞 S7）

已立住的样板：`slowOperations` facade（提交 `7bf70cee` + `9166757c`）—— tool-runtime 声明接口 + host 启动时注册 + 31 个文件翻转。剩下三个照方抓药：

| 项 | 规模 | 状态 |
|---|---|---|
| **analytics facade** | 25 处翻转 | **需重跑**（上次丢失） |
| **MessageResponse facade** | 27 处翻转 | 未开始 |
| **bootstrap-state facade** | 26 处翻转 | 未开始 |
| **22 条 type 边燃尽** | type-only 回引换成 tool-runtime 声明的结构接口，host 用 `satisfies` 注册 | 未开始 |

另外，Wave A 期间被审计守卫**合理封锁**的 6 个模块（`format`、`envUtils`、`path`、`slowOperations`、`debug`，以及 lane 3 报告的另一个）挂着非叶子依赖，全部记入 Wave C 的 facade 注入清单 —— `slowOperations` 已按此路径解决，其余同理。

> Wave C1 的一个重要副产物：证伪了三个手写 lazy-require「破环器」的实际作用（madge 连 require 边一起算，它们从未减过环）。同类「优化」不要再加。

### 5.2 S7 —— monolith 拆分 + 内存修复（XL，主战场）

拆分顺序：`messages.ts`（✅ 已完成待推）→ `main.tsx` → `print.ts` → `REPL.tsx`，二线三件（`sessionStorage` / `hooks` / `attachments`）在 4a 模式立好后穿插。

**安全网已就位**：S7 开工前已经用 workflow 并行铺了 characterization 测试（4 条 lane，只增测试文件、零生产代码改动），包括 messages 导出面快照 + lookup 增量等价性属性测试、CLI 参数子进程 golden 测试、headless NDJSON 事件序列固定、sessionStorage/hooks/attachments 导出面快照。

| 子项 | 要点 |
|---|---|
| **4b `main.tsx` 拆分**（下一个）| → `src/cli/program/`（rootOptions/preAction/rootAction verbatim 搬 + `commands/` 14 文件）；**必须保住 print 模式跳过子命令注册的 65 ms 优化**；churn 最高，**拆分窗口内其他工作流禁碰 `main.tsx`**；由已入库的 14 个 cli-golden 测试护航 |
| **4c `print.ts` 拆分** | → 9 模块；`runHeadlessStreaming` 二遍拆（先搬顶层函数零风险，再引入 `HeadlessRunState` 上下文对象逐层拆嵌套） |
| **4d `REPL.tsx` 拆分** | 最保守：纯 helper → 3 个内联组件 → gated hooks → 连续 hook 簇**原位提取**（同位置替换保 hook 调用顺序，先以代码注释提交簇映射）；目标 <2000 行 orchestrator |
| **4e 二线三件** | `sessionStorage`（刻意隔离两个内存点）/ `hooks`（config/messages/execution/toolHooks/lifecycleHooks/commandHooks）/ `attachments`（100 importer，barrel 必须） |
| **阶段 5 内存修复（逐项 gate）** | 5.2 `Messages.tsx` 接线增量 lookup（gate 4a，**现在可以做了**）；5.3 `query.ts` 展开复制 + AutoCompact 时序 + reactiveCompact（gate 4a）；5.4 sessionStorage 流式读写（gate 4e）；5.5 forkedAgent FileStateCache 分层；5.6 `lastAPIRequestMessages` 截断留存 |
| **5.7 Windows 1 小时浸泡验证** | 按 `docs/agent/sur-loop-scheduled-oom.md` 复现形状（2 HEARTBEAT + 3 cron），验收标准 = RSS 曲线 warmup 后平坡；预期管理：Bun mimalloc 不还页（~150–250 MB 常驻地板），目标是**削峰不是降基线** |

> 5.2 的安全网就是 messages lane 写的 `buildMessageLookups` vs `updateMessageLookupsIncremental` **等价性属性测试** —— 它已经如实钉住了三处 build 与增量 lookup 的**真实分歧**（「记录而非背书」）。做 5.2 之前先读这三处。

### 5.3 S8 —— 收尾（L）

- **utils 平铺层领域分组**：move-with-shim + 延迟 codemod（明确拒绝 big-bang 和 leave-and-barrel），约 10–14 对提交，knip 清尾
- **`onKeyDown` / keybindings 迁移收尾**
- **ACP 4 个 critical 合规项**（此前为避免五路并发挤兑 precheck 被刻意压后）
- **规范文档（3-WS6，最后做，描述终态）**：
  - 剩余矛盾修复（`spec/` 与 `docs/superpowers/` 分工文档化、`.claude`/`.occ` 双目录政策文档化、commit scope 形式合法化、commit 语言规则）
  - 新写 `CONTRIBUTING.md`（11 节，中文主体 + 英文术语，**「指针不复制」铁律** —— AGENTS.md 783 行漂移是前车之鉴）
  - PR 模板（5 项清单）
  - `SECURITY.md` 重写（真实版本 + GitHub Security Advisories 私密通道，**不用邮箱**，邮箱域正在退役）
- **独立 verification agent 终审**：S6/S7/S8 各自末尾都要跑一次，PASS 必须附命令证据

### 5.4 每个 Stage 的完成门槛（沿用）

`bun run precheck` 零错误 + 相关 characterization/新增测试绿 + Conventional Commits 推 `occ/main` + 自审。

---

## 6. 独立议题：WSL 里 Claude Code 频繁崩溃（未完成）

这是**最新一次会话**（`8f261731-5c6c-4d9b-9317-8f9c45764f6a`，2026-08-01 16:41 UTC）的任务，用户原话：「解决 claude 在 wsl 总是崩溃的问题」。调查只跑了 4 条命令就中断，**尚无结论**。

已采集到的事实：

- **内核日志确证是 OOM**：`Out of memory: Killed process 386748 (python) total-vm:16285516kB, anon-rss:13261920kB` —— 是 `global_oom`（`constraint=CONSTRAINT_NONE`），即**整个 WSL VM 内存耗尽**，不是 cgroup 限额。这种情况下内核挑最大的进程杀，长跑的 `claude` / `codex` 属于高危目标。
- **VM 规格**：15 GiB 内存 / 4 GiB swap / 32 核。`.wslconfig` **没有 `memory=` 和 `swap=` 配置**，走的是 WSL2 默认（宿主内存 50%、内存 25% 作 swap）。
- `.wslconfig` 现有内容：`networkingMode=mirrored`、`dnsTunneling=true`、`firewall=true`、`autoProxy=true`、`vmIdleTimeout=-1`（为保住 `hermes-webui`/`hermes-tunnel` 的 systemd --user 服务常驻）。
- **安装方式**：`claude` 在 `~/.local/bin/claude`，版本 2.1.220；`bun` 1.3.14 在 `~/.local/bin/bun`。
- 注意：VM 此后重启过，`dmesg` 缓冲区已清空，上面那条 OOM 记录只存在于会话记录里。

值得作为**假设**（尚未验证）纳入排查：

- 本轮重构会话本身长期同时跑 5 个 codex 进程 + 4 lane workflow + 多个 worktree 里的 `bun install` / `bun test`，每个都是 GB 级；15 GiB 的 VM 很容易被这个组合打爆。
- **同一个 WSL VM 里还跑着别的项目的负载**：写这份交接文档时 `ps` 里就有一个无关的 `.venv/bin/python -m pytest` 在跑，而上次 OOM 杀掉的正是一个 13 GB 的 python 进程。也就是说，崩溃的直接原因很可能不在 occ 自己身上。

这与「Claude Code 自身泄漏」是两个不同的假设，需要分别验证。

建议的下一步：

1. 先在 `.wslconfig` 里显式设 `memory=` / `swap=`（宿主内存允许的话给 24 GiB + 8 GiB swap），消除「默认 50%」这个隐性上限
2. 复现时用 `dmesg -T | grep -i "Out of memory"` 确认被杀的**到底是谁**（是 `claude`/`bun`/`node`，还是像上次那样是无关的 python 作业）
3. 若确证是 occ 自身：接 `docs/agent/sur-loop-scheduled-oom.md` 与 §5.2 的阶段 5 内存修复一起看，那里已有基线数据（682 MB 基线 / 1.8 GB 峰值）与完整修复 diff
4. 另可参考 `CLAUDE.md` 里的构建说明：单文件 17 MB 产物会让 Bun/JSC 全量解析导致 RSS 冲到 ~1 GB，代码分割后降到 35 MB —— 如果崩的是**自建产物**，先确认用的是 `build:vite` 的分割产物

---

## 7. 交接情报：踩过的坑（省时间用）

**编排相关**

- Workflow 的 `agent()` **默认继承主模型** —— 想让 lane 跑 Opus 必须显式 `{ model: 'opus' }`，否则会静默用主模型 fan out（踩过一次，整批 lane 作废重发）
- lane 的 worktree 如果建早了（基于旧 main），启动链里要**先 `git merge --ff-only main` 再干活**
- 用 `cd A && ... && cd B && ...` 串联多个 worktree 操作极易断链（一次 merge 跑错了目录）—— 从主检出干净地逐步执行
- codex 有两种跑法：companion 模式（受沙箱覆盖）与 `codex exec` **直连模式**（继承 config 的完全访问，能自己提交、跑完整 precheck）。机械大任务用直连模式效率高得多
- workflow 支持 `resumeFromRunId` 恢复：已完成 lane 走缓存重放，失败的重跑。S5 Stage 3 有两条 lane 因 `ECONNRESET` 挂掉，就是这么救回来的
- 后台任务（codex/agent）**随 Claude Code 进程退出而丢失且不留完成记录** —— 收到「No completion record was found」的 task-notification 时，一律去 worktree 里核实实际产出，别假设它完成了

**工具/环境相关**

- 9p 文件系统（`/mnt/d`）上删 `node_modules` 极慢（5 套删了 5 分钟还没完）—— 放后台
- `madge` 把 `require()` 边也算进环，所以手写 lazy-require「破环器」在环数上毫无作用
- MCP 迁移：官方迁移指南有**两处误导**；`_meta` 键是 **camelCase**；协议版本 2026-07-28 **只能经 `server/discover` 到达**
- 已知 flaky（与本轮改动无关，单跑都过）：`claudemd.projectDirs.test.ts`（recursive readdir 顺序比较）、`promptCharacterization`（子进程 `@opentelemetry/sdk-metrics` 模块解析竞态）

**仓库相关**

- 推送目标是 **`occ`** 远端，不是 `origin`
- `messages/attachmentNormalize.ts` 是 971 行，超过 700 行的模块尺寸目标 —— 因为 `normalizeAttachmentForAPI` 是一个 869 行的 verbatim `switch`，拆它需要真重构，被明确留作后续
- 拆分留下的两个死私有 helper（`appendMessageTagToUserMessage`、`isToolResultMessage`）是随搬迁保留的，不是新增的死代码

---

## 8. 会话记录取用方法

会话记录都在 WSL 里（Windows 侧 `\\wsl.localhost\` 访问不到，要用 `wsl.exe` 进去读）：

```bash
# 项目下所有会话
ls -la ~/.claude/projects/-mnt-d-project-claude-code/

# 主会话（37 MB）
F=~/.claude/projects/-mnt-d-project-claude-code/073b77f0-1b71-4d5b-ad19-2c09bd9ece3a.jsonl

# 抽用户指令
jq -r 'select(.type=="user") | .message.content
       | if type=="string" then . else (map(select(.type=="text")|.text)|join("\n")) end' $F

# 抽主编排的阶段汇报（最有信息量的一条线）
jq -r 'select(.type=="assistant") | .message.content
       | if type=="array" then (map(select(.type=="text")|.text)|join("\n")) else empty end' $F | tail -200

# 子 agent 的完整记录
ls ~/.claude/projects/-mnt-d-project-claude-code/073b77f0-*/subagents/
# workflow 脚本（可直接 resume）
ls ~/.claude/projects/-mnt-d-project-claude-code/073b77f0-*/workflows/scripts/
```

崩溃调查会话：`~/.claude/projects/-mnt-d-project-claude-code/8f261731-5c6c-4d9b-9317-8f9c45764f6a.jsonl`
