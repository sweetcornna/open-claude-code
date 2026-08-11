# `/provider-settings` —— 多 provider 配置、切换与聚合

一台机器上可以同时配置多个 provider（Anthropic 直连、OpenAI 兼容端点、Gemini、Grok、OpenCode Zen / Go），随时切换，还能把其中几个**聚合**成一份模型列表，在 `/model` 里一起挑。

底层沿用既有的 provider profile 存储（`src/services/providerProfiles/`），不是新造一套。`/provider save|use|list|delete` 全部保留并共用同一份实现。

## 一、聚合是「列表」的聚合，不是「连接」的聚合

这一点决定了它能做什么、不能做什么：**选中一个聚合模型 = 把整个会话切到它所属的 provider**。

所以：

- ✅ 一个选择器里看到所有 provider 的模型，重名的标出归属
- ✅ 选中即切换，凭据、端点、客户端缓存整形替换（走 `activateProfile()`）
- ❌ 同一时刻**不能**让 `haiku` 走 A 家而 `opus` 走 B 家 —— 四个档位别名属于当前激活的那个 profile
- ❌ 子 agent 不能跑在与主循环不同的 provider 上

要突破后两条需要**按请求路由**（把 `getAPIProvider()` 从会话级改成模型级），那是独立的一期工程。

## 二、聚合是显式 opt-in

只有 `profile.aggregate === true` 的档案参与。刚保存的档案默认不参与，全新注册表聚合结果就是空列表。

理由：profile 首先是一份**凭据快照**，「曾经拉取过模型列表」不等于同意把这些模型塞进其他 provider 的选择器。

用 `/provider-settings aggregate <名字> on` 或面板里 `Space` 加入。方向必须写明（`on`/`off`），不猜。

## 三、重名怎么办

两个 provider 服务同一个模型 id 是常态（官方端点和中转都答 `gpt-5.4`）。此时 id 本身**不构成一个选择** —— 它没说该用哪把 key。

- 唯一的 id → 选择符就是 id 本身
- 重名的 id → 选择符是 `id@profile`，界面显示成 `gpt-5.4 (relay)`

### `@` 要转义

Vertex 风格的 id 真的含 `@`（`text-bison@002`），而 profile 名真的可以长得像版本后缀（`002` 能通过 `isValidProfileName`）。所以 **id 内部的 `@` 一律加倍**：

| id | profile | 选择符 |
|---|---|---|
| `gpt-5.4` | 唯一 | `gpt-5.4` |
| `gpt-5.4` | `relay`（重名） | `gpt-5.4@relay` |
| `text-bison@002` | 唯一 | `text-bison@@002` |
| `text-bison@002` | `vertex`（重名） | `text-bison@@002@vertex` |

profile 名不可能含 `@`，所以「第一个未成对的 `@` 就是分隔符」这个不变式成立，`parseModelSelector` 不需要查注册表就能反解。

**永远用 `selector` 字段或 `formatModelSelector()`，不要手工拼 `id + '@' + profile`。**

## 四、档位别名陷阱

`/model` 里聚合行的 option value 带 `occ-profile://` 前缀 —— 任何 `/models` 端点都造不出这种字符串。

这不是洁癖。`settingsSlotForOption()` 会把 option value 映射到档位设置槽，而档位行的 value 本来就是别名（`opus`、`sonnet[1m]`）。如果一个中转服务恰好提供一个**字面叫 `opus`** 的模型，不加前缀的话它会被解析成 Anthropic 的 Opus checkpoint，并且抢走 opus 档位的 effort / 最大上下文设置。

加了前缀后，聚合行的 id 原样返回，槽位改走 `getModelTier(id)` 反查。`modelPickerOptions.test.ts` 钉住了这个场景。

## 五、命令表面

面板：`/provider-settings`（别名 `/providers`）。

| 键 | 作用 |
|---|---|
| `↑`/`↓` | 移动 |
| `Enter` | 切换到该 provider |
| `Space` | 加入/移出聚合 |
| `R` | 刷新该 profile 的模型列表 |
| `D` `D` | 删除（按两次） |
| `Esc` | 关闭；有刷新在跑时先取消刷新 |

非交互式：`list` / `models` / `use <名>` / `save <名> [备注]` / `aggregate <名> on|off` / `refresh <名>` / `delete <名>` / `help`。动词大小写不敏感，**profile 名大小写敏感**。

## 六、凭据永不显示

面板只打印端点、是否存有 key（`key saved` / `no key (OAuth or env)`）、模型数量和备注。**不显示 key 值，也不显示 key 的环境变量名**。有测试断言列表输出里既不含 `sk-` 也不含 `OPENAI_API_KEY`。

`refresh` 对没有保存 key 的 profile 会直接返回说明而不发网络请求 —— 那正是 OpenCode 的 OAuth 情况，它的 token 是**故意**不放进 profile 的（见 [opencode.md](./opencode.md)）。

## 七、一个已知的粗糙边

保存 profile 时快照的是「当前 provider 家族的 env 键」。判定家族要问**身份**谓词而不是 `getAPIProvider()` —— 后者答的是协议。这条在接入 OpenCode 时踩过：按协议判定会把 Zen 会话认成 anthropic 家族，从而把镜像写入的活 access token 快照进 `provider-profiles.json`。修复与回归测试见 `activate.test.ts` 的 `describe('saving an OpenCode session')`。
