# OfficeAce（华为 MaaS / 果办）provider 笔记

> 来自 PR #89 的三轮审计（接线审计 / 展示层审计 / 对抗性审计）。
> 每条都是**实测**或**逐行核对**得出的，不是推测。

## 0. 它是什么

华为云 ModelArts MaaS 的桌面客户端「果办」背后的云端 API。第 15 个 provider，
id = `officeace`，服务名 `officeaceAuth`。登录/推理/续期/余额/倍率**五项云端直连**，
不需要安装或运行果办客户端（对抗审计逐字段核对后确认该声称成立；本地 API
降级链只存在于 `ref === undefined` 的老单账号兼容路径，生产 RPC 恒传
`credentialRef` 故走不到）。

## 1. 协议要点

| 项 | 端点 | 鉴权 |
|---|---|---|
| 登录 | 华为云 OAuth PKCE（`client_id='pdp5_for_agentarts'`，公开客户端无 secret） | code_verifier + ES256 DPoP JWT |
| 推理 | `POST {maas}/v2/chat/completions` | `Basic base64(model_app_key:secret)` |
| 续期 | `POST sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens` | refresh_token（**30 天且一次性**）|
| 余额 | `GET {base}/v1/subscription` | V11-HMAC-SHA256 |
| 倍率 | `GET {base}/v1/model-token-rates` | V11-HMAC-SHA256 |

### ⚠️ V11 签名的三条铁律（各自都曾导致 APIG.0301，别凭直觉改）

1. **GET 请求不发 `Content-Type`** —— 多这一个头，签名串多一行，服务端重算必不匹配
   （`officeace-auth.ts` 的 `signAndRequest`：`if (method === 'POST') original['Content-Type'] = contentType`）。
2. **密钥派生用 hex 字符串作 key，不是 raw bytes**：
   `HMAC(sha256, ak).update(sk)` → 拼 scope + `0x01` → 取前 32 字节 →
   **`.toString('hex')`** → 再 `Buffer.from(derivedKey, 'utf8')` 当 HMAC key。
3. **分隔符是 LF**（canonical 头行与 stringToSign），不是空格；路径**强制尾斜杠**。

### ⚠️ `expires_at` **没有**秒/毫秒混淆 —— 别"顺手"加归一化

华为 STS 的 `expiration` 是 **ISO 8601 字符串**（`IamTokenResponse.credentials.expiration: string`），
消费侧一律 `Date.parse(...)`。故 buddy / lobsterai / accio 那条 `> 1e12` 防御分支
**对 officeace 不适用**，加了反而是错。这是「同族只共享信封骨架，不共享每个字段形状」的又一例。

### ⚠️ DPoP 私钥**必须复用同一把**

`generateDpopKeyPair` 只在 `startLogin()` 调一次，私钥 JWK 持久化进凭据，
续期时 `importDpopPrivateKey(current.dpopPrivateJwk)`。换一把 ⇒ 服务端拒绝。
payload 必须齐 `{htm, htu, iat, jti}`；**无 `ath` 是正确的**（RFC 9449：没有 access token 时省略）。

## 2. ⚠️⚠️ 续期三条规则（2026-10-13 审计补齐，此前一条都没有）

**背景**：`refresh_token` **一次性**，而三条入口（定时器 `refreshAll` /
适配器 401 兜底 / `account.refresh` RPC 与积分自愈）会并发进入同一个 ref。

初版实现的三个缺陷：

| 缺陷 | 症状 |
|---|---|
| `refreshAccountCredential` **直连** `doRefreshCredential`，无锁 | 并发时先到者消费 token、后到者拿 STS5.1806；先到者写盘前被打断 ⇒ **新 token 永久丢失，只能重新登录** |
| **无任何过期判据** | 定时器每 30 分钟续期一次 ⇒ **一天烧掉 48 个一次性 token**（STS 寿命约 2 小时，根本不需要） |
| 失败时**不回读凭据** | 并发下把「他处已续成功」误判成本账号失效 ⇒ 永久标死 |

⚠️ **原先的 `refreshInFlight` 闸只加在 `refreshStoredCredential` 那条「兼容文件腿」上，
生产主路径完全绕过它** —— 这是最隐蔽的一种错法：**加了锁，但加错了一条腿**。

现已按 codearts 的同款三件套补齐（`refreshAccountCredential` 内）：

1. **per-ref `SerialQueue`**（`queueFor(refName)`，队列表上限 64，超额淘汰最早创建者）；
2. **锁内重读 + lead-time**：拿到锁时凭据可能已被上一轮换新，距过期还早时
   只对账池值、**不发请求**（`shouldRefreshNow`，lead = 1 小时）；
3. **判终态前重读**：续期被拒时先看磁盘那份 `refresh_token` 是否**已经不等于**
   本次用的那份 —— 并发下服务端烧掉的是**旧的**一份，磁盘上此刻躺着**新的、可用的**
   凭据，那是「他处已续成功」而不是「本账号失效」。

守卫：`tests/unit/officeace-refresh-guards.spec.ts`（5 条，逐条做过反向验证）。

## 2.5 ⚠️⚠️ 批量续期把**同步**池当 Promise（Issue IKLPTZ，2026-10-14 报障）

**症状**：宿主每次启动 + 每 30 分钟一轮，日志固定一条
`[jet-hub] officeace 批量续期失败：p.listAccountsByProvider(...).catch is not a function`，
被 `refreshAllCredentials` 逐 provider `try` 吞成 warn ⇒ **界面零提示**，
OfficeAce 的**批量**续期整条失效。

### 双重误判：一个 bug 被复制了两遍

```ts
const accounts = await p.listAccountsByProvider('officeace').catch(() => [])
```

`AccountPool.listAccountsByProvider` 是**同步**方法（`src/account-pool.ts`
返回 `ProviderAccountEntry[]`），数组没有 `.catch` ⇒ 恒抛 `TypeError`。

⚠️⚠️ 该行在**两处**逐字出现（连注释都相同）：

| 位置 | 角色 |
|---|---|
| `src/officeace-auth.ts` 的模块导出 `refreshAll` | 兼容文件腿 |
| `src/index.ts` 的 `officeaceAuthService.refreshAll` | **定时器实际走的是这份**（`ctx.credentials` 只能在那里注入）|

⇒ 只修一处会让另一处继续静默失效。

**类型系统为什么没拦**：两处都把形参声明为 `unknown` 再**内联断言**收窄，
其中返回值写成了 `Promise<…>`；断言直接覆盖 `unknown` 的推导结果 ⇒ `tsc` 全程通过。
⚠️ **别声称「加了结构化接口就能拦住它」**：`unknown as X` 恒被允许。
真正有牙的是：① 行为用例；② 结构上**只留一份遍历实现**
（`refreshAccountList`，两处只提供各自的 `refreshOne` 分派）。

⚠️ **如实标注那句「编译期写不出来」的射程**（2026-10-14 复审）：本函数**当前那句
赋值**处写不出来（`accounts` 显式标注为数组，`.catch` 与 `for…of Promise` 都编不过），
但**换个地方重新断言**一份 Promise 版本（`?.(…).catch()`、跨行 + 非空断言）
`tsc` **仍然全绿**（复审实测 exit 0）。⇒ 拦截力来自「只有一份实现」，不是类型。

### ⚠️ 登记行为变更（**两处**；第一版只登记了一处、且登记错了格子）

⚠️⚠️ 本节曾被**对抗性审计打穿**：第一版写「池返回 rejected Promise → 等价」，
实测那格**根本不是等价**，而是新代码**抛 `TypeError: accounts is not iterable`**
（`accounts.length===0` 对 Promise 为 false ⇒ 进 `for…of` 抛）——**连兜底都绕过**，
比修复前的行为更糟。⇒ 已修（接受两种形态）并更正如下。

`refreshAccountList` 与修复前相比共**两格**不同：

| 池返回 | 修复前 `await ….catch(…)` | 现（`await` + `Array.isArray` 归一） |
|---|---|---|
| 数组（生产实际形态） | 逐个续期 | 逐个续期（**等价**） |
| Promise（resolved 数组） | 逐个续期（`await` 到了数组） | 逐个续期（**等价**，已恢复） |
| Promise（rejected） | 吞成 `[]` ⇒ 兜底 | 兜底（**等价**，已恢复） |
| 非数组（形状不符） | `accounts.length` undefined ⇒ `for…of` 抛 | 归入「空池兜底」（**刻意变更**：不再抛） |
| 池**同步 throw** | **逃逸出 `refreshAll`**（`.catch` 接不住同步 throw，已实测） | 吞成 `[]` ⇒ 兜底（**刻意变更**） |

⇒ **刻意的变更只剩两条**（非数组、同步 throw），方向都是「归入空池兜底而不是抛」。
理由：`refreshAllCredentials` 的语义是「单个 provider 失败不阻断其余」，
而读池抖动/桩写错不该让 OfficeAce 整条从续期表里消失（那正是 IKLPTZ 的症状）。
按本仓库惯例**必须登记**（`provider-abstraction-g3-exceptions.md`）。

⚠️ **「只接受同步池」这条收紧已被撤销**：它把「调用方给了 Promise」从「能用」
变成「抛错」，是**新引入的回归**（审计实测旧代码能跑、新代码抛）。生产池是同步的
⇒ 那格**当前不可达**，但不可达不是等价 —— 已恢复兼容。

守卫：
- `officeace-refresh-all.spec.ts` 用例⑤（读池抛错时 `fallbackRefresh` **真被调用一次**；
  改成静默 `return` 即变红）；
- 用例⑤b（**Promise 池**必须与数组池等效：逐个续期、不抛）；
- 用例⑤c（**非数组**归入兜底、不抛 `TypeError`）。

**影响面（如实）**：只坏**批量/定时**续期；适配器的按需续期走
`refreshAccountCredential`（401 兜底 / `credentialProvider`），不经过这两行 ⇒ 仍可用。

### 连带发现 ①：修复后暴露了一处**被缺陷遮蔽**的测试失败

`jet-hub-rpc-auth-wiring.spec.ts` 的「每个 provider 的续期只分派到自己实例」
在缺陷在场时**是绿的** —— 因为 `apply()` 内部的
`void refreshAllCredentials()`（fire-and-forget 首轮）跑到 officeace 就抛
`TypeError`，**背景噪声根本不产生**。修好后首轮走通并调用
`refreshAccountCredential`，噪声混进断言 ⇒ 误报「codearts 轮分派错位」
（实际 `['officeaceAuth','codeartsAuth']` —— **codearts 是对的**，多的是噪声）。

修法是**在开始测量前把背景链跑完并清空记录**（`setup()` 改 `async` +
`settleBackground()`），**不是放宽断言**。已反向验证：把
`auths.qodercn` 错接成 `qoder` ⇒ 立刻 2 条变红并点名。

### 连带发现 ②：⚠️⚠️ 单测会**消费用户真实的一次性凭据**（安全）

`officeace-auth.ts` 的 `storeDir()` 默认落 `~/.dsh-officeace`，那里的
`session.json` 是**用户真实的华为云凭据**，而 `refresh_token` **一次性**。

**触发路径**（实测踩到，非理论风险）：`apply()` 的 fire-and-forget 首轮续期在
spec 的 `afterEach` 恢复 `USERPROFILE` **之后**才跑到「池为空 ⇒ 续期本机凭据」
兜底分支 ⇒ 用**真实 home** 读凭据并真发 STS 请求；vitest 输出里随即出现真实上游报文
`STS5.1806 has been used`（一次性 token 已被消费的专属错误码）。
**用例自己改 `USERPROFILE` 抢不过这条后台链。**

⇒ 修法与 `jet-hub-store.ts` 的 `DSH_JET_HUB_STATE_DIR` **同型**：
`storeDir()` 支持 `DSH_OFFICEACE_HOME` 覆盖，`tests/setup-isolation.ts` 把它
指向临时目录（**进程级**，对后台链同样生效）。另给
`refreshAccountList` 加第三参 `fallbackRefresh`，让单测能替换掉那个碰盘的入口。

⚠️ 反向验证过：把 setup 里的隔离关掉 ⇒ 守卫用例⑩立刻变红。
⚠️ 全程用**哈希对拍**确认用户真实 `session.json` 未被改写。

守卫：`tests/unit/officeace-refresh-all.spec.ts`（18 条；含防复发：结构委托 /
**调用点普查** / AST 源码判据 / 数组无 `.catch` 的事实 / 隔离三条腿）。

### ⚠️⚠️ 守卫网被**两轮独立审计**打穿（逐条已修 + 反向验证）

**第一轮**（4 处，见下表前半）与**第二轮对抗性审计**（3 处，后半）。
⚠️ 教训统一为一句：**「守卫写好了」≠「守卫有牙」** —— 第一轮有 4 条是
「用例在、但判据测不到目标」（同义反复 / 空洞断言 / 只测一半）。

| 缺口 | 变异（打穿方式） | 修法 |
|---|---|---|
| ⑧ 正则三漏 | 逐行正则只认「同行、无修饰」；`!` / `?.` / 跨行**全漏**。放宽成 `[!?]?` **也只修好两种** | 改 **AST** 按节点形状判定 + ⑧b **判据自检**（7 种绕过必须命中、4 种合法不得误报） |
| ② 是弱判据 | 模块 `refreshAll` 改成「读了池但**一个账号都不续**」⇒ **全绿** | ② 改为经隔离凭据走**每账号一次 `updateAccount` 对账** |
| ⑤ 不验证自身语义 | catch 分支改成静默 `return`（**不走兜底**）⇒ ⑤ 仍绿 | 补 `expect(fallback).toHaveBeenCalledTimes(1)` |
| ⑩ 只守一半 | `storeDir()` 改成**不读** env ⇒ ⑩ 仍绿 | 拆 ⑩a（env）+ **⑩b（写进去读得回来）** |

**第二轮（对抗性）**：

| 缺口 | 打穿方式 | 修法 |
|---|---|---|
| ⚠️⚠️ ⑧ 对**间接写法**失明 | 四种写法真写进 `src/`、⑧ **全绿**：`(await …).catch()`／`const r=…; r.catch()`／`const s=…; s('x').catch()`／**`const list=q=>q.listAccountsByProvider('x'); list(p).catch()`**（最像重构的写法）。穷举间接写法需数据流分析 ⇒ **不可判定** | **换判据**：⑦b **调用点普查**（「再写一份遍历」必然新增一个调用点 ⇒ 可判定，与写法无关）。⑧ 降级为**辅助**并如实标注射程 |
| ⚠️⚠️ **新引入的行为回归** | 第一版按「只接受同步」写 ⇒ Promise 池掉进 `for…of` 抛 `accounts is not iterable`，**连兜底都绕过**（旧代码 `await ….catch()` 是能处理 Promise 的）。且 doc 把「rejected Promise」那格写成「等价」—— **登记错了格子** | 恢复兼容：`await` 一次 + `Array.isArray` 归一；doc 改表（**刻意变更只剩**「非数组」与「同步 throw」两条）；新增 ⑤b/⑤c |
| `.office-claw` 未隔离 | `readSessionCookie()` 直接 `os.homedir()`，**不受**该 env 覆盖。审计实测：用户真实 cookie 存在且**能 DPAPI 解密**（约 1.05s） | 抽 `officeAceClientHome()` 复用同一 env（三条腿同源）；新增 ⑩c |
| ⑩a 判据过弱 | `/temp\|tmp/i` —— 审计预置**仓库内** `.audit-tmpdir`（名字含 tmp）⇒ 全绿 | 改为与 `os.tmpdir()` 做**路径前缀**比较 |
| ⚠️ ⑩c 第一版是**空的** | 我只断言「隔离目录无 cookie ⇒ undefined」，但 spec 的 `beforeEach` 又把 `USERPROFILE` 指向了隔离目录（第二道防线）⇒ **env 覆盖完全失效也仍绿**（实测把 `officeAceClientHome()` 改成忽略 env，18 passed） | ⑩c 内**主动把 `USERPROFILE` 指回真实 home**（撤掉第二道防线），把 env 覆盖单独隔离出来测；改后同一变异**立刻变红** |

⚠️ **`lib/` 是旧产物**：`pnpm build:all` 之前，从 `lib/` 加载的真实插件跑的是
**修复前**代码（审计提示，非缺陷）。改完宿主侧必须重建并重启 DSH。

## 2.7 ⚠️⚠️ Issue IKLTHB（2026-10-15）：哑锁 / 401 诊断错与无效重登 / 401 不算渠道不可用

报障人 ChaunceyG，三个缺陷**一条链**：401 连失败 264+ 次，每轮都白烧一次尝试，
同时「锁定永久积分」那个开关一直是**哑锁**。

### ① 「锁定永久积分」曾是**哑锁**（登记了字段，没有执行代码）

`provider-registry.ts` 里 officeace 登记了 `permanentLock: true`，面板照它渲染
开关并**逐字承诺**「这类积分用尽后将没有可用账号」，而全仓读
`permanentLocked()` 的**只有** `credential-resolver.ts` 的 buddy / loomy 两个分支 ——
officeace 走的是**适配器自己的** `credentialProvider` ⇒ 开关写进
`permanent-locks.json` 后行为与关闭**完全一致**（用户照旧烧永久套餐包），
且**零用例变红**。

修法（用户从 issue 给的两条路里选了第 2 条）：新增 `src/officeace-lock.ts`，
`index.ts` 按锁定态分道：

| 状态 | 行为 |
|---|---|
| 未锁定 | `resolveUnlocked()` **逐字保留**原路径（连 `summaryOf` 都不调）|
| 锁定 | 逐账号读订阅摘要 ⇒ 只挑**有「N 天内到期」桶**的账号；都不满足 ⇒ **抛错，绝不回落池** |

⚠️ **判据与 buddy 系同口径**：窗口取 `buddyExpiringWindowMs()`
（`DSH_BUDDY_EXPIRING_WINDOW_DAYS`，默认 15 天），与面板 RPC
（`credits.permanentLock` 回传的 `windowDays`）**同一个函数**——写死天数会出现
「提示说 15 天、实际按 31 天筛号」。
⚠️ **缺失到期时间 ⇒ 算永久**（保守方向：锁定时少用一个号，而不是把长期积分
误当临期烧掉）。
⚠️ **本机不能改服务端扣减顺序**（云侧定的），锁定能做的只有「拒绝只有永久桶的账号」——
文案必须说「扣减顺序由服务端决定」，不得暗示我们能控序。
⚠️ **刻意没给 `officeaceExpiry` 加锁定语义**：buddy 的 `sharedPackageExpiry`
同样把「只剩永久桶」的账号保留在候选表里（算 `NEVER`），由凭据路径拒绝 ——
与验收参照物保持一致。

守卫（新增；⚠️ **刻意不写条数** —— 条数是必然腐坏的快照，以 `pnpm test` 输出为准）：
- `tests/unit/officeace-lock.spec.ts`：分桶边界（恰好 15 天 ⇒ 永久、
  少 1ms ⇒ 临期）、缺到期时间 ⇒ 永久、`expired`/`remaining<=0` 跳过、
  未锁定 ⇒ **零次** `summaryOf`、锁定 + 只剩永久 ⇒ 拒绝且 `resolveUnlocked`
  **一次都没被调**、多账号换号、读失败 ⇒「无法确认」而不是「额度已用尽」、
  临期判定**刻意不缓存**（永久/未知缓存 60s）、池为空的兼容路径、文案逐字
  （含「解锁」、不含「重新登录」、**无 `code`**）、⑨⑩ **窗口同源**
  （env 非默认值 ⇒ 筛号与文案同时跟随；注入值 ⇒ 文案用注入值）。
- `tests/unit/permanent-lock-execution.spec.ts`：**执行路径普查** ——
  凡 `permanentLock: true` 的渠道都必须在这里登记「实现模块 + 守卫用例 + 判别符号」，
  多一家少一家都红（与 `expiry-runtime-parity.spec.ts` 的 `EXPECTED_WIRED` 同款）；
  并用**真实 `apply()`** 驱动 officeace 那条闭包，证明锁定真的会拒、
  解锁真的可用、锁 buddy 不影响 officeace、**锁定时 `listModels` 仍不 reject**。

### ⚠️⚠️ 连带回归：**锁定只该约束「推理取号」，不该把只读目录也一起关掉**

第一版修法把「会抛错的 `credentialProvider`」直接留在 `listModels` 里 ⇒
**锁定后 `listModels` 抛错**。而 `listModels` 的调用方**全都不接这个错**
（`dsh-llm/lib/index.js` 的 `llm.listModels()` 就是一句 `await`），于是一串
与「锁定」毫不相干的症状：

| 调用方 | 症状 |
|---|---|
| `jet-hub-rpc.ts` 的 `model.list` | 面板报「读取模型列表失败：…锁定…」|
| `jet-hub-rpc.ts` 的 `readableCatalogIds` | **关不掉该供应商**（判据读 `remoteError`）|
| `aggregate-adapter.refreshCatalog` | 记一条 warn 后**静默少一个候选** |
| DSH 模型选择器 | 分组消失（与「目录门控」的空分组**同形**）|

⚠️ 判据：**`/v2/models` 与 `/v1/model-token-rates` 都是只读、不扣积分**的，
没有理由因为锁定而一起关掉 —— buddy 系也正是这样（锁定后模型照常列在目录里，
发消息才报「没有可用账号」）。故适配器新增 `probeCredential`（缺省回落
`credentialProvider`，既往嵌入方与单测行为不变），`index.ts` 把它与
`resolveUnlocked` **共用同一份** `resolveOfficeAceCredential`；
`tests/unit/permanent-lock-execution.spec.ts` 的 ⑦ 钉这条（锁定 + 只剩永久桶 ⇒
目录探测照常给出凭据、`listModels()` 不 reject，**同刻**推理侧仍必须抛错）。

### ② 401 诊断错 + **无效重登**（引导用户做一件结构上不可能有用的事）

报文恒为 `HTTP 401 {"error_msg":"AppKey or AppSecret is invalid","error_code":"APIG.1009"}`，
而旧文案写的是「Basic 凭据失效：OfficeAce 会话已过期，**请重新登录** OfficeAce 客户端」。
**有反证**：用户照做后 `credentialRef` 与 STS 三元组**都换了**，
而 `modelAppKey`/`modelAppSecret` **逐字节不变**（`ffff8ba7…c476` / `bd4da972…d76b`，
`accountId` 也没变）⇒ 重登在结构上改不了这个结果，却被指引做了一遍又一遍。

两个实现错误：

1. **`renewed !== credential` 恒为真** —— `resolveCredential()` 每次调用都
   重新 `JSON.parse` ⇒ 对象身份必然不同 ⇒ 「续期+重发」是**无条件**执行的
   （真正有效的判据是**逐字段比对 Basic 三元组**）。
2. **`shouldRefreshNow` 的 1 小时 lead-time** ⇒ 有时根本没真发续期。

修法：新增 `basicAuthFingerprint(credential)`（`modelAppKey\0modelAppSecret\0maasBaseUrlOf(credential)`，
⚠️ **与熔断用的指纹不是同一条判据**，刻意分成两个函数），并把「本次续期结果」
从布尔改为**四态** `RenewalOutcome = 'not-attempted' | 'unchanged' | 'changed' | 'unreadable'`：

| 态 | 何时 | 文案指向 |
|---|---|---|
| `unchanged` | 真发过续期，三元组一个字节都没变 | **「重新登录 OfficeAce 改不了这个结果」**，去华为云控制台核对 MaaS 应用凭据/订阅 |
| `changed` | 刚换过凭据仍被拒 | 新凭据也被拒 ⇒ 权限/订阅面 |
| `unreadable` | 续期后读不到新凭据 | 先查凭据库/登录态，**别去查一个不存在的问题** |
| `not-attempted` | 没走 401 重试路径 | 可先点一次「刷新」看凭据会不会变 |

⚠️ **判据键在报文、不在状态码**：华为文档把 `APIG.1009` 定义为 **HTTP 400**，
而现场收到的是 **401** ⇒ `isBasicCredentialRejection(status, body)` 必须同时看
body（`/APIG\.1009/i` 或 `/AppKey or AppSecret/i`），只认状态码会漏。
非该形状的 401 如实说「**不是已知的「AppKey/AppSecret 无效」形状**」并提示核对
`maasBaseUrl` 与出口 —— 不能硬套凭据失效。
⚠️ 抛的是**裸 `Error`（无 `code`）**：`AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 会被
DSH 客户端**整段替换 message**，而这里文案本身就是出路（同 `IKLBSH` 的形态）。

### ③ 401 不算「渠道不可用」⇒ 每轮白烧一次尝试（静默降级 `max→high`）

新增 `src/officeace-credential-health.ts`：**渠道级熔断**。

- **键 = Basic 密钥对的 sha256 前 16 位**（`officeaceCredentialFingerprint`），
  **不是 `credentialRef`** —— 重登会换 ref/账号而 key 一模一样，按 ref 记账
  等于每次重登都重置熔断器（也就等于没有）。顺带中和了
  `account.create` 造出的幽灵池条目（恒新 id + ref）。
  ⚠️ 只存哈希，**不存明文密钥**。
- 阈值 2 次连续拒绝 ⇒ 熔断；`DSH_OFFICEACE_BREAKER_MINUTES`（默认 10，**0 = 关闭**，
  判据里**不得**用 `parseInt(x) || default` 那种写法）；TTL 到期自动放行
  （**半开**：计数不重置 ⇒ 再被拒立刻重新熔断）；**成功一次即清除**。
- 熔断期内在 `stream()` 里**直接抛错、零请求**；文案含「已临时跳过本渠道」
  「连续拒绝 2 次」「约 10 分钟后自动重试」「这与额度无关」，并明确
  **劝阻去解锁**（解锁会不可撤回地烧掉永久积分）。
- ⚠️ **半开的严格性如实登记**：判据只有 `until <= now`，**没有 in-flight 闸门**
  ⇒ 到期那一瞬间并发到达的 N 个请求会各自放行一次（随后第一次失败立即重熔）。
  代价是「每 10 分钟最多多打几次注定 401 的请求」，故不加单飞机制 ——
  **不要**把它读成「严格只探测一次」。
- ⚠️ 熔断表**只在成功时删记录**：TTL 到期不删（半开要留计数）、
  `BREAKER_MINUTES=0`（关闭）时计数仍会累积但恒不拦请求。
  上界 = 进程内见过的**不同 Basic 密钥对**数（有界且极小，故敢用纯内存 Map）。
- `aggregate-expiry.ts` 的 `officeaceExpiry` 开头短路成 `UNUSABLE`：熔断的渠道
  **不该再出现在聚合候选表**里。⚠️ 只读记账（余额/倍率）**不清理**熔断状态、
  也不受它影响（V11 签名是**另一套认证面**）⇒ **读到余额不得覆盖熔断**。
  ⚠️ 折算结论另有一层 60 秒缓存（`EXPIRY_CACHE_TTL_MS`）⇒ 熔断生效/解除都可能
  滞后最多 60 秒，两个方向都有界。

### ⑦ 第一轮 subagent 审计的结论与落地（2026-10-15）

审计范围 = 本 issue 的全部改动。**结论：无阻断级问题**（专门找过「锁定后仍可能烧
永久积分」与「401 白烧请求」两类，都没有路径）。它同时指出**两处判据无牙**、
两处注释与实现不符 —— 均已修，且**都补了会红的判据**：

| 发现 | 为什么算无牙 | 落地 |
|---|---|---|
| **窗口天数同源**这条不变式 | 所有期望值都是 `buddyExpiringWindowDays()` **现算**的 ⇒ 把窗口**写死 15 天**（写死在筛号里、或写死在文案里）默认 env 下全部用例仍绿 | `officeaceLock.spec` ⑨：把 env 设成 **3 天**、桶 5 天后到期 ⇒ 必须**拒绝**且文案必须说「**3** 天」（不注入 `windowMs`，走生产路径）；`permanent-lock-execution.spec` ⑥ 补「env=31 ⇒ 面板文案跟着变」 |
| 普查登记表的 ② | 只做 `includes(provider)`，而**普查文件自己**含全部六家渠道名 ⇒ 把任意一条登记指向本文件也绿，注释却自称「真的会驱动那条路径」 | 登记表新增 `drives`（**判别符号**：`pickBuddyAccount` / `loomyBalanceTier` / `createOfficeAceCredentialProvider`），②断言「模块真的导出它 + 用例真的引用它 + 不许指向普查文件自己」；注释同时写明**它仍不是「路径被执行过」的证明**（那由 B 段真实 `apply()` 承担） |
| 熔断「半开」= 严格一次探测 | 注释写「允许**一次**尝试」，而实现只有 TTL 判据、无并发闸门 | 改注释（见上方 ③ 的第一条），**不**加单飞机制 |
| 文案窗口 ≠ 筛号窗口 | 文案自己调 `buddyExpiringWindowMs()`，筛号用可注入的 `deps.windowMs` ⇒ 注入态下「按 1 天筛、报文说 15 天」（一条判据两份取值） | `officeaceLockedError(reason, windowMs)` 改为**入参**，装配处把**同一个** `windowMs()` 传进去；⑩ 钉住「注入 2 天 ⇒ 报文说 2 天」「非法值 ⇒ 回落 env」 |
| 文案写死「每日签到赠送 1000 分」 | 云侧常量写进本地文案（accio 已登记过同类教训） | 改成「每日签到赠送的额度当日作废」，不写数字 |

⚠️ 同一轮里**我自己**（不是审计）另发现并修掉两处，都补了判据：
① 锁定后 `listModels` 抛错的**连带回归**（见上一节）；
② 续期真的换掉了 Basic 三元组时，熔断**记在旧凭据上** ⇒ 熔断器追不上实际在用的
那份、每轮仍白撞一次（正是本 issue 第 ③ 条）⇒ 改记在**产生最终拒绝的那份**上
（`officeace-401-diagnosis.spec` 的 ⑥ 两侧同时断言：新凭据记了账、旧凭据**一个字节
也不该有**）。
⚠️ 另：本轮审计**开工期间工作区被我自己并发修改**（还一度有一处模板字符串语法错误
持续了 ~43 秒）⇒ 审计报告里为此单列了时点哈希。**教训**：声称「只读审计」的
subagent 在跑时，主会话就该**停手**，否则它的证据会落在两个快照上（本仓库
`AGENTS.md` 早写了同一条纪律，这次违反的是「唯一的写者」这半边）。

### ⑧ 第二轮**对抗性**审计的结论与落地（2026-10-15）

第二轮是**对抗性**审计（subagent，只读）：**31 条变异**逐条注入 + 跑对应用例 +
**原字节回写** + SHA256 逐文件比对。**结论：无阻断缺陷**（25 条变异变红 ⇒ 守卫有牙；
专门找过「锁定后仍可能烧永久积分」与「401 白烧请求」两类，都没有路径）。它查出
**四处无牙守卫**与**两处判据强度问题**，我另在同轮查出**一条真缺口**（失效方向恰好
就是 issue 第 ① / ③ 条）。**全部已修 + 已补会红的判据**，并且我**再自己变异验证过
一遍**：8 条变异（M1–M8）**全部 RED、全部 RESTORE-OK**（源文件 SHA256 逐字节回原）。

| 审计发现 | 为什么算无牙（实测证据） | 落地 |
|---|---|---|
| ⚠️ **`remaining` 守卫整条无牙**（真缺陷） | ④ 里唯一的 `<= 0` 样本是 `remaining: 0`，而 **0 加进任何桶等于没加** ⇒ 删掉那行守卫（或只删半条腿）**逐字节同效、仍全绿**（变异 d / d1 / d2 三向 GREEN）。失效方向 = `NaN` 让临期桶变 `NaN` ⇒ 判定翻「永久」⇒ **锁定态放行、烧永久积分** | `officeace-lock.spec` 新增 **④b**：喂 `remaining: -5` 与 `Number.NaN`，断言两桶都不计入（M3/M4 证明删任一半条腿都会红：`-5` 抓 `<= 0`、`NaN` 抓 `isFinite`）。⚠️ 如实标注：**未取证**华为云会下发这两种形状，钉的是「该判据不可能变红」这件事 |
| 两处**死代码默认参数** | `officeaceLockedError` 与 `splitOfficeAceCreditsByExpiry` 的 `windowMs =` 改成常数 15 天后 **22 条全绿** ⇒ 生产装配恒显式传参、默认值永不求值，却给「一条判据两份取值」留了后门 | 两个 `windowMs` 改成**必填**（删默认值）⇒「忘了传窗口」变成**编译错误**。`officeaceLockedError` 内部的 NaN/≤0 回落腿**保留**（那是防御，不是兜底），由 ⑩ **显式传 `Number.NaN`** 钉住 |
| `noteOfficeaceRejection` 的 `minutes > 0` 闸门无牙 | ⑥ 在 `env=0` 下只喂 **1 次**拒绝（`consecutive=1` 恒不达阈值 2），第 2 次**没带 env** ⇒ 恰好绕开。风险低（`until = now` 随后立刻判关）但返回值 `open: true` **是错的** | ⑥ 的两次拒绝都带 `env`，并断言第二次为 `{ open: false, consecutive: 2 }`（M5 变红） |
| ① 的「**双向**一致」是错觉 | `expect(registered).toEqual(declared)` 紧跟 `expect(declared).toEqual(registered)`；`toEqual` 对数组**对称** ⇒ 第二条在第一条通过时**不可能单独失败**（三个方向的变异只让第一条红） | 改成两个**差集**断言：各自只负责一个方向，且**差集内容会进失败信息**（谁多了谁少了一眼可见） |
| 两条 `it` **标题与函数体逐字相同** | 同一判据写了两遍（变异 l 让两条同时红）⇒「看起来覆盖了两件事」是假的 | 删掉重复那条，腾出的位置换成**真新增覆盖** ⑥b（见下） |
| ⑦b 判别力为**零** | 整条只有 `resolves.toBeUndefined()`；实测把兼容路径退化成裸 `return undefined`（变异 f）时 **⑦ 红而 ⑦b 仍绿** | ⑦b 补**对照格**：「池空但本机凭据**有临期额度**」必须**真的返回它**（M8 证明该格会红），并断言「根本没有凭据时不去读余额」 |

#### ⚠️⚠️ 同轮**我自己**查出的真缺口：`APIG.1009` 的判据**钉死在 401**（自相矛盾）

对抗性审计的变异 m1/m2 只证明「凡 401 都算」与「只认 400」两个方向会红，**没有测
「400 + 真机报文」这一格** —— 而华为官方文档把 `APIG.1009` 定义为 HTTP **400**、
真机回的是 401（issue 取样即 401）。实测**三处各自**钉死了 401：

1. `isBasicCredentialRejection(status, body)`：`if (status !== 401) return false`，
   而它**正上方**的注释写着「判据**不得**依赖状态码」；
2. `diagnose()`：整个 `APIG.1009` 分派**嵌在** `if (status === 401)` 里面；
3. 续期闸门：`if (response.status === 401 && this.options.refresh !== undefined)`。

⇒ 一旦网关按文档回 400，**归因文案与熔断双双失效**，每轮又白撞一次（正是 ③）。
三处一起改：判据改为「**4xx + 报文点名这对 Basic 凭据**」；`diagnose` 改为
**先判形状、再判 401**；续期闸门改成**超集**（`401` 照旧一律尝试续期，行为零回退）。
下界设在 **400** 而不是「不看状态码」，理由是 **2xx 的 body 是模型输出** ——
用户正是在排查这个错误，模型完全可能原样复述这句报文，不设下界会让一次**成功**的
回答熔断整渠道 10 分钟；**5xx** 是基础设施抖动、形状未知，与「网关空体 401 不熔断」
同一条理由。
判据：`credential-health.spec` **④**（400/403 ⇒ true）+ **④b**（2xx ⇒ false，注释写明
「模型输出不得熔断渠道」）+ **④c**（5xx ⇒ false）；`officeace-401-diagnosis.spec`
**⑥b**（真机报文 + **400** ⇒ 必须给出同一套归因且熔断记账为 1）。
⚠️ 那条 ④ 的**原版是写反的**：标题写「只认报文，不认状态码」，断言却把
`(400, APIG.1009) === false` 当期望值**锁死**了 —— 又一个「注释说一套、判据做另一套」。
⚠️ 该缺口的两半分别由 M6（分派嵌套）与 M7（续期闸门）证明**有牙**。

#### ⑧ 附带登记：红线实证、未取证项与刻意不修的缺口

- ✅ **`AUTH`/`QUOTA` 会连 message 一起被客户端丢掉**这条红线，本轮从「文档相传」
  升级为**对着装好的 DSH 源码实证**：`dsh-client-ui-chat/lib/client.js:1222` 把
  `QUOTA`/`ACCOUNT_QUOTA` 换成 `message.failure.quota`、`:1223` 把 `AUTH` 换成
  `message.failure.auth`，且 `:7392-7395` 对 `AUTH` 直接给出 `message: ""`
  （**整段抹掉**，不是某一个渲染点替换）。⇒ 锁定文案与 401 归因**必须是裸 `Error`
  （无 `code`）**，用例断言 `.code === undefined`。
- ⚠️ **仍未取证**：华为官方错误码页**没抓到**（本机 `web_search` 端点的 token 失效、
  Bing 忽略 `site:` 过滤）⇒「官方定义 400」目前**仍是 issue 报障方的一面之词**。
  修法**不依赖**它：判据只认报文措辞，状态码只当**状态类**边界用。
- ⚠️ **登记一处诚实性小缺口（刻意不修）**：`jet-hub-rpc.ts` 的 `officeace.status`
  用**无 ref** 的 `readOfficeAceCredential()` 判 `ready: true`，**完全不看锁定表**
  ⇒ 锁定期间面板仍显示「就绪」，而推理侧会抛「没有可用账号」。它**不烧积分**
  （只读探测），**不是绕过**，但症状会让人以为锁定没生效。修它要给该 RPC 响应加锁定态
  并同步客户端文案（面板 + bundle 重建）⇒ 收益不抵本轮风险，**登记**即可，建议将来
  随「每日额度刷新入口」一起做（那本来就要动这段响应）。
- ✅ 上一轮登记的「熔断产生的 `UNUSABLE` 会不会被折算缓存留得比熔断更久」**本轮关闭**：
  `aggregate-expiry.ts:194` 的 `EXPIRY_CACHE_TTL_MS = 60_000`（60 秒）**远短于**熔断默认
  10 分钟 ⇒ 缓存最多让「不可用」结论滞后 1 分钟，恢复侧以熔断 TTL 为准。
- ⚠️ **审计工具自身会产生假绿**（方法论）：该轮变异助手前两轮把 m1/m2 报成 GREEN 且
  摘要**为空** —— 是它自己 `2>&1 | Out-String` 在 `$ErrorActionPreference='Stop'` 下
  偶发捕空，使判定退化成 GREEN，**不是守卫无牙**；改成「重定向到文件 + 未解析到
  `Test Files` 就重试」后重跑全表才是权威结果。⇒ **摘要为空必须人工复核**，
  别把工具故障当成「守卫有牙」或「守卫无牙」的证据。

### 如实登记的缺口（**别据此改代码**）

- ⚠️ 「额度耗尽 ⇒ 云侧撤销 MaaS 授权」这条链**未被证明**（issue 原文即要求
  不要据此改代码）。上面三条修法都不依赖它。
- ⚠️ `.trial` 类 SKU 的 `expiresAt` 在 `fetchCloudSubscriptionFor` 里被**刻意丢弃**
  ⇒ 按窗口判据它算**永久** ⇒ 只有试用包的账号在锁定时会被拒（保守，绝不烧钱）。
  要支持它应修**归一化层**，不是在锁定层加 provider 特例。
- ⚠️ 重登会产生**新账号条目/新 ref**（`account.create` 恒新造 id），旧条目留在池里
  ⇒ 可能的重复/幽灵条目。面板上**刻意没有**「刷新每日额度」入口：它本质是
  重新登录**既有**账号，需要宿主侧新增一条 RPC（如 `account.relogin`）——
  `account.create` 拿来做这件事只会造幽灵账号而额度一点没刷新，
  `login.poll` 对已登录账号又立刻回 `done: true`（假成功）。

## 3. ⚠️ 接线陷阱（新 provider 通用，此处已复发）

`src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS` ——
officeace 初版**漏登记**，症状是「系统睡眠/挂起恢复后刷新积分报 HTTP 401、
卡片红『已过期』、窗口内无手动自救、**日志零字**」，与 issue IKKHL5 逐字相同。
STS 寿命约 2 小时，恰好落在「恢复后到定时器补触发那一轮（最多 30 分钟）」的窗口内。

⚠️ **这条不是「记得加」能解决的** —— 原有的守卫是**硬编码白名单**，
只锁住已知的 11 家，新增 provider 漏接时**零用例变红**。
现已把**守卫用例的期望值**改为**从 `PROVIDER_REGISTRY` 派生**
（`credits-balance-self-heal.spec.ts` 的
`★★ 每个「有余额能力的渠道」都必须在自愈 Set 里`），并做过反向验证：
删掉 `OFFICEACE.id` 精确点名变红。

⚠️⚠️ **但生产侧的那个 Set 仍是硬编码**（`src/jet-hub-rpc.ts` 的
`SELF_HEAL_REFRESHABLE_PROVIDERS`，形如 `new Set([...])` 字面量）——
**2026-10-13 合并审计实测确认**。两者是**两个不同的东西**：

| | 是什么 | 漏加新 provider 的后果 |
|---|---|---|
| 生产 `SELF_HEAL_REFRESHABLE_PROVIDERS` | 硬编码 `Set` | 该家**永不自愈**（症状静默、日志零字） |
| 守卫用例的**期望值** | 从 `PROVIDER_REGISTRY` 派生 | **用例变红**（把静默失效变成显式失败） |

⇒ **加新 provider 时仍必须手动往那个 `Set` 里加一行**；守卫的作用是
「忘了加就会红」，不是「加了就自动生效」。别把「期望值已派生」读成
「生产 Set 已派生」—— 那正是本节此前措辞的歧义。

同款陷阱还有 `src/jet-hub-store.ts` 的 `REF_PREFIX_TO_PROVIDER`（漏加 =
`OFFICEACE_ACCOUNT_*` 的账号在 `state.json` 缺失时静默消失）。

## 4. ⚠️ 多账号：`session.json` 共享文件是「串号」根源

凭据已改按 `credentialRef` 分文件 + 走 DSH 凭据库，但**兼容用的公共
`session.json` 仍在**（`persistLogin` 每次登录都顺手写一份）。读它的三处都会串号：

| 读点 | 症状 | 状态 |
|---|---|---|
| `account.list` 的 `expiresAt` 自愈回填 | 把**同一份**有效期写给所有缺该字段的账号（方向还可能相反） | 已修：逐账号 `ctx.credentials.resolve` |
| `officeace.status` RPC | 三个字段描述的都是「最后登录的那个账号」 | 无客户端调用方（客户端零命中），是埋好的地雷 |
| `probeOfficeAce` / `readOfficeAceCredential` | 面板门控读共享文件 | 生产路径已绕开 |

**教训**：改「单凭据 → 多凭据」时，**别只改主路径** —— 旧的单文件读取点
会一颗颗变成串号源。逐个 grep 该文件名，别凭「主路径已经改了」的印象收工。

## 5. 展示层：三档分桶与倒计时的两个真实缺陷（2026-10-13 审计）

详见 `client-ui.md`。这里只记 officeace 相关的一条：

⚠️ **TRAE 的 `active` 是硬编码 `true`**（`src/trae-credits.ts`），压根不反映是否过期。
这让 `earliestExpiringAt` 选中已过期包成为**必然可达**而非理论风险 ——
选中后 `expiryCountdown` 拿到过去时刻返回空串 ⇒ **整段倒计时消失**。
已修（选举时要求 `end > now`）。

## 5.5 ⚠️⚠️ 换账号登录：华为 authui 会静默复用会话（2026-10-13 用户报障）

> 「新建账号那个链接就自动用之前登录的账号授权了」

**根因不在授权链接参数** —— `state` / `code_challenge` 每次都是新随机值，PKCE 完整。
复用发生在**更前面一层**：浏览器里 `auth.huaweicloud.com` 的登录会话 cookie。实测三条：

| 试验 | 结果 |
|---|---|
| `authui/login.html?service=<authorize>` | **200 直接放行**（复用会话，看不到登录框）|
| authorize 里追加 `&prompt=login` | **仍 200、无重定向** ⇒ **authui 忽略该参数**，此路不通 |
| `authui/logout?service=<authorize>` | **302 先清会话**再跳 authorize；跟随后落到 `/authui/login`（注意从 `login.html` 变成 `login`）|

⇒ 只有两条路：先 logout，或**换一个 cookie jar**。

### 选「无痕窗口」而不是 logout —— 理由是作用域

实测 `logout` 的 `Set-Cookie` 有 4 条，其中：
`cloud_verify_ticket=; Max-Age=0`（清票据）+ `IAMIdentity=…; Path=/`（重写）。
**作用域是整个 `auth.huaweicloud.com` 域，不是单次授权** ⇒ 在用户日常浏览器里执行会
**连带登出华为云控制台**。无痕窗口是全新 cookie jar，天然无会话，
**既不碰用户既有会话、也不需要 logout**。

⚠️ **官方（果办）同样没解决这点**，别当参考实现：它的 `LoginPage` 用
`window.open(url, 'officeclaw-login', 'popup,…')` 开**共享 cookie** 的小窗，
「重新登录」走 `authui/logout`（`LoginCallbackPage`）。即官方也无法换账号登录。

### 实现落点与三条实测约束

客户端**做不到**无痕（`window.open` 无法请求无痕 —— 那是进程级启动参数），
故由宿主 `spawn` 浏览器可执行文件（`src/login.ts` 的 `openIncognitoWindow`）：

1. ⚠️⚠️ **不要用「app 模式」开关**（真机证伪，阻断级）：初版传了它想让窗口去掉
   地址栏，结果 360 极速浏览器 X 上显示「**域名解析错误 —— 请检查域名拼写**」——
   该浏览器把开关的值当**域名**去解析。隔离探针（本地 HTTP 服务器 + 独立
   `--user-data-dir`）证明该开关本身能被 Chromium 正确解析并发出请求
   ⇒ 是**该浏览器对它的改写**，不是 URL 编码问题（实测 28 个 `%` 序列逐字送达）。
   ⇒ 换取账号**不依赖**它，而它的失败是阻断级 ⇒ 只用无痕开关。
2. **浏览器路径必须读注册表**（`UrlAssociations\https\UserChoice` → ProgId →
   `shell\open\command`）：用户装的可能是 Chrome / Edge / 360 / Firefox，
   路径各不相同，硬编码必然错。⚠️ 三个根都要试（HKCR / HKCU\Software\Classes /
   HKLM），本机的 360 就只注册在 **HKCU\Software\Classes**。
3. **轮询不依赖浏览器 cookie**：`GET /v1/claw/auth/code?state=` 是**匿名服务端轮询**
   （实测直接返回 `AgentArts.11000004` 参数校验错，说明不需要任何身份）
   ⇒ 无痕窗口完成授权后，宿主照样拿得到 code。窗口关掉也不影响。

### ⚠️⚠️ 测试纪律：**开窗的行为测试只能放 e2e**（用户 2026-10-13 明确要求）

> 「打开浏览器窗口的测试只能放在 e2e 测试里」
> 「单元测试里不要加打开浏览器 url 的测试，打开一堆空白窗口没用，挡我视线」

这是我**真实污染过用户桌面**两次换来的纪律：

1. **单测里直接调 `openIncognitoWindow`**：初版写
   `expect(() => openIncognitoWindow('https://example.invalid')).not.toThrow()`，
   想验「不抛错、返回 boolean」。该函数**会真的 spawn 浏览器** ⇒
   每跑一次 `pnpm test` 就在用户桌面弹一个 `example.invalid` 窗口。
2. **间接污染（更隐蔽）**：`officeace-rpc-multi-account.spec.ts` 走的是**真实的
   `account.create` RPC**，其桩数据里带
   `authorizeUrl: 'https://auth.huaweicloud.com/stub'`。接线后宿主就真去打开那个
   桩 URL ⇒ 全量测试一跑，用户桌面多出一堆 **`auth.huaweicloud.com/stub`**
   空白窗口。**根因不是那个用例写错了**（它的桩完全合理），而是**被测代码
   在测试环境下产生了真实副作用**。

**修法是两层的，缺一不可**：

1. **被测代码加测试断路器**：`openIncognitoWindow` 开头
   `if (process.env.NODE_ENV === 'test') return false`。
   ⚠️ 判据必须按**运行环境**，**不能按 URL 特征打补丁**（`if (url.includes('stub'))`）
   —— 换个用例换个 URL 立刻复发。
   ⚠️ 返回 `false` 而不是抛错：调用方据此走正常回退分支，断言形态与生产一致。
2. **真开窗的验证移到 `tests/e2e/`**，带闸门
   （`DSH_OFFICEACE_E2E=1`，见 `pnpm test:e2e:officeace`），**默认跳过** ——
   与 `login.e2e.spec.ts` 同款范式（`describe.runIf(E2E)`）。

**守卫**：`tests/unit/officeace-incognito-login.spec.ts` 的
⑩（测试断路器存在）与 ⑪（本文件不得 import `src/login.js`，且 e2e 版本必须存在）。

### 另一条源码级断言的教训

⚠️ **判据要避开字符串字面量**：⑪ 的第一版写成「剥注释后匹配
`openIncognitoWindow(` 调用形态」，结果扫到了**同一文件里另一条用例的字符串
字面量**（它断言 `jet-hub-rpc.ts` 的源码文本）而恒红。⇒ 只锚定 **import 语句**
（没 import 就必然调不到真实实现，精确且不会假失败）。

## 5.8 ⚠️⚠️ 聚合轮换：决定可见性的是 `WIRED_EXPIRY_PROVIDERS`，不是 `AGGREGATE_CHANNELS`

**用户要求**（2026-10-13）：「officeace 的模型好像没有加入聚合 provider 的轮换中，
我们需要加入」。

⚠️ **同款陷阱已复发三次**（cline → accio → officeace），症状**恒定静默**：

```
aggregate-adapter.ts 有 4 处按 WIRED_EXPIRY_PROVIDERS 过滤
  （探测过滤 / 候选过滤 / 虚拟模型过滤 / 价格）
⇒ 该表里没有的渠道，折算恒为 UNUSABLE ⇒ 候选表里永远没有它
⇒ 而 AGGREGATE_CHANNELS 只影响「进不进目录构建」，**不决定候选可见性**
```

**接入必须三处同改**（少一处都是静默失效）：

1. `aggregate-expiry.ts` 的 `officeaceExpiry` 折算原语；
2. `WIRED_EXPIRY_PROVIDERS` 白名单（**这才是决定候选表可见性的那个**）；
3. `provider-expiry.ts` 的 `createProviderExpiry()` 表。
   （2 与 3 的一致性由 `expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。）

### 折算判据：与 buddy 系**同形**（不是与 loomy/accio 同形）

officeace 的订阅**每个积分桶都带 `expiresAt`**（ISO 8601）⇒ 走「有效包取最早」
那套，判据与 `sharedPackageExpiry` **逐格一致**：

| 情形 | 折算值 |
|---|---|
| 有 `remaining > 0` 且未失效的桶，至少一个给了到期时间 | 那些时刻的**最小值** |
| 有可用桶但都没给到期时间 | `NEVER`（长期，排最后但不剔除）|
| 一个可用桶都没有 | `UNUSABLE`（剔除）|
| 查询失败 / 未登录 | `UNUSABLE`（读不到就不猜）|

⚠️ **为什么不用共享的 `sharedPackageExpiry`**：它吃
`fetchBalance: () => Promise<CreditBalance | null>`，而 officeace 的余额入口是
`fetchSubscriptionSummary(staleHours, ref, credential, credentials)`，返回
`OfficeAceSubscriptionSummary` —— **形状套不进那个泛型**（与 qoder / opencode
被排除在共享骨架外的理由同源）。但**判据必须同构**（本仓库红线）。

### ⚠️ 必须把 `credentialRef` 传下去（否则多账号串号）

`fetchSubscriptionSummary` **传了 `ref` 才走云侧 V11 直读**；不传会回落到
果办客户端的**全局单一 cookie**（只反映「当前登录在果办里的那一个账号」）
⇒ 多账号下所有账号折算成**同一个余额**（实测两个账号都显示 6500），
而聚合候选排序是**每账号**粒度 ⇒ **会选错人**。

为此给 `ProviderExpiryContext` 新增可选 `credentialRef`
（其余家忽略它 —— 与 `catalogIds` 同一模式），并在折算调用点从
`item.entry.credentialRef` 填充。

### 真机验证（2026-10-13 本机）

折算输出 = `2026-10-13T15:59:59.000Z`，逐桶核对**语义正确**：

| 桶 | remaining | expiresAt | 参与折算？ |
|---|---|---|---|
| 个人体验版 | 500 | **无** | ❌ 不参与（不臆造时刻）|
| 新用户专属福利 | 4000 | 11-12 | ✅ |
| 每日签到有礼 | 993.32 | **今天 15:59** | ✅ 取最小 |
| 国庆黄金周·登录翻倍礼 | 1000 | 今天 15:59 | ✅ 同刻 |

⇒ 正是「临期优先」要的语义：今天作废的签到积分排最前，
而「个人体验版」被判长期、**不拉低最小值**。

**守卫**：`tests/unit/officeace-expiry.spec.ts`（折算判据 + 接线两段；
⚠️ **刻意不写条数**，2026-10-15 加了两条熔断短路用例后旧数字已腐坏）。
已反向验证：移出白名单 ⇒ **3 条独立守卫同时变红**并点名；
丢掉 ref 传递 ⇒ ⑫ **精确变红**（收到 `undefined`）。

## 5.7 ⚠️⚠️ 模型列表为空 = 打错了 host（`maasBaseUrl` 是死字段，2026-10-13 真机实测）

**用户报障**：「provider 列表里有 OfficeAce、我也加了账号，但**对话中选择模型的
列表里看不到 OfficeAce 的模型**」。

**根因**：适配器一律打硬编码的 `OFFICEACE.defaultBaseUrl`
（`https://officeace.cn-southwest-2.huaweicloud-agentarts.com`），
而华为**按账号下发专属网关**（本机是 `modelgw-0004.officeace.cn-southwest-2...`）。
同一个 Basic 凭据实测：

| host | `/v2/models` | `/v2/chat/completions` |
|---|---|---|
| `officeace…`（硬编码，修复前）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
| `modelgw-0004.officeace…`（凭据里）| **200** | **200** |

**后果链（全程零日志）**：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 选择器空分组；
而空返回与「无账号」**同形** ⇒ 目录门控把**整个 provider 隐藏**。

⚠️ **`maasBaseUrl` 一直都在凭据里**（`fetchModelInfo` 从云侧 `model_api_url_base`
取），只是**从没被读过** —— 典型「写了不读的死字段」。我在 PR #89 审计时**已登记
这条为已知缺口，却低估了它**（当时判为「影响有限，若账号被分到别的 region 才暴露」）。
真机证明：**它就是主路径**，而且**默认域对新账号直接 401**。
⇒ **教训：写进凭据却没人读的字段，要按「可能已经是主路径」对待，而不是按注释里的
推断定性。** 这条缺口当时只要跑一次真实的 `listModels` 就会暴露。

**修法**（`src/officeace-adapter.ts` 的 `maasBaseUrlOf`）：
推理/探测三处（probe、stream 首发、401 重试）改用 **`credential.maasBaseUrl`**，
缺失时回退 `defaultBaseUrl`（老凭据零行为变化）；尾斜杠规范化。

⚠️ **只改 Basic 鉴权的推理面**。V11 签名那套（`/v1/subscription`、
`/v1/model-token-rates`）实测**两个 host 都存在且都要求 IAM 签名**
（返回 `failed parse aksk format` 而非 404/DNS 错）⇒ 它们是**管理面 API**，
**不要**「为统一」一起改 —— 会把余额与倍率一起打挂。

**守卫**：`tests/unit/officeace-base-url.spec.ts`（9 条：纯函数边界 / 端到端
mock fetch 断言 probe 与推理真打账号域 / 缺字段回退 / **范围守卫**防误改 V11）。
已反向验证：改回硬编码 ⇒ 行为断言与源码断言**各自精确变红**。

## 5.6 ⚠️⚠️ DSML 工具调用是**闭环**：只「教」不「解」= 工具永不执行（2026-10-13）

DeepSeek-V4 系模型走 DSML 而非标准 `tool_calls`（理由见 `src/dsml.ts` 头注：
标准 `tool_calls` 的参数需一次性打包，会撞 APIG ~60s 空闲断连）。

⚠️ **这条协议由插件负责收发，宿主不参与**。实测宿主 bundle（116 MB
`app.asar`）用 `findstr` 搜 `DsmlContentExtractor` / `parseDsmlToolCalls` /
`DSML_TOOL_CALLS_OPEN` —— **全部零命中**，只有标准 `tool_calls`。

故一个通道要用 DSML，必须**两半都接**：

| 一半 | 做什么 | 落点 |
|---|---|---|
| **教** | 不发 `tools` 字段，改把 schema 注入 system 提示 | `buildDsmlSystemPrompt` |
| **解** | 把正文里的 DSML 块摘出来转成结构化 tool-call | `DsmlContentExtractor` |

⚠️ **只接「教」的后果**：模型写出的 DSML 整段当**正文**显示，工具
**永不执行** —— 用户看到的是标签文本而不是执行结果，且日志里那条
assistant 消息只有 `reasoning` + `text` 两块、**没有任何 `tool/call` 记录**。

这正是本通道**合并初期的真实状态**：`officeace-adapter.ts` 注入了提示且
`toolsPayload = undefined`（模型只会写 DSML），而它走的 `consumeOpenAiSse`
（`openai-compat.ts`）**不解析 DSML** —— 解析器当时只存在于
`llm-adapter.ts`（CodeArts 专用），本通道复用不到。

这跟当初**漏注入** `buildDsmlSystemPrompt` 是**同一个病根**：
协议实现散落，换个通道就漏一半。

### 修法：协议实现只有一份，收发成对

- 解析器（状态机 + `parseDsmlToolCalls` + 标量还原）**下沉到 `src/dsml.ts`**，
  与提示词同处一层；`llm-adapter.ts` 改从共享层导入，删本地副本。
- `consumeOpenAiSse` 新增可选 `dsmlToolMode`：正文 delta 先过提取器，
  解析出的调用复用既有 tool-call 注册/发射路径（wire 下标取**负数**，
  与标准 `tool_calls` 的 0/1/2… 隔离，不抢槽位）。**默认关闭**，
  关闭时行为与从前逐字节一致；收尾 flush 把未闭合残片放行，不吞内容。
- `officeace-adapter.ts` 由**同一个 `dsmlMode` 开关**同时驱动两半
  （注入提示 + 传 `dsmlToolMode`）—— 单边存在就等于没修。

### ⚠️⚠️ OfficeAce **默认不走 DSML**（2026-10-13 三次事故后决定）

> ⚠️ 这里的「三次事故」是**当时**的计数；当天晚些又发生第四次
> （「聚合 provider 很快就结束了没有原因」），见下方「第四次事故」。
> 两者根因同族：协议实现散落，换个通道/换个笔误就漏一半。

`officeace-adapter.ts` 的 `dsmlMode` **默认 `false`**，只有
`OFFICEACE_DSML=1` 且模型匹配 `needsDsmlToolMode` 时才为真。

| 开关 | 「教」= 注入 `buildDsmlSystemPrompt` | 「解」= 传 `dsmlToolMode` | 请求体 |
|---|---|---|---|
| 默认（未设 env）| ✗ | ✗ | 发标准 `tools` 字段 |
| `OFFICEACE_DSML=1` | ✓（且不发 `tools`）| ✓ | 只发注入的 system 提示 |

**为何默认关**：DSML 把工具协议从「框架保证的结构化字段」降级成「模型自觉
遵守的文本约定」，而 `deepseek-v4.1-flash` 经本渠道**无法稳定遵循** —— 三轮
迭代（注入提示 → 大小写判定 → `calls` 别名兼容）全部到位后，模型仍在同一轮
里混写 `<｜DSML｜tool_calls>` 与 `<｜DSML｜ calls>`；更常见的是**压根不发工具
调用**，只输出「我这就去查：」然后结束（用户视角 = 「Agent 不干活」）。
两害相权：标准 `tools` 字段下**工具必定可用**，超时风险留给需要它的场景权衡。

⚠️ 故本节描述的「解析接线」在**默认配置下不执行** —— 它是为
`OFFICEACE_DSML=1` 那条路径准备的。**codearts 通道不受本开关影响**，
`needsDsmlToolMode` 在那边仍是恒开（见 `llm-adapter.ts`）。

### 守卫

行为级（**真喂 SSE 流、断言 chunk**）：
`tests/unit/dsml-consume-wiring.spec.ts` —— 这是**唯一**能证明接线通了的守卫。

- ① / ②：开启时解析出 tool-call、关闭时**逐字节**保持旧行为（对照）。
- ③：逐字符分帧（标签必然跨帧，只测整块等于没测）。
- ④ / ⑤：开标签**别名**端到端；⑤ 专门覆盖 `\s*` 的**多空白**形态
  （`<｜DSML｜␣␣calls>` / `\t` / U+3000）—— 枚举式保留候选会在此提前放行。
- ⑥ / ⑦：`<thought>` 内容归位到 reasoning；未闭合时残片也须放行。
- ⑧：**正文死循环命中后到达的 DSML 调用仍须执行**。
- ⑨：纯 DSML 响应不得留下孤儿 `block-start(text)`。
- ⑩：上游不合规的 `index:-1` 不得与 DSML 的负数下标撞车。
- ⑪：名字不可用的调用一个 chunk 都不发（报 max-tokens 而非静默 stop）。

源码级（强度有限，只能防「整段协议被删」）：
`tests/unit/dsml-parse-roundtrip.spec.ts` 的 ⑥（**剥注释后**断言
`buildDsmlSystemPrompt(` 与 `dsmlToolMode: true` 各≥2 处）、⑦⑧⑨。

⚠️ **两组的强度差异必须如实标注**：源码 grep **挡不住「删掉接线、保留注释」**
—— 2026-10-13 审计实测，删掉 `openai-compat.ts` 里
`if (dsmlExtractor !== undefined) {…}` **整块**后，当时的入库用例**全部仍绿**
（只有钉住构造那一行的 ⑨ 才红）。这正是必须另立行为级 spec 的原因。

⚠️ 与 §6 的 `reasoning-delta` 归一化缺口是**两件事**：那条是「标记写坏了要修」，
本条是「协议根本没接全」。

### ⚠️⚠️⚠️ 第四次事故（2026-10-13 晚，用户报障「聚合 provider 很快就结束了没有原因」）

**现场取证**（真实会话 `session-bac90b72`，逐字样本）：

| seq | provider/model | 观感 |
|---|---|---|
| 17 / 34 | `aggregate/deepseek-v4-1-flash` | reasoning + 一句正文，`finish=stop`，**零 tool-call**，usage 全 0 |
| 47 | `codearts/deepseek-v4.1-flash` | text 块**整段是 DSML 原文**（690 字符） |

**根因不是「协议没接」，而是「协议接了但读不出这一种笔误」**：
模型输出的是

```
<｜DSML｜ calls>\n<｜DSML｜ invoke name="pwsh">\n<｜DSML｜ parameter name="command" string="true">…</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>
```

`｜DSML｜` 之后**带空格**，且不只在 `calls` 上 —— `invoke` / `parameter` 同样中招。
而当时 `feed()` 的归一正则 `(<\/?)｜DSML｜\s*(?:tool_)?calls>` **只覆盖
`tool_calls` / `calls` 一种名字** ⇒ `indexOf(DSML_INVOKE_OPEN_PREFIX)`
恒不命中 ⇒ `parseDsmlToolCalls` 返回**空数组** ⇒ `in-dsml` 分支把它当
「解析成功但无调用」⇒ **整段工具调用被静默丢弃**。

⇒ 症状与「无报错中断」同型，且**比标签泄漏更糟**：用户连「模型写了什么」
都看不到（那 690 字符不是泄漏，是同一根因在**整帧**路径下的另一种表现）。

⚠️ **这条与 §5.6 前三版是同一个病根的第四种形态**：协议定义散落、
换个通道/换个笔误就漏一半。修法仍是**收归一处**（`normalizeDsmlText`）。

**本轮修的 4 条真缺陷**（均反向验证，见 `scripts/reverse-verify-dsml.mjs`）：

1. **`invoke` / `parameter` 的空白形态从未被归一** ⇒ 内容凭空消失。
   新增 `normalizeDsmlLabel`（对**任意**标签名压空白，名字规则与
   `normalizeDsmlText` 同源）。
2. **`parseDsmlToolCalls` 的空数组被当「解析成功」** ⇒ `in-dsml` 分支
   静默丢块。改为 `parsed === undefined || parsed.length === 0` 一并放行原文。
3. **`parseDsmlInvoke` 在整块上搜 `name=`** ⇒ 模型漏写 invoke 的 name 时，
   第一个 `name=` 命中 **parameter 名** ⇒ 工具名变成 `command` /
   `path` / `pattern` ⇒ `unknown tool "command"`。改为只在 invoke 开标签内找。
4. **`fixDsmlMarkers` 的 `DSML` 后前视漏了字母** ⇒ `<｜DSML｜｜invoke`
   （右侧双竖线后紧跟 `i`）**一条都修不了**，只修左侧、留下半修形态。
   前视补上协议标签名首字母 `[tcip]`（`t`ool_calls / `c`alls /
   `i`nvoke / `p`arameter / `t`hought）；**不泛化成任意字母**，否则
   `DSMLX` 这类普通词重新被误伤。

**顺带修的两条判据缺口**（都在 `isDsmlLabelPrefix`，均为本轮自伤后修复）：

- 第二段写成 `｜{2,}` 只认双竖线 ⇒ **漏掉规范单竖线形态**（多空白别名走的路）
  ⇒ 标签被提前放行（`dsml-consume-wiring` ⑤ 实测变红）。改回 `｜+`。
- `DSML` 四字符本身会被拆帧切开（逐字符时 `<｜D`、`<｜DS`…），
  加第一段 `^<｜{0,3}$` 纯竖线判据 + 第二段 `D(?:S(?:M(?:L)?)?)?` 逐级可选。

**新增守卫**：`tests/unit/dsml-label-forms.spec.ts`（23 条，**行为级**）。
灵魂是**二分帧 + 逐字符穷举**，样本直接抄**真实会话原文**（自造 fixture
曾在真实数据上失效，见 `session-replay.spec.ts` 的建立理由）。

⚠️ **`aggregate` 为何也中招**：它只是**透传** `options`（含 `tools`）给
`ctx.llm.stream({ provider: target.provider, model: target.realId })`，
下层 codearts 注入了 DSML 提示、模型写 DSML、解析器读不出 ⇒
**聚合层零改动也照样中招**。即：这类缺陷的排查不能停在聚合层。


## 5.9 ⚠️⚠️ 模型上下文窗口初版**全是估值**（2026-10-15 真机取证改正）

**用户报障**：「验证一下 officeace 的 ds v4.1 flash 模型的上下文窗口是不是只有
197k，还是可以 1m —— 我们设置的不对」。

### ① 结论：初版小 5.3 倍，且**症状是静默降级**

`OFFICEACE_MODELS` 初版的 `contextWindow` 一列**没有任何实测**：GLM 三行的
`202_752` 与 CodeArts 表里的 `GLM-5.2` **逐字相同**（`llm-adapter.ts` 的
`CONTEXT_WINDOWS`），`deepseek-v4.1-flash` 的 `196_608` 查无出处
（`git log -S196_608` 只在 `a9dc173` 引入过一次，即 PR !89 的 rebase）。

实测真实上限 **1_048_576**。后果**不是报错而是静默降级**：DSH 的自动压缩阈值是
`min(contextWindow × 0.8, …)`（`dsh-compaction-basic`）⇒ 上下文涨到
`0.8 × 196_608 ≈ 157K` 就压缩，**1M 的能力永远吃不到**；上下文占用指示器的分母
也是错的。⚠️ **「设小了」比「设大了」更难发现**：设大了会 400，设小了只是提前压缩。

### ② 取证手段：让**上游自己说数**（不需要穷举，被拒请求免费）

发一个远超上限的 prompt（`content = ' the'.repeat(1_200_000)`），上游在**推理前**
就拒绝，报文里**自报上限**：

| 模型 | 上游原话 | 取值 |
|---|---|---|
| `deepseek-v4.1-flash` | `input token limit is 1048576` | **`1_048_576`** |
| `deepseek-v4-flash` | `the prompt length 1200004 must less than the maximum input length 1044480` | `1_044_480` |
| `glm-5.2` | 同上句式，`1044480` | `1_044_480` |
| `glm-5.1` | 同上句式，`196608` | `196_608` |
| `kimi-k2.6` | 同上句式，`262144` | `262_144` |
| `qwen3-32b` / `qwen3-30b-a3b` | `This model's maximum context length is 131072 tokens` | `131_072`（原值即对）|
| `glm-5.3` | 只回 `Prompt exceeds max length`，**不给数** ⇒ 改走**夹逼**（见下）| `1_048_576` |

⚠️ **`glm-5.3` 是唯一不给数的**，故用**夹逼**：`1_200_004` 拒、`1_050_038` 拒、
**`1_048_025` 接受（200，`usage.prompt_tokens=1_048_025`）**
⇒ 上限落在 `(1_048_025, 1_050_038]`（宽 **2_013**），该区间内**只有 1 MiB = `1_048_576`
这一个整数兆** ⇒ 取值确定。⚠️ 它的**针尖问句判不出来**：`glm-5.3` 是**思考型**模型，
`max_tokens: 128` 被 `reasoning_content` 吃满后就 `finish_reason: 'length'` 且
`content` **恒为空** —— 那是**判分口径**问题（探针已把输出预算提到 2048），
**不是**截断；窗口结论**不依赖**针尖。

⚠️ **两种报文三种形状**（`ModelArts.81001` / `InvalidParamException` / 通义原生），
故上一行不能写成一条正则 —— 但**都自报数值**，除 `glm-5.3` 外。

输出上限同理自报（小输入 + 超大 `max_tokens`）：

- `deepseek-v4.1-flash` / `deepseek-v4-flash`：`max_tokens range is [1, 393216]`
- `glm-5.3` / `5.2` / `5.1`：`max_tokens must be between 0 and 131072`
- `kimi-k2.6`：`2_000_000` **都不拒**（未取到上限，留保守值）
- ⚠️ 该轮里 `max_tokens=200001` 对 `deepseek-v4.1-flash` / `kimi-k2.6` 是 **HTTP 200**
  —— **别把「200」读成「上限很高」**，它只是没触到阈值；要拿数必须发得足够大。

### ③ 交叉验证：**针尖试验**（证明不是「只被接受」）

只证明「请求被接受」不够 —— 网关**静默截断头部**也会得到同样的 200。
故另做 needle-in-haystack：密码放**最头部**、提问放**最尾部**、`max_tokens: 128`：

| 输入 `prompt_tokens` | 密码 | 模型回答 | 结论 |
|---|---|---|---|
| 250_054 | `CODE-413812` | `CODE-413812` | ✅ |
| **1_020_054** | `CODE-674004` | `CODE-674004` | ✅ **头部真的可见** |
| 1_100_000 | — | HTTP 400 `input token limit is 1048576` | 硬限 |

⇒ 1_048_576 是**输入硬限**且头部不被截断。另：`/v2/models` **不返回任何窗口元数据**
（只有 `id/object/created/owned_by`），`/v2/models/<id>` → 404 `APIG.0101`
⇒ 上游自报是这一列**唯一**的可取证来源。

### ④ 落地的三处口径

1. `contextWindow` 填**输入上限**（上游措辞即 `input token limit`），而 DSH 的
   `contextWindow` 是「输入 + 输出」总容量 ⇒ **偏保守**，压缩阈值稳落在硬限之下。
2. ⚠️ 用户 2026-10-15 明确「1M 可以就用 1M」⇒ `deepseek-v4.1-flash` 取
   **`1_048_576`**（= 上游自报值 = 1 MiB）。⚠️ 别为「凑整 1_000_000」改它 ——
   CodeArts 那侧的 `1_000_000` 是**另一个网关的**实测值，两条渠道**不必等值**。
3. ⚠️ `maxTokens` 顺手改成实测值，但**它目前是死字段**：`resolveModel` 只下发
   `contextWindow` 与模态，**没有任何代码读 `maxTokens`**（见 §6）。

### ⑤ 两个**渠道本身的坑**（不是窗口问题，但取证时都会撞上）

1. ⚠️⚠️ **`glm-5.3` 的「非流式」200 响应在 Node/undici 下是坏 gzip**：报
   `TypeError: terminated`（`cause: Z_DATA_ERROR`），而**同一 host** 的
   `deepseek-v4.1-flash` 正常、`glm-5.3` 自己的 **400** 也正常
   ⇒ 只有它的**非流式 200 体**坏。自建探针必须显式发 **`Accept-Encoding: identity`**，
   否则**永远拿不到它的答案**、还会误判成「网络不稳 / 请求太大被掐」。
   ⚠️ **对插件无影响，已实测**（2026-10-15）：**流式**（`stream: true` + SSE，即
   `officeace-adapter.ts` 的**唯一**推理路径）对 glm-5.3 **正常**（`identity` 有无都一样），
   而插件的另一处非流式调用是 `probe()` 打的 **`/v2/models`**（目录端点，也正常）
   ⇒ 这条只坑**自建的非流式探针**，不是渠道缺陷。
2. ⚠️ **`glm-5.3` 是思考型模型**：`reasoning_content` 与 `content` 是**两个字段**，
   输出预算不够时 `content` 恒空、`finish_reason: 'length'`
   ⇒ 只看 `content` 会把「预算不够」误读成「没读到针尖」。

### ⑥ 复现脚本

`scripts/probe-officeace-limits.mjs`（只读凭据 + 只发请求，`--ref` 选账号；
⚠️ `scripts/` 已 gitignore，与其它探针同例 = **仅本机保留**）：
`--limits` 自报上限一轮全打、`--needle --model <id>` 针尖试验、`--maxout` 输出上限。
⚠️ 会真的消耗额度（针尖一轮约 1M input token；**超限被拒的请求不产生生成费用**）。
⚠️ 本轮取证在 `OFFICEACE_ACCOUNT_DE2A4FB8` 上消耗约 **4.2M input token**
（6 次被接受的请求：250K / 600K / 1.02M / 250K / 1.02M / 1.048M，另 1 次 20K；
其中两次命中前缀缓存）。
⚠️ 余额**读不到实时值**：`/v1/subscription` 仍要求 IAM/V11 签名（当前 `APIG.0301`）
⇒ `fetchSubscriptionSummary` 回落到本地缓存（`stale: true`），**无法据此核对扣费**。

## 6. 待办 / 已知缺口

- ✅ ~~**`glm-5.3` 的上下文窗口未取证**~~ —— **2026-10-15 已取证**：夹逼定在
  `(1_048_025, 1_050_038]` ⇒ `1_048_576`（见 §5.9）。原文这条已过期，保留一行是
  为了留下「上游不给数时**夹逼**仍然可判」这个手法。
- ⚠️ **上游若调窗口，本插件不会知道**：`/v2/models` 零元数据（§5.9 ②）⇒ 这八行是
  **快照**，只能靠重跑 `scripts/probe-officeace-limits.mjs --limits` 发现漂移。
  若将来这列又可疑，**先跑探针再改值**。
- ⚠️ **`OFFICEACE_MODELS` 的 `maxTokens` 是死字段**（2026-10-15 登记）：写了从没人读
  （`resolveModel` 只下发 `contextWindow` 与模态）。值已按 §5.9 实测更新，但**填了不生效**；
  要让 DSH 用上得先接 `defaultMaxTokens`（同 `minimax` / `raccoon` 的做法）。
- ✅ ~~**`maasBaseUrl` 是死字段**：写了从不读~~ —— **2026-10-13 已修**（见 §5.7）：
  推理/探测三处改读凭据里的 `maasBaseUrl`（缺失回退默认域）；V11 管理面
  （`/v1/subscription`、`/v1/model-token-rates`）实测两个 host 都存在且都要求 IAM
  签名，**刻意不动**。原文这条已过期，保留一行是为了让「写过却没人读的字段」
  这个教训留在原地。
- **`fetchModelTokenRates` 读共享 `session.json`** ⇒ 多账号下倍率取「最后登录那个」。
  影响低（倍率是账号级静态配置，取不到时空表降级），但它与 §4 是同一类。
- **V11 `scope` 硬编码 `cn-southwest-2` / `apic`**：当前与 URL 一致故正确，
  但没有守卫 —— 账号若被分配到别的 region，签名 scope 与 Host 都会错。
- **`reasoning-delta` 未接 DSML 归一化**：11 处思考链出口全发原文，
  守卫清单里也没登记。见 `protocol-wire.md`。
- **`login.poll` 的 `done:false, error` 客户端零消费** ⇒ 用户看到「转圈 5 分钟」。
- ⚠️ **`officeace.status` 不反映「永久积分锁定」**（2026-10-15 第二轮审计登记，
  **刻意不修**，详见 §2.7 ⑧）：该 RPC 用**无 ref** 的 `readOfficeAceCredential()`
  判 `ready: true`，与锁定表无关 ⇒ 锁定期间面板显示「就绪」而推理侧抛
  「没有可用账号」。**不是绕过**（不烧积分），是**诚实性**缺口；修它要同时改
  RPC 响应与客户端文案（含 bundle 重建），建议与「每日额度刷新入口」一起做。
