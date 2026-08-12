# ToolSearch 设计指南

> 基于 feature/tool_search 分支的 4 次 commit 迭代，系统性地记录 ToolSearch 的架构、核心机制、演进历史和维护指南。

## 1. 问题背景

Claude Code 内置了 60+ 工具，加上用户连接的 MCP 服务器可能引入数十甚至上百个额外工具。将所有工具的完整 schema 一次性发送给模型，会产生几个严重问题：

1. **Token 爆炸** — 每个工具定义（name + description + inputSchema）平均消耗数百 token，60 个工具就是数万 token 的常量开销。
2. **Prompt Cache 失效** — 工具列表作为 prompt 的一部分参与缓存计算。任何工具的增减（如 MCP 服务器连接/断开）都会导致整段缓存失效。
3. **模型注意力稀释** — 过多的工具定义干扰模型对核心工具的选择准确性。

## 2. 解决方案概览

ToolSearch 采用 **延迟加载（Deferred Loading）** 模式：

- 将工具分为 **Core Tools**（始终加载）和 **Deferred Tools**（按需发现）
- 模型通过 `SearchExtraTools` 工具搜索并发现 deferred tools
- 通过 `ExecuteExtraTool` 工具代理执行发现的 deferred tools
- **工具数组在会话中保持稳定**，不再动态注入已发现的 deferred tools（v3 修复的关键决策）

## 3. 核心架构

### 3.1 工具分类体系

```
┌─────────────────────────────────────────────────────────────┐
│                     All Tools (60+ built-in + MCP)          │
├───────────────────────────┬─────────────────────────────────┤
│    Core Tools (29 个)     │     Deferred Tools (其余全部)    │
│    始终加载，直接调用      │     不加载 schema，按需发现      │
│    CORE_TOOLS 白名单定义   │     isDeferredTool() 判定       │
└───────────────────────────┴─────────────────────────────────┘
```

**Core Tools**（`src/constants/tools.ts` 中的 `CORE_TOOLS` Set）：

| 类别 | 工具 |
|------|------|
| 文件操作 | Bash/Shell, Read, Edit, Write, Glob, Grep, NotebookEdit |
| Agent 交互 | Agent, AskUserQuestion |
| 任务管理 | TaskOutput, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, TodoWrite |
| 规划 | EnterPlanMode, ExitPlanMode, VerifyPlanExecution |
| Web | WebFetch, WebSearch |
| 代码智能 | LSP |
| 技能 | Skill |
| 工作流 | Workflow |
| 工具发现 | SearchExtraTools, ExecuteExtraTool, StructuredOutput |

**isDeferredTool 判定逻辑**（`packages/builtin-tools/src/tools/SearchExtraToolsTool/prompt.ts`）：

```
isDeferredTool(tool) =
  tool.alwaysLoad === true?  → false（显式跳过延迟）
  CORE_TOOLS.has(tool.name)? → false（核心工具不延迟）
  tool.name === Goal?        → !isGoalPresent()（有 goal 时不延迟）
  otherwise                  → true（其余全部延迟）
```

`alwaysLoad` 有两个来源，任一为真即生效：MCP 服务器给单个工具打的
`_meta['anthropic/alwaysLoad']`，以及用户在该服务器配置里写的 `alwaysLoad: true`
（`.mcp.json` / settings 的 `mcpServers`，stdio·sse·http·ws 四种传输均支持）。
后者是给「重度依赖某一个 MCP 服务器」的用户准备的逃生阀 —— 前者要求你能控制
那台服务器。注意它对 turn 1 是尽力而为：occ 刻意不让 MCP 阻塞启动，未连上的
服务器从下一轮起才贡献工具。

### 3.2 三层组件架构

```
┌──────────────────────────────────────────────────────┐
│  API Layer (src/services/api/claude.ts)              │
│  ├─ 判定是否启用 ToolSearch                          │
│  ├─ 过滤 deferred tools 不进入 API tools 数组         │
│  ├─ 宣告 deferred 名单（delta 附件；env 可退回旧式）   │
│  └─ 处理 tool_reference/text 格式的消息归一化         │
├──────────────────────────────────────────────────────┤
│  Query Loop (src/query.ts)                           │
│  ├─ Turn-zero 预取：用户输入时触发                    │
│  └─ Inter-turn 预取：assistant turn 后异步触发        │
├──────────────────────────────────────────────────────┤
│  Search Engine                                       │
│  ├─ SearchExtraToolsTool — 搜索入口（4 种查询模式）  │
│  ├─ TF-IDF Index (toolIndex.ts) — 语义搜索          │
│  ├─ Keyword Search — 精确匹配                       │
│  └─ ExecuteExtraTool — 代理执行                      │
└──────────────────────────────────────────────────────┘
```

### 3.3 搜索引擎设计

SearchExtraToolsTool 支持四种查询模式：

| 模式 | 语法 | 行为 | 返回 |
|------|------|------|------|
| **Select** | `select:CronCreate,Snip` | 按名称直接获取，逗号分隔多选 | 精确匹配列表 |
| **Discover** | `discover:schedule cron job` | 纯发现模式，返回描述+schema | 工具信息文本 |
| **Keyword** | `notebook jupyter` | 关键词搜索 | 按相关性排序 |
| **Required** | `+slack send` | `+` 前缀强制包含 | 包含必选词的结果 |

**混合搜索算法**：

```
最终分数 = 关键词分数 × 0.4 + TF-IDF 分数 × 0.6
```

- **Keyword Search**：基于工具名解析（CamelCase 分词、MCP 前缀拆解）、searchHint 匹配、描述文本匹配，加权计分
- **TF-IDF Search**：复用 `skillSearch/localSearch.ts` 的算法，对 name (3.0)、searchHint (2.5)、description (1.0) 三个字段加权计算 TF-IDF 向量

**MCP 工具名解析**：

```
mcp__slack__send_message → parts: ["slack", "send", "message"]
CamelCase → parts: ["cron", "create"]
```

### 3.4 执行管道

```
模型调用 ExecuteExtraTool({tool_name: "CronCreate", params: {...}})
  ↓
ExecuteTool.call() 在全局工具注册表中查找 CronCreate
  ↓
检查目标工具 isEnabled() — 桥接/条件工具可能不可用
  ↓
委托目标工具的 checkPermissions() — 权限传递给实际工具
  ↓
调用目标工具的 call() — 与直接调用完全等价
  ↓
返回结果（包装为 ExecuteExtraTool 的 output schema）
```

关键设计：ExecuteExtraTool 的 `checkPermissions()` 返回 `passthrough`，将权限决策完全委托给目标工具。它本身不引入额外的权限层。

### 3.5 Prompt Cache 稳定性策略（v3 关键修复）

**问题**：早期版本在发现 deferred tool 后会将其注入 API tools 数组，导致每次发现新工具时 tools JSON 变化，prompt cache 全面失效。

**修复**（commit `c14b7ead`）：deferred tools **始终不进入 API tools 数组**。tools 数组在整个会话中只包含 core tools + SearchExtraTools + ExecuteExtraTool，保持稳定。

```
API Tools 数组（会话期间不变）:
  [Core Tools (29)] + [SearchExtraTools, ExecuteExtraTool, SyntheticOutput]
  
  不包含: 任何 deferred tool（即使已被发现）
  执行方式: 通过 ExecuteExtraTool 代理调用
```

## 4. 预取机制（Prefetch）

### 4.1 两个触发时机

1. **Turn-zero**（`getTurnZeroSearchExtraToolsPrefetch`）— 用户输入第一轮时，基于输入文本搜索相关 deferred tools，以 attachment 形式注入
2. **Inter-turn**（`startSearchExtraToolsPrefetch`）— assistant turn 结束后，基于对话上下文异步搜索

### 4.2 Attachment 管道

```
prefetch → Attachment(type: 'tool_discovery')
  → messages.ts 转换为 system-reminder
  → "The following tools were discovered... Use ExecuteExtraTool to invoke..."
```

### 4.3 会话去重

`discoveredToolsThisSession` Set 跟踪已发现的工具，避免重复推荐。该 Set 独立于 skill prefetch 的去重集合，互不影响。使用 `addBoundedSessionEntry()` 保持上限 500 条，超出时裁剪到 400 条。

## 5. 模式切换系统

通过环境变量 `ENABLE_SEARCH_EXTRA_TOOLS` 控制：

| 环境变量值 | 模式 | 行为 |
|-----------|------|------|
| 未设置 | `tst` | 默认启用，始终延迟非核心工具 |
| `true` | `tst` | 强制启用 |
| `false` | `standard` | 完全禁用，所有工具内联加载 |
| `auto` | `tst-auto` | 仅当 deferred tools 超过上下文窗口 10% 时启用 |
| `auto:N` | `tst-auto` | 自定义阈值百分比（N=0 启用，N=100 禁用） |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | `standard` | 全局 kill switch |

`isSearchExtraToolsEnabledOptimistic()` — 快速判断（不检查阈值），用于工具注册
`isSearchExtraToolsEnabled()` — 完整判断（含阈值检查），用于 API 调用

## 6. Deferred Tools Delta 机制

deferred 名单通过**持久化的 `deferred_tools_delta` attachment** 宣告：首次注入完整
名单，之后只注入增量（新增/移除），中间轮次一个字节都不发。

**为什么必须是持久化的**：它替代的那条 `<available-deferred-tools>` 临时消息由
`claude.ts` 在每次请求的**尾部**重新拼一次、且不写回历史；而 `addCacheBreakpoints`
全局只放一个 message 级 `cache_control` 标记，位置正是 `messages.length - 1` ——
于是每一轮的缓存写入都落在一条下一轮不会再出现的消息上，写进去永远读不回来。
代价是每轮一次 1.25× 的 cache write，外加整份 deferred 名单（MCP 装满时几百行）
按未命中重新计费。`promptCacheBreakDetection` 看不见这件事：它只比
`toolsHash`/`systemHash`/`cacheControlHash`，不比消息体。

判定在 `packages/builtin-tools/src/tools/SearchExtraToolsTool/deferredToolsDelta.ts`
（零依赖叶子模块），默认开启，`CLAUDE_CODE_DEFERRED_TOOLS_DELTA=0` 退回旧式临时消息。
**这个判定必须只有一处**：`SearchExtraToolsTool` 的描述要告诉模型去哪儿找工具名
（system-reminder 还是 `<available-deferred-tools>`），两边一旦漂移，模型就会去找
一条根本不存在的消息。`searchExtraTools.ts` 再导出它而不是自己复制一份，正是因为
后者曾经是两份手抄。

**宣告 ≠ 已发现**：`extractDiscoveredToolNames` 刻意不把 delta 的 `addedNames` 计入
discovered 集合。discovered 的语义是「模型已经看过参数 schema」，`ExecuteExtraTool`
的「先搜后调」守卫和 compaction 的 `preCompactDiscoveredTools` 都依赖这一点；混淆
两者等于取消守卫，模型会对着 strictObject 猜字段名。

`addedLines`（渲染用）截断到 `DEFERRED_DELTA_LIST_CAP = 30`，`addedNames`（记账用）
保持完整 —— 从记账里丢名字会让同一批工具每轮重新宣告。超出部分由渲染文案指引模型
改用关键词 / `discover:` 检索。

### 6.1 tool_search_usage_reminder

与 delta 互补的反向提醒：连续 15 个 assistant 轮次没调过 `SearchExtraTools`、且仍
有从未被搜索过的 deferred 工具时，注入一条 system-reminder 点名其中前 10 个。
针对的失败是「模型断定某能力不存在」或直接用 Bash 手搓替代方案 —— occ 默认全量延迟
（`CORE_TOOLS` 之外 + 全部 MCP 工具），这个坑比上游深。`tool_discovery` 预取是「猜
你要什么」，这条是「提醒你还没看」，两者不重复。`CLAUDE_CODE_TOOL_SEARCH_REMINDER=0`
关闭。

### 6.2 搜不到时的分状态说明

`SearchExtraTools` 返回空结果时按 MCP server 状态分四类说明，而不是笼统的
"No matching deferred tools found"：still-connecting（可以再搜）、failed（是连接
失败，不是能力缺失）、needs-auth（去 `/mcp` 认证，别问用户要 token）、disabled
（管理性状态，重试无用）。区分的理由是模型会把「找不到工具」读成「这个能力不存在」，
然后去告诉用户或自己造轮子。服务器上报的 error 文本先经消毒（去控制字符、去尖括号
引号、截断 200 字符）才进上下文，并明确标注为诊断数据而非指令。

搜索还会**主动等待**仍在连接的 MCP server（最多 5s，50ms 轮询，尊重 abort），条件是
先刷新工具池仍无结果、且查询指向的正是 pending 的那台（或没点名任何 server）。
不等的话就是白白多烧一整个往返 —— 而且模型未必会重试。

## 7. 演进历史

### v1: 基础设施层（`7be08f53`）

**34 个文件，+4040/-90 行**

- 定义 `CORE_TOOLS` 白名单（31 个核心工具）
- 实现 TF-IDF 工具索引模块 `toolIndex.ts`
- 创建 `ExecuteTool` 作为统一执行入口
- 增强 ToolSearchTool：TF-IDF 搜索路径、discover 模式、并行搜索合并
- 新增 27 个单元测试
- 实现预取管道和 UI 组件

**关键文件**：
- `src/services/toolSearch/toolIndex.ts` → 后续重命名为 `searchExtraTools/toolIndex.ts`
- `packages/builtin-tools/src/tools/ExecuteTool/` — 执行入口
- `src/constants/tools.ts` — CORE_TOOLS 定义

### v2: 统一自建搜索（`8c157f07`）

**17 个文件，+274/-395 行**（净减少 121 行）

- **移除 `tool_reference` blocks** — 不再依赖 Anthropic API 的 `tool_reference` 功能
- **移除 `defer_loading` 字段** — 不再发送 API 级别的工具延迟加载标记
- **移除 `modelSupportsToolReference()`** — 不再区分模型是否支持 tool_reference
- **重命名 ExecuteTool → ExecuteExtraTool** — 更清晰地表达其作为代理执行器的角色
- **输出改为纯文本** — 所有 provider 通用，无需特殊 API 功能支持
- **简化 system prompt** — 工具使用指南从 ~120 行压缩到 ~10 行

**设计决策**：这次重构的核心洞察是 — 依赖 Anthropic 私有 API 特性（tool_reference、defer_loading、beta header）使得系统只能用于 first-party provider。自建 TF-IDF + keyword 搜索完全能满足需求，且对所有 provider（OpenAI、Gemini、Grok）通用。

### v3: Cache 稳定性修复（`c14b7ead`）

**7 个文件，+46/-31 行**

- **移除 "discover then include" 逻辑** — 发现的 deferred tools 不再注入 tools 数组
- **tools 数组保持稳定** — 只有 core tools + SearchExtraTools + ExecuteExtraTool
- **强化优先级引导** — core tools 直接调用，ToolSearch 仅作为发现 deferred tools 的手段
- **已加载工具拒绝提示** — 搜索 core tool 时返回明确拒绝

**设计决策**：prompt cache 是 Claude Code 性能优化的关键。每次 tools JSON 变化都会导致缓存失效，代价远大于通过 ExecuteExtraTool 代理调用 deferred tools 的额外 token。因此选择牺牲一点直接调用的便利性，换取 cache 稳定性。

### v4: Agents/Teams 延迟化（`af0d7dc8`）

**7 个文件，+36/-18 行**

- 将 `TeamCreate`、`TeamDelete`、`SendMessage` 从 CORE_TOOLS 移除
- 这些工具仅在 swarm 模式下常用，平时占用 context token
- swarm 模式下 SendMessage 保持 always loaded
- TeamCreate/TeamDelete 在 swarm 未启用时返回启用提示

**设计决策**：不是所有用户都需要团队功能。将其延迟化后，大部分用户可以节省约 3 个工具定义的 token 开销。

### v5: 宣告改走缓存（吸收官方局部改进）

- **`deferred_tools_delta` 默认开启**，弃用每轮重发的 `<available-deferred-tools>`
  临时消息（理由见 §6）。判定下沉到零依赖叶子模块，消除两处手抄的同一个门控。
- **宣告与「已发现」解耦** —— delta 不再把工具计入 discovered 集合。
- **搜不到时分四类说明** + **MCP pending 主动等待 5s**（§6.2）。
- **`tool_search_usage_reminder`**（§6.1）。
- **用户侧 per-MCP-server `alwaysLoad`** —— 此前只有服务器自己声明的 `_meta` 一条路。
- 修 `ExecuteExtraTool` few-shot 教错字段名（`schedule` → `cron`，CronCreate 是
  strictObject，照抄必被拒），并加了一条把示例参数喂给真 schema 的守卫测试。

**设计决策**：这一轮**没有**迁移到官方的 `defer_loading` / `tool_reference` 直调式。
那套依赖服务端不把带标记的工具渲进 prompt 顶部，只有 `api.anthropic.com` 与做过能力
探测的托管平面兑现；官方自己在非官方 `ANTHROPIC_BASE_URL` 上默认关闭它。迁移等于
回滚 v3，并把正确性押在 occ 大部分会话都拿不到的服务端契约上。真正可测量的浪费不在
机制选择上，而在宣告的载体 —— 那个不迁移就能修。

## 8. 文件索引

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/constants/tools.ts` | CORE_TOOLS 白名单、工具权限集合 |
| `src/utils/tools/searchExtraTools.ts` | 模式判定、阈值计算、delta 差分、discovered tools 提取 |
| `src/services/searchExtraTools/toolIndex.ts` | TF-IDF 索引构建和搜索 |
| `src/services/searchExtraTools/prefetch.ts` | 预取管道（turn-zero + inter-turn） |
| `packages/builtin-tools/src/tools/SearchExtraToolsTool/` | 搜索工具实现（4 种查询模式） |
| `packages/builtin-tools/src/tools/ExecuteTool/` | 代理执行器实现 |
| `src/services/api/claude.ts` | API 层集成（工具过滤、消息归一化） |
| `src/query.ts` | 查询循环集成（预取触发点） |
| `src/utils/messages/attachmentNormalize.ts` | Attachment → system-reminder 转换 |
| `src/utils/attachments/deltas.ts` | delta / usage-reminder attachment 的生产者 |

### 共享基础设施

| 文件 | 被复用的导出 |
|------|-------------|
| `src/services/skillSearch/localSearch.ts` | `tokenizeAndStem`, `computeWeightedTf`, `computeIdf`, `cosineSimilarity` |
| `src/services/skillSearch/prefetch.ts` | `extractQueryFromMessages` |

### 测试文件

| 文件 | 覆盖范围 |
|------|---------|
| `src/services/searchExtraTools/__tests__/toolIndex.test.ts` | 索引构建、TF-IDF 搜索、CJK 处理 |
| `src/services/searchExtraTools/__tests__/prefetch.test.ts` | 预取管道、去重、attachment 生成 |
| `packages/builtin-tools/src/tools/SearchExtraToolsTool/__tests__/` | 搜索工具 4 种模式 |
| `packages/builtin-tools/src/tools/ExecuteTool/__tests__/` | 代理执行 |

## 9. 维护指南

### 9.1 新增工具的延迟化决策

将新工具加入 deferred 状态的标准：
- 工具仅在特定场景使用（如 swarm 模式、特定 MCP 集成）
- 工具的 schema 较大（占用较多 context token）
- 工具不是模型默认会尝试的核心操作

将已延迟的工具提升为 core tool：
- 在 `src/constants/tools.ts` 的 `CORE_TOOLS` Set 中添加工具名常量
- 确保导入对应的 `*_TOOL_NAME` 常量

### 9.2 修改注意事项

1. **修改 `localSearch.ts` 的 TF-IDF 函数**：需同步检查 `toolIndex.test.ts` 和 `localSearch.test.ts`
2. **修改 `skillSearch/prefetch.ts` 的 `extractQueryFromMessages`**：需同步检查工具预取行为（`searchExtraTools/prefetch.ts` 调用同一函数）
3. **修改 CORE_TOOLS**：需更新 `src/constants/__tests__/tools.test.ts` 测试
4. **修改 `isDeferredTool`**：需更新 `src/constants/__tests__/tools.test.ts` 和 `SearchExtraToolsTool.test.ts`

### 9.3 性能优化配置

```bash
# 环境变量调优
ENABLE_SEARCH_EXTRA_TOOLS=auto:15    # 当 deferred tools 超过上下文 15% 时启用
SEARCH_EXTRA_TOOLS_WEIGHT_KEYWORD=0.5  # 关键词搜索权重
SEARCH_EXTRA_TOOLS_WEIGHT_TFIDF=0.5    # TF-IDF 搜索权重
SEARCH_EXTRA_TOOLS_DISPLAY_MIN_SCORE=0.10  # 最低显示分数阈值
```

### 9.4 搜索质量调优

- `TOOL_FIELD_WEIGHT`（`toolIndex.ts`）：控制 name/searchHint/description 对 TF-IDF 分数的贡献权重
- `KEYWORD_WEIGHT` / `TFIDF_WEIGHT`（`SearchExtraToolsTool.ts`）：控制混合搜索中两种算法的最终权重比例
- `searchHint` 属性：为工具添加精心编写的搜索提示，提高关键词匹配质量

## 10. 与 Skill Search 的关系

ToolSearch 和 SkillSearch 是平行的搜索系统，共享底层算法但服务于不同领域：

| 维度 | ToolSearch | SkillSearch |
|------|-----------|-------------|
| 搜索对象 | Deferred 工具（内置 + MCP） | 用户技能（skill） |
| 执行方式 | `ExecuteExtraTool` 代理调用 | 直接注入 attachment 内容 |
| 字段权重 | name:3.0, searchHint:2.5, desc:1.0 | name:3.0, whenToUse:2.0, desc:1.0 |
| 缓存策略 | 按工具名列表缓存 | 按 cwd 缓存 |
| 去重集合 | `discoveredToolsThisSession` | 独立的 Set |

共享的底层函数：
- `tokenizeAndStem` — 统一的 CJK/ASCII 分词和词干提取
- `computeWeightedTf` — 加权词频计算
- `computeIdf` — 逆文档频率计算
- `cosineSimilarity` — 向量余弦相似度
- `extractQueryFromMessages` — 从对话历史中提取搜索查询文本
