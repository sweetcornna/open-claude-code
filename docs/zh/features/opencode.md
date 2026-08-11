# OpenCode 接入（Console 推理面 · Zen 网关 · Go 订阅）

occ 可以直接接 [OpenCode](https://opencode.ai) 的订阅和网关。**一个账号后面挂着三个推理端点**，它们互不通用：Console 自己的推理代理（设备码登录拿到的 token 只在这里被接受）；Zen 是按量计费的聚合网关（61 个模型，横跨 Anthropic、OpenAI、Google、DeepSeek、xAI、Kimi、Qwen、MiniMax、GLM 等家，外加 9 个免费档）；Go 是包月订阅（25 个开源系编码模型，**一个 Claude 都没有**）。

本文是配置与判定的真源。实现散在 `src/services/auth/opencode/`（认证、`/api/config`、目录）、`src/components/opencodeLogin/opencodeCatalog.ts`（两张产品表）和 `src/utils/model/opencodeWire.ts`（会话种类与协议线路由）。

## 〇、四个平面，别混

OpenCode 有一个账号面和**三个**推理面，职责完全不同，混淆它们是这里最容易犯的错：

| 平面 | 主机 / base URL | 管什么 | 计费 |
|---|---|---|---|
| **账号面** | `console.opencode.ai` | 设备码 OAuth；`/api/config` 给出该组织**有权使用**的 provider、**推理端点**与**必带请求头** | — |
| **推理面 · Console** | `/api/config` 里的 `provider.opencode.api`（公有 console 上是 `https://console.opencode.ai/inference/openai/v1`） | 该组织授权的模型，**只有 OpenAI 兼容一条线** | 走账号 |
| **推理面 · Zen** | `https://opencode.ai/zen/v1` | 61 个模型（含 Claude），三条协议线 | 按量，扣 credit 余额 |
| **推理面 · Go** | `https://opencode.ai/zen/go/v1` | 25 个开源系编码模型，无 Claude | 包月订阅（首月 $5，其后 $10/月） |

账号面回答「你是谁、你能用什么、话发到哪」，推理面回答「话怎么说」。**Console 推理面的 base URL 与请求头永远从 `/api/config` 取，不许写成常量**（详见 §〇bis）；Zen/Go 那两个是公开固定的端点，写成常量是对的。

## 〇bis、Console 登录的 token 不能发给 Zen

**这是本文最贵的一条，也是 Console 登录曾经完全不可用的原因。** 设备码登录拿到的 access token 只在 console 自己的推理代理上被接受。同一个账号、同一个 token，实测（2026-08-11）：

| 请求 | 结果 |
|---|---|
| `POST {config.provider.opencode.api}/chat/completions` + `x-org-id` | **200**，真实 completion（用 `big-pickle` 验） |
| `POST https://opencode.ai/zen/v1/chat/completions`（occ 曾写死的那个） | **401** `{"type":"AuthError","message":"Invalid API key."}` |

症状是每一条请求都回 `API Error [OpenAI]: Invalid API key. status=401`。这条错既不提端点也不提登录方式，所以此前多次被误判成「账号没开通」——**不是**，是 occ 把 token 发错了地方。

`GET https://console.opencode.ai/api/config`（`Authorization: Bearer <access token>` + `x-org-id`）返回 200，`config.provider` 下**只有一个 provider**：

```jsonc
config.provider.opencode = {
  name, npm: "@ai-sdk/openai-compatible",
  api: "https://console.opencode.ai/inference/openai/v1",  // ← 推理 base URL
  env: ["OPENCODE_CONSOLE_TOKEN"],
  options: {
    apiKey:  "{env:OPENCODE_CONSOLE_TOKEN}",               // ← 解析成 access token
    headers: { "x-org-id": "org_01KZ…" }                   // ← 必带，且按账号不同
  },
  whitelist: [...],
  models: { …59 条，全部 status:"active"… }
}
```

sst/opencode 自己的插件就是这么读的（`packages/core/src/plugin/provider/opencode.ts`：`provider.api = item.npm ? { type:"aisdk", package:item.npm, url:item.api } : …`，外加 `Object.assign(provider.request.headers, item.options?.headers)`）。occ 现在照做：

- **base URL** ← `provider.opencode.api`
- **请求头** ← `provider.opencode.options.headers`（带 `x-org-id`；不带就没有按组织收窄）
- **凭据** ← OAuth access token 作 bearer
- **协议** ← OpenAI chat completions，**无条件**，不做线路由
- **模型表** ← 同一份响应里的授权模型

**`POST {console}/inference/openai/v1/messages` 实测 404。** 那个平面只有 OpenAI 兼容一条线，所以 §一 的三线路由**不适用于 Console 会话**——连 `OPENCODE_WIRE_API=messages` 这个逃生口也不适用，钉了也只能钉出一个 404。`getOpencodeLane()` 因此在 Console 会话上直接返回 `chat`，不看模型家族也不看那个 env。

### 授权表说了不算：`managed_inference_model_disabled`

`/api/config` 把 `claude-haiku-4-5` 列成 `status: "active"` 并放进 `whitelist`，但真发请求时：

```
POST {console}/inference/openai/v1/chat/completions  {"model":"claude-haiku-4-5", …}
→ 403 {"error":{"type":"managed_inference_model_disabled",
                "message":"Model is disabled for this organization"}}
```

同一个账号、同一个端点上 `big-pickle`（免费）照样 200。**结论：按组织的可用性在请求之前不可知**，目录里筛不掉，所以 occ 不假装能筛，改为在撞上时说人话（`src/services/auth/opencode/inferenceErrors.ts`）：点名是哪个模型、说明凭据没问题、指出目录本来就答不了这个问题、给出 `/model` 换一个或去 console 开通两条出路。

**它不是认证失败，也不许被当成认证失败。** 403 单看 status 会被分类成 `authentication_failed`，那会把用户赶去 `/login` 修一把根本没坏的凭据。`retryClassification.ts` 的信号判定排在 status 之前，`MODEL_DISABLED` 落在 `invalid_request` 一档。同理，登录探针（`verifyOpencodeAccess`）遇到这个 type 直接判**通过**——探针模型是 occ 从那张「全是 active」的表里挑的，为它否掉一个好账号是本末倒置。

**Zen 和 Go 只差一个路径段，主机相同 —— 这是本文最贵的一条。** 拿 Go 订阅的 key 去打 Zen 的 base URL，请求会记到 **Zen 的 credit 余额**上并失败：

```
POST /zen/v1/chat/completions   （Go 订阅者的 key）
→ {"type":"error","error":{"type":"CreditsError",
     "message":"Insufficient balance…"}}
```

这条错误既不提产品也不提 URL，用户完全无从反推。所以凡是「这是哪个 OpenCode 端点」的判定，**必须比 path，不能只比 host** —— `usesOfficialEndpoint()` 那种只比 host 的写法对两个产品都答「是官方端点」。真源是 `opencodeProductForBaseUrl()`。

Go 的订阅性质在响应体里也能看到：`/zen/go/v1/chat/completions` 实测返回的 completion 带 `"cost":"0"`（用 `kimi-k3` 验的），也就是不走计量。

## 一、三条协议线（**只在 Zen / Go 上**）

Console 推理面不参与这一节：它只有 `/chat/completions`，`/messages` 是 404（见 §〇bis）。以下只对两个网关产品成立。

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

`OPENCODE_WIRE_API`（`messages` | `responses` | `chat`）可以强制钉死某条线，给命名让这套启发式误判的部署留的出口。**它对 Console 会话无效**——那个出口的语义是「用户比表更清楚」，而 Console 平面上不存在第二条线可选，钉了只能钉出 404。

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

**两者作为 bearer 的形状等价，但它们打的不是同一个端点。** 形状那半是真的、也不是 occ 的简化：opencode 运行时把两种凭据解析成同一个 bearer 值（`packages/core/src/session/runner/model.ts`，`credential.type === "key" ? key : access`）。但「形状一样」曾被错误地外推成「端点也一样」，于是 Console 的 token 被发去了 Zen，实测 401（§〇bis）。**两种凭据 = 两种会话种类 = 两套配置，不要合并**：

| | Console 订阅 | API key |
|---|---|---|
| base URL | `/api/config` 的 `provider.opencode.api` | 用户在登录菜单里选的 Zen / Go |
| 请求头 | `/api/config` 的 `options.headers`（`x-org-id`，按账号） | 只有 `Authorization`（多组织账号另加 `x-org-id`） |
| 协议 | 只有 OpenAI chat completions | 三线路由，按 `OPENCODE_MODEL` 的家族 |
| 模型表 | 该组织的授权表 | 产品的公开 `/models`，拉不到退回 occ 内置表 |
| 标记 | `OPENCODE_INFERENCE_PLANE=console` | 该键不存在 |

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

### 拿到设备码不等于登录成功

**console 发的 token 是给账号的，不是给产品的**，而 Zen 和 Go 分开计费。所以「设备码换到了 token」和「这个 token 能用在你刚选的那个端点上」是两件事，中间没有任何东西把它们连起来 —— 登录流程里的每一个请求要么根本不需要凭据，要么按设计吞掉自己的失败：

| 登录期间的请求 | 为什么证明不了凭据可用 |
|---|---|
| `GET {base}/models` | **两个产品都公开**（实测无凭据 200），选择器里那 25 个真 id 跟你的订阅无关 |
| `GET {console}/api/user`·`/api/orgs` | `fetchAccount` 逐个 `.catch`，拿不到就退回 `{}`（这是刻意的：账号描述不该否决一个能推理的 token） |
| `GET {console}/api/config` | 404 按「没有远端配置」处理，照搬 sst/opencode |

于是登录能一路走完、写进 settings、开出一个装满真模型的选择器，而 token 一次都没被真正用过 —— **第一次用它是用户的第一条 prompt**，回来的是 `API Error [OpenAI]: Invalid API key`。那个提示既不提登录也不提产品，看起来像 provider 坏了。

**修法是在激活之前探一次**（`verifyOpencodeAccess`，`services/auth/opencode/catalog.ts`）：拿 `messages: []` 打一次 `POST {base}/chat/completions`。**那个 `{base}` 必须是会话真正会用的端点**，Console 会话上就是 `/api/config` 给的那个而不是产品常量 —— 拿 Zen 去探一个 Console token 只会得到 401，这个探针从「防止半配置会话」变成「拦下所有 Console 登录」。**网关先鉴权后校验 body**，所以这个形状既能问出凭据的判决又不可能计费。三个方向都对真实端点实测（2026-08-10）：

| 发什么 | 回什么 |
|---|---|
| 不带 bearer | 401 `{"type":"AuthError","message":"Missing API key."}` |
| 错的 bearer | 401 `{"type":"AuthError","message":"Invalid API key."}` |
| **被接受的 bearer**（Zen 免费档 `Bearer public`） | **400** `Input required: specify "prompt" or "messages"` —— 鉴权已过，没跑推理 |

**只有 `AuthError` 算拒绝。** 未知 model id 网关回的是 `ModelError`，而且**照样盖 401**（实测），只看 status 会因为 occ 探针模型猜错而否掉一个好账号。传输层抛错也不算判决 —— 设备码流程几秒前刚连上 console，这里抛就是网络抖动，为它拦下登录比它要防的问题更糟。

拒绝时**一个字都不写**（`components/opencodeLogin/activateSession.ts`）：settings.json、`process.env`、镜像的认领表全部保持原样，用户停在登录界面上，错误里写明是哪个产品、哪个 URL、以及可以换另一个产品或改用 API key。半配置的会话正是这条检查要消灭的东西 —— `modelType: "opencode"` 一项就足以让 `/model-settings`、`/provider save` 和状态栏一起报告一个答不出任何请求的会话。

### API key 走的是同一个坑，也是同一个探针

上一条对 API key 一字不差地成立。向导第一步唯一的请求就是 `GET {base}/models`，而它**两个产品都公开** —— 所以打错一个字符、把 Go 的 key 贴在 Zen 的 URL 上、或者用了另一个组织的 key，第一步照样成功、选择器照样装满真 id、第二步照样保存完成，第一次真正发出这把 key 的仍然是用户的第一条 prompt。

修法是同一个探针，挂在共享向导的一个**可选钩子**上：`ProviderSetupSpec.verifyCredential`（`src/components/providerSetup/specs.ts`），只有 opencode 一家声明，实现在 `components/opencodeLogin/verifyFormCredential.ts`。串起两个请求的是 `providerSetup/endpointRequests.ts`，顺序是刻意的 —— 先 `GET /models`，因为目录的答案正好用来挑探针模型：

| 判决 | 结果 |
|---|---|
| 接受 | 照常进第二步，目录原样带过去 |
| `AuthError` | **停在第一步**，光标回到 API Key 字段（端点和 key 都还在，改一处就能重试），错误里写明产品、URL、另一个产品的 URL 与计费方式，以及可以改用 Console 登录 |
| 探不出来（没有目录也没有内置表可挑模型、或传输层抛错） | 放行 —— 不确定不是拒绝 |

**「第一步写不了任何东西」是这条检查最便宜的部分。** 设备码那条线要靠 `activateSession.ts` 手工保证「拒绝时一个字都不写」；向导第一步本来就不写 settings.json、不写 `process.env`、不碰镜像的认领表，所以拒绝天然零副作用。`Esc` 在探测期间会真的中止：`/models` 和探针共用第一步那一个 `AbortController`。

**其余五家 provider 不声明这个钩子，第一步因此一次调用都没多** —— 这不是巧合，是回归测试钉住的（`providerSetup/__tests__/endpointRequests.test.ts`）。它们也不需要：`GET /models` 在它们那儿是要凭据的，key 错了第一步自己就会失败。`validate` 保持原样 —— 同步、只管形状；这个钩子是另一件事，不要往 `validate` 里塞。

#### 空 key 在两个产品上不是一回事

`apiKeyRequired: false`，因为 Zen 的免费档 `Bearer public` 无账号可用，**空 key 在 Zen 上必须仍然配得出来**。所以空 key 时探针发 `public`，并**优先挑一个免费 id** 当探针模型 —— 公共 bearer 只对免费模型有权限，拿付费模型去探是在问另一个问题。

「仅免费模型」那个入口传进来的 apiKey **就是 `public` 本身**（不是空串），所以这两种情况在探针这里必须算同一种。分开算的后果很具体：那条路上 `/models` 会成功返回 Zen 的 61 个，于是探针模型取到 `claude-fable-5` —— 一个付费模型 —— 用公共 bearer 去问它，问的已经不是「这个凭据能不能用」了。

**Go 没有免费档**（25 个 id 里没有 `-free`，也没有 `big-pickle`），所以同一个 `public` 在 Go 上预期会被拒。occ **不把这条预期写死**：端点答应就算通过，occ 只负责在它拒绝时说清楚「Go 没有免费档，25 个模型全都需要凭据」。这是刻意的 —— 「Go 无免费档」的结论来自目录表，不是来自对 Go 打过 `public` 的实测，把没实测过的推断写成硬规则正是本文反复在防的事。

其他 provider 的无凭据本地网关（Anthropic 兼容壳后面的 vLLM 之类）不受影响：`apiKeyRequired: false` 在那边的含义没变，而它们没有钩子。

### 免费档不需要登录（只有 Zen 有）

`Authorization: Bearer public` 无账号即可用免费模型（`mimo-v2.5-free` 实测返回真实 completion）。这与 opencode 插件的行为一致：无凭据时它把 `apiKey` 设为 `public`，并只禁用成本非零的模型。

**Go 没有免费档**：它的 25 个 id 里没有 `-free` 结尾的，也没有 `big-pickle`。所以凭据选择屏在 Go 上直接不渲染「仅免费模型」那一行 —— 留着它等于给用户开一个空的选择器。

## 三、环境变量

| 键 | 含义 |
|---|---|
| `OPENCODE_AUTH_MODE` | 置为 `opencode` 标记这是 OpenCode 会话 |
| `OPENCODE_BASE_URL` | 推理面 base URL。API key 会话上**同时也是选产品的那个键**：`https://opencode.ai/zen/v1` = Zen（默认），`https://opencode.ai/zen/go/v1` = Go。Console 会话上是 `/api/config` 给的那个地址 |
| `OPENCODE_INFERENCE_PLANE` | 只有 `console` 一个取值，**不设置**就是 Zen/Go 那种会话。由设备码登录写入（且只在 `/api/config` 真给出了端点时），由 `PROVIDER_SETUP_SPECS.opencode.extraEnv` 清除——那个钩子只在「本次保存拥有凭据面」时跑，也就是配 API key 的时候，而订阅会话的纯模型保存会整块跳过它 |
| `OPENCODE_API_KEY` | OpenCode / 服务账号 key，或 `public`（Zen 免费档） |
| `OPENCODE_MODEL` | 默认模型；**线路由从它的家族推出** |
| `OPENCODE_WIRE_API` | 强制钉线 |
| `OPENCODE_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL` | 四个档位 |

**access token 绝不写进 settings.json。** 它一小时就过期，写进去既是个必然过期的值、又是一份明文密钥躺在普通配置文件里。持久化的只有上面这些配置键；活 token 由认证层推进内存，镜像时才落到线路对应的键上（`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`）。

### 端点与请求头必须活过刷新

Console 会话的端点和 `x-org-id` 不是 occ 选的，是 console 说的，所以它们**存在 0600 凭据文件里、和账号放在一起**（`opencode-auth.json` 的 `inference: { api, headers }`），不是和 token 放在一起。理由很具体：刷新接口只回 token，任何跟着 token 走的东西都会在第一次续期时丢掉，然后会话回落到常量端点——正好是本文要修的那个 401。`refreshAndPersist` 展开上一条记录，所以这一块自然被带过每一次写入。

活 token 与端点一起被推进 `opencodeWire.ts` 的内存槽（`setOpencodeRuntimeCredential(token, { baseUrl })`）。**槽里的端点压过 `OPENCODE_BASE_URL`**：那个 env 是 console 答案的一份持久化副本，凭据文件里的才是原件；从旧版本升级上来、settings 里还写着 Zen 的会话因此在第一次请求时就自愈，不用重登。反过来，API key 凭据不携带端点，槽里是空的，env 说了算。

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

**三个判定都不看 base URL**，读的是 `OPENCODE_AUTH_MODE`、`OPENCODE_INFERENCE_PLANE` 和 `OPENCODE_MODEL`，所以 Go 无需任何改动就得到正确答案：Go 目录里没有 claude id → 线永远不是 `messages` → `getAPIProvider()` 答 `openai`、`servesAnthropicModels()` 答否、`isThirdPartyModelCatalog()` 答是。

**Console 会话同理，且更简单**：线恒为 `chat`，于是 `getAPIProvider()` 恒答 `openai`、`isThirdPartyAnthropicEndpoint()` 恒答是。这一条是有代价的——Console 上的 `claude-*` 会因此拿不到 `[1m]` opt-in 和 Anthropic 专属 beta 头。这是对的：那些头是 Anthropic Messages 协议上的东西，而这条会话根本不走那个协议（`/messages` 在这里是 404）。

## 五、隔离

凭据落在 occ 自己的配置目录，**三方互不相干**：不碰 `~/.claude`、不碰官方 Claude Code 拥有的 macOS keychain 记录、也不碰 opencode CLI 自己的 `~/.local/share/opencode/auth.json`。同时装了 occ 和 opencode CLI 的机器，登出任何一边都不该影响另一边。

## 六、怎么登录

`/login`（或首启向导）的菜单里 OpenCode 占**两行**，先选产品：

- **OpenCode Zen** —— 按量计费网关，61 个模型（含 Claude），扣 credit 余额。
- **OpenCode Go** —— 包月订阅，25 个开源系编码模型，无 Claude。

两行而不是一行加二级菜单，是因为这个选择的代价不对称：选错的唯一症状是另一个产品余额上的 `CreditsError`，而两个 URL 只差一个路径段。产品一旦选定就随状态走完整个流程（`opencode_method_select` / `opencode_device` 都带 `product` 字段），包括出错后的重试 —— 重试丢掉产品就等于把 Go 用户的设备码流程重启到 Zen 上。

选完产品是三个凭据入口（Go 上只有前两个）：

1. **Console 订阅** —— 设备码流程。屏幕上给出 `user_code`、自动打开的验证地址，以及**这次登录配的是哪个端点**。那一行先显示所选产品的 URL，等 `/api/config` 答出 `provider.opencode.api` 就换成真正会被打的那个地址 —— 因为对 Console 会话来说产品 URL 并不是答案（§〇bis）。`Esc` 会真的中止轮询（`AbortController` 同时喂给 `pollForTokens` 的循环判断和 fetch，所以是一个 tick 内响应，不是等到下一个 5 秒间隔）。产品选择在这条路径上只剩两个作用：错误文案里的计费说明，以及 `/api/config` 没给出任何 provider 时的回退端点。
2. **API key** —— 粘贴 OpenCode 页面的 key，或服务账号 key。key 在进第二步之前会先被探一次，拒绝就停在端点表单上（见 §二「API key 走的是同一个坑」）。
3. **仅免费模型**（Zen 限定）—— 不需要账号，用 `Bearer public` 直接拉真实模型列表。

端点步骤（第一步）也把产品写在标题和说明里：标题是 `OpenCode Zen Setup` / `OpenCode Go Setup`，说明里给出**另一个**产品的 URL 和计费方式，因为换产品就是把那个 URL 粘进 Base URL 字段而已。base URL 不是这两个之一时标题退回 `OpenCode Setup` —— occ 只描述自己读过的两个端点。

登录完进入统一的两步向导第二步（`src/components/providerSetup/`，opencode 的差异全在 `specs.ts` 的表里）。

**订阅模式下 opencode 仍然自己写 `OPENCODE_AUTH_MODE` 和 `OPENCODE_BASE_URL`**，走 `specs.ts` 的 `sessionEnv` 而不是 `extraEnv`。这条区分不是命名洁癖：`planProviderSave` 对订阅会话（`credentialEditing: 'locked'`）**整块跳过**凭据面，包括 `extraEnv` 和 base URL —— 对 ChatGPT 和 Antigravity 是对的（它们的 OAuth 流程自己存凭据，端点是隐式的），对 opencode 是错的。**端点在这里不属于凭据面，它选的是产品**，是用户在登录菜单里做的选择；而 `OPENCODE_AUTH_MODE` 是 `isOpencodeSessionActive()` 的唯一依据，`getAPIProvider()`、`currentProfileModelType()`、`currentProviderSetupKind()` 三个都问它。少任何一个，会话就会「声称」走 OpenCode 却没应用 —— `applyOpencodeWire()` 没有 base URL 会直接早返回，整个镜像形同虚设。`sessionEnv` 排在凭据块之后，所以两种模式下它都是权威。**Zen/Go 的选择器里直接标出每个模型落在哪条线**：`claude-opus-5 · /messages`、`gpt-5.6-luna · /responses`、`kimi-k3 · /chat/completions`。标签只是显示，存的值仍是纯 id。**Console 会话不加这个后缀** —— 那里所有 id 都落在同一个 `/chat/completions` 上，标上 `/messages` 等于在广告一个 404。

`OPENCODE_INFERENCE_PLANE` 恰恰相反，走的是 `extraEnv`：它描述的是**这把凭据**说话的地方，而「本次保存拥有凭据面」就等于「用户在配 API key」，API key 只会打 Zen 或 Go。所以那个钩子只做清除、从不设置；订阅会话的纯模型保存跳过 `extraEnv`，标记因此活过 `/model-settings`。

两条容易踩的：

- **默认模型是必填的**，且订阅模式也不放宽。`OPENCODE_MODEL` 是 `laneForModel()` 唯一的输入，留空会让会话静默落到 `/chat/completions` —— 哪怕四个档位配的全是 `claude-*`。这跟 ChatGPT 订阅不同：Codex 后端自己会按档位解析，Zen 和 Go 都不会。（Console 会话不受这条影响：它本来就只有一条线。）
- **`urlKind` 用 `openai` 而不是 `anthropic`**。Anthropic 的 URL 语法会剥掉结尾的 `/v1`，把 `…/zen/v1` 变成 `…/zen`（`…/zen/go/v1` 同理变成 `…/zen/go`）。

订阅模式下第二步的标题仍然带产品名（`OpenCode Go — Models`）：那个模式跳过端点步骤，标题是**唯一**还在说「这个会话打的是哪个端点」的地方。

`/model-settings` 随时重开模型步骤。它认 OpenCode 会话靠的是 `isOpencodeSessionActive()` 而不是 `getAPIProvider()` —— 后者答的是协议，会把 messages 线的会话认成 anthropic，进而用镜像写入的**活 access token** 预填 API-key 字段并明文存进 `settings.env`。

多 provider 共存、切换与聚合见 [provider-settings.md](./provider-settings.md)。

## 七、模型目录

两个来源，顺序是刻意的：

1. `GET {console}/api/config` —— **授权**答案，也是 Console 会话的**端点与请求头**答案（§〇bis）。按组织，只有 OAuth 凭据才有，但它是唯一知道企业自建部署的来源。404 按「没有远端配置」处理，不是错误（照搬 sst/opencode 的做法）。实测那份响应里 59 个模型全部 `status: "active"`，而其中一部分真发请求会 403 —— 所以这是**授权**答案，不是**可用性**答案。
2. `GET {base}/models` —— **目录**答案。两个产品都公开可读（无凭据 200：Zen 61 个、Go 25 个），OpenAI 形状，同一产品下对所有人相同。

公开表是回退而不是首选：某个套餐不含的模型如果照样列出来，用户会在第一次使用时才撞墙。但对一把纯 API key 来说它就是正确答案 —— 那背后没有可问的 console 账号。Console 会话不走这个回退：那个端点没有公开 `/models`，`/model-settings` 重开模型步骤时会拿存着的 OAuth 凭据重新问一次 `/api/config`。

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
