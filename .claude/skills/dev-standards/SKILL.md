---
name: dev-standards
description: open-claude-code 的开发规范，源自 Anthropic 对 Claude 5 代模型的官方指导。涵盖 system prompt、工具定义、CLAUDE.md、skill 与 Windows 兼容的取舍原则。在修改 src/constants/prompts.ts、packages/builtin-tools/ 下的工具定义、CLAUDE.md、.claude/skills/，或在权衡「要不要再加一条约束」「要不要拆子 agent」时使用。
---

# open-claude-code 开发规范

只写**判断依据**。能从代码读出来的事实在 `CLAUDE.md`，流程与命令在 `CONTRIBUTING.md`。

## 总原则：少即是多

官方复盘的第一结论：他们**过度约束**了 Claude Code——system prompt 和 CLAUDE.md 两头都是。
针对 Opus 5 / Fable 5 删掉 **80% 以上的 system prompt**，编码评测**没有下降**。

新增任何"规则"前先自问：**这条是在补充模型不知道的事实，还是在替模型做它自己会做的判断？**
后者不要加；已经存在的那种，遇到就删。

对 CLAUDE.md 的每一行问官方那句话：**「删掉它会让 Claude 犯错吗？」** 不会就删。
过长的 CLAUDE.md 的真实代价不是 token，是**重要规则被淹没后被忽略**。

## Opus 5 专属：这些反而要删

occ 默认跑 Opus 5，下面几类指令在这一代模型上**有害**（会叠加成本、不会提升质量）：

- **"最后加一步验证" / "用 subagent 复核"** —— Opus 5 本来就会自我验证，写进去只会过度验证。
- **"再检查一遍" / "回答前再确认"** —— 同上，自我纠错已内建。
- **"不要思考" / "不要推理"** —— 关 thinking 时反而**增加** `<thinking>` 标签泄漏。
- **评审类的"只报高危" / "保守一点"** —— Opus 5 会照字面执行导致漏报。正确做法是让它**全报，另起一轮过滤**。

需要控制成本时，降 **effort** 而不是关 thinking：thinking 开 + `low` effort 通常优于 thinking 关的同等成本。

反过来，Opus 5 需要**显式**给的是：响应长度（verbosity 不随 effort 下降）、写盘文档的长度、
任务边界（它会自行扩大范围）、子 agent 的委派门槛与数量上限。

## 四个面的落点

| 面 | 放什么 | 细则 |
| --- | --- | --- |
| system prompt | 产品身份与环境事实——模型无法自己得知的 | [prompts-and-tools.md](prompts-and-tools.md) |
| 工具定义 | 用参数与 schema 表达能力，不用示例约束 | [prompts-and-tools.md](prompts-and-tools.md) |
| CLAUDE.md | 仓库概览 + gotcha，其余只留指针 | [docs-and-skills.md](docs-and-skills.md) |
| skills | 团队观点与实践，渐进式披露 | [docs-and-skills.md](docs-and-skills.md) |

## 给 Claude 可验证的检查

官方最强的一条工程建议：**给 Claude 一个它自己能跑的检查**，否则"看起来完成了"就是唯一信号，
人变成验证回路。本仓库现成的检查：`bun run precheck`、`bun run check:cycles`、
`bun test <path>`、`scripts/dump-prompt.ts` 前后对比。

写任务描述时把验收条件写成**能跑的东西**，而不是形容词。要求它**出示证据**（命令与输出），
而不是声称成功。

## 参照物优先于文字描述

要复现某个形态时给**高保真参照**——现有实现、测试、快照——而不是散文规格。
本仓库天然有很多："新增 facade 照抄 `slowOperations.ts`"、"新增 provider 照抄 `specs.ts` 的表项"
比十行规格准确得多。

## 跨平台：路径一律正斜杠

官方 skill 规范明写：**永远用正斜杠**，即使在 Windows 上。反斜杠在 Unix 上直接出错。
本仓库还有一条更强的：**解析**路径时必须同时接受两种分隔符（`split(/[/\\]/)`），
因为 `join()`/`dirname()` 在 Windows 上产出反斜杠——这里踩过坑（plugin 命名空间、版本解析）。

Windows 相关的不变式在 `CLAUDE.md` 的路径与隔离一节。

## 反模式对照

| 旧做法 | 现在 |
| --- | --- |
| 为最坏情况预设护栏 | 陈述事实，信任模型判断 |
| 给工具写用法示例 | 把能力表达进参数与 schema |
| 同一条指令多处重复 | 单一权威位置，其余引用 |
| 知识堆在 CLAUDE.md | gotcha 留下，其余进 skill / `docs/` |
| 用散文描述期望产物 | 给代码 / 测试 / 快照当参照 |
| 叮嘱模型自我验证 | 给它能跑的检查，删掉叮嘱 |
| 无脑派子 agent | 只在大且真正独立的任务上派 |

## 参考

- [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
