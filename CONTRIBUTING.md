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

### 9.1 Mock 卫生棘轮

`bun run check:mock-hygiene` 与 `scripts/mock-hygiene-budget.json` 比对，同样双向严格，同样在 precheck 和 CI 里。

规则只有一条：**mock 仓库内的模块必须走 `tests/mocks/` 的 helper，不能写内联 `mock.module('src/…', () => ({ … }))`。** 外部 specifier（`bun:bundle`、`axios`、`node:*`）豁免——它们没有可委托的仓库模块。

脚本查两类，分别记账：

1. **内联表面** —— `mock.module('src/…', () => ({ … }))`。
2. **未复位的覆盖** —— `setupXMock({ … })` / `.setup({ … })` 在模块顶层装了覆盖，全文件却没有任何 `.reset()`。

为什么值得一条棘轮：Bun 把一个分片的所有测试文件跑在**同一个进程**里，而 `mock.module` 是进程全局、last-write-wins 的。所以内联 mock 不是「给自己」装的，是给此后加载的每个文件装的。而且**表面完整也不够**，关键是覆盖的生命周期：

- `src/utils/sandbox/__tests__/` spread 了真实模块（表面完整），只把 `getSettingsFilePathForSource` 永久钉成 `undefined` → `changeDetector.test.ts` 监听了错误目录。
- `MagicDocs/__tests__/prompts.test.ts` 在套件结束后装了个**手写的** fs 适配器，缺 `mkdirSync` 等一批 `*Sync` 方法 → `updateSettingsForSource` 抛错被吞 → `pluginOperations.builtinSecurity.test.ts` 拿到 `success:false`。

两个都只在 Linux 上炸：**Bun 的测试文件顺序由文件系统决定，既不是字母序也不是命令行参数顺序，本地无法复现、也无法用参数控制**。CI 从 v2.11.0 到 v2.30.0 连续 55 次全红。正确写法是 `setup()` 装完整表面 → `beforeAll` 里 `set()` → **`afterAll` 里 `reset()`**；能用模块自带的 setter（如 `setFsImplementation`/`setOriginalFsImplementation`）就别用 `mock.module`。

存量按文件记在预算里，逐步转换；每转换一处跑 `--update` 提交更低基线。

### 9.2 死代码棘轮

`bun run check:unused` 是**套在 knip 外面的棘轮**，不是裸 knip。裸 knip 报 ~1900 条未使用导出/类型，其中相当一部分**不能删** —— 光 `src/entrypoints/sdk/` 就占约 170 条，那是 Agent SDK 的公开 schema 表面，`coreTypes.generated.ts` 正是从 `coreSchemas.ts` 生成的，"内部没人 import"是预期状态而非缺陷。照 knip 的话删会破坏已发布的契约。

所以按可信度分两档：

- **硬性零**（`files` / `dependencies` / `devDependencies` / `optionalPeerDependencies` / `unlisted` / `unresolved` / `binaries`）—— 已逐条核实清空，再出现就是真事故（没人 import 的文件、没人用的依赖、解析不到的 import）。**一出现就 fail。**
- **预算档**（`exports` / `types` / `duplicates`）—— 存量记在 `scripts/unused-budget.json`，双向严格，与前面几个棘轮同一套契约。

想看原始报告用 `bun run check:unused:raw`。

**核实过再删。** knip 在这个仓库假阳性不少：vendored Ink（`packages/@ant/*` 被整体排除在分析外）让它把 `auto-bind`、`cli-boxes`、`emoji-regex`、`react-reconciler`、`wrap-ansi` 等十个**在用**的依赖报成未使用 —— 照单删会直接搞坏构建。这类只能进 `ignoreDependencies` 并写明原因。`@napi-rs/keyring` 同理：它是**故意可选**的动态 import（模块缺失就降级到加密文件存储），不是漏声明。

## 10. Pull Request

1. 从 `main` 切分支。
2. 小步提交，每个提交都能独立通过 typecheck。
3. 提交前跑 `bun run precheck`（零错误）和 `bun run check:cycles`。
4. 按 [PR 模板](.github/pull_request_template.md)填写，**验证方式一栏要贴实际跑过的命令和结果** ——「应该没问题」不算验证。
5. pre-commit hook 会自动对暂存文件跑 `biome check --fix`；CI 会跑 `biome ci` + typecheck + 环数棘轮 + 全量测试 + 构建。

发现了问题但不在本次范围内？**记录，不要顺手改。** 在 PR 描述里列出来。夹带无关改动的 diff 会拖慢审查，也让回滚变得危险。

## 11. 发布流程

发版是一条命令加一次 push：

```bash
bun run release 2.10.0 --dry-run   # 先看它打算做什么
bun run release 2.10.0             # 改版本、跑门禁、提交、打 tag（不 push）
git push origin main --follow-tags # 这一步才真正发布
```

`scripts/release.ts` 会按顺序做：校验版本号 → 校验仓库状态（工作树干净、在 `main`、不落后于 `origin/main`、tag 未占用）→ 跑发布门禁 → 写文件 → `chore(release): v<version>` 提交 + annotated tag。本地领先于 origin 是正常的（那些提交会随 `--follow-tags` 一起 push），落后或分叉才是硬失败。**门禁跑在写盘之前**，所以门禁失败不会留下改了一半的工作树。脚本永远不 push：npm 上的版本发出去就撤不回来，最后那一下必须是人按的。

被这条链路更新的**所有**版本源：

| 源 | 谁写 | 作用 |
| --- | --- | --- |
| `package.json` 的 `version` | `bun run release` | 唯一构建真源，`scripts/defines.ts` 由它注入 `MACRO.VERSION`；也是 npm 发布的版本 |
| `CHANGELOG.md` | `bun run release` 插入草稿，**人工润色** | 同时喂给 GitHub Release 正文和应用内「更新说明」 |
| git tag `v<version>` | `bun run release` | `publish-npm.yml` 的**唯一**触发条件 |
| npm 包 | `publish-npm.yml` | `npm publish --provenance` |
| GitHub Release | `publish-npm.yml` | 正文优先取 `CHANGELOG.md` 对应小节，取不到才回退到 commit 列表 |
| 应用内「更新说明」 | 用户端从 `main` 拉 `CHANGELOG.md` | `src/utils/update/releaseNotes.ts`，所以发布提交必须在 main 上 |

几条不能绕的约束：

- **版本号只能递增。** `occ update` 用 semver 比较判断"有没有新版"，发一个不大于前一版的版本，等于让所有已安装的客户端**永久**认为自己已是最新——他们不会再收到任何后续更新，只能手工重装。脚本因此把"严格大于 `package.json` 当前版本"作为硬校验，并拒绝 `2.10`、`02.10.0`、`latest` 这类形状（`v2.10.0` 可以，会被规范化成 `2.10.0`）。同理，**不要把版本号退回 1.x**：叙事延续 2.8.x，首个对外发布是 v2.9.0。
- **CHANGELOG 条目是给用户看的。** 脚本生成的是 commit subject 草稿，不是发布说明 —— 它会明确提示你去润色。改完 `git commit --amend` 再 `git tag -f`，然后才 push。写法见下。

### CHANGELOG 写作规范

读者是用户，不是提交历史的考古者。每条只回答一个问题：**这次发布对我意味着什么。**

- **先说结果，再说原因。** 「首次启动现在需要先完成迁移」比「重构启动流程」有用得多。
- **说人话。** 不写内部符号名、文件路径、提交 hash。要提到代码位置时，说它对应的用户可见功能。
- **一条一件事，一到三句话。** 需要长篇解释的，写进 `docs/` 再从这里给一个链接。
- **不喊。** 通篇加粗等于没有重点。一条里最多一处强调，用来标出用户必须采取行动的部分。
- **破坏性变更必须显式说明用户要做什么。** 只写「BREAKING」不写补救步骤，等于把问题丢给用户。
- **别写「杂项修复」「若干改进」。** 说不出对用户的影响，就说明这条不该出现在 CHANGELOG 里。

**多语言**：`CHANGELOG.md` 是规范源，也是工具链唯一解析的那份（`parseChangelog` → 应用内「更新说明」、GitHub Release 正文）。`CHANGELOG.en.md` 与 `CHANGELOG.ja.md` 是它的译本，随发布一起更新，格式保持一致但**不参与**工具链。译本缺失不会阻塞发布，但补上之前不要发下一个版本 —— 语种一旦落后就再也追不回来。
- **格式由解析器约束。** `## <semver>` 或 `## <semver> - <日期>` 作版本标题，条目用顶层 `- `；嵌套列表会被 `parseChangelog` 拍平。写坏了不会报错，只是用户在应用内看不到条目。
- **发布门禁包含全量单测**（2026-08-07 起）。脚本跑 `typecheck` + `check:cycles` + `check:mock-hygiene` + `./scripts/test-shards.sh`，与 `publish-npm.yml` 同源，所以本地失败 = 工作流也会失败，而且是在打 tag 之前就失败。
  用的是**分片脚本而不是 `bun test`**：按目录分片是这套测试在 Linux 上能确定性通过的原因（见 [`CLAUDE.md`](CLAUDE.md) 发布一节与脚本头部注释）。`precheck` 仍用不分片的 `bun test`，那是给开发回路的快路径，不是门禁。

## 12. 文档放哪里

| 内容 | 位置 |
| --- | --- |
| 架构、模块地图、约定 | [`CLAUDE.md`](CLAUDE.md)（唯一真源） |
| 跨工具入口 | `AGENTS.md`（**只放指针**，不要往里抄内容） |
| 功能说明、集成指南 | `docs/zh/features/`、`docs/` 下按主题分目录 |
| 编号的功能规格与人工验收清单 | `spec/feature_<日期>_<编号>_<名字>/` |
| 设计文档、实施计划、评审记录 | `docs/zh/superpowers/{specs,plans,reviews}/` |

`spec/` 与 `docs/zh/superpowers/` 的分工：`spec/` 是**带编号、带人工验收清单**的正式功能规格（`spec-design.md` + `spec-plan-N.md` + `spec-human-verify.md` 一套）；`docs/zh/superpowers/` 是**按日期归档**的设计/计划/评审文档，更轻量、更连续。新功能要走人工验收就进 `spec/`，否则进 `docs/zh/superpowers/`。

**关于 `.claude/` 与 `.occ/` 双目录**：仓库里两个都有，这是有意的。`.claude/` 放**跨工具生态共享**的资产（skills、agents —— 官方 Claude Code 和其他 AI 工具也读这里），`.occ/` 放 **occ 独有**的运行时产物（workflow-runs 等）。判断标准：别的工具也该看到 → `.claude/`；只有 occ 认识 → `.occ/`。

## 12. 文档多语言（i18n）

`docs.json` 的 `navigation.languages` 声明三棵导航树：

| 语言 | 目录 | 状态 |
| --- | --- | --- |
| `en` | `docs/en/**` | 翻译中，**目标默认语言** |
| `zh` | `docs/zh/**` | 完整（当前默认） |
| `ja` | `docs/ja/**` | 翻译中 |

**不要手改 `docs.json` 的 navigation，也不要手写切换器**——两者都由 `bun run sync:docs-i18n` 从磁盘状态生成：

- **导航按语言裁剪到实际存在的页面。** Mintlify 对「声明了但文件不存在」的导航项不会跳过，而是发布成一个 404。翻译是一页一页落地的，所以未翻译的页面必须从该语言的树里剪掉，空掉的分组一并去掉。
- **切换器只链到该页面真实存在的语言。** 同理，链到不存在的翻译等于送用户去 404。只有中文版的页面，切换器就只有一个加粗的 `**中文**`。
- **默认语言必须 100% 覆盖。** 默认树是所有读者的落地页，有洞就等于把人送进 404。脚本自动选择第一个完整的语言作为默认——英文补齐到 65/65 时会自动接管，无需改配置。
- 页面集合与分组结构的真源是 `CANONICAL_LANG`（当前 `zh`），其余语言是它的子集。
- `docs/images/`、`docs/logo/`、`docs/diagrams/`、`docs/favicon.svg` 是**共享资源**，不进语言目录。
- 未进导航的内部设计文档 / 测试报告只保留中文，放 `docs/zh/` 下即可，不要加进 `docs.json`。

新增或删除翻译页面后跑 `bun run sync:docs-i18n`；`bun run check:docs-i18n` 校验断链、缺切换器、默认语言完整性，并报告覆盖率（`--strict` 额外要求三种语言都补齐）。
