# 分层模型设置（`/model-settings`）

按模型档位（haiku / sonnet / opus / fable）分别配置**思考强度**与**上下文窗口**。

在此之前这两轴都是全局单值：一个扁平的 `settings.effortLevel`，和一个 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。前者说不出「opus 多想一点、haiku 省着点」，后者更是 `utils/session/context.ts` 里明写的「the single knob」。而合理的默认值其实取决于别名背后是哪家 provider——DeepSeek 的三档 effort 梯子和 Anthropic 的五档不是一回事，GPT 的窗口也不是 200k。

## 出厂默认

**升级即生效，不需要任何配置。**

| provider 家族 | effort | 上下文 |
| --- | --- | --- |
| DeepSeek | `max` | 1M |
| GPT | `xhigh` | 272k |
| Claude opus / fable | `xhigh` | 1M |
| Claude sonnet / haiku | `xhigh` | 200k |
| Gemini / Grok | `high` | 200k |
| 其他（GLM / Qwen / Kimi / 本地 vLLM …） | `xhigh` | 200k |

Claude 的 sonnet 和 haiku **只降窗口、不降 effort**。那条例外针对的是能力（这两档没有 1M 档位），不是偏好（该想多少还想多少）。

Gemini 和 Grok 取 `high`，因为它们是唯二**没有五档词汇**、要靠 occ 映射到别的参数上的家族（分别是思考预算和两档梯子）。`high` 被这两个映射定义为**恒等档**——发出去的东西和 occ 开始介入之前完全一样——所以打开映射不会悄悄把存量会话重新调过一遍。见「effort 怎么落到各家协议上」。

两道硬约束由调用方施加，不在默认表里：

- effort **只在 `modelSupportsEffort(model)` 为真时才发**。探测不到支持就不发这个字段，避免第三方端点直接 400。
- 1M 对 **Anthropic 系**要求模型 id 带 `[1m]` 后缀。后缀是 beta 头 `context-1m-2025-08-07` 的唯一来源；只把本地记账改成 1M 而不发头，结果是 API 在 200k 就拒，而 auto-compact 以为还有 800k 余量从不触发——一次本该压缩的对话直接变成 prompt too long。`apply1mContextOptIn` 会在「配置要 1M 且模型支持」时补上后缀。

  **这道闸门是关于 Anthropic 模型的事实，不是关于数字的**，所以对别家不成立：第三方 id 没有 beta 头可漏，而指着那个端点的用户比一张从没听说过该 checkpoint 的能力表更清楚它的窗口。此前对所有模型一律 clamp，等于让「给这个档位设最大上下文」在**每一家 1M 模型不叫 Claude 的 provider 上都静默失效**。判定见 `supportsContextWindow()`，`/model` 的窗口梯子也用它筛选可选项。

## 优先级

```
环境变量  >  分层配置  >  内置默认
```

env 留在最上面是有意的：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 被定义为「探测不到真实窗口时的最终纠正手段」，脚本、容器和 CI 靠它给单次运行临时覆盖。把它降级会静默破坏这些场景。

`CLAUDE_CODE_EFFORT_LEVEL` 同理，会话内的 `/effort` 也仍然压过分层配置。

**档位映射本身以用户手配的为准**，对所有 provider 一致：`OPENAI_DEFAULT_<TIER>_MODEL` / `ANTHROPIC_DEFAULT_<TIER>_MODEL` 等显式配置压过任何内置映射，包括 DeepSeek Anthropic 线自带的 `claude-opus*` → v4-pro / `claude-sonnet*`·`claude-haiku*` → v4-flash。

## effort 怎么落到各家协议上

occ 的五档（`low`/`medium`/`high`/`xhigh`/`max`）只有 Anthropic 一家原生认。其余每家都要映射，且**映射表是各自 provider 目录下的唯一权威**：

| provider | 字段 | 映射 |
| --- | --- | --- |
| Anthropic（含 Bedrock / Vertex / Foundry） | `output_config.effort` | 原样发；五档就是它的词汇 |
| DeepSeek（**两条线都是**） | chat 线 `reasoning_effort` / Anthropic 线 `output_config.effort` | 折成三档：low→low，medium·high→high，xhigh·max→max，未设→max |
| OpenAI responses | `reasoning.effort` | 原样发（该线认 xhigh/max） |
| OpenAI chat | `reasoning_effort` | xhigh·max 夹到 high；只对 reasoning 模型发 |
| Gemini | `generationConfig.thinkingConfig.thinkingBudget` | 按倍率缩放：0.25 / 0.5 / **1（恒等）** / 1.5 / 2，下限 128 token |
| Grok | `reasoning_effort` | 折成两档：low→low，其余→high；**只对 `grok-3-mini` 系发** |

三个容易踩的点：

- **DeepSeek 的 Anthropic 线也要折。** 实测（2026-08-07）该端点对五个值全部返回 200、不报错、也测不出差异 —— 这是坏消息不是好消息：它没定义的档位会静默回落到自己的默认，而状态栏还在显示用户选的那一档。折叠让 `/effort` 在 DeepSeek 两条线上含义一致。
- **Gemini 没有 effort 词汇**，唯一的旋钮就是思考预算，所以是缩放而不是加字段 —— 请求形状不变，不可能把本来能用的端点打成 400。`high` 是恒等档且是该家族的出厂默认，所以用户没动过 `/effort` 的会话发出去的字节和以前一模一样。
- **Grok-4 系拒收 `reasoning_effort`**，所以那几个模型 `modelSupportsEffort()` 返回 false、界面上根本不给选。这不是漏做，是那个参数在那个模型上不存在。

`modelSupportsEffort()` 是显示与发送的**同一个**判据。两者分叉过一次（DeepSeek `deepseek-chat` 判为不支持而 chat 线照发 `max`），结果是界面装作没有这个旋钮、请求却一直被它操纵。改任何一边都要同时改另一边。

## 档位从模型 id 反查

分层配置以**档位**为键，而请求里流动的是**解析后的模型 id**。对 Claude 系这不是问题（id 自带 `opus`/`sonnet` 字样），但第三方 id 一个字都不带 —— `deepseek-v4-pro`、`glm-5.2`、`gpt-5.6-sol` 全都查不出档位。此前的后果是：`getModelTier` 返回 `undefined` → `getTierOverride` 返回 `undefined` → **写进 `modelSettings` 的每个值都被静默忽略**，而那恰恰是本特性存在的全部理由。

补上的那一环是用户自己配的档位映射：`OPENAI_DEFAULT_OPUS_MODEL=deepseek-v4-pro` 本来就说明了「opus 别名解析到这个 id」，反着读一遍即可。四个前缀（`ANTHROPIC` / `OPENAI` / `GEMINI` / `GROK`）都扫，大小写与 `[1m]` 后缀都归一化。

**反查可能是多对一**：把四个别名全指向同一个 checkpoint 是常见的 DeepSeek 配置，此时请求里没有任何东西能区分它们。规则是「先取已配置的那个档位，再取能力最高的（fable > opus > sonnet > haiku）」，`/model-settings` 会把这种情况显式打印出来 —— 因为同一个 id 上给两个档位配不同的值，本来就不可能都生效。

## 用法

两个入口，写的是同一份 `settings.modelSettings`：

**`/model` 选择器**（推荐）—— 高亮某一行时，`←/→` 调该档位的 effort，`Space` 循环该档位的最大上下文（默认 → 128k → 200k → 272k → 512k → 1M → 回到默认）。面板会写明当前这对旋钮属于哪个档位，并在 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_EFFORT_LEVEL` 正在压制它时给出提示。

`Space` 以前是「1M context 开/关」二元开关。它现在是同一件事的完整梯子：`[1m]` 后缀由所选窗口推导（≥1M 且模型支持时才加），不再是一个独立开关。旧的 `modelPicker:toggle1M` 键位 id 仍然可用，绑到同一个动作。

选择器里对**任何**档位做的调整都会保存，不只是最后按 Enter 的那一行 —— 一路翻过去把每档调好再回车确认是这个界面的自然用法，只留最后一行等于把其余的活白干。

**首启向导 / `/login` Step 2** 也写这里：`Max context tokens` 与新增的 `Thinking effort` 两个字段落进 `modelSettings`，而不是从前的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（那个键在本层**之上**，写在登录里等于让开场值静默压过用户此后每一次调整；保存时会删掉旧版留下的它）。留空 = 写入各档位自己的家族默认值，于是登录结束后就是四个已配置档位而非四行 `(defaults)`。**重跑向导时留空则什么都不动** —— 不会把你分档调好的值压平。

**`/model-settings` 命令**：

```bash
/model-settings                      # 打印四个档位当前生效的值
/model-settings show                 # 同上
/model-settings opus effort max      # 设一个档位的 effort
/model-settings haiku context 128k   # 设窗口，接受 200000 / 272k / 1m
/model-settings opus reset           # 清掉该档位的覆盖，回到默认
```

落盘在 `settings.json` 的 `modelSettings`：

```json
{
  "modelSettings": {
    "opus": { "effort": "max", "contextTokens": 1000000 },
    "haiku": { "contextTokens": 128000 }
  }
}
```

两轴可以只设一个，另一个继续走默认。

## 与旧的 `effortLevel` 的关系

`settings.effortLevel` 是本特性之前唯一的 effort 键，它在启动时播种 AppState，而 **AppState 的优先级高于分层配置**。两者并存会产生最糟的结果：用户在 `/model-settings` 里设了值，却发现毫无变化。

所以 `/model-settings <tier> effort <level>` 在写入时会**顺带清掉全局 `effortLevel`**，命令输出里会明确告诉你这一点。这是一次性的单向迁移；此后 effort 就由分层配置和 `/effort`（会话内）共同决定。

`effortLevel` 的枚举对非 ant 用户不含 `max`；**`modelSettings` 的 effort 枚举五档齐全**，因为 DeepSeek 的出厂默认就是 `max`，所有用户都必须能看到、保留和选择它。这是与旧键的有意分歧。

## 实现要点（改代码前先读）

- `modelTier.ts` 与 `tierDefaults.ts` **零依赖**。`getContextWindowForModel` 和 `getDefaultEffortForModel` 都会调用它们，而两者都从 `providers.ts` 可达——带依赖就会闭环。这与 `deepseekHost.ts` 存在的理由完全相同。
- `getModelTier` 的正则此前在 `packages/@ant/model-provider/src/providers/{openai,gemini,grok}/modelMapping.ts` 里**各存了一份且都是模块私有**，现在收敛到一处。
- 在 `getContextWindowForModel` 里，**显式覆盖**排在所有探测分支之上，**家族默认**排在最底、替换原来那个扁平的 200k。这个区分是必须的：家族默认对每个模型都返回值，放在上面会把 China preset 窗口、ChatGPT 窗口和 `/v1/models` 能力查询全部短路。
