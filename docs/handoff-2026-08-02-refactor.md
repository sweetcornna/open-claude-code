# 交接文档 — open-claude-code 全仓库重构工程（第二棒）

> 交接时间：2026-08-02
> 上一棒：[`handoff-2026-08-01-refactor.md`](handoff-2026-08-01-refactor.md)（WSL 会话，S0–S5 完成，S6 进行中）
> 本棒环境：macOS（新机器，`bun` 1.3.13 按 `.tool-versions` 安装）
> 起点 `dd74d3bd` → 终点见 §1

---

## 0. 一页速览

| 项 | 值 |
|---|---|
| 本棒完成 | **S6 全部**、**S7 全部技术项**、**S8 大部** |
| 唯一未验收项 | **5.7 Windows 一小时浸泡验证** —— 本棒在 macOS 上，执行不了，见 §4 |
| 主线状态 | 已全部推送到 `origin/main`（= 上一棒说的 `occ` 远端），工作区干净 |
| 执行方式 | 14 条 lane，Opus 5 与 Codex `gpt-5.6-sol` 并行，每条独立 worktree；主编排只做规格/验收/合并/推送 |

**接手者第一件事**：读 §4「未完成事项」，那里是唯一还欠的验收和各 lane 记录不修的问题清单。

---

## 1. 本棒做完了什么

### S6 — tool-runtime 依赖反转（完成）

Wave C2 的三个 facade 加最后的 type 边燃尽：

| 项 | 结果 |
|---|---|
| analytics + featureGate facade | 46 条 import 翻转（含交接文档没算进去的 growthbook 17 处）、6 处测试 mock 目标、5 个影子 type-stub |
| MessageResponse facade | 27 处翻转。它传的是 React 组件而非函数集合，未注册时透传 children |
| bootstrap-state facade | 22 个符号、26 条静态 + 1 条动态 import、3 个影子 stub。**fallback 是 fail-fast 抛错**，因为状态存取器没有「原生等价物」，返回默认值会掩盖注册顺序 bug |
| 23 条 type 边燃尽 | `tool-runtime` 成为**真叶子**：包内零 `src/` 与 `builtin-tools` import（含 type-only） |

facade 的形状、注册触发点、各自不同的 fallback 语义已写进 `CLAUDE.md` 的「Host facade 模式」一节。

**一个踩过的坑记在这里**：给 `bootstrapState` 加 `src/tools.ts` 的 side-effect import 会让类型图环数从 2171 涨到 2409。原因不是新耦合 —— `tools.ts` 本来就有一条到 `bootstrap/state` 的 type-only 回边，多这一条 import 让 madge 的 DFS 把既有环族重新枚举了一遍。判断方法是**对比边集而不是看环数**（导出 madge 的 `obj()` 排序后 diff）：实测删掉 24 条真实反向边、新增的全是零出边的死胡同边，耦合严格下降。最终改为搭 session bootstrap 的顺风车触发注册。

### S7 — monolith 拆分 + 内存修复（技术项全部完成）

**六个 monolith**：

| 文件 | 拆前 | 拆后 |
|---|---|---|
| `src/main.tsx` | 5302 | **302**（+ `src/cli/program/` 25 模块） |
| `src/cli/print.ts` | 5603 | **24**（barrel，+ `src/cli/print/` 22 模块） |
| `src/utils/hooks.ts` | 5190 | **70** |
| `src/utils/sessionStorage.ts` | 5052 | **127** |
| `src/utils/attachments.ts` | ~4000 | **81** |
| `src/screens/REPL.tsx` | 6417 | 5440（**有意停手**，见下） |

`messages.ts` 是上一棒拆的（5931 → 147）。

**REPL 为什么停在 5440 行**：lane 用 tsc 探针实测了每个剩余 hook 簇的捕获面 —— 查询流水线 57 个、`onSubmit` 51 个、工具上下文 53 个。提取它们不产生更好的抽象，只是把同样的代码藏到 50+ 字段的接口后面；而这些字段里有多个共享结构类型（`() => void`、`MutableRefObject<number>`），**字段错配 tsc 抓不到**，REPL 又此前零运行时测试。lane 改为交付一份 hook 簇映射（写进代码注释）和一个经变异测试验证的 hook 顺序护网（253 次调用顺序快照）。这个判断我认可，别为了数字硬拆。

**阶段 5 内存修复**（每项都是取证先行 + 可复现 bench）：

| 项 | 效果 |
|---|---|
| 5.2 渲染 lookup | 800 轮会话重建 **1601 → 1** 次；顺带修掉一个滑动窗口导致的陈旧 lookup 潜伏 bug |
| 5.3 query 回路 | 2000 轮瞬时垃圾 **171.6 MB → 0.2 MB**；预测式 AutoCompact 此前压缩完**自己把结果丢了**，已修 |
| 5.4 sessionStorage | 三条路径峰值 RSS 共减约 **587 MB**（hydration −181.7、tombstone −193.9 即 235 倍、drain −211.1） |
| 5.5 fork 文件缓存 | 跨压缩留存 **4.90 MB → 0.02 MB** |
| 5.6 诊断槽 | **4.83 MB → 0**（该槽零生产读者，直接删而非截断） |

**三个被实测推翻的前提**（后来者别照文档的旧结论办事）：

1. **5.5 的「50N MB 全量克隆」不存在。** `cloneFileStateCache` 走 lru-cache 的 `dump()`/`load()`，父子共享 `FileState` 对象与内容字符串，实测每次克隆 23 KB，且 pin 住的内存对 fork 数是 **O(1)**。真正的 bug 在下面：fork 路径克隆了**两次**，teardown 只清第二次，第一次挂在仍存活的 generator 帧上永不释放。
2. **5.6 的槽早已被 ant-gated 且零读者。** 它声称的用途（`/share` 的 `serialized_conversation.json`）从未实现，`/share` 读的是磁盘转录。所以是删掉而非截断。
3. **5.3 的「7-8 次数组展开，120-320 MB」归因错了。** 那些数组装的是指针，4 份共存约 128 KB。真凶是 `toolUseResult` 剥离在**每次迭代**都重拷一遍所有载荷消息。
   `docs/memory-peak-analysis.md` 已按实测更正。

**测量工具本身的三个陷阱**（写进了 `docs/memory-peak-analysis.md`，踩过才知道）：

- `process.memoryUsage().heapUsed` 在 Bun 1.3.13 上是**冻结常量** —— 分配 20 万个对象前后返回同一个值。
- `bun:jsc` 的 `heapStats().heapSize` 只在**分配侧**可信，且对大字符串失明（8 MB 字符串拼接它纹丝不动，RSS 涨满）。测大字符串工作负载要用 RSS，且每个策略跑**独立进程**（Bun 不归还页，先跑的会把页送给后跑的，后者测出约 0）。
- 多字符 `unit.repeat(n)` 在 JSC 里构造的是 **rope**，从不分配实际载荷 —— 用它造测试数据会得到假数字。

### S8 — 收尾（大部完成）

| 项 | 结果 |
|---|---|
| ACP critical 合规项 | 5 个 critical **全部已不适用**：§2.1/§3.1/§3.3 被后续重构顺带修掉，§8 的 14 条随 `acp-link` 删除失效，§4.1 维持既定撤销。补了 2 条回归测试把 §2.1 钉死，审计文档追加复核状态 |
| keybindings 迁移 | 交接文档说的「做了一半」是误判 —— 实际 179 个 `useKeybinding` 调用点，已完成约 95%。核查中挖出**真实用户可见 bug**：`EffortPanel` 漏在 `VALID_CONTEXTS` 外，用户对那 10 个动作的任何重绑配置被**静默丢弃**。已修 + 加棘轮测试 |
| utils 领域分组 | move-with-shim + 延迟 codemod，见 §2 |
| 规范文档 | 新写 `CONTRIBUTING.md`（11 节）、`.github/pull_request_template.md`；**重写 `SECURITY.md`** —— 它此前是 GitHub 默认模板一字未改（版本表里 5.1.x/4.0.x 全是占位符，连指导语都还在） |
| CLAUDE.md 更新 | 补上完全没记载的 `packages/tool-runtime/` 与「Host facade 模式」一节；main.tsx/REPL/集成测试的陈旧描述已更正 |

### 量化总账

| 维度 | 起点 | 终点 |
|---|---|---|
| 循环依赖 runtime | 469 | **446** |
| 循环依赖 total | 2186 | 2150 |
| 测试 | 5814 通过 | **5945 通过 / 0 失败**（477 文件） |
| `src/utils/` 平铺文件 | 334 | **68** |
| 六个 monolith 合计 | 约 30 600 行 | 约 6 200 行（其中 5440 是有意保留的 REPL 本体） |
| `builtin-tools` 反向 import | 920 | 约 820（三个 facade 消掉约 100 条） |

环数每次升降都按棘轮协议处理，重基线的提交信息里写明了是表示性变化还是真实耦合变化。**total 的净变化（−36）远小于中途波动**：最低到过 1888，拆分带来的枚举膨胀每次都单独判定过。判断依据永远是边集 diff，不是环数本身。

---

## 2. utils 领域分组（已完成）

按上一棒定的打法：**move-with-shim + 延迟 codemod**，明确拒绝 big-bang 和 leave-and-barrel。每对提交 = 一次 `git mv` 到领域目录并在原路径留 re-export shim（importer 零改动）+ 其后的 codemod（改 import 路径）。13 对 + 4 个收尾提交，共 30 个。

| 数字 | 值 |
|---|---|
| 平铺文件 | **334 → 68** |
| 移动文件 | 329 |
| 新建领域目录 | 13（collection、text、filesystem、process/shell、terminal、network、update、configuration、session、agent/task、runtime、tools、telemetry 等） |
| knip 清掉的孤儿 shim | 266 |
| 有意保留的 shim | 63 |

**剩下的 68 个平铺文件是什么**：5 个是当时其他 lane 正在动的避让文件，63 个是给 `attachments/`、`messages/`、`hooks/`、`sessionStorage/` 四个目录用的兼容 shim（它们有 206 条入边）。那四个目录当时被其他 lane 占用，所以只移不改。**后续可以把这 206 条 import 路径 codemod 到新目录，然后删掉这 63 个 shim** —— 这是本项唯一的尾巴。

> **✅ 尾巴已于 2026-08-02 收掉**（`9e970d49` codemod / `6d2f671f` 删 shim / `e28fdfe6` 重基线）。实测入边 208 条（比上面的 206 多出的是 `agent.test.ts` 里两处 `mockModulePreservingExports` 说明符，常规 import 前缀正则抓不到，靠逐字面量兜底扫描补上 —— 后续做同类 codemod 时记得把自定义 mock 包装函数算进说明符来源）。平铺层现余 5 个真实文件；total 环数 2150 → 2038，纯表示性下降。指向平铺路径的文本引用（CLAUDE.md mock 示例、`tests/mocks/` 头注释、若干活代码注释）已一并修正。

---

## 3. 执行模型（建议延续）

| 角色 | 模型 | 职责 |
|---|---|---|
| 主编排 | Fable 5 | 规格、验收、合并、推送。**不亲自 fan out 同模型** |
| 判断密集 lane | Opus 5（Agent tool，显式 `model: 'opus'`） | 接口提取、monolith 拆分、内存取证 |
| 机械密集 lane | Codex `gpt-5.6-sol`（`codex exec` 直连） | 规格明确的搬迁、codemod、批量翻转 |

**本棒验证有效的几条做法**：

- **每条 lane 一个 worktree**，spec 里写明「不碰哪些路径」（其他 lane 正在动的）。14 条 lane 只出现过一次真冲突（三条 facade lane 都要往 `src/tools.ts` 同一位置加行），且是预料到的，主编排手解。
- **lane 只跑 typecheck + 自己那摊测试**，全量 `precheck` 由主编排在合并时统一跑一次。并发跑 precheck 会互相拖垮。
- **spec 里要求「取证先行」和「记录不修」**。本棒三个被推翻的前提（§1）全部来自这条 —— 如果 spec 只说「修这个内存问题」，lane 会照着错误前提改出无意义的代码。
- **验收时核对范围而不只看报告**：`git diff main --stat` + 检查是否碰了禁区。
- codex 直连模式（`codex exec`，继承 config 的完全访问）比 companion 模式效率高得多。

---

## 4. 未完成事项

### 4.1 唯一欠的验收：5.7 Windows 浸泡验证

阶段 5 的五项内存修复都有 bench 数字，但**都是合成负载的进程内测量，不是真实 RSS 曲线**。计划里的验收门是：

> 按 `docs/agent/sur-loop-scheduled-oom.md` 的复现形状（2 HEARTBEAT + 3 cron）跑一小时，验收标准 = RSS 曲线 warmup 后平坡。

本棒在 macOS 上，做不了。**预期管理**（上一棒定的，仍然适用）：Bun 用 mimalloc，不还页，常驻地板约 150–250 MB；目标是**削峰不是降基线**。

### 4.2 各 lane 记录不修的问题

这些都是 lane 在自己范围内发现、按「记录不修」纪律留下的，按值得处理的程度排：

**有用户可见影响**
- ~~`headlessControlRequests.ts:199` 的 `initialize` 处理器报的是 `state.initialCommands`/`initialAgents` 而非 `currentCommands`/`currentAgents`。若插件在 `initialize` 到达前完成安装，SDK 消费方拿到的是装插件前的命令集。~~ **已修**（`41fadb7e`，2026-08-02）：统一读写 `current*`，`initial*` 字段删除；取证时发现问题比记录的更重 —— 该顺序下 stdin 提供的 agent 也会被 push 进死数组而丢失。回归测试 `headlessControlRequests.initialize.test.ts`。
- ~~`/compact` 不清 `lastAPIRequest`（完整 system prompt + 全部 tool schema，**对所有用户**留存，且它有真实读者，不像 5.6 删掉的那个）。~~ **已修**（`ce9207a3`，2026-08-02）：集中清在 `runPostCompactCleanup` 主线程分支（四条 compact 路径都汇到这里），subagent compact 不清主线程快照。伴随 total 环数预算 2038 → 2039（runtime 不变，边集判定为表示性 +1，理由见提交信息）。
- `Config.tsx:1547` 与 `PermissionRuleList.tsx:385` 硬编码了按键排除清单，与绑定表重复，用户重绑后会失效。**不能简单地从 resolver 推导** —— `r` 绑给了 `settings:retry` 却不在排除清单里，推导版会让 `r` 无法进入搜索框，那是行为改动。

**架构层面**
- `packages/tool-runtime/src/Tool.ts` 的 `ToolUseContext` 仍然承载 host 的 `AppState`。import 边没了（走 host 绑定），但概念耦合还在。真正的解法是共享类型包。
- keybinding 系统有三个缺口：`App.tsx:618` 的**双分发未门控**（`InputEvent` 与 `KeyboardEvent` 都发，`stopImmediatePropagation` 挡不住另一条），这是迁移停滞的根因；没有 focus-aware 的 `useKeybinding` 变体（挡住剩余约 15 个 focus-scoped 处理器）；`resolver.ts:42` 是**按绑定数组顺序 last-match-wins 而非上下文优先级**。
- `src/screens/repl/rootAction.tsx` 3340 行、`headlessControlRequests.ts` 664 行仍超尺寸目标，是 verbatim 搬迁的产物，拆它们需要真重构。
- `messages/attachmentNormalize.ts` 971 行（上一棒记的，仍成立）：`normalizeAttachmentForAPI` 是 869 行的 verbatim `switch`。

**代码卫生**
- `main.tsx` 头部注释关于 ESM 的说法是错的：它声称三个启动调用「先于所有 import 运行」并与 ~135 ms 的 import 重叠，但 ESM 会 hoist 所有 import 并在任何模块体语句之前求值整张图 —— 那个并行从未发生。修它会改变启动行为，超出拆分范围。
- `_isBeingDebugged()`、`isForkBoilerplateMessage` 是死代码（`noUnusedLocals` 关着，tsc 不报）。
- `resume` 的依赖数组是 `[resetLoadingState, setAppState]` 但函数体读了约 15 个其他局部变量 —— **陈旧闭包**，先于本轮存在，拆分时逐字保留了。
- `lastClassifierRequests` 有写无读；`STATE.invokedSkills` 无上限地留存 skill 文件全文。

### 4.3 上一棒遗留的独立议题

WSL 里 Claude Code 频繁崩溃（OOM）—— 上一棒 §6 记的调查。本棒换到 macOS，没有复现环境，未推进。那份分析里的关键事实仍有效：内核日志确证是 `global_oom`（整个 WSL VM 内存耗尽，不是 cgroup 限额），且上次被杀的是一个无关的 13 GB python 进程，所以「Claude Code 自身泄漏」这个假设**尚未被证实**。

---

## 5. 各 Stage 的完成门槛（沿用）

`bun run precheck` 零错误 + `bun run check:cycles` 通过（升降都按协议处理）+ 相关 characterization 测试绿 + Conventional Commits 推 `origin/main`。

本棒额外验证过的门：`bun run build:vite` 通过（556 chunks），构建产物用 `node dist/cli.js` 实测 `--version`、`--help`、`mcp --help`、print 模式参数校验全部正常 —— 这是对入口拆分的端到端确认，precheck 覆盖不到。
