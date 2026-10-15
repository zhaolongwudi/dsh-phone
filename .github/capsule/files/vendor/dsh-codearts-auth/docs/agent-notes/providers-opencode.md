<!-- 搬自 AGENTS.md 的「深细节索引」惯例：事故史与逐项规则放本文件，按需阅读，
     不进每轮注入。内容与 src/opencode-proxy.ts 的 proxyFetch 注释互为对照。 -->

## ⚠️⚠️ OpenCode 出口代理：dispatcher 与 fetch **必须同源**（Issue IKK4BY）

**用户报障**（2026-10-08，Gitee issue IKK4BY）：「OpenCode 账号的代理按钮，
填任意合法地址后点测试连接，**固定显示测试失败 fetch failed，耗时 0 到 1 毫秒**。
代理地址或目标站点换成别的也一样。但直连出口 IP 查询接口是正常的。
保存动作会成功，保存后该账号的每次对话请求也会以相同方式失败。」
环境：`dsh-codearts-auth` 0.2.0-rc.3 / DSH Desktop / Node **v24.21.0**（内置 undici 7.29.1）/
插件依赖 `undici` 8.11.2。

### 根因：跨实例 handler 契约冲突，断言发生在**建连之前**

`src/opencode-proxy.ts` 的 `ProxyAgent` / `Agent` 来自**外部** undici，
而 `fetch` 原先用的是**全局**（Node 内置 undici）。`RequestInit.dispatcher`
把外部实例交给内置 fetch 时，内置 fetch 会按**自己的版本**塑造 handler，
外部 undici 的 `Client` 再按**自己的版本**去断言它：

```
TypeError: fetch failed
  ← InvalidArgumentError: invalid onRequestStart method
    code = UND_ERR_INVALID_ARG
```

断言在 `new Request(...)` 里完成，**早于任何 socket 建立** ——
故与代理地址是否可用、目标站点是否可达**完全无关**（实测耗时 1~7ms、
代理中介命中 0 次），也与账号/额度无关。又因为该异常被 fetch 包装成
`TypeError` 且 **`cause` 被 UI 丢弃**（旧 `opencode-rpc.ts` 只取 `error.message`），
用户只能看到一句没有信息量的 `fetch failed`。

### 版本矩阵（本机实测 Node 22.19 / 24.21 / 26.10，外部 undici 8.11.2）

| Node | 内置 undici | 全局 fetch + 外部 8.x dispatcher |
|---|---|---|
| 22.19.0（engines 下界） | 6.21.2 | ✗ 缺 6 个新契约字段 |
| 24.21.0（报障者环境） | 7.29.1 | ✗ 缺 5 个 |
| 26.10.0 | 8.10.2 | ✓ **恰好**同契约 |

⚠️ **机制关键点（容易漏）**：undici **7.x** 的 `assertRequestHandler`
开头带「双契约早返回」——

```js
if (typeof handler.onRequestStart === 'function') {
  // TODO (fix): More checks...
  return            // 有 onRequestStart 就直接通过，不再查老方法
}
```

而 **8.x 删掉了这个早返回**，改为无条件要求新契约字段。这就是
「同一份 handler，Node 26 过、Node 22/24 挂」的全部来源，也是
「把外部 undici 降到 7.x 也能兼容三代 Node」的原因。

⚠️ 该「降级可行」结论已做**真实 fetch** 实测（不是只读源码判据）：
7.0.0 / 7.16.0 / 7.30.0 × Node 22.19 / 24.21 / 26.10 = **9 组全部通过**
（自建 HTTP CONNECT 中介，逐组断言 `body=origin-ok` 且中介命中 +1）。
（补记：初版只对 7.30.0 跑过真实 fetch，7.0.0 / 7.16.0 仅做过源码静态判据 ——
  自审时补齐，以免把「静态推断」写成「实测」。）

⚠️ 因此 **Node 26 上「看似正常」纯属版本巧合**，不是「跨实例 Dispatcher 被支持」。
外部 undici 升到 9.x、或用户换回 Node 22/24，都会立刻复发。
⇒ **结论与版本无关的唯一根治办法是让 dispatch 与 fetch 出自同一份 undici。**

### 修法：`proxyFetch` 收口（不允许再出现「裸 fetch + dispatcher」）

`src/opencode-proxy.ts` 新增并导出 `proxyFetch(input, init, proxy)`：

- **有代理** → 走 `undici` 自带的 `fetch`（与 dispatcher 同源）；
- **无代理**（`proxy === undefined`）→ **仍走全局 `fetch`**。
  ⚠️ 这条不是随手写的：无代理路径本来就没有 dispatcher，切实现只会白白改变
  既有直连行为。**已实测**：`NODE_USE_ENV_PROXY=1` + `HTTP_PROXY=<中介>` 时，
  Node 26 的全局 fetch 会经中介（中介命中 +2），而 Node 22 不支持该特性
  （命中 0）—— 这正是「保留全局 fetch」要护住的宿主特性。

两个调用点因此都改为经 `proxyFetch`：`opencode-adapter.ts`（chat）与
`opencode-rpc.ts`（`opencode.testProxy`，即「测试连接」按钮）。
⚠️ `buildProxyDispatcher` 仍是导出，但它只该被 `proxyFetch` 内部使用。

⚠️ **语义差异已逐条实测无影响**（换成 undici 的 fetch 之后）：

- **SSE 增量语义不变**：`response.body` 仍逐块到达（4 段 SSE 的分片数与首片耗时
  与全局 fetch 一致，未被整体缓冲）—— `consumeOpenAiSse` 依赖这条；
- **`AbortSignal` 行为不变**：1.5s 中断 3s 慢响应，两者都是 `AbortError`，耗时一致；
- **HTTPS + CONNECT 隧道**（生产 chat 的真实形态，`https://opencode.ai/zen`）
  也单独实测通过（自签 TLS 目标站 + 统计 CONNECT 次数）。

### ⚠️ 可观测性：`fetch failed` 的根因在 `cause` 里

`opencode-rpc.ts` 新增导出的 `describeFetchError(error)`：沿 `cause` 链
（最多 3 层）展开 message 与 `code`，产出 `invalid onRequestStart method ← UND_ERR_INVALID_ARG`
这样的可读串。顶层那句没有信息量的 `fetch failed` 在**后面还有 cause 可展开**时省略；
若它就是全部（没有 cause）则保留原样。

⚠️ **只取 `error.message` 是本缺陷「无从下手」的直接原因** ——
Node 的 fetch 在**任何**传输层失败（DNS / 连接被拒 / TLS / 契约冲突）时
message 恒为 `fetch failed`。排查任何 fetch 问题时先看 `cause`。

⚠️ **边界（自审实测，记录以免误判）**：

- 自引用 `e.cause = e` **不死循环**（限深挡住），输出 `Error: fetch failed`；
  环形 `a↔b` 输出 `A ← B ← A`（尾部轻微重复，无害）。
- `message` 为空串时输出空串 ⇒ 用户会看到「测试失败：」后面空着（信息量为零，
  但不会崩，且比编造一句假原因好）。
- 5 层链被限深截到 3 层（`L1 ← L2 ← L3`），符合设计。
- **凭据泄漏：实测不可达**。`normalizeProxy` 允许 `http://user:pass@…` 与
  `socks5://user:pass@…`，而本函数会原样带出 `cause.message` —— 理论上若 cause
  含 URL 原文就会把明文口令回给 UI。但真实 fetch 失败时 cause 只有
  `connect ECONNREFUSED 127.0.0.1:45999`（**不含** URL 与口令），实测两种协议均未泄漏。
  ⇒ 不作为缺陷，仅记为残余风险（upstream 若改变错误消息形态需重新评估）。
  相关的 `maskLabel()` 经实测对各种形态均正确脱敏（`user:secret@`、`user:p%40ss@`、
  `user:a@b@`、仅用户名）。

### 测试与闸门（三道，缺一会复发）

1. **接线断言**（`tests/unit/opencode-proxy.spec.ts` 的「同源不变式」段）：
   扫**整个 `src/` 目录**（不是写死文件清单，新增文件也必须被覆盖，实测 169 个 `.ts`），
   除 `opencode-proxy.ts`（唯一合法落点）外**任何文件出现 `dispatcher:` 即变红**；
   另锁 `adapter` / `rpc` 两个调用点走 `proxyFetch`、`describeFetchError` 接线。
   ⚠️ 这组断言必须**先剥注释**再匹配：注释里**故意**引用了那些反面写法
   （写用例时实测到两条假失败）。
   ⚠️⚠️ **判据必须是 `dispatcher:`，不能是「`fetch(...dispatcher:)`」**（自审实测）：
   初版写成 `/\bfetch\s*\([^;]{0,400}?dispatcher\s*:/`，**6 种等价写法漏网** ——
   最现实的一种是 `const init = { dispatcher: d }; fetch(url, init)`（dispatcher
   字面量不在 fetch 的括号里）；另有展开对象、夹分号（IIFE）、间隔 >400 字符、
   代理对象传参等。改用 `/\bdispatcher\s*:/` 后漏网降到 1 种，且**不误伤**
   属性读取 `init.dispatcher` 与类型注解 `dispatcher?: Dispatcher`（均实测）。
2. **真实联通**（`tests/unit/opencode-proxy-live.spec.ts`）：6 例全部改走 `proxyFetch`。
   ⚠️ 两处**假绿**已修掉：原先「代理不可用/不存在时失败」只断言 `rejects`，
   而契约冲突**恰好也 reject** —— 那两条在缺陷环境下「因为错误的原因通过」，
   掩盖了缺陷两轮。现在必须验 `error.cause` 的 `code`：
   真连不上是 `ECONNREFUSED`，**绝不能**是 `UND_ERR_INVALID_ARG`；
   CONNECT 被拒那例还要验到自建隧道抛出的可读错误文案。
   `DEAD_PORT` 用 45xxx（合法、无人监听、不与真实服务撞 port）。
   ⚠️ **纠正一处早先写错的理由**：曾称「`1`/`9` 落在 forbidden-port 名单里会被
   拦成 `bad port`」—— 实测**不成立**：forbidden-port **只作用于 target URL**，
   **完全不检代理端口**（proxy 端口 1/9 走的是 `connect ECONNREFUSED`）。
   当时看到 `bad port` 是因为把 **target** 写成了 `:9`，报的是目标 URL 的问题。
3. **行为用例**（`tests/unit/opencode-fetch-error.spec.ts`，11 条）：
   单层/多层 cause、带 code、无 cause、非 Error、code 已含在 message 里不重复追加；
   另含审计发现的边界：噪音层不得挤掉根因、`cause=null` 与 `undefined` 同判、空 message 不输出空串、自引用/环形不死循环。
4. **SOCKS5 端口**（`opencode-proxy.spec.ts` 的 `resolveConnectPort` 段 8 条 +
   `opencode-proxy-live.spec.ts` 的 CONNECT 帧端到端 1 条）：见下面的独立缺陷章节。

⚠️ **`vi.stubGlobal('fetch', …)` 拦不到有代理的路径**（它已改走 undici 的 fetch）：
`opencode-rpc.spec.ts` 与 `opencode-rotate.spec.ts` 里涉及代理的用例改为
`vi.mock('undici', importOriginal => ({ ...original, fetch: spy }))` ——
⚠️ 必须用 `importOriginal` 展开，**只换 `fetch`**：`ProxyAgent` / `Pool` 要保持真实，
否则 `buildProxyDispatcher` 失去构造能力，测的就不是本 provider 了。
（改完后全量 3 条红转绿；无代理的用例**仍用**全局 stub，因为那条路径刻意保留全局 fetch。）

⚠️ 替身的清理必须放 `afterEach`，**不要**在各用例里手写 `mockReset()`：
手写版一旦某条断言中途抛错，那行 `mockReset()` 就被跳过，被污染的替身会
**泄漏到下一条用例**（表现为随机性假失败，极难排查）。两个文件均已收进 `afterEach`。

### ⚠️⚠️ 同源修复**顺带挖出**的独立缺陷：SOCKS5 走默认端口时 CONNECT 帧端口写成 0

**同一轮实测（2026-10-08）发现，与 IKK4BY 同源但独立**：修好「fetch 同源」后
用真实 `https://opencode.ai/zen` 复测 SOCKS5，仍报
`SOCKS5 代理在握手完成前关闭了连接`。往下查发现 CONNECT 帧里的端口是 **0**。

**根因**：旧的端口解析写的是

```ts
const port = Number(opts.port ?? 443)
```

而 undici 传给 connector 的 `opts.port` 在**默认端口**时是**空字符串 `""`**、
**不是 `undefined`**（实测 undici 8.11.2；`opts` 全部键为
`host,hostname,protocol,port,servername,localAddress`）：

| 目标 URL | `opts.port` | `Number(opts.port ?? 443)` |
|---|---|---|
| `https://opencode.ai/zen/...`（默认 443） | `""` | **0** ← 坏 |
| `https://example.com:8443/` | `"8443"` | 8443 ✓ |

`??` 只兜 `null`/`undefined`，**兜不住空串** ⇒ `Number("") === 0` ⇒ CONNECT 帧
端口写成 `0x0000` ⇒ 上游按端口 0 连接**必然失败**。

**影响面正好是生产主路径**：`OPENCODE.baseUrl = https://opencode.ai/zen`（默认 443）
⇒「SOCKS5 代理」在修复前是**恒不可用**的（HTTP 代理不受影响，它不走这条 connector）。
三代 Node（22.19 / 24.21 / 26.10）一致复现，**与 Node 版本无关**。

**实测证据**（自建 SOCKS5 中介记录它收到的 CONNECT 目标）：

```
修复前：CONNECT → "opencode.ai:0"        → 失败（应答码 0x5）
修复后：CONNECT → "opencode.ai:443"      → HTTP 400（服务端正常应答，链路通）
显式端口对照：CONNECT → "example.com:8443" → 通过（修复前后都通过）
```

**修法**：抽出可单测的纯函数 `resolveConnectPort(opts)`，三层兜底 ——
① 空串/`null`/`undefined` 视为「未指明」；② 解析后必须是 **1..65535 的整数**，
否则回退；③ 按协议给默认值（`https:`/`wss:` → 443，其余 → 80）。
⚠️ **不复用 443 作通用兜底**：http 目标回退到 443 会把「端口没给对」伪装成
「连不上」，掩盖真实原因。

⚠️ **为什么必须配一条端到端用例**：纯函数用例覆盖不了「undici 真的传空串」这一步。
端到端手法是**绕过 `fetch`、直接驱动 dispatcher** 打一个**无显式端口**的 origin：

```ts
dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET', headers: {} }, handler)
```

并**从 CONNECT 帧里读出端口**断言为 443（实测：`example.test:443` / `example.test:80` /
`example.test:8443` 三种形态都正确）。用 `proxyFetch(url)` 构造不出这个场景 ——
URL 解析层不会暴露「端口缺省」这一步。

⚠️ 反向验证：把实现改回 `Number(opts.port ?? 443)` ⇒ **2 条独立用例变红**
（纯函数接线闸 + 端到端 CONNECT 帧断言）。两条各自锁死，别删其中任一条。

⚠️ 记录一个测试期望的坑：`Number('0x50') === 80` 且 80 是**合法端口**，
故 `'0x50'` **不该**回退到 443（我最初把它当非法值，实测红了）。
这是 JS 数字字面量语义，不是解析缺陷，已单独写用例记录。

### ⚠️ 已知的**同族缺口**（未修，超出本 issue 范围，留待后续）

`src/index.ts:2121` 的 `fetchRemoteCatalog` 拉 `https://opencode.ai/zen/v1/models`
（模型目录）时**不传 dispatcher** —— 即「配了代理的账号，目录仍走本机直连出口」。
它的 `slot.proxy` 是**可用**的（`IdentitySlot` 上就有该字段），只是没被用。

- 它是 `7dd3422` 引入的 **pre-existing** 问题，**不是**本次提交造成的；
- 它**不触发** IKK4BY 的机制（没有 dispatcher 就不会有跨实例断言冲突）；
- 影响面限于**模型可见性**（`listModels` / 目录），**不影响对话**（对话走 `stream()`，已修）；
- 修法显然是改走 `proxyFetch(url, init, slot.proxy)`，但会改变「目录经由哪个出口」
  的行为（含缓存按槽 id 分开存的语义），**需单独评估**，故本次不动。

### 反向验证（变异各自独立锁死，别当同义反复删掉）

| 变异 | 结果 |
|---|---|
| `proxyFetch` 改回全局 `fetch`（还原缺陷） | live **5 条红** + 接线断言 **1 条红** |
| `adapter` 调用点改回「裸 fetch + dispatcher」 | 接线专项断言 **2 条红**（⚠️ 见下方补充） |
| `describeFetchError` 改回只取 `error.message` | `opencode-fetch-error` **3 条红** |
| 去掉 `init instanceof Request` 守卫（审计发现 C） | live 的 Request 用例 **1 条红** |
| `describeFetchError` 退回「单 depth 计数 + cause!==undefined」（审计发现 D） | `opencode-fetch-error` **2 条红** |
| SOCKS5 端口改回 `Number(opts.port ?? 443)`（本轮独立缺陷） | **2 条红**（纯函数接线闸 + CONNECT 帧端到端） |

⚠️ 补充（对抗性审计实测）：第 2 行那个「接线闸 2 条红」里，**`src/` 总闸对修复前的
adapter 写法其实是漏网的** —— 真正拦住它的是 adapter 专项断言 `/buildProxyDispatcher/`。
即「总闸能覆盖新增调用点」这个假设当时并不成立（已在下面第 1 条修掉）。
教训：**总闸的判据要单独做一次「对已知缺陷形态的召回测试」**，别假设它自然覆盖。

### ⚠️ 对抗性审计（2026-10-08）发现的四条（已全部落地修复）

对提交做了一轮独立对抗性审计（只读、约束不可改仓库）。**修复本身成立、核心机制与
三条反向验证均被独立复现**；以下四条是审计揪出的实质问题，均已修 + 补测 + 反向验证：

1. **总闸判据两度被绕过**（最值得修，因为它保护的正是「下次有人加调用点」）：
   - 初版 `/\bfetch\s*\([^;]{0,400}?dispatcher\s*:/` → **6 种等价写法漏网**
     （`const init = { dispatcher: d }; fetch(url, init)` 最现实）；
   - 二版 `/\bdispatcher\s*:/` → 仍漏 `{ ['dispatcher']: d }` 与 `[k]` 模板键；
   - 现版 `/\bdispatcher\b/`（**只用于扫 `src/`**）→ 7 种写法零漏网、`src/` 零误伤
     （大小写敏感，故 `Dispatcher` 类型名与 `closeAllProxyDispatchers` 不命中）。
   ⚠️ **测试文件不能套最严判据**：live spec 有用例名 `'per-request dispatcher 生效'`
   这类正当措辞，套了会假失败（实测踩到）—— 故测试文件用 `/\bdispatcher\s*:/` 分层。
2. **`proxyFetch` 不接受 `Request` 作 `init`（新增显式守卫）**：`{ ...init }` 展开
   `Request` 得到**空对象** ⇒ 请求**静默降级**为 GET、丢 body 与 headers
   （实测：全局 fetch 传 Request 是 POST+body，展开后变 GET 空体）。
   这比抛错更危险，故入口 `instanceof Request` 直接抛。三个调用点今天都不传 Request，
   属**防御性**修复。
3. **`describeFetchError` 的「噪音层挤掉根因」**：旧实现用**同一个 depth 计数**
   兼任「遍历上限」与「输出条数上限」，于是 `fetch failed` 这类无信息量层会
   **白白吃掉输出预算**。实测反例：
   `outer → mid → fetch failed → connect ECONNREFUSED` 旧输出 `outer ← mid`（**根因丢失**）。
   现拆成 `TRAVERSE_CAP=8`（防环形）+ `MAX_PARTS=3`（控可读性）。
4. **`cause = null` 未与 `undefined` 一视同仁**：旧判据写 `cause === undefined`，
   于是 `null` 走进「无 cause」分支，输出带 `Error: ` 前缀的噪音（实测 `Error: fetch failed`）。
   改用 `cause != null`。另：空 message 不再输出空串（UI 会显示成「测试失败：」后空白）。

### 实测基线（修复后，三版本一致）

`pnpm test` 全量：Node 22.19 / 24.21 / 26.10 均 **6716 passed / 0 failed / 5 skipped**。
（基线对照：修复前 master 是 `6522 passed / 2 failed`；本轮修复后首轮全绿 6701，
自审加固 +5 → 6706，再补 SOCKS5 端口缺陷 +10 → **6716**。）
⚠️ **修复前 Node 22.19 与 24.21 上是 `2 failed`**（就是本 issue 的那两条 live 用例）。
⚠️ **Node 26 上「能否工作」的端到端实测**（真实出网，本机可直连 opencode.ai）：
经自建代理打 `https://opencode.ai/zen/v1/models` → **HTTP 200**、CONNECT 隧道目标
`opencode.ai:443`；SOCKS5 形态 → 端口修复后 **HTTP 400**（服务端正常应答，链路通）；
SSE 逐块到达（0/43/89ms 三片）、并发 5 全 200。⇒ **Node 26 上工作正常**，
且该版本上「旧写法」也恰好能过（内置 8.10.2 与外部 8.x 同契约）—— 属版本巧合而非修好。

⚠️ **一条 pre-existing flaky（与本修复无关，已用 master 基线证实）**：
`tests/unit/aggregate-expiry.spec.ts:154`（`★ 清单里的每个渠道都真的走过了折算路径`）
偶发 `Test timed out in 5000ms`，实测频率约 **1/5 ~ 1/6**。

- 与本修复**无关**的三条证据：① 该 spec 未在本次改动中被触碰；② 它 import 的是
  `aggregate-core.js` / `lobsterai-product.js` / `trae-product.js`，而
  `aggregate-expiry.ts` 也不 import 本次改过的任何文件；③ `WIRED_EXPIRY_PROVIDERS`
  **不含 `opencode`**（只有 buddy / workbuddy / loomy / codearts / zcode / lobsterai / trae）。
- **决定性证据**：用 `git worktree add <dir> master --detach` 拉出**未含本修复**的
  master 基线，同一台机器同一 Node 跑 6 次，同样出现 **1 次失败**。
- ⇒ 全量跑看到它变红时，**先看失败项是否落在自己改过的文件上**，别记到本次账上。
  ⚠️ 但也别当噪音永久放过（本 issue 的教训正是「把红用例当环境性问题放过」）——
  它值得**单独开 issue** 查「为什么逐条遍历 7 个渠道会偶发超过 5s」。

### ⚠️ 为什么这个缺陷能进主干（值得记住的教训）

`git log` 显示它由 `7dd3422`（2026-10-02，新增 OpenCode Zen provider）引入，
此后 `opencode-proxy.ts` 未改。进主干的路径是**两次被当成「环境性问题」放过**：

- `PR-描述.md`：「那 2 条失败与本 PR 无关……属**环境性问题，非代码回归**」；
- `docs/GEMINI-PORT-PLAN.md`：「undici 8.11.2 的环境性不兼容，**移植前基线同红**」。

两次判断都**基于真实观察**（确非那两个 PR 引入、基线确实同红），但结论下错了 ——
「非本 PR 引入」不等于「不是缺陷」。而且更早还有第三重掩盖：
该 spec 的 2 条「代理不可用」用例**因为错误的原因通过**（见上文假绿）。
⇒ **教训**：看到「基线同红 / 环境性问题」时，要么查清根因，要么**留一条会持续报警的闸**；
把红用例当背景噪音放过，等于让一个「provider 完全不可用」的缺陷安静地留在主干里。
