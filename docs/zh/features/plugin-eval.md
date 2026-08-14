# 插件评测（`occ plugin eval`）

对一个插件跑一组 case，**每个 case 跑两遍**——一遍装着插件，一遍不装——报告两者的分差。

> 这条命令回答的是「装了这个插件，模型是不是做得更好了」。没有对照臂的评测只是个会调模型的测试跑器：它能告诉你 case 过了，但说不出插件跟这件事有没有关系。

**它是开发者手动调用的工具，不是 CI 步骤。** 每次调用都花真钱和真时间，所以成本/时长上限是**默认值而不是选项**，并且有 `--dry-run`。

## 30 秒上手

```bash
cd my-plugin                      # 插件根目录（有 .claude-plugin/plugin.json）
occ plugin eval init first-case   # 生成 evals/first-case/case.yaml
$EDITOR evals/first-case/case.yaml
occ plugin eval . --dry-run       # 会跑什么、要几次模型调用，不真跑
occ plugin eval .                 # 真跑
```

## case 格式

一个 case 就是 `evals/` 下的一个目录，里面一个 `case.yaml`。没有 sidecar 的 grader 目录：提示词和判它成败的断言放在同一屏里。

```
my-plugin/
  .claude-plugin/plugin.json
  evals/
    follows-house-schema/
      case.yaml
      files/            # 可选，每次运行前拷进 workspace 的种子文件
```

```yaml
name: follows-house-schema        # 可选，默认取目录名
description: 一句话说明这个 case 在探什么
tags: [changelog]

prompt: |                         # 与 prompt_file 二选一，必填其一
  给 CHANGELOG.md 加一条 2.0.0 的记录……

# files: files                    # 可选种子目录
runs: 1                           # 默认 1
max_turns: 12
# timeout_ms: 120000              # 覆盖 --timeout
# model: sonnet

allowed_tools: [Read, Glob, Grep, Write, Edit, Skill]

assert:                           # 确定性断言，零模型调用
  - type: file_matches
    path: CHANGELOG.md
    pattern: '<!--\s*clog-schema:\s*3\s*-->'
    weight: 2
  - type: skill_used
    skill: changelog

# judge:                          # 可选，每次运行每条臂多花一次模型调用
#   rubric: |
#     …什么样算好…
#   weight: 1
```

### 为什么确定性断言是一等公民

官方那套提供六种 grader，但 `init` 脚手架默认写 `type: llm`，于是阻力最小的路径是**花一次模型调用去问「文件写出来没有」**——比 `stat()` 又慢又不可信。

这里反过来：`assert:` 是主表面，完全不需要模型；`judge:` 是独立的可选块。一个没写 `judge:` 的 case **可证明地**花零判官 token，`--dry-run` 把两个数分开报，就是为了让这个区分一直可见。

只有正则真的看不见的东西（语气、结构、判断力）才值得上判官。

### 断言类型

| type | 判据 |
| --- | --- |
| `file_exists` / `file_absent` | workspace 里文件在不在 |
| `file_matches` | 文件内容匹配正则（`match: not_contains` 反向） |
| `output_matches` | 最终回答匹配正则 |
| `tool_used` | 转录里某工具被调用的次数（`input_matches` 再筛入参） |
| `skill_used` | 某个 skill 被调用过 |
| `command` | 在 workspace 里跑一条命令，比对退出码 / stdout |

每条可带 `weight`（默认 1）。运行得分 = 通过项权重和 ÷ 参与计分项权重和。

### `with-only`：不让对照臂制造假阳性

「插件的 skill 被调用了」这种断言**只可能在装了插件的那条臂上通过**。给它计分等于凭空造出一个正的 Δ——那个数字量的是同义反复，不是插件效果。

所以这类断言标 `arm: with-only`：在 with 臂正常执行并写进报告，但**两条臂都不计入分数**；在 without 臂直接跳过（不算失败）。`skill_used` 默认就是 `with-only`。

## 消融怎么跑

两条臂各起一个 `occ -p` 子进程，**只差一个 `--plugin-dir`**：

```
with:     occ -p <prompt> … --plugin-dir <插件根>
without:  occ -p <prompt> …
```

**为什么是子进程而不是进程内沙箱**：occ 的插件加载在进程内不可逆——loader 有记忆化、hook 全局注册、MCP server 已经拉起、skill 清单已缓存。「装上→跑→卸掉→再跑」量的是残留。换成每次一个新子进程，隔离就是结构性的而不是要靠维护的。顺带它也直接继承用户已经配好的 provider、认证和模型，不用再维护第二条凭据链路。

子进程固定带 `--permission-mode dontAsk`：不弹窗，且**没预先批准的一律拒绝**——于是 `--allowed-tools` 就是这个 case 能做的事情的完整清单。

### 已装同名插件会被拒绝

`mergePluginSources()` 允许 `--plugin-dir` 按名字覆盖已安装的插件。所以如果被测插件**同时也装着并启用**，without 臂仍然会加载那份已安装的副本，Δ 就悄悄从「有插件 vs 没插件」变成了「工作树 vs 已发布版本」。

这种情况直接报错并要求先 `occ plugin disable <id>`。报一个名不副实的数字比拒绝更糟。

### 工具授权分两级

case 文件是**数据**，而且通常是你刚 clone 下来的某个插件仓库里的。所以 case 能自行授予的只有只读工具加写文件（workspace 是本命令自己造的一次性目录）：

```
Read Glob Grep Write Edit NotebookEdit Skill TodoWrite Agent Task* LSP
```

`Bash`、`WebFetch`、`WebSearch` 和所有 MCP 工具**必须由操作者 `--allow-tools` 显式授予**。`command` 类断言会在宿主上跑 shell，另外由 `--allow-assert-commands` 单独把门。

## 成本、时长与 `--dry-run`

一个 suite 是 cases × runs × 2 条臂 个 agent 会话——五个 case 跑三遍就是三十个会话，算术很容易失手。所以：

| 闸 | 默认 | 说明 |
| --- | --- | --- |
| `--max-cost-usd` | `5` | 花到这个数就停，退出码 2 |
| `--max-duration` | `1800`（秒） | 跑到这个时长就停，退出码 2 |
| `--timeout` | `120000`（毫秒） | 单次运行墙钟，超时 SIGKILL |
| `--runs` | case 里的 `runs`，默认 1 | 覆盖 case 声明 |

两个闸都在**每次运行开始前**检查，并且每次运行还会拿到**剩余预算**作为它自己的 `--max-budget-usd`——所以单次会话不可能超出它被授予的总额。

> 第三方 provider 不一定回报 `total_cost_usd`。那种情况下成本闸会失效，**时长闸和 runs 上限才是真正兜底的东西**。

`--dry-run` 列出会跑哪些 case、几条臂、几次 agent 调用、几次判官调用，然后退出 0，**一次模型都不调**。

## 可重复性

同一份 case 跑两次应当可比。逐项处理：

- **workspace**：每次运行都从 `files/` 重新播种，两次重复的起点字节相同。
- **路径**：`<临时根>/<case>/<arm>/run-<n>`，确定性；只有临时根带时间戳，且它不进分数。
- **CLAUDE.md**：子进程带 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`——workspace 是临时目录，但 occ 会往上走去找 `CLAUDE.md`，不关掉的话操作者的家目录记忆会混进每次运行，并且随机器而变。
- **判官**：提示词是固定文本，只有 rubric / 任务 / 转录三处变量；判官回一个词（`VERDICT: PASS|FAIL`），不回分数——模型给 0–1 打分校准很差，多出来的精度只是噪声。解析不出来的一律算失败，绝不静默算通过。
- **采样**：occ 的 CLI 不暴露 temperature，**模型采样是剩下的主要不确定性来源**。这正是 `runs:` 和取均值存在的理由：要一个能信的数字就把 `runs` 调高，而不是指望单次运行。

### 沙箱不能放在配置目录里

运行沙箱建在系统临时目录，**不是** `occConfigPath()` 下。occ 会保护自己的配置根不被工具写入，所以放在 `~/.occ/plugin-eval/...` 的 workspace 每一次 `Write` 都会被拒——而且拒绝信息是笼统的「don't ask mode」，读起来像权限配错了而不是沙箱位置错了。报告仍然写在配置目录下：那是父进程用 `fs` 写的，不走工具。

## 输出

- **终端表格**：总是打印。列是 `CASE | WITH | W/OUT | Δ | RUNS | COST | NOTES`，NOTES 是第一个失败的 grader。
- `--json [path]`：完整结果。不带路径时写 stdout，此时人类报告改走 stderr，stdout 保持可解析。
- `--report [path]`：markdown 报告，含每条臂每次运行的逐 grader 明细。不带路径时落在配置目录下。
- `--publish`：把报告交给 artifact 后端（默认本地后端，返回 `file://`）。只调公开入口，本命令不掺和报告页长什么样。
- `--keep-temp`：保留每次运行的 workspace 和 `trace.jsonl`。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部 case 达到 `--threshold`（默认 1） |
| 1 | 有 case 未达阈值，或有 case 文件加载失败，或（带 `--fail-on-regression` 时）出现回归 |
| 2 | 提前停止（成本 / 时长 / 中断）——**partial 的 0 分不能读成成功**，所以单列一个码 |

## 与官方实现的差异

| | 官方 | occ |
| --- | --- | --- |
| grader 声明 | `graders/<name>.md`，各带 frontmatter | 单个 `case.yaml` 里的 `assert:` 列表 |
| 脚手架默认 | `type: llm` | 确定性断言，`judge:` 注释掉 |
| 判官票数 | 3 票多数决 | 1 票；方差交给 `runs` |
| 成本上限 | 可选 | 必有默认值（5 美元） |
| 时长上限 | 无 | 必有默认值（30 分钟） |
| `--dry-run` | 无 | 有，分开报 agent / judge 调用数 |
| 报告 | 内建 ~130 行 CSS 的 HTML | markdown，交给 artifact 后端 |
| `command` 类断言 | 无（只有 setup 用的 `scaffold_script`） | 有，`--allow-assert-commands` 把门 |

保留的官方设计：`--plugin-dir` 单点差异的消融、with-only grader 不计分、成本闸退出码 2、case 目录约定。
