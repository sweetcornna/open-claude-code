# 贡献指南

欢迎参与 open-claude-code（CLI 名 `occ`）。这份文档讲**怎么在这个仓库里干活**；架构、模块地图、feature flag 体系这些「代码是什么样」的问题，一律以 [`CLAUDE.md`](CLAUDE.md) 为准。

> 术语保留英文原文（feature flag、barrel、ratchet 等），因为它们同时是代码里的标识符，翻译会让搜索失效。

## 1. 开始之前

按这个顺序读：

1. [`CLAUDE.md`](CLAUDE.md) —— 唯一的架构真源。**「路径与隔离不变式」一节在动任何路径相关代码前必读。**
2. 本文档 —— 工作流与规范。
3. 你要改的那块代码附近的 `docs/`。

这是 Anthropic Claude Code CLI 的逆向/反编译社区版，目标是恢复核心功能、裁掉次要能力，并与官方 Claude Code 做到用户态完全隔离。很多模块是 stub 或被 feature flag 关掉的 —— 看到"空实现"先确认是不是有意为之，再动手补。

## 2. 环境准备

```bash
bun install          # 这是 Bun 项目，不是 Node 项目
```

- **Bun 而非 Node**：所有 import、构建、执行都走 Bun API（`engines.bun >= 1.3.11`，`.tool-versions` 钉了具体版本）。**不要用 `npx`，用 `bunx`** —— pre-commit hook 曾因为这个坏掉过。
- 首次跑 `bun run dev` 前不需要额外配置；feature flag 的默认启用列表见 `scripts/defines.ts`。

## 3. 日常工作流

```bash
bun run dev                    # 开发模式
bun test src/path/to/x.test.ts # 单个测试文件
bun run precheck               # 任务完成前必须跑，且必须零错误
```

`precheck` = `tsc --noEmit` + `biome check --fix` + 全量 `bun test`。注意它**会改写你的文件**（`check:fix` 而非 `check`），跑完记得看 `git diff`。

完整命令表在 [`CLAUDE.md`](CLAUDE.md) 的 Commands 一节，这里不复制。

## 4. 「指针不复制」铁律

**同一个事实只允许存在于一个地方，其他地方只放指针。**

这条不是洁癖，是有代价的教训：`AGENTS.md` 曾经是 `CLAUDE.md` 的完整副本，两份漂移到相差 783 行，审计发现副本里有 **21 处与代码不符的陈述** —— 不存在的 workspace package、过期的 feature flag 计数、脚本早已删除的命令。现在 `AGENTS.md` 只剩 17 行指针。

落到日常：

- 写文档前先搜一遍这个事实是不是已经写在别处。是，就链接过去。
- 需要在两处都提到时，一处写完整内容，另一处只写「见 X」。
- 代码注释同理：注释该写代码本身表达不了的约束（为什么必须这样），而不是复述代码在做什么。

## 5. 提交规范

**Conventional Commits**：

```
<type>: <描述>
<type>(<scope>): <描述>
```

- 常用 type：`feat`、`fix`、`docs`、`chore`、`refactor`、`perf`、`test`
- **scope 可选**，用于点明改动范围：`refactor(messages):`、`fix(acp):`、`perf(sessionStorage):`
- **语言**：中英文都接受，仓库历史两者都有。同一个 PR 内保持一致即可。描述要说清**做了什么**，别写 "update code" 这种。
- 一个提交一件事。重构与行为改动分开提交 —— 混在一起的 diff 没法审。

## 6. 代码规范

- **TypeScript strict，tsc 必须零错误。**
- **生产代码禁止 `as any`**（测试里的 mock 数据可以）。类型对不上优先 `as unknown as SpecificType` 双重断言或补 interface；未知结构用 `Record<string, unknown>`；联合类型用类型守卫收窄，不要强转。
- **Biome** 管 lint 与格式化，覆盖 `src/`、`scripts/`、`packages/`。42 条规则因反编译代码被关掉，只留 `recommended` 基线。`.tsx` 是 120 列 + 强制分号，其他文件 80 列 + 按需分号 —— 移动代码到不同扩展名的文件会导致重排，拆分时留意。
- **`feature()` 的位置约束**：`import { feature } from 'bun:bundle'` 是 Bun 内置模块。`feature('X')` **只能出现在 `if` 语句或三元表达式的条件位置**，不能赋值给变量、不能放进箭头函数体、不能作为 `&&` 链的一部分。这是编译器限制，不是风格偏好。
- **React Compiler 产物**：组件里的 `const $ = _c(N)` memoization 样板是反编译产物，正常现象，别"清理"。

## 7. 测试规范

- 框架 `bun:test`；单元测试就近放 `src/**/__tests__/<module>.test.ts`，集成测试放 `tests/integration/`。
- **只 mock 有副作用的依赖链**，不 mock 纯函数/纯数据模块。
- **`mock.module` 是进程全局的**（last-write-wins），会污染同进程里所有其他测试文件 —— 这是本仓库最难查的一类失败。核心规则：**不要 mock 被测模块的上层业务模块**，要 mock 就 mock 底层（比如 mock `axios` 而不是 mock 调用它的 API 模块）。
- `log.ts` / `debug.ts` 用 `tests/mocks/` 下的共享 mock，不要在测试文件里内联。
- 修 bug 先写出会红的测试，再让它变绿。**不要为了让测试过而削弱断言或 skip 用例。**

完整的 mock 规则与污染排查方法在 [`CLAUDE.md`](CLAUDE.md) 的 Testing 一节。

## 8. 路径与隔离不变式

occ 必须能和官方 Claude Code 装在同一台机器上互不干扰。**所有路径都从 `src/config/paths.ts` 派生**，禁止字面量拼接 `homedir() + '.claude'`。

隔离改造前有 12 处绕过 helper 直接拼路径，其中两处是真实事故：卸载逻辑会 `rm -rf ~/.claude/local`（等于删掉官方 CLI 的本地安装），`doctor` 上报的路径和它实际检查的路径根本不是同一个。

具体对照表（要什么用什么、绝对不要写什么）、以及**故意保持不变**的那几项（`CLAUDE.md` 文件名、`CLAUDECODE=1`、`~/.claude/ide` 锁文件目录），见 [`CLAUDE.md`](CLAUDE.md) 的「路径与隔离不变式」。改这块之前请务必读完。

## 9. 循环依赖棘轮（ratchet）

`bun run check:cycles` 用 madge 统计循环依赖，与 `scripts/cycle-budget.json` 的预算比对。**它是双向严格的**：超预算失败，低于预算**也**失败。

- 环数**变多** → 先想办法破环。确实是新功能的合理代价，才 `--update` 抬预算，并在提交信息里说明理由。
- 环数**变少** → 恭喜，`bun run check:cycles -- --update` 把改进锁进预算，防止回退。

一个反复出现的现象要知道：**把大文件拆成 barrel + 子模块，往往会让 total 数字上升,而真实耦合是下降的** —— madge 的 DFS 会为多出来的一跳枚举出更多路径。判断方法是对比拆分前后的**边集**（谁 import 谁），而不是看环数。这类情况照常 `--update`，但提交信息要写清楚是表示性变化还是真新增耦合。

另外：手写 lazy `require()` 当"破环器"**无效** —— madge 把 `require` 边也算进去。不要再加这类代码。

## 10. Pull Request

1. 从 `main` 切分支。
2. 小步提交，每个提交都能独立通过 typecheck。
3. 提交前跑 `bun run precheck`（零错误）和 `bun run check:cycles`。
4. 按 [PR 模板](.github/pull_request_template.md)填写，**验证方式一栏要贴实际跑过的命令和结果** ——「应该没问题」不算验证。
5. pre-commit hook 会自动对暂存文件跑 `biome check --fix`；CI 会跑 `biome ci` + typecheck + 环数棘轮 + 全量测试 + 构建。

发现了问题但不在本次范围内？**记录，不要顺手改。** 在 PR 描述里列出来。夹带无关改动的 diff 会拖慢审查，也让回滚变得危险。

## 11. 文档放哪里

| 内容 | 位置 |
| --- | --- |
| 架构、模块地图、约定 | [`CLAUDE.md`](CLAUDE.md)（唯一真源） |
| 跨工具入口 | `AGENTS.md`（**只放指针**，不要往里抄内容） |
| 功能说明、集成指南 | `docs/features/`、`docs/` 下按主题分目录 |
| 编号的功能规格与人工验收清单 | `spec/feature_<日期>_<编号>_<名字>/` |
| 设计文档、实施计划、评审记录 | `docs/superpowers/{specs,plans,reviews}/` |

`spec/` 与 `docs/superpowers/` 的分工：`spec/` 是**带编号、带人工验收清单**的正式功能规格（`spec-design.md` + `spec-plan-N.md` + `spec-human-verify.md` 一套）；`docs/superpowers/` 是**按日期归档**的设计/计划/评审文档，更轻量、更连续。新功能要走人工验收就进 `spec/`，否则进 `docs/superpowers/`。

**关于 `.claude/` 与 `.occ/` 双目录**：仓库里两个都有，这是有意的。`.claude/` 放**跨工具生态共享**的资产（skills、agents —— 官方 Claude Code 和其他 AI 工具也读这里），`.occ/` 放 **occ 独有**的运行时产物（workflow-runs 等）。判断标准：别的工具也该看到 → `.claude/`；只有 occ 认识 → `.occ/`。
