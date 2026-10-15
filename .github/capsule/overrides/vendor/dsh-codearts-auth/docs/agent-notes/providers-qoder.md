<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ 安装（git 插件）的 allowBuilds 键在 pnpm 10 / 11 语义**互不兼容**（Issue IKJCOC）

**用户报障**（2026-09-30，Gitee issue IKJCOC）：「DSH Desktop 内置 pnpm 下
`dsh plugin add` 安装失败：allowBuilds 的 git URL 键触发
`ERR_PNPM_INVALID_VERSION_UNION`」。报错里 `Found:` 的那个键，正是当时 README
「方式一」与本仓库 `pnpm-workspace.yaml` 里那行
`dsh-codearts-auth@git+https://gitee.com/iJetLi/deepseek-harness-codearts.git`。

**实测结论：这不是"换个键写法"就能了事，而是两代 pnpm 的键语义互不兼容** ——
同一个键在一代上"非法"、在另一代上"合法但永不匹配"。本机实测（Windows 11，
2026-09-30；依赖侧统一用**本地 git 仓库**里的同名包，带 `prepare` 脚本，
⚠️ **每个变体都换一个新 commit**，因为 pnpm 的 side-effect cache 命中时会跳过
allowBuilds 判定，不换 commit 会得到假的"成功"）：

| `allowBuilds` 键 | pnpm 10.28.0 | pnpm 11.7.0 |
|---|---|---|
| `dsh-codearts-auth@git+<url>`（旧 README / 旧仓库写法） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ❌ `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（缺 `#commit`，永不匹配） |
| `dsh-codearts-auth@git+<url>#<当前commit>`（**pnpm 自己打印的键**） | ❌ `ERR_PNPM_INVALID_VERSION_UNION` | ✅ 放行成功 |
| `dsh-codearts-auth@git+<url>#<旧commit>` | — | ❌ `NOT_ALLOWED`（换 commit 即失效） |
| `dsh-codearts-auth`（纯包名；**issue 建议的"已验证修复"**） | ✅ 放行成功 | ❌ `NOT_ALLOWED` |
| `dsh-codearts-auth@0.1.0`（精确版本） | — | ❌ `NOT_ALLOWED` |
| `dangerouslyAllowAllBuilds: true`（顶层） | ✅ | ✅ |
| `add --allow-build=dsh-codearts-auth`（CLI） | — | ❌（它只写入纯包名键，本次仍不放行） |

- pnpm 11.7.0 取自本机安装的 DSH Desktop：
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\pnpm`
  （`DeepSeek Harness.exe` 的 FileVersion `0.2.0-rc.2`）；pnpm 10.28.0 用
  `npx pnpm@10.28.0`（issue 报告的内置版本是「10.28.0 定制构建」，与本机这版**不同**，
  故两代都必须覆盖）。
- ⚠️ **issue 建议的纯包名键不能直接采纳**：它只在 pnpm 10 上有效。pnpm 11 的
  `createAllowBuildFunction` 里
  `trustPackageIdentity = name && version && !nonSemverVersion` —— git 包的
  `nonSemverVersion` 非空 ⇒ 直接 `return undefined`，**纯包名/精确版本键一律不参与匹配**，
  只有 `allowedDepPathBuilds` 里的 `name@git+...#sha` 能命中。
- ⚠️ **pnpm 10 的坑更深：它连自己打印的键都拒绝**。11.7.0 有 `isDepPathAllowBuildKey()`
  把含 `:` / `/` / `#` 的键当 depPath 键，从而**绕开**版本并集解析；10.28.0 没有这层保护，
  所有键都走 `parseVersionPolicyRule()` → `semver.valid('git+https://…')` 为 `null` →
  抛 `INVALID_VERSION_UNION`。⇒ pnpm 10 上「复制 pnpm 打印的键」这条官方提示**走不通**，
  只能写纯包名键或 `dangerouslyAllowAllBuilds: true`。
- ⚠️ **失败表现的版本差异**（排查时先看这个）：本机 desktop（11.7.0）**不复现**
  `ERR_PNPM_INVALID_VERSION_UNION`，而是报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；
  两者根因同为"那个键不可用"。**不要**因为报错文案与 issue 不一致就判定"desktop 下没问题"。
- ⚠️ **pnpm 只对 git 托管包打印提示、不写占位符**（实测 `pnpm-workspace.yaml` 未被改动），
  所以 DSH 的「允许这些脚本并重试」按钮覆盖不到 git 插件安装 ——
  `readPendingBuilds`（`packages/boot/plugin-manager/src/build-approval.ts`）只认值为
  `set this to true or false` 的条目。用户只能手写键。这属 DSH 侧可改进项，不在本仓库范围。

**端到端复现与修复验证**（本机、离线、不动工作区；`git clone` 到临时目录后按场景改写
并 **commit** —— ⚠️ pnpm 取的是**提交内容**，只在工作区覆盖文件是无效的，第一次就这么白跑了一遍）：

| 场景 | 结果 |
|---|---|
| 修复前（仓库保留那行 git 键）+ pnpm 10.28.0，profile 已按 issue 写纯包名键 | ❌ 插件自己的 `pnpm install` 阶段：`ERR_PNPM_INVALID_VERSION_UNION … Found: "dsh-codearts-auth@git+https://…"` → `ERR_PNPM_PREPARE_PACKAGE … Exit status 1`（issue 描述的第二个失败点，原样复现） |
| 修复后（删掉那行键）+ pnpm 10.28.0 + profile 纯包名键 | ✅ install + `prepare`（tsc / copy-assets / client 打包）跑通，`lib/index.js` 产出 |
| 修复后 + DSH Desktop 内置 pnpm 11.7.0 + profile 精确键（`…#<commit>`） | ✅ 85 个依赖装好、`esbuild` postinstall 执行、`prepare` 全跑通（`lib/qoder-auth-wasm.wasm`、`lib/client/jet-hub.js` 均产出） |

⇒ **两条不要改回去的红线**：

1. **本仓库 `pnpm-workspace.yaml` 里不得出现 `包名@git+URL` 键**。本包不依赖
   `dsh-codearts-auth`，该键永远匹配不上；而在 pnpm 10.x 下它会**毒化整个 clone**：
   从 git 安装时 pnpm 要在 clone 里跑 `pnpm install`，读到这行即抛
   `ERR_PNPM_INVALID_VERSION_UNION`，`prepare`（`pnpm build:all`）根本起不来。
   （`esbuild: true` 必须保留 —— registry 包的版本是 semver，纯名键在两代都生效。）
2. **README「方式一」的放行键必须按 pnpm 大版本分别给出**，不能把某一代的写法写成通用解。
   唯一跨版本可用的是 `dangerouslyAllowAllBuilds: true`（代价：放行该 profile 里所有依赖的
   构建脚本）。改完请照上表重跑一遍验证 —— 尤其**要换新 commit**，否则缓存会骗你。

## ⚠️ 额度类业务码**不是一个值，是一条链** —— 只认 `110` 会让换号静默失效（Issue IKKJFH）

**用户报障**（2026-10-10，Gitee issue IKKJFH，provider `qoder` 国内版）：

```
本轮运行失败  qoder: {"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"} (112/model_error)
模型请求重试已取消 (2/5)
```

观感是**「轮换没生效」**：白退避、重试计数走到 2/5，期间**既没换号也没换 provider**。

**根因**：`src/model-queue.ts` 的额度判据原先**只认单码值 `110`**，
`isBillingBusinessCode('112')` 为 false，文案兜底 `looksLikeBillingError` 也不含
`pricingUrl` ⇒ 三个判据全 false ⇒ 落 `SERVER` ⇒

1. `SERVER` **在** harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒ **白退避 5 次**；
2. `qoder-adapter.isQuotaExceededError(SERVER) = false` ⇒ `switchAccountOnQuota`
   **永不被调用** ⇒ **既不换号、也不换 provider**。

⚠️ 这与 2026-09-27 那次 `110` 缺陷**完全同型，只是换了码值**。

### 两条判据腿**必须同时在**，缺一条下次换码值就复发

- **码值腿**：`BILLING_BUSINESS_CODES = ['110', '112']`
  （`BILLING_BUSINESS_CODE` 保留为单值再导出，仅为对外 API 兼容，**判据别用它**）；
- **文案腿**：`looksLikeBillingError` 增认结构字段 `"pricingUrl"\s*:`。

⚠️ **`pricingUrl` 是窄词**：它是该错误报文的**结构字段名**，不是自然语言。
判据是**认结构字段，不认主题词** —— 实测 `balance` / `quota` / 正常讨论 pricing 的正文
都不含这个键名，故不会误伤（单测有反向断言锁住）。

### ⚠️ 证据强度（如实标注，别当成客户端产物实证）

`110` 当年的取证是**读客户端 obf 产物原文**（`billing_error → permission`）。
`112` **没有**那份证据：本机未装 Qoder 客户端 ⇒ 无产物可读；上游全历史搜
`pricingUrl` **零命中**。现有依据是**报文语义**（定价页链接 = 付费才能用）＋
**兄弟码同类**。若哪天能拿到客户端产物，欢迎修正 `112` 的语义。

### 反向验证（四条各自独立，别当同义反复删掉）

| 变异 | 变红用例 |
|---|---|
| 集合改回 `['110']` | 纯函数「110 与 112 都算额度」 |
| 正则撤掉 `"pricingUrl"` | 「pricingUrl 报文算额度」＋「无业务码只有 pricingUrl 文案」 |
| **源码整体回退到修复前** | **6 条**（含行为用例「112 同样触发换号」） |

⚠️ 「归 `QUOTA_EXCEEDED`」与「真的切了号」是**两件事** ——
`switchAccountOnQuota` 在无池/无候选时会返回 `undefined` 而码仍然正确。
故 `112` 必须有一条**走完整行为链**的用例（标记 → 取号传 tried → 换号重发 → 拿到内容），
只断言错误码会漏掉 issue 现象的另一半。

### 顺带记录：`qoder-adapter.ts` 的 `isBillingBusinessCode(response.status)` **恒 false**

HTTP 分支那条判据（`src/qoder-adapter.ts:809` 附近）把 **HTTP 状态码**传给了判**业务码**的
函数 —— 两者是不同命名空间（业务码是 `110`/`112`，状态码是 `2xx/4xx/5xx`），
实测 `200/400/401/403/429/500/502` 逐个喂进去**全部 false**（`110`→true）。
该分支实际只靠右边的 `looksLikeBillingError(errorText)` 兜住。
**本次未改**（不在 IKKJFH 范围内）：注释里写明是「为服务端将来改用 HTTP 状态码下发而预留」，
是否要补「从 body 里解析业务码」那条腿属独立决策，交维护者判断。

## ⚠️ 渠道原生搜索（2026-10-14 接入）

Qoder 客户端**自带** WebSearch 能力，与聊天同源同账号。本插件把它接到官方
`web_search` 工具上（`QoderAdapter.searchOnce`，见
`src/native-search-contract.ts` 的契约说明）。

### 端点与请求形状（全部来自官方客户端源码 + 真机实测）

| 项 | 值 |
|---|---|
| host | 本产品的 `encryptedInferBase`（CN = `gateway.qoder.com.cn`；国际实测 `center.qoder.sh` / `api2.qoder.sh` / `gateway.qoder.com.cn` **都能通**） |
| path | `/api/v1/webSearch/oneSearch` |
| method | `POST` |
| 鉴权 | **WASM 签名**（`prepareRequest(host, path, 'POST', 'auth', body)`，本插件已实现于 `src/qoder-wasm.ts`） |
| 请求头 | `Authorization: Bearer COSY.<载荷>.<签名>` + 18 个 `Cosy-*` 头（全由 WASM 生成）+ `X-Session-ID` |

**明文 payload**（信封内层）：
```json
{ "query": "…", "timeRange": "NoLimit",
  "contents": { "mainText": false, "markdownText": false, "summary": false } }
```

**明文 body**（信封外层）：
```json
{ "payload": "<上面那个 JSON 的字符串>", "encodeVersion": "1" }
```

**响应**：`{ requestId, pageItems: [{title, link, snippet, publishedTime, hostname, hostLogo}], searchInformation: {searchTime} }`

### 源码依据（`qoder-worker-runtime.obf.mjs`，asar.unpacked 里）

```js
p0d = "/algo/api/v1/webSearch/oneSearch"
$bt = class { async search(A) {
  let e = { query: A.query, …, timeRange: "NoLimit",
            contents: { mainText: false, markdownText: false, summary: false } }
  return (await this.sender.send(mi.builder().operation("webSearch.search")
    .endpoint("webSearch").post(p0d).withSignature("auth")
    .json({ payload: JSON.stringify(e), encodeVersion: "1" }).build())).json(m0d)
}}
// path 另有 `/api/v1/webSearch/unifiedSearch`（通义灵码环境走它）
function APl() { return ePl() ? "/api/v1/webSearch/unifiedSearch" : "/api/v1/webSearch/oneSearch" }
// endpoint host：webSearch 与 center **同一个 host**
poe = { prod: { center: `https://${Mme}`, webSearch: `https://${Mme}`, … } }
```

### ⚠️ 四个不能改错的点

1. **`hostname` / `hostLogo` 必须丢弃**：官方 output schema 是
   `additionalProperties: false`，多传字段会让 `createSuccessResult` 抛
   `ToolOutputError`，**整条调用失败**（不是少一条结果）。
   ⚠️⚠️ **但 `publishedTime` 属于另一格**（2026-10-14 PR95 审计修正）：官方
   `dsh-tool-web` 的 output schema 与 seam 的 `WebSearchSource` **都**声明了
   可选的 `publishedAt?: string`（「provider 给的发布时间戳」）—— 原注释把三个
   字段一锅端说成「schema 不允许」，对 `publishedTime` **不成立**。
   **当前刻意仍丢弃**：接它要先真机确认 Qoder 下发的是 ISO-8601 字符串，
   接错的代价是整条调用失败，收益（多一列时间）不抵风险。**待办**。
2. **url 字段叫 `link`**（腾讯叫 `url`）—— 投影时必须改名。
3. **WASM 实例必须 `dispose`**：`QoderContext` 是 wasm 堆上的 Rust 对象，
   `gluePromise` 是进程级单例，不释放会让堆只增不减 → 长上下文会话最终以裸
   `RuntimeError: unreachable` 暴毙（真实事故史见 `qoder-wasm.ts` 文件头）。
4. **两处 path 别混**：`oneSearch` 是默认；`unifiedSearch` 只在通义灵码环境下用。

### 与腾讯（buddy 系）的差异对照

| | 腾讯 | Qoder |
|---|---|---|
| 端点 | `/agenttool/v1/search` | `/api/v1/webSearch/oneSearch` |
| 参数 | `{query, type:'text2text', max_results}` | `{query, timeRange, contents}` |
| 鉴权 | `Bearer <access_token>` | **COSY 签名（WASM）** |
| 信封 | 明文 JSON | `{payload, encodeVersion}` + 加密 body |
| 结果字段 | `results[].{title,url,snippet}` | `pageItems[].{title,link,snippet,…}` |
| 上限 | 8（上游实测封顶） | 实测返回 10 条（本插件仍按官方 `MAX_RESULTS=8` 截断） |

### 实测记录（2026-10-14）

- CN 免费账号（`qfmodel` 所在的号）：`POST https://gateway.qoder.com.cn/algo/api/v1/webSearch/oneSearch?Encode=1` → **HTTP 200**，
  返回 10 条 `pageItems`。
- **与客户端真实调用逐条对比**（客户端侧证据取自本机
  `~/.qoder-cn/projects/…/d6bb315c-….jsonl` 的真实会话记录）：
  **URL 10/10 一致、标题 10/10 一致、顺序完全一致**。
- `searchInformation: { searchTime: 371 }` 是搜索耗时，客户端**未使用**该字段。

### ⚠️ 未验证

- 官方还有第二个后端：`tools.webSearch.provider = bailian`（阿里百炼 MCP，
  `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp`，需 Bailian API Key）。
  本插件**未接入**它 —— 默认走 `qoder` 后端（用户机器上也是默认）。
- 国际版（`qoder` 非 CN）的搜索 host 官方源码写的是 `center.qoder.sh`，
  实测三个 host 都能通；本插件用 `product.encryptedInferBase`（`api2.qoder.sh`）。
