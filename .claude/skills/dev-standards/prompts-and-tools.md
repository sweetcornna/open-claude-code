# System prompt 与工具定义

## 目录

- system prompt 放什么、不放什么
- 改 system prompt 的证据要求
- 工具定义：接口优先于示例
- 工具返回值：token 预算与截断
- 工具错误信息
- 工具合并：少而高层
- occ 特有：延迟加载工具的 schema 契约

---

## system prompt 放什么、不放什么

放**模型无法自己得知的环境事实**：CLI 名与身份、当前可用工具集、平台差异、会话形态
（交互 / print / SDK / ACP）、权限模式。

不放：

- 代码风格指令。正确写法是"写得像周围的代码：匹配它的注释密度、命名与惯用法"，
  而不是枚举禁令（官方原例：不要写 "never write multi-paragraph docstrings"）。
- 对单个工具的重复叮嘱——那属于工具描述。
- 为最坏情况准备的护栏。
- 让模型自我验证 / 复核的指令（见 SKILL.md 的 Opus 5 一节）。

**结构**：用 Markdown 标题或 XML 标签分节（`<background_information>`、`## Tool guidance`），
不要一大段散文。

**海拔**：既不要硬编码分支逻辑，也不要空泛口号——要"足够具体到能指导行为，又足够灵活让模型有启发式空间"。

## 改 system prompt 的证据要求

`src/constants/promptEngineeringAudit.runner.ts` 钉着行为锚点、已删内容的反向断言与结构断言。

**加约束容易，删约束需要证据。** 删之前用 `scripts/dump-prompt.ts` 对比前后，
确认删掉的是重复表述而非唯一来源。

GPT / DeepSeek 的差异化行为必须挂各自的唯一门控（见 `CLAUDE.md`），
**Anthropic 路径必须字节级不变**。

## 工具定义：接口优先于示例

官方结论：工具定义值得与整体 prompt 同等的打磨，且**用接口表达能力，而不是用示例**——
示例会约束探索空间。

- **参数名即说明书**。与其在描述里写"记得传 X"，不如把 X 变成必填参数。
  用 `user_id` 而不是 `user`。
- **描述讲边界**：这个工具不做什么、与哪个工具区分。官方判据：
  **如果一个人类工程师无法明确说出该用哪个工具，模型也一样做不到。**
- **命名带命名空间**：按服务/资源前缀分组（`asana_search` / `asana_projects_search`），
  避免名字重叠。
- 需要示例时，给**少量典型**示例而不是穷举边界情况——示例是复杂规则的压缩表示。

工具描述快照只钉 Bash / Agent / FileRead / FileEdit 四个（`promptCharacterization`）。
改完跑 `bun test <runner路径> -u` 并**人工审读 snap diff**。

## 工具返回值：token 预算与截断

**上下文是公共资源。** 官方硬性做法：

- Claude Code 默认把单次工具返回**限制在 25,000 tokens**。
- 大返回必须支持**分页 / range / 过滤 / 截断**，并给合理默认值。
- 截断时**在返回里告诉模型更省的路子**（"用过滤或分页，不要请求全部结果"），
  而不是干巴巴截断。
- 只返回**高信号**内容。剔除 `mime_type`、`uuid`、缩略图 URL 这类模型用不上的字段；
  把 UUID 换成**语义可读的标识**（甚至 0 起的序号），能显著降低检索类任务的幻觉。
- 需要时给 `response_format` 之类的枚举参数让模型自己选详略
  （官方例子：详细版 206 tokens vs 精简版 72 tokens）。

**搜索型工具优先于列全量型工具**——agent 的上下文有限，这一点和普通程序不同。

## 工具错误信息

给**具体、可操作**的下一步，不要抛栈或不透明错误码。
错误信息是模型唯一的纠错输入。

本仓库的例子：hook 找不到 Git Bash 时，错误里要写清装什么、设哪个环境变量、
以及 `System32\bash.exe` 为什么不算。

## 工具合并：少而高层

**工具更多不等于效果更好。** 不要把每个 API 端点包一个工具——中间产物会吃掉上下文。

官方示例：用 `schedule_event` 取代 `list_users` + `list_events` + `create_event`；
用 `search_logs`（只回相关行加上下文）取代 `read_logs`。

## occ 特有：延迟加载工具的 schema 契约

非 `CORE_TOOLS` 的工具走 `SearchExtraTools` 的 TF-IDF 检索按需加载。

**schema 必须进检索索引。** 索引里只有名字没有 schema 时，模型只能猜参数，
`ExecuteExtraTool` 必然校验失败——这是本仓库踩过的坑。

`src/services/searchExtraTools/` 复用 `localSearch.ts` 的 TF-IDF 函数；
改那些函数要同步跑工具索引测试。
