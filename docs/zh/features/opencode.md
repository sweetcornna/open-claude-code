# OpenCode 接入（Zen 网关 · Go 订阅 · Console 登录）

occ 可以直接接 [OpenCode](https://opencode.ai) 的订阅和网关。**一个账号后面卖的是两个产品**，它们不是同一个端点：Zen 是按量计费的聚合网关（61 个模型，横跨 Anthropic、OpenAI、Google、DeepSeek、xAI、Kimi、Qwen、MiniMax、GLM 等家，外加 9 个免费档）；Go 是包月订阅（25 个开源系编码模型，**一个 Claude 都没有**）。

本文是配置与判定的真源。实现散在 `src/services/auth/opencode/`（认证与目录）、`src/components/opencodeLogin/opencodeCatalog.ts`（两张产品表）和 `src/utils/model/opencodeWire.ts`（协议线路由）。

## 〇、三个平面，别混

OpenCode 有一个账号面和**两个**推理面，职责完全不同，混淆它们是这里最容易犯的错：

| 平面 | 主机 / base URL | 管什么 | 计费 |
|---|---|---|---|
| **账号面** | `console.opencode.ai` | 设备码 OAuth；`/api/config` 给出该组织**有权使用**的 provider/模型表 | — |
| **推理面 · Zen** | `https://opencode.ai/zen/v1` | 61 个模型（含 Claude），三条协议线 | 按量，扣 credit 余额 |
| **推理面 · Go** | `https://opencode.ai/zen/go/v1` | 25 个开源系编码模型，无 Claude | 包月订阅（首月 $5，其后 $10/月） |

账号面回答「你是谁、你能用什么」，推理面回答「话发到哪」。`/api/config` 的答案**永远不靠推断**，只从账号面取。

**Zen 和 Go 只差一个路径段，主机相同 —— 这是本文最贵的一条。** 拿 Go 订阅的 key 去打 Zen 的 base URL，请求会记到 **Zen 的 credit 余额**上并失败：

```
POST /zen/v1/chat/completions   （Go 订阅者的 key）
→ {"type":"error","error":{"type":"CreditsError",
     "message":"Insufficient balance…"}}
```

这条错误既不提产品也不提 URL，用户完全无从反推。所以凡是「这是哪个 OpenCode 端点」的判定，**必须比 path，不能只比 host** —— `usesOfficialEndpoint()` 那种只比 host 的写法对两个产品都答「是官方端点」。真源是 `opencodeProductForBaseUrl()`。

Go 的订阅性质在响应体里也能看到：`/zen/go/v1/chat/completions` 实测返回的 completion 带 `"cost":"0"`（用 `kimi-k3` 验的），也就是不走计量。

## 一、三条协议线

两个产品在各自的 base URL 下都提供多条协议线（均已对真实端点实测，无凭据时返回 401 而不是 404）：

| 路径 | 协议 | occ 走它的模型 |
|---|---|---|
| `/messages` | Anthropic Messages | `claude-*` |
| `/responses` | OpenAI Responses | `gpt-*`、o 系 |
| `/chat/completions` | OpenAI Chat Completions | 其余全部（gemini / deepseek / glm / kimi / qwen / minimax / grok / 免费档） |

`claude-*` 走 Anthropic 线不是风格选择：Zen 代理的是**真的** Anthropic checkpoint，走这条线意味着 occ 用自己的原生格式收发，零转换损耗，原生 thinking 块也能完整保留。

**`/messages` 不做格式转换 —— 它只是转发。** 拿一个非 Anthropic 上游的模型去打它，回来的是上游透传的错误：

```
POST /zen/v1/messages   {"model":"mimo-v2.5-free", …Anthropic 形状的 body…}
→ 400 {"error":{"type":"server_error","message":
   "Error from provider (Console): Upstream request failed:
    [400] Input required: specify \"prompt\" or \"messages\""}}
```

也就是说 Zen 把 Anthropic 形状的 body 原样递给了一个说 OpenAI 的上游。**推论**：`OPENCODE_WIRE_API=messages` 配非 Claude 模型是个必然失败的配置，而且报错来自上游、读起来跟 occ 毫无关系。这个出口保留「用户比表更清楚」的语义（将来可能出现 Anthropic 上游但不叫 `claude-` 的模型），但用错了就是这个症状。

**未验证**：Zen 是否把 Anthropic 专属 beta 头（context management、global cache scope、interleaved thinking、adaptive thinking）转发给上游。已知的只有「带上 beta 头不会让网关拒绝解析请求」—— 带与不带返回的是字节相同的 401。真正的验证需要一把付费 key 打 claude 模型。判定为 Anthropic 端点会顺带打开这些头，所以这是这条线上**唯一没有实测背书**的行为。

**线路由只读环境变量，不解析模型。** `getAPIProvider()` 在模型解析链的上游，去问 `model.ts` 某个别名解析成什么会闭合一条依赖环 —— 这正是 `modelTier.ts` 和 `tierDefaults.ts` 保持零导入的原因。所以线是从 `OPENCODE_MODEL` 的家族推出来的，配置一变就整体重新应用。

**当前阶段的已知限制**：一个会话只说一种协议。把 `opus` 钉在 `claude-opus-5`、同时把 `haiku` 钉在 `gpt-5.6-luna`，必然有一个走错线。真正的按请求路由是更大的一次改造，不在这一期。

`OPENCODE_WIRE_API`（`messages` | `responses` | `chat`）可以强制钉死某条线，给命名让这套启发式误判的部署留的出口。

### Go 上的三条线

Go 的 base URL 底下同样挂着这三条路径，**同一套 `laneForModel()` 启发式在 Go 上已经是对的，不要改**：

| 路径 | 实测结果 |
|---|---|
| `POST /zen/go/v1/chat/completions` | 200，真实 completion（用 `kimi-k3` 验），响应带 `"cost":"0"` |
| `POST /zen/go/v1/responses` | 200，status `completed`（用 `gpt-5.6-luna` 验，Go 目录里唯一走这条线的 id） |
| `POST /zen/go/v1/messages` | 存在，但和 Zen 一样**只转发不转换**：`Error from provider (Console Go): Upstream request failed: [invalid_request_error] Invalid request: messages must not be empty` |

**Go 目录里没有任何 Claude，所以 `/messages` 在 Go 上永远不是正确选择。** 反过来说，如果用户在 Go 端点上手填了一个 `claude-*` 模型名（手动录入模式下没有目录可校验），会话就会被路由到 `/messages`，然后收到上面那条上游报错 —— 里面没有 occ 也没有 Go 的模型表，纯靠这份文档才能反推。

## 二、两种凭据

和 sst/opencode 自己注册的两种方法一一对应：

| 类型 | 怎么来 | 存哪 |
|---|---|---|
| **Console 订阅** | 设备码 OAuth（RFC 8628） | `<配置目录>/opencode-auth.json`，0600 |
| **API key** | Zen 页面复制，或服务账号 key | `OPENCODE_API_KEY` |

**两者在推理面完全等价**，这不是 occ 的简化：opencode 运行时把两种凭据解析成同一个 bearer 值（`packages/core/src/session/runner/model.ts`，`credential.type === "key" ? key : access`），推理面根本区分不了。

**优先级是 key 压过 OAuth。** 显式导出的 `OPENCODE_API_KEY` 是一次刻意行为（CI、服务账号、另一个组织），而存着的登录是环境自带的。让环境自带的赢，等于让环境变量静默失效 —— 这正是 CLAUDE.md 记录的 `OPENAI_MODEL` 那个坑。

### 设备码流程

```
POST https://console.opencode.ai/auth/device/code   {"client_id":"opencode-cli"}
  → {device_code, user_code:"RWTD-JXVR",
     verification_uri_complete:"/device?user_code=…", expires_in:900, interval:5}
POST https://console.opencode.ai/auth/device/token  轮询
  → authorization_pending 继续 / slow_down 加宽 5s / 其余终止
GET  /api/user, /api/orgs                           取邮箱与组织
```

**`verification_uri_complete` 是服务器相对路径**，必须拼到 origin 上。当成绝对 URL 用会得到一个打不开的地址。

刷新用同一个 `/auth/device/token`，`grant_type=refresh_token`。

**刷新做了单飞。** 并发的模型请求会在同一刻同时发现 token 过期；各刷各的会导致最后一次写入生效，而之前每个持有者刚拿到的新 pair 全部作废。

### 免费档不需要登录（只有 Zen 有）

`Authorization: Bearer public` 无账号即可用免费模型（`mimo-v2.5-free` 实测返回真实 completion）。这与 opencode 插件的行为一致：无凭据时它把 `apiKey` 设为 `public`，并只禁用成本非零的模型。

**Go 没有免费档**：它的 25 个 id 里没有 `-free` 结尾的，也没有 `big-pickle`。所以凭据选择屏在 Go 上直接不渲染「仅免费模型」那一行 —— 留着它等于给用户开一个空的选择器。

## 三、环境变量

| 键 | 含义 |
|---|---|
| `OPENCODE_AUTH_MODE` | 置为 `opencode` 标记这是 OpenCode 会话 |
| `OPENCODE_BASE_URL` | 推理面 base URL，**同时也是选产品的那个键**：`https://opencode.ai/zen/v1` = Zen（默认），`https://opencode.ai/zen/go/v1` = Go |
| `OPENCODE_API_KEY` | OpenCode / 服务账号 key，或 `public`（Zen 免费档） |
| `OPENCODE_MODEL` | 默认模型；**线路由从它的家族推出** |
| `OPENCODE_WIRE_API` | 强制钉线 |
| `OPENCODE_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` | 四个档位 |

**access token 绝不写进 settings.json。** 它一小时就过期，写进去既是个必然过期的值、又是一份明文密钥躺在普通配置文件里。持久化的只有上面这些配置键；活 token 由认证层推进内存，镜像时才落到线路对应的键上（`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`）。

### messages 线只认 `x-api-key`

镜像到的是 `ANTHROPIC_API_KEY` 而**不是** `ANTHROPIC_AUTH_TOKEN`。这两个键在 SDK 里不等价：`apiKey` 变成 `x-api-key` 头，`authToken` 变成 `Authorization: Bearer`。对真实端点用真实 key 实测：

| 发的头 | 结果 |
|---|---|
| `Authorization: Bearer <key>` | `{"type":"AuthError","message":"Missing API key."}` |
| `x-api-key: <key>` | 通过鉴权 |
| 两个都发 | 通过鉴权 |

写错这个键，**每一个 OpenCode Claude 会话都会 401**。而这种错单元测试看不见 —— 它们断言的是「某个凭据 env 键被写了」，不是「那个键会变成什么头」。这类问题只有打真实端点才抓得到。

另外，镜像写进去的 `ANTHROPIC_API_KEY` 必须能绕过交互式的「Detected a custom API key」审批（`isOpencodeMirroredApiKey()` → `isOccConfiguredAnthropicApiKey()`）。那个审批列表是给「occ 在你 shell 里**发现**的 key」用的，而镜像值是用户两屏之前刚登录进来的，根本不存在他能回答的提问 —— 默认答案是 No，于是拒掉自己刚配好的凭据。`--print` 完全跳过审批，所以症状是 headless 能跑、REPL 里显示 `Not logged in · Please run /login`。

镜像的记账规则和 DeepSeek 那条线一样：只回收「当前值仍等于自己上次写入值」的键。不等于就说明中途有更权威的东西覆盖过（settings.env 重新应用、用户 export），删它就从「撤销自己的写入」变成了「丢弃用户的配置」。

## 四、三个问题要分开答

CLAUDE.md 里那三个容易混的判定，OpenCode 会话上的答案是：

| 问题 | 答案 | 为什么 |
|---|---|---|
| `getAPIProvider()` —— 走哪套协议和客户端 | 线是 `messages` 时 `firstParty`，否则 `openai` | 这问的是协议 |
| `isThirdPartyModelCatalog()` —— 谁的目录、谁的价目表 | **是第三方** | 目录、计费、限额全是 opencode 的 |
| `servesAnthropicModels()` —— `claude-opus-5` 是不是真的 Opus 5 | `claude-*` **是**，其余**否** | Zen 转发真实 Anthropic checkpoint，叫它 Opus 5 是诚实的；对着 `gpt-5.6-sol` 显示 Anthropic 营销名和单价则是撒谎 |

第三条的后果是实打实的：答错会让 Zen 上的 claude 会话丢掉 `[1m]` opt-in 和 Anthropic 专属 beta 头。

**三个判定都不看 base URL**，读的是 `OPENCODE_AUTH_MODE` 和 `OPENCODE_MODEL`，所以 Go 无需任何改动就得到正确答案：Go 目录里没有 claude id → 线永远不是 `messages` → `getAPIProvider()` 答 `openai`、`servesAnthropicModels()` 答否、`isThirdPartyModelCatalog()` 答是。

## 五、隔离

凭据落在 occ 自己的配置目录，**三方互不相干**：不碰 `~/.claude`、不碰官方 Claude Code 拥有的 macOS keychain 记录、也不碰 opencode CLI 自己的 `~/.local/share/opencode/auth.json`。同时装了 occ 和 opencode CLI 的机器，登出任何一边都不该影响另一边。

## 六、怎么登录

`/login`（或首启向导）的菜单里 OpenCode 占**两行**，先选产品：

- **OpenCode Zen** —— 按量计费网关，61 个模型（含 Claude），扣 credit 余额。
- **OpenCode Go** —— 包月订阅，25 个开源系编码模型，无 Claude。

两行而不是一行加二级菜单，是因为这个选择的代价不对称：选错的唯一症状是另一个产品余额上的 `CreditsError`，而两个 URL 只差一个路径段。产品一旦选定就随状态走完整个流程（`opencode_method_select` / `opencode_device` 都带 `product` 字段），包括出错后的重试 —— 重试丢掉产品就等于把 Go 用户的设备码流程重启到 Zen 上。

选完产品是三个凭据入口（Go 上只有前两个）：

1. **Console 订阅** —— 设备码流程。屏幕上给出 `user_code`、自动打开的验证地址，以及**这次登录配的是哪个端点**（产品名 + base URL + 计费方式）。`Esc` 会真的中止轮询（`AbortController` 同时喂给 `pollForTokens` 的循环判断和 fetch，所以是一个 tick 内响应，不是等到下一个 5 秒间隔）。设备码流程本身两个产品完全一样 —— console 发的是同一个 token —— 差别全在它之后：写进 settings 的 base URL、拉哪个目录、谁付钱。
2. **API key** —— 粘贴 OpenCode 页面的 key，或服务账号 key。
3. **仅免费模型**（Zen 限定）—— 不需要账号，用 `Bearer public` 直接拉真实模型列表。

端点步骤（第一步）也把产品写在标题和说明里：标题是 `OpenCode Zen Setup` / `OpenCode Go Setup`，说明里给出**另一个**产品的 URL 和计费方式，因为换产品就是把那个 URL 粘进 Base URL 字段而已。base URL 不是这两个之一时标题退回 `OpenCode Setup` —— occ 只描述自己读过的两个端点。

登录完进入统一的两步向导第二步（`src/components/providerSetup/`，opencode 的差异全在 `specs.ts` 的表里）。**选择器里直接标出每个模型落在哪条线**：`claude-opus-5 · /messages`、`gpt-5.6-luna · /responses`、`kimi-k3 · /chat/completions`。标签只是显示，存的值仍是纯 id。

两条容易踩的：

- **默认模型是必填的**，且订阅模式也不放宽。`OPENCODE_MODEL` 是 `laneForModel()` 唯一的输入，留空会让会话静默落到 `/chat/completions` —— 哪怕四个档位配的全是 `claude-*`。这跟 ChatGPT 订阅不同：Codex 后端自己会按档位解析，Zen 和 Go 都不会。
- **`urlKind` 用 `openai` 而不是 `anthropic`**。Anthropic 的 URL 语法会剥掉结尾的 `/v1`，把 `…/zen/v1` 变成 `…/zen`（`…/zen/go/v1` 同理变成 `…/zen/go`）。

订阅模式下第二步的标题仍然带产品名（`OpenCode Go — Models`）：那个模式跳过端点步骤，标题是**唯一**还在说「这个会话打的是哪个端点」的地方。

`/models-setting` 随时重开模型步骤。它认 OpenCode 会话靠的是 `isOpencodeSessionActive()` 而不是 `getAPIProvider()` —— 后者答的是协议，会把 messages 线的会话认成 anthropic，进而用镜像写入的**活 access token** 预填 API-key 字段并明文存进 `settings.env`。

多 provider 共存、切换与聚合见 [provider-settings.md](./provider-settings.md)。

## 七、模型目录

两个来源，顺序是刻意的：

1. `GET {console}/api/config` —— **授权**答案。按组织，只有 OAuth 凭据才有，但它是唯一知道企业自建部署的来源。404 按「没有远端配置」处理，不是错误（照搬 sst/opencode 的做法）。
2. `GET {base}/models` —— **目录**答案。两个产品都公开可读（无凭据 200：Zen 61 个、Go 25 个），OpenAI 形状，同一产品下对所有人相同。

公开表是回退而不是首选：某个套餐不含的模型如果照样列出来，用户会在第一次使用时才撞墙。但对一把纯 API key 来说它就是正确答案 —— 那背后没有可问的 console 账号。

**base URL 是 `fetchOpencodeModels()` 的必填参数，没有默认值。** 有默认值就意味着 Go 会话可以在没人写下这件事的情况下退回去拉 Zen 的 61 个模型。**未验证的一点**：`/api/config` 是账号面的答案，它会不会按当前配置的产品收窄未知。真出现「Go 会话拿到账号的全部 Zen 目录」，修法在 `catalog.ts` 里 —— 但拿 occ 自带的表去和它求交集是不行的，那会静默隐藏企业自建部署真实提供的模型。

### occ 自带的两张表

occ 给两个产品各自内置一份 id 表（`opencodeCatalog.ts` 的 `OPENCODE_PRODUCTS`），只在 `/models` 拉取失败时兜底。给第三方硬编模型表通常是错的（CLAUDE.md 对 Gemini/Grok 就是这么说的），OpenCode 是例外：两个 `/models` 都公开，所以这两张表是**读来的**不是编的（2026-08-10 读取）。

Go 的 25 个（读自 `GET https://opencode.ai/zen/go/v1/models`）：

```
minimax-m3, minimax-m2.7, minimax-m2.5, kimi-k3, kimi-k2.7-code, kimi-k2.6,
kimi-k2.5, glm-5.2, glm-5.1, glm-5, deepseek-v4-pro, deepseek-v4-flash,
qwen3.7-max, qwen3.8-max, qwen3.7-plus, qwen3.6-plus, qwen3.5-plus,
mimo-v2-pro, mimo-v2-omni, mimo-v2.5-pro, mimo-v2.5, hy3, hy3-preview,
gpt-5.6-luna, grok-4.5
```

**选哪张表按 base URL 的 path 判，不按 host。** 这正是修掉的那个 bug：原来的门是 `usesOfficialEndpoint(context, 'opencode.ai')`，只比 host，而两个产品同主机 —— 于是 `/models` 拉取失败的 Go 用户被塞了 Zen 的 61 个模型，其中大部分他的订阅根本不服务，选中一个就变成扣 Zen 余额 + `CreditsError`。回归测试钉的就是这一条：**Go 的 base URL 不得产出 Zen 的预设表**。

两个产品都不认的 base URL（自建网关，或 opencode.ai 上还没发布过的路径）**两张表都拿不到**。协议兼容不等于目录归属，而没读过的路径不是 occ 能描述的产品。
