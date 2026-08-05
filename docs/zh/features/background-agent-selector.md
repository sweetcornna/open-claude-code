# Background Agent Selector — 底部统一后台 Agent 切换器

> Feature Flag: 无（直接启用）
> 实现状态：完整可用
> 依赖：`viewingAgentTaskId` / `enterTeammateView` / `exitTeammateView` 已有机制

## 一、功能概述

Background Agent Selector 是渲染在 PromptInput 下方的常驻状态条，列出当前所有 **backgrounded 的 local_agent 任务**（包括 AgentTool fork 路径 —— 调用时不指定 `subagent_type` —— 派生的 fork agent，和 Task/AgentTool 调用 `run_in_background: true` 派生的子 agent）。用户可以用 ↑/↓ 方向键在 `main` 和各 agent 之间切换焦点，按 Enter 把 REPL 主视图替换为所选 agent 的实时 transcript，再按 Enter 选中 `main` 即可回到主对话。

整个机制完全复用官方已有的 teammate transcript 查看基础设施，不引入新的视图层 / 数据流，仅新增一条 footer pill 类型。

### 核心特性

- **统一入口**：AgentTool fork 路径（不指定 `subagent_type`）、Task 派生的 subagent、所有 `run_in_background: true` 的 agent 都在同一栏显示
- **就地切换**：prompt 为空时按 ↓ 溢出进入底部 selector，↑↓ 选中某行，Enter 即切主视图
- **实时状态**：每行显示 agent 类型 + 当前动作（recap，见 §七）+ 运行时长 + 已消耗 token；圆点颜色编码**状态**（运行中灰、完成绿、失败红、被停止黄）
- **Keep-alive 视图**：agent 完成后在 `evictAfter` grace 窗口内保留一段时间，用户可回看
- **零界面侵入**：tasks 数为 0 时 selector 完全不渲染，不占屏幕高度
- **与旧 Dialog 共存**：Shift+↓ 打开的 `BackgroundTasksDialog` 原有行为保留，selector 只作为展示 + 快捷切换

## 二、用户交互

### 触发方式

有任何 background agent 时，selector 自动出现在 `bypass permissions on` 行下方：

```
  claude-code | Opus 4.7 (1M context) | ctx:4%
  ▶▶ bypass permissions on (shift+tab to cycle)

    ● main                                  ↑/↓ to select · Enter to view
  ❯ ● Explore  Verifying runtime sampler     23s · ↓ 10.9k tokens
    ● Explore  Reading src/components        22s · ↓  9.5k tokens
    ● Explore  Research src/utils            21s · ↓ 13.6k tokens
```

选中行由 `❯` 指针 + 加粗表示；圆点一律实心，**只用颜色表达状态**。描述列显示的是 agent 当前在做什么（recap / 工具活动），不是派生时写死的任务描述 —— 见 §七。

### 键盘路由

| 位置 / 状态 | 按键 | 行为 |
|---|---|---|
| PromptInput 非空 | ↑↓ | 光标移动 / 翻历史（不变） |
| PromptInput 空 + 历史底部 | ↓ | 焦点下放到 selector，高亮到 `● main` |
| Selector 聚焦（`footerSelection === 'bg_agent'`） | ↓ | 高亮下移，-1 → 0 → ... → N-1 |
| Selector 聚焦 | ↑ | 高亮上移；在 `main` 再 ↑ → 焦点回 PromptInput |
| Selector 聚焦 | Enter | `-1` → `exitTeammateView`；`>=0` → `enterTeammateView(agentId)`。焦点保留在 pill |
| Selector 聚焦 | Esc | `footer:clearSelection`，焦点回 PromptInput |

### 视觉规则

- **选中态**：`❯ ` 指针前缀 + 该行加粗。指向当前被**查看**（`viewingAgentTaskId`）或被**光标聚焦**（pill focused 时以光标为准）的一行
- **圆点**：一律实心 `●`，颜色**只编码任务状态**，与选中与否无关（`getAgentStatusDotColor`）：

  | 状态 | 颜色 token | 观感 |
  |---|---|---|
  | running / pending | `inactive` | 灰 |
  | completed | `success` | 绿 |
  | failed | `error` | 红 |
  | killed | `warning` | 黄 |

  这里刻意**不复用** `getTaskStatusColor`：那个函数把 running 映射到 `background` token，而该 token 在所有内置主题里都是青色，读起来像强调色而不是中性色。
- `main` 行保持中性色 —— 它没有 agent 状态可报告
- 右上角 hint 随状态变化：
  - pill 聚焦：`↑/↓ to select · Enter to view`
  - 已选中 running agent：`shift+↓ to manage · x to stop`
  - 已选中 terminal agent：`shift+↓ to manage · x to clear`
  - 未选中任何 agent：`shift+↓ to manage background agents`

## 三、实现架构

### 3.1 数据层：`useBackgroundAgentTasks`

文件：`src/hooks/useBackgroundAgentTasks.ts`

封装对 `useAppState(s => s.tasks)` 的过滤：

```ts
export function useBackgroundAgentTasks(): LocalAgentTaskState[] {
  const tasks = useAppState(s => s.tasks)
  return useMemo(() => {
    const now = Date.now()
    return Object.values(tasks)
      .filter(isLocalAgentTask)
      .filter(t => t.agentType !== 'main-session')
      .filter(t => t.isBackgrounded !== false)
      .filter(t => t.evictAfter === undefined || t.evictAfter > now)
      .sort((a, b) => a.startTime - b.startTime)
  }, [tasks])
}
```

AgentTool 的 fork 路径（不指定 `subagent_type`）和 `AgentTool` 的 `run_in_background: true` 底层都走 `registerAsyncAgent → runAsyncAgentLifecycle`，最终写入同一个 `appState.tasks` Map；此 hook 是唯一数据源，Selector 和 PromptInput 的 `bgAgentList` 都消费它。

### 3.2 状态层：新增两个字段

文件：`src/state/AppStateStore.ts`

```ts
export type FooterItem =
  | 'tasks' | 'tmux' | 'bagel' | 'teams' | 'bridge' | 'companion'
  | 'bg_agent'   // ← 新增

export type AppState = DeepImmutable<{
  // ...
  selectedBgAgentIndex: number  // -1 = main, 0..N-1 = 选中的 agent
}>
```

- `'bg_agent'` 作为 `FooterItem` 加入 footer pill 体系，享受既有的 `footer:up` / `footer:down` / `footer:openSelected` keybinding 路由
- `selectedBgAgentIndex` 记录 selector 的光标位置，与 `viewingAgentTaskId`（"正在看什么"）独立；它不可从 `viewingAgentTaskId` 派生——Enter 后光标留在 pill 继续导航，查看目标才变

### 3.3 键盘路由：PromptInput footer pill 分支

文件：`src/components/PromptInput/PromptInput.tsx`

1. **`bg_agent` 进入 footerItems[0]**：保证 prompt ↓ 溢出时（`handleHistoryDown` → `selectFooterItem(footerItems[0])`）直接进入 selector，而不是 `tasks` 等其他 pill
2. **`footer:up` 分支**：`bgAgentSelected` 时 `selectedBgAgentIndex > -1` 则递减；在 -1 → `selectFooterItem(null)` 退出 pill
3. **`footer:down` 分支**：`selectedBgAgentIndex < bgAgentList.length - 1` 则递增，到底 clamp
4. **`footer:openSelected` 分支**：index === -1 → `exitTeammateView`；否则 `enterTeammateView(bgAgentList[i].agentId)`。**不清理 pill 焦点**，光标留在 selector 上继续导航
5. **`selectFooterItem('bg_agent')`**：入 pill 时重置 `selectedBgAgentIndex = -1`（光标落到 `main`）

### 3.4 渲染层：`BackgroundAgentSelector`

文件：`src/components/tasks/BackgroundAgentSelector.tsx`

纯展示组件，不订阅键盘：

```tsx
const tasks = useBackgroundAgentTasks()
const viewingId = useAppState(s => s.viewingAgentTaskId)
const footerSelection = useAppState(s => s.footerSelection)
const selectedBgIndex = useAppState(s => s.selectedBgAgentIndex)

if (tasks.length === 0) return null

const pillFocused = footerSelection === 'bg_agent'
const highlightedId = pillFocused
  ? (selectedBgIndex === -1 ? null : tasks[selectedBgIndex]?.agentId ?? null)
  : (viewingId ?? null)
```

**高亮派生规则**：pill 聚焦 → 跟 `selectedBgAgentIndex`；未聚焦 → 镜像 `viewingAgentTaskId`。这样当用户通过 Shift+↓ Dialog 或 `enterTeammateView` 其它途径切换视图时，selector 也会正确反映。

### 3.5 主视图切换：复用 `viewingAgentTaskId`

REPL.tsx 主体仍复用原有查看逻辑：

```ts
const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
const viewedAgentTask = ... (isLocalAgentTask(viewedTask) ? viewedTask : undefined)
const displayedMessages = viewedAgentTask ? displayedAgentMessages : messages
```

当 `enterTeammateView(agentId)` 把 `viewingAgentTaskId` 设成某个 local_agent 的 id：

- `viewedAgentTask` 解析成该 agent
- `displayedMessages` 切换到 agent 的 messages
- 消息列表、spinner、unseen divider 等一整套组件自动用 agent transcript 重渲染
- 主对话流被"暂停"（并非销毁，回到 `main` 时仍在原处）

`enterTeammateView` 同步负责：设 `retain: true` 阻止 eviction、清 `evictAfter`、触发 disk bootstrap 从 `agent-<id>.jsonl` 加载完整 transcript 到 `task.messages`。

#### Fork agent prompt 归一化

AgentTool fork 路径（不指定 `subagent_type`）派生的 agent，其 transcript 和普通 subagent 不同：它继承 main agent 的上下文，真实初始消息形态是：

```text
...parent messages
assistant([...tool_use])
user([tool_result..., text("<fork-boilerplate>...Your directive: <prompt>")])
...fork live messages
```

这里的 prompt 文本混在 `[tool_result..., text]` 多 block user message 里。消息渲染管线会优先把这条 user message 当作 tool-result plumbing 来处理，导致 `<fork-boilerplate>` 里的用户 prompt 不稳定可见。为保证切换到 fork agent 时总能看到用户发起的 fork prompt，REPL.tsx 对 fork 视图做一次展示层归一化：

1. 仅当 `viewedAgentTask.agentType === 'fork'` 时启用，不影响普通 Explore / Task subagent。
2. 从原始 messages 中识别包含 `<fork-boilerplate>` 的 carrier message。
3. 剥离 carrier message 里的 boilerplate text block，但保留 `tool_result` blocks，避免破坏父 assistant `tool_use` 的承接关系。
4. 强制插入一条独立 `createUserMessage({ content: viewedAgentTask.prompt })` 作为可见用户 prompt。
5. 插入位置优先为 boilerplate carrier 后；如果 sidechain bootstrap 还没读到 carrier，则插到最后一条 inherited `assistant tool_use` 后面，确保 prompt 接在 main 上下文之后，而不是跑到视图顶部。

这个归一化只影响 UI 展示用的 `displayedAgentMessages`，不回写 `task.messages`，也不改变发送给模型的 fork transcript。

### 3.6 生命周期

完全复用官方既有机制：

- **运行中**：`isBackgroundTask()` 谓词为真，selector 列出
- **完成 / 失败 / 中止**：`completeAgentTask` / `failAgentTask` / `killAsyncAgent` 设 `status` 为 terminal
- **回访后退出**：`exitTeammateView` 调 `release(task)`——清 `retain`、清 `messages`、terminal 状态下设 `evictAfter = now + PANEL_GRACE_MS (30s)`
- **evictAfter 过期**：`useBackgroundAgentTasks` 过滤时自然剔除，selector 行消失
- **手动清除**：`stopOrDismissAgent(taskId)` 设 `evictAfter = 0`，立即消失

## 四、设计决策

1. **数据源单一**：`useBackgroundAgentTasks` 是唯一过滤点，PromptInput 也复用，避免过滤条件散落
2. **pill 聚焦保留**：Enter 切视图后不松焦，让 ↑↓ 连续导航，贴近官方体验
3. **`bg_agent` 放 footerItems[0]**：确保 ↓ 溢出直接进入 selector 而非其它 pill
4. **selector 不订阅键盘**：所有按键路由集中在 PromptInput 的 `footer:*` 分支，避免 selector 组件和 PromptInput 双重 `useInput` 的冲突
5. **`selectedBgAgentIndex` 存 AppState 而非局部 state**：selector 和 PromptInput 分别在两棵不同子树，需要全局字段协调；该值不能从 `viewingAgentTaskId` 派生
6. **与 `BackgroundTasksDialog` 共存**：Shift+↓ 行为完全不变，selector 是补充快捷入口；Dialog 仍管 shell / workflow / monitor_mcp 等 selector 不显示的 task 类型
7. **fork prompt 展示层兜底**：fork prompt 不依赖 boilerplate 自身渲染，统一在 `displayedAgentMessages` 中合成独立用户消息；普通 subagent 不走该分支，避免 prompt 重复

## 五、关键 API 复用

| 官方已有能力 | selector 如何使用 |
|---|---|
| `AppState.tasks` | 单一数据源，无需 file watcher / output JSONL 订阅 |
| `registerAsyncAgent` | AgentTool fork 路径（不指定 `subagent_type`）和普通 AgentTool 调用共用，selector 不区分来源 |
| `enterTeammateView(id)` | Enter 时调用，负责 retain + disk bootstrap |
| `exitTeammateView` | Enter 选中 `main` 时调用 |
| `release(task)` + `PANEL_GRACE_MS` | 30s keep-alive，selector 自动生效 |
| `useElapsedTime` | 每行时长显示，非 running 自动停 interval |
| `formatTokens` (`utils/format.ts`) | token 数 1k 缩写 |
| `footer:up` / `footer:down` / `footer:openSelected` keybinding | 键盘路由复用 Footer context |

## 六、文件索引

| 文件 | 职责 |
|------|------|
| `src/hooks/useBackgroundAgentTasks.ts` | 数据过滤 hook（backgrounded local_agent + evictAfter 过滤 + startTime 排序） |
| `src/components/tasks/BackgroundAgentSelector.tsx` | 底部 selector UI，纯展示 |
| `src/components/tasks/taskStatusUtils.tsx` | `getAgentRowDescription`（recap 优先级 + 终态回落）与 `getAgentStatusDotColor`（状态色），三处 agent 行共用 |
| `src/services/AgentSummary/enabled.ts` | recap 开关：`OCC_AGENT_SUMMARIES` 硬开关 + 前台/后台判定 |
| `src/services/AgentSummary/agentSummary.ts` | 30s 周期 fork 摘要、并发上限、`skipCacheWrite` |
| `src/components/PromptInput/PromptInput.tsx` | 新增 `'bg_agent'` footer pill + 对应的 `footer:up/down/openSelected` 分支 |
| `src/state/AppStateStore.ts` | `FooterItem` 加 `'bg_agent'`；新增 `selectedBgAgentIndex` 字段 |
| `src/main.tsx` | `getDefaultAppState` 同步初始化 `selectedBgAgentIndex: -1` |
| `src/screens/REPL.tsx` | 在 PromptInput + SessionBackgroundHint 之后挂载 `<BackgroundAgentSelector />`；切换 agent 主视图；对 fork transcript 做 prompt 归一化 |
| `src/components/messages/AssistantToolUseMessage.tsx` | 新增 `defaultCollapsed?: boolean` prop，为后续详情视图默认折叠工具块预留 |
| `src/components/messages/UserTextMessage.tsx` | 识别 `<fork-boilerplate>`，交给 fork 专用 renderer 处理 |
| `src/components/messages/UserForkBoilerplateMessage.tsx` | 将 fork boilerplate text 折叠为纯用户 prompt；作为 transcript 中原位渲染的兼容路径 |

## 七、Recap —— 描述列显示什么

描述列不是派生时写死的 `description`，而是"这个 agent 现在在干什么"。取值优先级由 `getAgentRowDescription`（`src/components/tasks/taskStatusUtils.tsx`）统一决定，`BackgroundAgentSelector`、底部 `BackgroundTask` pill、`BackgroundTasksDialog` 三处共用：

| 优先级 | 来源 | 例子 |
|---|---|---|
| 1 | `progress.summary` —— AI 生成的 recap | `Verifying runtime sampler` |
| 2 | `progress.lastActivity.activityDescription` —— 每条 assistant 消息更新的工具活动 | `Reading src/foo.ts` |
| 3 | `description` —— 派生时的任务描述 | `Research src/utils` |

**终态例外**：agent 进入 `completed` / `failed` / `killed` 后一律回落到 `description`。已结束的行显示"Reading src/foo.ts"是最后一次动作的快照，读起来像还在跑。

### Recap 是怎么生成的

`startAgentSummarization`（`src/services/AgentSummary/agentSummary.ts`）每 30s fork 一次该 agent 的会话，做一次**无工具**推理，产出 3-5 词的现在进行时短语，写入 `task.progress.summary`。

它只对**后台 agent** 启用：

- ✅ `run_in_background: true` 起跑的 agent
- ✅ 前台 agent 被转入后台之后（从那一刻开始计时，所以转后台后约 30s 才出现第一条 recap）
- ❌ 前台同步 agent —— 它们 `isBackgrounded === false`，被 `useBackgroundAgentTasks` / `isBackgroundTask()` 过滤掉，压根没有行可以显示 recap；而且 spinner 已经在显示实时工具活动

判定逻辑集中在 `src/services/AgentSummary/enabled.ts`（`isBackgroundAgentSummarizationEnabled` / `isForegroundAgentSummarizationEnabled`），`AgentTool` 的派生路径与 `resumeAgent` 的续跑路径共用同一个入口。

### 关闭开关：`OCC_AGENT_SUMMARIES`

recap 每个 agent 每 30s 要真实调用一次 API。默认开启；要关掉：

```bash
OCC_AGENT_SUMMARIES=0 occ
```

| 值 | 效果 |
|---|---|
| `0` / `false` / `no` / `off`（大小写不敏感、允许首尾空格） | **关闭** |
| 未设置 | 开启（默认） |
| **空串 `OCC_AGENT_SUMMARIES=`** | **开启** —— 空串不算"关"，视同未设置 |
| 其他任意值（`1` / `true` / `on` / 乱填） | 开启 |

> ⚠️ **空串语义与 `FEATURE_*` 相反**。构建期的 `FEATURE_<NAME>=` 把空串当作"关"（见 `scripts/defines.ts` 的 `resolveBuildFeatures()`），而这里走的是 `isEnvDefinedFalsy()`，只有显式的 falsy 字面量才算关。这样 shell 里误写 `OCC_AGENT_SUMMARIES=` 不会静默吞掉功能。该语义有测试钉住（`src/services/AgentSummary/__tests__/enabled.test.ts`）。

关闭是**硬开关**，优先级高于一切 opt-in：coordinator 模式、fork subagent、SDK 的 `setSdkAgentProgressSummariesEnabled` 控制请求都会被它压过。理由是这个变量由启动进程的人设置，"关了还在计费"才是更意外的行为。

关闭后描述列自动退回工具活动（上表第 2 档），并不会变回静态描述。

### 成本

- **命中缓存的只有稳定前缀**（system prompt + tools）。messages 段是倒序后缀窗口，每 tick 起点都在滑动，属于全新输入 —— 长时间运行的 agent 最坏一次要付 `MAX_SUMMARY_CONTEXT_CHARS`（约 50k token）的全价输入。别把它当"几乎免费"。
- fork 传 `skipCacheWrite: true`：那段窗口下一 tick 读不回来，写缓存只是白付 1.25x 溢价。
- 全局并发上限 `MAX_CONCURRENT_SUMMARY_FORKS = 2`：N 个后台 agent 各有独立 30s timer，没有这个上限时同一瞬间可能打出 N 个请求，和用户自己的对话抢 rate limit。取舍是超出上限的 agent **跳过本 tick**（不排队），所以并发高时单个 agent 的 recap 最多可能陈旧 60s；由于 timer 是在完成时重排的，agent 群体会自然错峰而不是共振。
- poor mode 期间、transcript 未变化、消息少于 3 条时都会跳过。

## 八、已知限制

- `Date.now()` 在 `useBackgroundAgentTasks` 的 useMemo 里冻结于 `[tasks]` 触发时：若长时间没有新 task 变更事件，某个 terminal agent 的 grace 期过期后不会立即从 selector 消失，要等下一次 tasks 变化才刷新。在典型使用（主对话一直在产生消息）下感知不到，暂不额外加 interval。
- Selector 当前不处理 Shell Task / Workflow / Monitor MCP 等类型——这些仍走 `BackgroundTasksDialog`（Shift+↓）管理。
- `AssistantToolUseMessage` 的 `defaultCollapsed` prop 目前无调用方传值，保留作为后续"agent 详情视图内工具块默认折叠"扩展点。
