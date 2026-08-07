# 分层模型设置（`/model-settings`）

按模型档位（haiku / sonnet / opus / fable）分别配置**思考强度**与**上下文窗口**。

在此之前这两轴都是全局单值：一个扁平的 `settings.effortLevel`，和一个 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。前者说不出「opus 多想一点、haiku 省着点」，后者更是 `utils/session/context.ts` 里明写的「the single knob」。而合理的默认值其实取决于别名背后是哪家 provider——DeepSeek 的三档 effort 梯子和 Anthropic 的五档不是一回事，GPT 的窗口也不是 200k。

## 出厂默认

**升级即生效，不需要任何配置。**

| provider 家族 | effort | 上下文 |
| --- | --- | --- |
| DeepSeek | `max` | 1M |
| GPT | `xhigh` | 272k |
| Claude opus / fable | `high` | 1M |
| Claude sonnet / haiku | `high` | 200k |
| 其他（GLM / Qwen / Kimi / 本地 vLLM …） | `xhigh` | 200k |

Claude 的 sonnet 和 haiku **只降窗口、不降 effort**。那条例外针对的是能力（这两档没有 1M 档位），不是偏好（该想多少还想多少）。

两道硬约束由调用方施加，不在默认表里：

- effort **只在 `modelSupportsEffort(model)` 为真时才发**。探测不到支持就不发这个字段，避免第三方端点直接 400。
- 1M **只在 `modelSupports1M(model)` 为真时才生效**，而且对 Anthropic 系还要求模型 id 带 `[1m]` 后缀。后缀是 beta 头 `context-1m-2025-08-07` 的唯一来源；只把本地记账改成 1M 而不发头，结果是 API 在 200k 就拒，而 auto-compact 以为还有 800k 余量从不触发——一次本该压缩的对话直接变成 prompt too long。`apply1mContextOptIn` 会在「配置要 1M 且模型支持」时补上后缀。

## 优先级

```
环境变量  >  分层配置  >  内置默认
```

env 留在最上面是有意的：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 被定义为「探测不到真实窗口时的最终纠正手段」，脚本、容器和 CI 靠它给单次运行临时覆盖。把它降级会静默破坏这些场景。

`CLAUDE_CODE_EFFORT_LEVEL` 同理，会话内的 `/effort` 也仍然压过分层配置。

**档位映射本身以用户手配的为准**，对所有 provider 一致：`OPENAI_DEFAULT_<TIER>_MODEL` / `ANTHROPIC_DEFAULT_<TIER>_MODEL` 等显式配置压过任何内置映射，包括 DeepSeek Anthropic 线自带的 `claude-opus*` → v4-pro / `claude-sonnet*`·`claude-haiku*` → v4-flash。

## 用法

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
