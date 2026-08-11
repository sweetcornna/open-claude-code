# `/provider-settings` —— 多 provider 新增、切换与聚合

一台机器上可以同时配置多个 provider（Anthropic 直连、OpenAI 兼容端点、Gemini、Grok、OpenCode Zen / Go），随时切换，还能把其中几个**聚合**成一份模型列表，在 `/model` 里一起挑。

底层沿用既有的 provider profile 存储（`src/services/providerProfiles/`），不是新造一套。

## 〇、一条命令，四个名字

`/provider`（别名 `/api`）与 `/provider-settings`（别名 `/providers`）在 2026-08-11 合并成**一条**命令。合并前者是后者的薄壳：`save|use|list|delete|models|refresh|aggregate` 直接转调同一份实现，只有「provider 家族切换」是它自己的。`/help` 里两行读起来像重复项，因为它们确实是。

**四个名字全部保留为别名，所有旧写法照旧工作**：`/provider save x`、`/provider use x`、`/provider list`、`/api openai`、`/providers`。

家族切换也保留，作为裸参数：

```
/provider-settings openai        选家族（不动凭据）
/provider-settings unset         回落到环境变量
/provider-settings use openai    激活名为 openai 的档案
```

**裸家族名和 `use <名>` 是两件事**，靠位置区分 —— 档案真的可以叫 `openai`。家族切换只改 `settings.modelType`，档案切换是整形状 env 替换。

`-p` 下也照旧：`/provider` 原本是 headless 可用的 `local` 命令，合并后的 `local-jsx` 命令显式声明了 `supportsNonInteractive`，无参调用在无法渲染的环境里回答**列表文本**而不是面板。

## 〇bis、新增 provider 会切换会话（这是刻意的）

面板里按 `A` 新增一个 provider：选家族 → （若当前配置尚未存档）问要不要先存档 → 起名 → 问要不要加入聚合 → 跑**既有的**登录向导（`ProviderSetupWizard`，不是第二套表单）→ 回到面板，新行已在。

**向导保存的那一刻就是激活**：它写的是 settings.env 整形状，并同步到 `process.env`。所以新增结束后，会话就在新 provider 上。这在第一屏就写明。

为什么不「保存完再恢复原状」：

- 唯一诚实的恢复手段是 `activateProfile()`，而它需要一个档案。`file.active` 不是 —— 那个指针只由档案切换写入，之后一次 `/login` 或手改 settings.env 都会让它指向一个会话早已不在用的配置。拿它去「恢复」等于静默切到第三个配置，比诚实地切到用户刚配好的那个更糟。
- 从来没经过档案的会话（纯 OAuth、导出的 env、手写的 settings.env）根本没有可恢复的东西 —— 而那恰恰是第一次按 `A` 的常见情形。只在部分情况下生效的回滚，就是这里要避免的「半恢复」。

所以做法是把**回程**变成真的：当前配置若匹配不到任何档案，流程会先问一句要不要把它存成档案（就是 `save <名>`）。之后回去只是在某一行按 `Enter` —— 一个既有的、已经能用的机制。

判据是纯函数 `sessionProfileMatch()`：某个档案的**每一个**受管键都与当前合并 env 相等（即激活它不会改变**凭据面**上的任何东西）。多出一个键就不算，因为激活真的会删掉它。判据**只比 env**，不比档位设置 —— 后者加进去会让所有本次改动之前存的档案统统匹配不上，把一句「要不要先存档」变成每次按 `A` 都出现的噪音。

档案同时会带上 `settings.modelSettings`（见 §〇ter），所以切回去恢复的是当时那套配置，而不只是端点和凭据。

## 〇ter、档案存什么：env **加上**各档位的 effort / 上下文

档案快照的是「我在跟哪个 provider 说话、怎么说」：`modelType` + 该家族的受管 env 键 + `settings.modelSettings`（各档位的 thinking effort 与最大上下文）。

**为什么后者必须跟着走**：这些值是**按 provider 形状**来的。`tierPersistence.ts` 按每个档位背后的模型家族播种默认值 —— DeepSeek 一行是 `max` / 1M，GPT 是 `xhigh` / 272k，Claude opus·fable 是 `xhigh` / 1M。只恢复端点和凭据、把上一家的那行留在原地，等于拿 DeepSeek 的数字去跑 GPT 的模型。这正是 2.38.0 给 `/logout` 修过的同一个缺陷（见 `resetProviderConfig.ts` 的注释），现在补上 `/provider use` 这一半。

### 激活是整形状写入（和 env 一样）

`updateSettingsForSource` 是**深合并**，所以只写「本档案配了的槽位」不够 —— 没写到的槽位、乃至同一槽位里没写到的那个轴，都会留着上一家的值。`buildActivationModelSettingsPatch()` 因此点名**全部五个槽位**（`default` + 四档），恢复的槽位里两个轴也都点名，`undefined` 在那次合并里就是删除。

### 本次改动之前存的档案：清空，不是沿用

这是个明确的取舍，两个答案都有代价：

- **沿用**（原行为）就是那个 bug —— 留下的值是从**上一个** provider 的模型家族播种的。
- **清空**意味着老档案激活后各档位回落到 `getTierDefaults()`，而那正是按这个档案刚刚恢复的那些模型算出来的家族默认值。`/logout` 出于同样理由也是这么做的。

决定性的理由是第三条：清空让激活的结果**只取决于档案本身**。如果结果还要看「这个档案是什么时候存的」，那界面上没有任何地方能告诉用户答案 —— 那比正在修的这条粗糙边更糟。对老档案跑一次 `/provider-settings save <同名>` 就会把当前值记进去，它从此不再是老档案。

### 扁平的 `effortLevel` 不跟着走，而是被删掉

`settings.effortLevel` 是 `modelSettings` 之前的全局单值，它会 seed AppState，而 AppState **压过**分层设置（`resolveAppliedEffort`）。所以档案要是也带着它，恢复出来的分层值会被它自己盖住 —— 看起来就像什么都没修。occ 里其他写入路径（`writeTierSettings`、向导的 `clearFlatEffort`、`resetProviderConfiguration`）本来就见一次删一次，激活跟着删。会话内的另一半（`AppState.effortValue`）由切换入口清掉：`/provider-settings` 面板的 `onProviderSwitched` 与 `/model` 里选中聚合模型的那条分支。

### env 覆盖仍在最上面

`CLAUDE_CODE_EFFORT_LEVEL` 与 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 按设计排在分层设置之上（见 `tierSettings.ts` 头部），**恢复档案不改这个顺序**：

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 是每个家族的受管键，照旧随 settings.env 整形状清除再恢复；
- `CLAUDE_CODE_EFFORT_LEVEL` 不受管 —— occ 自己从不写它，所以环境里有值就是用户自己设的，激活不碰。

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

## 二bis、聚合列表不会和当前 provider 叠加

`/model` 里聚合行接在当前 provider 自己的行后面。如果不去重，正在用的那家的模型会出现两次 —— 这正是曾经的实际表现，两个原因各自独立：

1. **归属判据依赖 `file.active`**。那个指针只由 `activateProfile()` 写入，所以经 `/login` 配好 provider 再把档案加入聚合的用户根本没有指针，整个去重条件被跳过。现在改问**配置本身**：`sessionOwnedProfiles()` 认为「家族与 `settings.modelType` 相同、且各 `*_BASE_URL` 与当前一致」的档案就是当前 provider（**只比端点不比 key** —— 同一端点两把 key 是同一个 provider）。`file.active` 仍然叠加生效，老行为不变。
2. **「已提供的模型」比的是 option value**。当前 provider 的行 value 是**档位别名**（`opus`、`sonnet[1m]`），而聚合行带的是**具体 id**，两边根本不是同一种东西，于是对档位行这个条件几乎永远为假。现在两边都比**解析后的具体 id**（`offeredModelIds()` 逐行过 `resolveOptionModel`）。解析会碰模型 provider 链，Gemini 未配置时会抛，`__NO_PREFERENCE__` 还会走订阅链 —— 所以逐行 try/catch：解析不出来的那一行不参与去重，绝不能拖垮整个列表。

**两个条件仍然是「与」**：只有「来自当前 provider」**且**「这个 id 已经在列表里」才丢弃。别家 provider 服务同一个 id 照样列出并标注归属 —— 换个账号/中转跑同一个模型是正当需求，那正是 `ambiguous` 与 `id (profile)` 的意义。

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

面板：`/provider-settings`（别名 `/providers`、`/provider`、`/api`）。

| 键 | 作用 |
|---|---|
| `↑`/`↓` | 移动 |
| `Enter` | 切换到该 provider |
| `Space` | 加入/移出聚合 |
| `A` | **新增 provider**（跑登录向导 → 存成档案 → 会话切过去） |
| `E` | **重命名**该档案 |
| `R` | 刷新该 profile 的模型列表 |
| `D` `D` | 删除（按两次） |
| `Esc` | 关闭；有刷新在跑时先取消刷新；子流程里先回到列表 |

`A` 不需要选中行 —— 空注册表按 `A` 正是它存在的理由。子流程（新增、重命名）占屏时，面板自己的单键快捷键整体关闭，否则输入框里打字会被它吃掉。

非交互式：`list` / `models` / `overview` / `use <名>` / `save <名> [备注]` / `add [名]` / `rename <旧> <新>` / `aggregate <名> on|off` / `refresh <名>` / `delete <名>` / `help`，外加裸家族名与 `unset`（见 §〇）。动词大小写不敏感，**profile 名大小写敏感**。

- `overview`（别名 `summary`）：聚合列表的整体视图 —— 共多少个模型、分别来自哪几个档案、哪些 id 重名。面板顶部也显示同一份内容（截断到 6 个贡献者 / 3 个重名 id），**同一个函数**，两边不可能算出不同的数。计数取自**聚合后**的结果而不是快照长度：某个档案重复列了同一个 id 时，「快照 2 个模型」和「选择器里 1 行」都是对的，而需要解释的是后者。
- `add`：没有可脚本化的版本，也**不会**有 —— 它收集的是凭据，作为命令参数传就会进 shell 历史。所以 `add` 只回答「怎么做」（面板按 `A`，或者当前会话已经连着目标 provider 时用 `save <名>`），并顺手校验一下名字是否可用。
- `rename <旧> <新>`：注册表**键**才是身份（`activateProfile()` 解析的、每个聚合选择符携带的都是它），所以重命名是一次键迁移，记录里的 `name` 字段同步移动。目标名已存在时拒绝 —— 覆盖会丢掉对方的端点和 key，而注册表是唯一的一份。重命名激活中的档案只移动 `file.active` 指针：会话的实际配置在 settings.env 里，从来不带名字，**不需要也不会**重新激活。

## 六、凭据永不显示

面板只打印端点、是否存有 key（`key saved` / `no key (OAuth or env)`）、模型数量和备注。**不显示 key 值，也不显示 key 的环境变量名**。有测试断言列表输出、聚合总览、新增流程的菜单文案与重命名的错误信息里，既不含 `sk-` 也不含 `OPENAI_API_KEY`。

**一处刻意的例外**：家族切换在目标家族还没配好时会打印缺哪个变量（`Warning: Missing env vars: OPENAI_API_KEY, OPENAI_BASE_URL`）。那是「你还**没**设的变量」，是一条操作指引；上面禁止的是「某个档案**已经存了**哪个 key」，那是秘密。两者不是同一件事。

`refresh` 对没有保存 key 的 profile 会直接返回说明而不发网络请求 —— 那正是 OpenCode 的 OAuth 情况，它的 token 是**故意**不放进 profile 的（见 [opencode.md](./opencode.md)）。

## 七、一个已知的粗糙边

保存 profile 时快照的是「当前 provider 家族的 env 键」。判定家族要问**身份**谓词而不是 `getAPIProvider()` —— 后者答的是协议。这条在接入 OpenCode 时踩过：按协议判定会把 Zen 会话认成 anthropic 家族，从而把镜像写入的活 access token 快照进 `provider-profiles.json`。修复与回归测试见 `activate.test.ts` 的 `describe('saving an OpenCode session')`。
