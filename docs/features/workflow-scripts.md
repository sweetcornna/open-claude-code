# WORKFLOW_SCRIPTS — 确定性多 agent 工作流编排

> Feature Flag：`FEATURE_WORKFLOW_SCRIPTS=1`
> 引擎包：`@open-claude-code/workflow-engine`（`packages/workflow-engine/`，确定性 JS 脚本编排，零核心层运行时依赖）
> 集成层：`src/workflow/`

## 一、功能概述

WORKFLOW_SCRIPTS 让 Claude Code 用**确定性 JavaScript 脚本**编排多个子 agent：可分解/并行、多视角置信、规模超单上下文、可 resume/可审计。

- **编排原语**：`agent` / `parallel` / `pipeline` / `phase` / `log` / `workflow`（见引擎包）。
- **确定性**：脚本在受限沙箱内执行，禁用 `Date.now()` / `Math.random()` / 无参 `new Date()`，保证 journal 可重放。
- **深度后端**：单一 `claude-code` AgentAdapter 接入当前会话体系（provider / model / agentType / 工具），workflow 内的 `agent()` 调用真实子 agent。
- **监控面板**：`/workflows` 双栏实时面板（见 §六）。
- **编排手册**：`/ultracode` 注入编排工作法（见 §七）。

> 历史说明：早期版本为 YAML/JSON DSL + 全 Stub 实现（`WorkflowDetailDialog` 等），已全量重写为引擎驱动的 JS 方案。

## 二、实现架构

```
   .occ/workflows/<name>.ts           Workflow 工具（name/script/scriptPath/args/resumeFromRunId）
            │                                       │
            ▼                                       ▼
   namedWorkflowCommands.ts              src/workflow/wiring.ts (createWorkflowToolCore)
   （/<name> 命令发现）                              │
                                                   ▼
                                      WorkflowService（门面：launch/kill/subscribe/listRuns/listNamed）
                                                   │
                                  ┌────────────────┼─────────────────┐
                                  ▼                ▼                 ▼
                          ports.ts            registry.ts        progress/
                       （端口聚合）      （AgentAdapterRegistry）  bus + store
                                  │                │
                                  ▼                ▼
                      hostHandle.ts        backends/claudeCodeBackend.ts
                     （不透明 host）       （深度读会话体系，跑真实 agent）
                                  │
                                  ▼
                  @open-claude-code/workflow-engine
                  （runWorkflow / hooks / journal / budget / 并发信号量）
```

### 2.1 模块清单

| 层 | 文件 | 职责 |
|----|------|------|
| 引擎 | `packages/workflow-engine/src/` | 确定性脚本沙箱 + hooks + journal + budget + 信号量；导出 `createWorkflowTool` |
| 工具装配 | `src/workflow/wiring.ts` | `createWorkflowToolCore()` —— 用 `WorkflowService.ports` 组装 `Workflow` 工具 |
| 服务门面 | `src/workflow/service.ts` | `WorkflowService` 单例：`launch` / `kill` / `subscribe` / `listRuns` / `listNamed` / `getWorkflowService()` |
| 端口 | `src/workflow/ports.ts` | `createWorkflowPorts()` 聚合所有端口（agentRunner/registry/progress/task/journal/permission/logger/hostFactory） |
| 后端注册 | `src/workflow/registry.ts` | `buildRegistry()` 注册 `claude-code` 后端并设为默认 |
| 深度后端 | `src/workflow/backends/claudeCodeBackend.ts` | AgentAdapter：按 `agentType`/`model` 解析会话体系，跑真实子 agent，结构化输出 |
| Host 句柄 | `src/workflow/hostHandle.ts` | `buildHostBundle()` 不透明包装 `toolUseContext`/`canUseTool`/`parentMessage` |
| 进度总线 | `src/workflow/progress/bus.ts` | 基于 Set 的进度事件发射 |
| 进度状态 | `src/workflow/progress/store.ts` | reducer：按 `agentId` 精确关联 `agent_done`（修并发竞态） |
| 监控面板 | `src/workflow/panel/*.tsx` | `/workflows` 双栏 UI（见 §六） |
| 命名命令 | `src/workflow/namedWorkflowCommands.ts` | 扫描 `.occ/workflows/` 生成 `/<name>` 命令 |
| 权限请求 | `src/workflow/WorkflowPermissionRequest.tsx` | workflow 启动权限 UI |

### 2.2 注册点

| 位置 | 内容 |
|------|------|
| `packages/builtin-tools/src/registry.ts` | `feature('WORKFLOW_SCRIPTS')` 下 require `src/workflow/wiring.js` 并注册 `Workflow` 工具 |
| `src/commands.ts`（`workflowsCmd`） | `/workflows` 命令（local-jsx，加载 `panelCall.js`） |
| `src/skills/bundled/ultracode.ts` + `index.ts` | `/ultracode` 知识 skill（`registerBundledSkill`） |

## 三、编排原语

workflow 脚本内可用的钩子（语义详见引擎包 `engine/hooks.ts`）：

| 原语 | 语义 |
|------|------|
| `agent(prompt, opts?)` | 派发一个子 agent；返回最终文本，或（带 `opts.schema`）结构化对象。opts：`model` / `agentType` / `label` / `phase` / `schema` |
| `parallel([() => …])` | 并发跑 thunk 数组，**barrier**（等全部完成）；单项抛错 → 该项 `null`，其余保留 |
| `pipeline(items, s1, s2, …)` | 每个 item 链式过各 stage；**item 间无 barrier**，stage 内顺序；单 item 某 stage 抛错 → 该 item `null` |
| `phase(title)` | 标记阶段（面板按此分组展示） |
| `log(msg)` | 进度日志（面板展示，无状态变更） |
| `workflow(name \| { scriptPath }, args?)` | 嵌套一层子 workflow（仅允许一层） |

**硬限**：单次 `parallel`/`pipeline` ≤ `MAX_ITEMS_PER_CALL`（4096）；单 workflow 总 agent ≤ `MAX_TOTAL_AGENTS`（1000）；并发 cap 默认 = `DEFAULT_MAX_CONCURRENCY`（3），可经 Workflow 工具的 `maxConcurrency` 入参覆盖，绝对上限 `MAX_CONCURRENCY_CAP`（16）。

## 四、编写 workflow

脚本置于 `.occ/workflows/<name>.js|.mjs`（也接受 `.ts`，但**引擎不转译 TS**，含类型注解会报语法错——推荐 `.js`/`.mjs`），自动成为 `/<name>` 命令。

```js
// .occ/workflows/review-changes.js
export const meta = {
  name: 'review-changes',
  description: '按维度审查改动并对抗式验证',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: '找正确性 bug' },
  { key: 'perf', prompt: '找性能问题' },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review' }),
  review => parallel(
    (review.findings || []).map(f => () =>
      agent(`对抗式验证：${f.title}`, { phase: 'Verify' })
    )
  )
)
return results.flat().filter(Boolean)
```

**脚本执行约束**（引擎执行模型，违反直接报错）：

脚本是 `new AsyncFunction` 的**函数体**，不是 ESM 模块：

- **禁 `import`**：`agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow` 与 `args`/`budget` 是注入的形参，直接用。
- **禁 TS 语法**：不要类型注解（`x: number`）、`interface`、`enum`、`as`、泛型。引擎不转译，即便文件是 `.ts` 也会原样报语法错。
- **只允许一处 `export const meta = {...}`**（引擎正则提取剥离）；不要 `export` 其他、不要 `export default`。
- **顶层 `return` 返回结果**。

**确定性约束**（违反则 resume 失效）：
- 禁 `Date.now()` / `Math.random()` / 无参 `new Date()`（沙箱强制抛错）。需时间戳/随机种子经 `args` 传入。
- `export const meta = { ... }` 必须是**纯字面量**（无变量、函数调用、模板插值）——加载期求值，否则抛 `ScriptError`。

## 五、Workflow 工具

模型通过 `Workflow` 工具启动 workflow（input schema 见引擎包 `tool/schema.ts`）：

| 字段 | 说明 |
|------|------|
| `script` | 内联脚本字符串 |
| `name` | 命名 workflow 名（对应 `.occ/workflows/<name>`） |
| `scriptPath` | 脚本文件路径 |
| `args` | 透传给脚本的 `args`（任意 JSON 值） |
| `resumeFromRunId` | 从既有 runId 重放（成功的 `agent()` 秒回缓存；**失败（dead）条目重跑**；发散点后现场重跑） |
| `maxConcurrency` | per-run 并发覆盖（钳到 `[1, 16]`） |

## 六、监控面板：`/workflows`

`/workflows` 打开三区焦点面板（local-jsx，全屏）：

- **顶部 tabs**：每个 run 一个 tab（状态圆点 + workflow 名 + `#runId短码`）；同名脚本多次跑会多个 tab。
- **左 phase 侧栏**：`All` + 合并 meta 声明的 phase（未启动 `○` pending 灰）与实际 phase（`●` running / `✓` done）；选中即决定右栏筛选。
- **右 agent 列表**：按选中 phase 过滤，再按状态筛选（`f` 循环 all → running → done → failed，非 all 时标题追加 `· <filter> only`）；每行 = 状态色标记 + label（28 字宽，`#N` 后缀保留）+ `model · Nk tok` + 右对齐时长列。模型名已短化（`us.anthropic.claude-sonnet-5-20260101` → `sonnet-5`），**逐行工具调用数已移入 agent 详情**——列宽留给 label 更有用。
- **右 agent 详情**：在 agent 列表上按 `↵` 或 `→` 进入，右栏整块替换为选中 agent 的状态视图：status / phase / model / elapsed / context tok / output tok / tool calls，失败时额外给出**失败原因**（引擎的 `no-structured-output`、`prompt-too-long`、`api-error` … 译成人话）、`retryable:false` 的「确定性失败，重跑同样的调用不会成功」提示与引擎 detail，成功时给出返回值预览（对象/文本，store 侧截断至 400 字符）。详情里 `↑`/`↓` 直接换到上/下一个 agent，无需退回列表。

**键位**：`Tab`/`Shift+Tab` 切 run · `←`/`→` 在 phases → agents → agent 详情之间进出 · `↵` 打开选中 agent 的详情 · `↑`/`↓` 区域内移动 · `f` 切状态筛选 · `r` resume · `x` kill 选中 agent · `K` kill 整个 workflow · `n` 新建提示 · `q`/`Esc` 退出。

> `←` **只退一级**（详情 → 列表 → phase 侧栏）并停在 phase 侧栏，永远不关面板；关面板是 `Esc`/`q` 的职责。`f` 切筛选会把选中项重置到第 0 行——存活的行是另一批，沿用旧下标等于把 `x` 悄悄对准了别的 agent。

**视觉**：无内框，左右一条竖线分隔；聚焦列标题橙粗；选中/光标行铺橙底（`backgroundColor`），文字色不变。

进度按引擎 `agentId` 精确关联 `agent_done`（解决并发 LIFO 竞态）。pending phase 来自 `run_started` 事件携带的 `meta.phases`，store 落地 `declaredPhases`，面板 `mergePhases` 合并。`useSyncExternalStore` 订阅 `WorkflowService`，稳定快照，无变更不重渲染。

### 后台任务界面里的 workflow 详情

`/tasks`（Shift+↓）后台任务列表中选中 workflow 条目进入 `WorkflowDetailDialog`（`src/components/tasks/WorkflowDetailDialog.tsx`）：与面板同源（同一 `ProgressStore`）的实时视图，单列布局 —— 状态头 + phase 行（`○/●/✓` + done/total）+ 逐 agent 行（spinner/`✓`/`✗`/`⊘` + label + `model · tok · tool`，复用面板 `AgentList`）。agent 列表按选中项开滑动窗口（`MAX_VISIBLE_AGENTS=10`，折叠行显示 `… N earlier/more`）。

按 `↵`/`→` 同样可以钻进选中 agent 的详情（复用 `/workflows` 面板的 `AgentDetail`）——两个界面渲染的是同一个 run，导航手势不能互相打架。

**键位**：`↑`/`↓` 选 agent · `↵`/`→` 进 agent 详情 · `x` kill 选中 agent（走可配置的 `taskDetail:kill`）· `K` kill 整个 workflow · 两者均有 `y`/`n` 二次确认 · `←` 退一级（详情 → 列表 → 关对话框）· `Esc` 直接关闭。数据/按键投影层在 `workflowDetailData.ts`（React-free，可单测）。

## 七、`/ultracode` skill

`/ultracode`（`src/skills/bundled/ultracode.ts`）注入多 agent workflow 编排工作法：何时用 / 何时不用、编排原语速查、质量模式库（adversarial-verify / judge-panel / loop-until-dry / multi-modal-sweep / completeness-critic）、确定性约束、后端路由、resume/budget、文件与命令。

**纯知识 prompt skill**：零运行时副作用，不改主循环、不切换行为开关。调用即把手册注入上下文。

## 八、resume / journal / budget / 错误恢复

- **journal**：每次 run 记录到 `.occ/workflow-runs/<runId>/journal.jsonl`。`resumeFromRunId` 重放 journal：成功结果秒回缓存；**dead 条目视为「记录的失败」，重放时现场重跑**（断点续传的意义就是重试失败，不是复读失败）。重跑结果以同 `seq` 追加，`read()` 按 seq 去重**保留最后一条**，新结果覆盖旧失败。
- **journal 损坏处理**：逐行解析并保留已验证的有效前缀。只有位于**文件末尾、无结尾换行**的半行（进程被杀留下的）会被忽略并告警；中间行损坏或结构不符抛 `JournalCorruptionError`，不再静默当成"没有历史"——那等于把所有 checkpoint 丢掉重跑一遍，重复计费且重复外部副作用。`ENOENT` 之外的 I/O 错误照常抛出。
- **journal 分歧与 `script.js`**：agent key 发散时先把有效前缀原子重写回盘再追加新记录，`truncate()` **只清 `journal.jsonl`**，同目录的 inline `script.js` 保留（inline → 编辑 → `scriptPath` resume 这条路才走得通）。整目录清理是独立的 `deleteRun()`。
- **`resumeFromRunId` 格式约束**：只接受 `^[A-Za-z0-9_-]{1,128}$`，schema 与存储层双重校验。它是拼进 runs 目录的路径片段，而 `deleteRun()` 会递归删除该目录——不校验就等于把"恢复工作流"变成任意目录删除。
- **agent 原地重试**：dead / 非 abort 抛错重试一次，重试前等 `AGENT_RETRY_BACKOFF_MS`（2s，abort 可打断）；**`retryable:false` 的确定性失败（如 `prompt-too-long`）不重试**——同样的调用重发必然再失败。
- **run 级自动断点续传**：脚本执行失败（常见于 dead agent 的 `null` 在脚本里炸出 TypeError）时**自动用 journal resume 重试一次**：成功的 agent 全部秒回，只重跑失败的。`WorkflowError`（配置/上限类，确定性）与 `BudgetExhaustedError`（新 context 会重置 spent 导致超支）不触发；`autoRetryOnFailure:false` 可关。
- **API 错误分类**（`claudeCodeBackend`）：query 层把终局 API 错误包装成 `isApiErrorMessage` 的 assistant 消息（不抛错），backend 显式识别 → `dead`，`reason: 'prompt-too-long'`（`retryable:false`）或 `'api-error'`（瞬态，可重试）。修复前该错误文本会在非 schema 模式被伪装成 agent 的正常输出。529 过载则由 API 层带指数退避重试（`'workflow'` 已加入 `FOREGROUND_529_RETRY_SOURCES`）。
- **budget**：`budget.total` 为 token 硬顶（默认 `null` = 无限）；`budget.spent()` / `budget.remaining()` 读实时消耗；耗尽后再发 `agent()` 抛错。
- **并发**：引擎 `Semaphore` 默认许可 3（`DEFAULT_MAX_CONCURRENCY`），可经 Workflow 工具的 `maxConcurrency` 入参 per-run 覆盖（钳到 `[1, MAX_CONCURRENCY_CAP=16]`）。
- **错误**：脚本语法/meta 错 → `parseScript` 即时返错（不进后台）；agent 抛错 → `kind:'dead'` → `null`，workflow 继续（`parallel`/`pipeline` 容错，但 **`WorkflowAbortedError` 会穿透**——kill 必须终止 run）；`WorkflowAbortedError` → `killed`。

## 九、文件索引

| 文件 | 职责 |
|------|------|
| `src/workflow/wiring.ts` | `Workflow` 工具装配（`createWorkflowToolCore`） |
| `src/workflow/service.ts` | `WorkflowService` 门面 |
| `src/workflow/ports.ts` | 端口聚合（`createWorkflowPorts`） |
| `src/workflow/registry.ts` | `AgentAdapterRegistry` + 默认后端 |
| `src/workflow/backends/claudeCodeBackend.ts` | 深度后端 AgentAdapter |
| `src/workflow/hostHandle.ts` | 不透明 host 句柄（`buildHostBundle`） |
| `src/workflow/progress/bus.ts` | 进度事件总线 |
| `src/workflow/progress/store.ts` | 进度 reducer（`agentId` 关联） |
| `src/workflow/panel/*.tsx` | `/workflows` 双栏面板 |
| `src/workflow/namedWorkflowCommands.ts` | `/<name>` 命令发现 |
| `src/workflow/WorkflowPermissionRequest.tsx` | 启动权限 UI |
| `src/components/tasks/WorkflowDetailDialog.tsx` | 后台任务界面的 workflow 详情（逐 agent 实时状态 + kill 交互） |
| `src/components/tasks/workflowDetailData.ts` | 详情对话框的窗口/按键投影层（React-free） |
| `src/skills/bundled/ultracode.ts` | `/ultracode` 知识 skill |
| `packages/builtin-tools/src/registry.ts` | 工具注册（feature-gated require） |
| `src/commands.ts` | `/workflows` 命令注册 |
| `packages/workflow-engine/` | 引擎包（hooks / journal / budget / 并发） |
