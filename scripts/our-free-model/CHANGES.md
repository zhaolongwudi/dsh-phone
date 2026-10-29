# 本对话（2026-10-16）的改动清单

供新对话接续使用。全部工具已整理到 `scripts/our-free-model/`。

> **2026-10-16 晚·第十四轮**：修「用量徽标恒占位」真实缺陷，并把**老 Jet Hub 的
> 完整设置页合并回 OFM**（补丁 G）。详见第 9 节与
> `docs/reports/移植第十四轮-老插件功能回归与徽标修复-20261016.md`。

## 一句话概要

把独立插件 **Jet Hub（`dsh-providers-hub`）的全部能力合并进 Our Free Model 自带的渠道包**
（`vendor/channel-pack`，源自 gitee `iJetLi/deepseek-harness-codearts`），**Jet Hub 已退场**；
并**重建了「用量徽标」**（模型选择器左侧的渠道·积分胶囊）。
**第十四轮补**：那枚徽标此前**一直是坏的**（恒占位），且**老 UI 整体丢失**；两者都已修复。

---

## 1. 架构变更（最重要）

| | 之前 | 现在 |
|---|---|---|
| 渠道引擎 | Jet Hub（独立插件，npm 包） | **OFM 自带 `vendor/channel-pack`** |
| 渠道包来源 | — | **gitee 上游 master**（用 WASM esbuild 重建 `pack.js`） |
| RPC 端点 | `jet-hub`（Jet Hub 提供） | `jet-hub`（**OFM 渠道包自己提供**，名字未变） |
| Jet Hub | 加载中 | **已从 profile 移除**（文件保留在 `node_modules/dsh-providers-hub`，可回滚） |

**关键事实**：渠道包与 Jet Hub **同源**，且**都读写同一份 `$DSH_HOME/jet-hub/state.json`** ——
所以切换时 36 个账号、模型黑名单、签到状态**无缝继承，无需数据迁移**。

## 2. 新增/重写的补丁脚本

| 脚本 | 作用 |
|---|---|
| `patch-channelpack-port.mjs` | 把 OFM 的本地适配施加到**渠道包上游源码**（7 处：网络出口 outlet、`disableOpencode`、代理 API 改名对齐） |
| `patch-capsule-port.mjs` | 胶囊**服务端**：`active-route.ts` + 聚合/自动适配器「转发开始即记录」+ RPC 端点 `router.activeRoute` |
| `patch-capsule-client.mjs` | 胶囊**客户端**（**已撤销**，见第 4 节） |
| `patch-badge-port.mjs` | **用量徽标**客户端（补丁 F）：把上游 `plugin-src/client/` 的 8 个源文件拼成 IIFE 注入 OFM 的 `client.js` |
| `patch-jet-hub-ui.mjs` | **老 Jet Hub 设置页**（补丁 **G**，第十四轮新增）：复用 `dsh-providers-hub/lib/client/jet-hub.js` 恢复 26 项丢失功能 |
| `update-channelpack.mjs` | 渠道包一体化：拉 gitee → 补 451 屏蔽文件 → 施加两个补丁 → 构建 → 备份安装 |
| `fetch-gitee-src.mjs` | 拉 gitee 上游 `src/`（6 并发、3 重试） |
| `hub-rpc.mjs` | **访问运行中实例的插件 RPC**（自签 cookie，见第 5 节） |
| `patch-phone-port.mjs` | OFM 本体补丁（**原 A 已删除**，现只留 B/C/D；D 的数据源从 Jet Hub 改为自家渠道包） |
| `headless-client-check.mjs` | 桩 React 无头加载验证（守**加载期/注册期**失败；第十四轮新增） |
| `render-check.mjs` | 真实 `react-dom/server` 渲染验证（守**渲染期**白屏；第十四轮新增） |
| `render-aggregate.mjs` | **直接渲染 AggregatePanel**（注入 `useState` 初值让候选行真的渲染）—— 因为 `render-check` 到不了这个面板；第十四轮新增 |
| `check-aggregate-wiring.mjs` | **交互接线验证**：取元素树后**真的调 `onClick`**，断言发出 `aggregate.setAllowed{allowed:true}`（守「点了没反应」那类缺陷；对未打 H 的文件正确失败）；第十四轮新增 |
| `probe-served-bundle.mjs` | 抓服务端**实际发出**的 bundle 字节（判断要不要重启；第十四轮新增） |
| `capsule-src/` | **固化素材**（`active-route.ts` / `active-model-pill.js`），替代会被清理的 `/tmp/capsule-repo` |
| `gitee-client-src/` | **gitee 权威客户端源码**（`jet-hub.gitee.js` / `AggregatePanel.gitee.js` / `aggregate-panel-logic.js`）—— 下一轮补「聚合排序/拖动」的单一真相源 |

## 3. 三个必须知道的技术事实

### ① 设备上没有可用的原生 esbuild
Android 禁止从应用数据目录执行二进制 → `Permission denied`。
**解法**：用 `esbuild-wasm`（纯 WebAssembly）+ 一个垫片让 `require('esbuild')` 指向它。
构建区：`/data/data/com.dshphone/files/ofm-build/`（`node_modules/{esbuild,esbuild-wasm,jose,undici}`）。

### ② gitee 对 `src/opencode-proxy.ts` 返回 HTTP 451
（文件含 "proxy" 被拦）。`update-channelpack.mjs` 自动从 npm 上游 `dsh-providers-hub`
的**编译产物**里取同名文件补齐。

### ③ 聚合的失效转移**只在一个块都没开时才换渠道**
`aggregate-adapter.ts` 约 2002/2067 行：`emitted` 或 `openedBlocks.size > 0` ⇒ **throw，不换候选**。
**这是老版就有的行为，不是合并引入的**（已逐行对比 Jet Hub 1.6.261016）。

## 4. 徽标（用量徽标）——本次的核心用户需求

**位置**：槽位 `conversation.input.right`，渲染在 `conversation.input.model` **之前** ⇒
天然落在**模型选择器左侧**。

**目标样式**（用户截图为准）：
```
● Loomy (讯飞) · 36231积分      ← 点开：三档偏好 / 逐账号明细 / 签到 / 全部渠道签到(自动)
```

**两处踩坑（都已修）**：

1. **`callJetHub` 必须定义在 `apply(ctx)` 内部**。初版插在模块级，而函数体用 `ctx.connection`
   ⇒ `ReferenceError` 被徽标的 `.catch(() => setActiveProvider(null))` 静默吞掉 ⇒
   **永远停在占位「聚合 · 待首次请求」**。
2. **数据源必须用 `router.activeRoute`**（转发一开始就写），**不是**上游的
   `aggregate.activeProvider`（整轮成功后才写）—— 后者在渲染门控阶段恒为 null ⇒ 恒占位。

**标签必须取 `PROVIDER_REGISTRY.label`**（`Loomy (讯飞)`、`CodeArts (华为云)`），
**不是** OFM 那份精简的 `CHANNEL_PROVIDERS.name`（只有 `Loomy`）。

**已撤销**：`patch-capsule-client.mjs`（补丁 E）—— 那是"输入区最下方的在用模型读数"，
用户不要。徽标（补丁 F）与它**互不依赖**（锚点用 OFM 自己的 `settings.onboarding`）。

## 5. `hub-rpc.mjs` 的原理（很有用）

Web 的启动令牌只在进程内存、日志被 redact ⇒ 外部 `fetch` 一律 401。
但 **cookie 签名密钥是持久化的**（`.credentials.yaml` 的 `client-connection/browser-session`，
`initializeSecret()` 写一次后长期复用），校验就是普通 HMAC-SHA256 ⇒ 可本地自签：

```
body      = base64url(JSON.stringify({ version:1, authority, issuedAt, expiresAt }))
签名      = base64url(HMAC-SHA256(secret, body))
cookie 值 = `v1.${body}.${签名}`
cookie 名 = 'dsh-auth-' + base64url(SHA256(authority))
authority = 请求的 host（http 下即 127.0.0.1:3080）
```

用法：`node hub-rpc.mjs provider.status '{"providers":["loomy"]}'`

## 6. 数据佐证：合并后反而更稳

| 日期 | 请求 | 错误 | 错误率 |
|---|---|---|---|
| 10-14（合并前） | 6509 | 751 | 11.54% |
| 10-15（合并前） | 8070 | 852 | 10.56% |
| **10-16（合并后）** | 1949 | **13** | **0.67%** |

`aggregate|deepseek-v4-1-flash` 951 次请求，实际分发到 **officeace 523 次 + loomy 387 次**
⇒ **「同模型换供应商」在正常工作**。

## 7. 待办 / 未验证

- [ ] **徽标尚未经用户验收**：`client.js` 最后一次改于 19:5x，需刷新页面看是否显示
      `Loomy (讯飞) · 36231积分` 且**可点开**
      → **第十四轮已定性并修复**（恒占位根因是键不一致，见 §9.1）；
      宿主侧修复**需重启 DSH 生效**，客户端侧（补丁 G）刷新即生效。
- [ ] Jet Hub 的文件仍在 `node_modules/dsh-providers-hub`（约 4 MB，未加载）——确认稳定后可删
      → ⚠️ **第十四轮改为「必须保留」**：其 `lib/client/jet-hub.js` 是补丁 G 的唯一来源。
- [ ] 未验证：`patch-badge-port.mjs --fetch` 在全新环境能否一次跑通（依赖 `ofm-build/gitee-src` 已存在）
- [ ] README.md 里的「渠道包同步」章节未随徽标改动更新

## 8. 「自动停止」已定性（非本仓库问题）

用户报"任务经常自己中断"。**根因是 DSH 的长期目标被解除武装**（会话恢复/重启后自动
`disarmed`），不是模型或渠道故障——证据：95 个会话文件里**零条**中断记录、错误率 0.67%。
该目标已标记 `complete`，不再有自动续跑，因此不会再出现。

## 9. 第十四轮：功能回归与徽标修复（2026-10-16 晚）

### 9.1 修了一个真实缺陷：徽标恒占位

**根因是「存与取的键不一致」**：

| 侧 | 键 | 位置 |
|---|---|---|
| 写（服务端） | **路由键** `aggregate` | `aggregate-adapter.ts`：`activeRoutes.record(AGGREGATE_PROVIDER, …)` |
| 读（客户端） | **模型键** `glm-5-3` / `auto` | `usage-badge.js`：`readActiveProvider(modelId)` |

`ActiveRouteRegistry` 是 `Map<routerProvider, …>` ⇒ 按模型键查**必然 miss**。真机取证：

```
router.activeRoute {"provider":"aggregate"}            → loomy   ← 有值
router.activeRoute {"provider":"glm-5-3"}              → null ❌
router.activeRoute {"provider":"deepseek-v4-1-flash"}  → null ❌
```

**修法**：`record()` 加第 4 个可选形参 `modelKey`，**两处同时写**；聚合适配器传入它
本来就有的 `modelKey`。**只有聚合传**（`aggregate/auto` 与 `jet-hub-auto/auto` 同名，
都写会串扰；徽标只在选中 `aggregate` 时查询）。

### 9.2 恢复了丢失的老插件界面（补丁 G）

**定性**：渠道包 62 个 RPC 端点，老 Jet Hub 客户端用 **47** 个，OFM 只接 **23** 个
⇒ **26 项功能没有任何界面入口**。

**做法**：老客户端产物（`dsh-providers-hub/lib/client/jet-hub.js`）**仍在设备上**，
只依赖 `react`、47 端点全可用 ⇒ **整体复用**成 IIFE 注入 OFM 的 `client.js`。

**恢复的界面**（真渲染实测）：供应商 / 一键签到 / 备份 / 恢复 / 网关 / Token 用量 /
渠道原生搜索 + **19 个渠道面板**（17 真渠道 + 聚合）。

**唯一手术**：摘掉老 UI 自带的 `conversation.input.right` 徽标注册（`jet-hub-usage`）——
OFM 那枚已占同槽位，否则输入框会**并排出现两枚一模一样的胶囊**。

### 9.3 三个真实踩坑（前两个都曾让补丁完全无效）

1. **抽取起点切错** ⇒ 只切 `var exports` 而不带 `var module` 时，那行会去**外层**找
   `module`（即 OFM 包装器的），**劫持 OFM 自己的导出**（实测槽位 4 → 1）。
   修法：**从 `var module` 开始切**（自带声明 + 含导出接线）。
2. **验证器的 `slots.register` 是丢弃桩** ⇒ 一个槽位都抓不到，被误读成「补丁没生效」。
   两个 bundle 都走 **`ctx.slots.register`（外层那个）**，不是 inject 回调的形参。
3. **`--revert` 连带还原线上文件**（本轮我自己造成的事故）：在副本上演练补丁链时跑
   `patch-badge-port.mjs --revert`，而那个脚本**硬编码**安装位置、没有 target 覆盖
   ⇒ 把**线上**的 F 补丁也还原了（`client.js` 1350964 → **454747** 字节，F/G 全没）。
   恢复靠 `.pre-patch-*` 备份（`client.js.pre-patch-h` = 「F+G 完好、H 未打」那一版）。
   加固：给该脚本补 `OFM_BADGE_TARGETS`，并已验证「对副本 revert 时线上字节数不变」。

### 9.4 新增工具

| 文件 | 作用 |
|---|---|
| `patch-jet-hub-ui.mjs` | **补丁 G**：抽取老客户端 → IIFE → 注入 OFM；`OFM_G_TARGETS` 先对副本试跑 |
| `patch-aggregate-toggle.mjs` | **补丁 H**：聚合候选**三态**（修「非临期候选开关点了没反应」，38/183 条）。⚠️ 被补丁 I **取代**（I 是超集）：打 I 后本补丁自检报「已被取代（正常）」并跳过 |
| `patch-aggregate-ordering.mjs` | **补丁 I**：聚合**排序模式 / 鼠标拖动 / 一键拒绝非临期**（gitee 排序版面板 + 21 个纯函数，整块替换）。**必须排在 H 之后**；`OFM_I_TARGETS` 先对副本试跑 |
| `patch-badge-fallback.mjs` | **补丁 J**：徽标读数**双端点回退**（先问 `router.activeRoute`，拿不到再问 `aggregate.activeProvider` 并**必须带 canonicalId**）。**排在 F 之后**（改的是 F 注入的那段）；`OFM_J_TARGETS` 先对副本试跑。**这是「不必重启就修好徽标恒占位」的关键**，已真机因果 A/B 验证 |
| `headless-client-check.mjs` | 桩 React 无头加载：守**加载期/注册期**失败 |
| `render-check.mjs` | **真实 react-dom/server** 真渲染：守**渲染期**白屏 |
| `render-aggregate.mjs` | **直接渲染 AggregatePanel**：`render-check` **到不了**这个面板（外壳靠 effect 选渠道，而 `renderToString` 不跑 effect ⇒ `selected` 恒 null）。单独注入 `useState` 初值让候选行真的渲染；**断言带区分力**（对已修/未修两份文件必须给出相反结果）。抽取函数用**依赖闭包 + 行首缩进判顶层**（写死名字或按括号深度判都踩过坑，见该文件注释） |
| `check-aggregate-wiring.mjs` | **交互接线验证**：取元素树后**真的调 `onClick`**，断言发出 `aggregate.setAllowed{allowed:true}` / `setOrderMode` / `rejectNonExpiring`；`--manual` 还能验**拖动 `onDragStart` 确实调了 `dataTransfer.setData`**（本仓库历史上那个「拖拽根本不触发」的缺陷）。反向验证过：删掉 `setData` ⇒ 变红 |
| `probe-served-bundle.mjs` | 抓服务端**实际发出**的字节：判断「要不要重启」 |
| `render-panel.mjs` | **通用单面板真渲染**：`render-check` 只渲染外壳，而外壳靠 state 选面板（`selected` / `showGateway` / `showTokenLedger`）⇒ **那些面板自己白不白屏它证明不了**。本工具抽任意具名组件 + 依赖闭包单独渲染。⚠️ 抽取踩过三个坑（都记在文件里）：① 只抽函数 ⇒ 漏掉模块级常量；② 常量**互相依赖**要再入队；③ **必须按源码顺序输出**（BFS 顺序会让 `PROVIDER_REGISTRY` 排在未初始化处）。已验证 GatewayPanel / BackupPanel / TokenLedgerPanel / ProviderSwitchPanel 四个面板真渲染出内容 |
| `check-provider-panels.mjs` | **18 个渠道面板逐个渲染**（把 `selected` 依次注入成每个渠道 id）。为什么要：`render-check` 的 `selected` 是初值 = 第一个渠道 ⇒ 只证明了**那一个**；而 17 家能力不同（`credits`/`creditPackages`/`permanentLock`/`usesExpiryWindow`/`rateLimit`/`accountTest`），面板走**不同分支**。⚠️ 第一版是**假绿**：注入装在 `ReactCurrentDispatcher` 上，被 `renderToString` 自装的 dispatcher 覆盖 ⇒ 18 个渲染出**逐字节相同**的 HTML 却照样报「全部通过」。修法：把代理过的 `React` **传给 `new Function`**（编译期注入）。**并补了防假绿判据**：不同渠道的 HTML 必须互不相同，否则失败 |
| `capsule-src/` | **固化素材**，替代会被系统清理的 `/tmp/capsule-repo` |
| `gitee-client-src/` | **gitee 权威客户端源码**（聚合排序/拖动的单一真相源） |

**关键发现**：服务端 combo 与盘上内容**同步** ⇒ **客户端改动刷新页面即生效**。

### 9.4.1 补丁 H：聚合面板的候选三态（本轮新发现的真实缺陷）

宿主为每个候选下发 `state`（`allowed`/`rejected`/`default-rejected`）与
`rejected`（= `state !== 'allowed'`，语义是「当前不参与轮换」）。npm 版客户端
**从不读 `state`** ⇒ ① 把「默认不参与」的候选显示成**「已拒绝」**（撒谎）；
② 点开关一律发 `setRejected{rejected:false}` ⇒ 删的是**不存在的键** ⇒ **点了没反应**。

受控实验（`glm-5-3-flash` 的 `qoder/gfmodel`，可复跑）：

```
基线                               state=default-rejected
setRejected {rejected:false} → ok  state=default-rejected  ❌ 没变（死开关）
setAllowed  {allowed:true}   → ok  state=allowed           ✅ 手工打开
setAllowed  {allowed:false}  → ok  state=default-rejected  （已回滚）
```

修法照抄 gitee 上游 `plugin-src/client/aggregate-panel-logic.js` 的语义
（`candidateToggleAction` / `candidateStateOf` / `rejectionsFromCatalog`），
含**老宿主回退**（响应无 `state` 时仍按 `rejected` 判，否则升级期用户存过的拒绝全丢）。
验证：**11 项单测**全过 + 真实 catalog 逐条分派（38 条改走 `setAllowed`）
+ **真渲染**（`render-aggregate.mjs` 渲染出「默认不参与」）+ **真点击**
（`check-aggregate-wiring.mjs` 调 `onClick` 后确实发出 `setAllowed{allowed:true}`）。
两个新验证器都做了**反向验证**：对未打 H 的旧文件必须**失败**（否则断言无区分力）。

### 9.4.2 「短信登录 / 验证码」：**误判已修正**（本轮实测）

曾按端点名推断「短信登录没有界面」。**错了**：

- 服务端有完整的**本地登录页**实现 —— `loomy-wechat-login.ts` 的 `/wechat/qr`
  一页里就有**二维码 + 首次绑手机号表单**，`loomy-auth.ts` 的 `sendSmsCode()`
  由**页面自己**调用；
- 实测 `account.create {provider:'loomy'}` 直接返回
  `loginUrl: "http://127.0.0.1:42277/wechat/qr"` ⇒ 客户端只需照常 `window.open`，
  与 codearts / lobsterai / qoder / trae / cline **同一条路径**；
- gitee 上游注释还记着原因：早期那个「短信表单」分支有**顺序死锁**
  （表单等 `account.create`、而它又要先有手机号）⇒ 已删，改走微信扫码。

⇒ `login.sendSms` / `submitSms` 是**登录页的内部接口**（服务端页面调用），
客户端本来就不该直接调。**「短信登录」不是丢失功能、也不是待开发功能 —— 它已在工作。**
⚠️ 本轮实验建的账号已删除（Loomy 账号数回到 3，状态文件与凭据库均无孤儿）。

### 9.4.3 补丁 I：聚合排序 / 拖动 / 一键拒绝非临期（第十五轮）

宿主**早就支持**、catalog **早已下发**、但客户端一直没有界面的三件事：

| 端点 | 现在 |
|---|---|
| `aggregate.setOrderMode` | 顶部「排序：按临期／按手工」**单按钮**切换 |
| `aggregate.setOrder` | **鼠标拖动**候选自定义顺序 |
| `aggregate.rejectNonExpiring` | 「拒绝非临期」一键恢复按钮 |

实测宿主确实支持（不是照文档猜）：

```console
aggregate.setOrderMode {mode:'manual'} → {orderMode:'manual'}   ✓
aggregate.setOrder {canonicalId, order:[…]} → {order:[…]}        ✓
aggregate.rejectNonExpiring {}         → {cleared:N}             ✓
```

⚠️ **顺序键是 `provider\0realId`**（双键）。我一开始按 `provider` 单键提交，宿主
照收但 `order` 回空数组 —— 因为对不上任何候选。

**做法**：把两块**成对**换成 gitee 排序版 —— 21 个纯函数 + 662 行面板。
⚠️ **只换一块会静默出错**：gitee 面板调 `candidateToggleAction(id, cand, resolved)`
（第 3 参**对象**），npm 版是 `(id, cand, state)`（第 3 参**字符串**）⇒ 三态错位
⇒ 开关又变「点了没反应」。补丁 I 写盘前会核对两块都换了。

**为什么值得**：gitee 版带着本仓库历史上那个缺陷的修复 ——
`onDragStart` 漏了 `dataTransfer.setData` ⇒ 拖拽根本不触发（用户当时的报障：
「拖动好像是不生效的」）。新验证器**钉住了这一点**。

**与补丁 H 的关系**：I 是 H 的**超集**（多一个 `expiryWired === false` 分支），
两者改同一段。打 I 后 H 标记消失**是正常的** —— H 自检已能识别为
「已被补丁 I 取代（正常）」并跳过。
⚠️ 顺带堵掉一个真实风险：H 的 `--apply` 在这种情况下会因 `.pre-patch-h` 不存在而
**把 I 的产物当成原始文件备份** ⇒ 回滚再也回不到干净版。现已直接跳过。

### 9.4.4 补丁 J：徽标恒占位**不必重启**的修法（第十六轮，真机因果验证）

**上一轮结论「必须重启 DSH」不完整**。本轮回头发现：**旧端点本来就能按模型查**。

```
router.activeRoute       {provider:'glm-5-3-flash'} → {"provider": null}    ✗
aggregate.activeProvider {canonicalId:'glm-5-3-flash'} → {"provider":"loomy"} ✓ 一直有数据
```

上游为「实时性」把读数换成新端点（转发一开始就写），而新端点的宿主侧修复
被 `pack.js` 的**进程内缓存**挡住 ⇒ 徽标恒占位。旧端点的历史数据一直都在。

**修法**：读数改双端点 —— 先问新端点，拿不到再问旧端点（**必须带 `canonicalId`**）。

两个关键点（都是查过才定的）：
1. **必须 try/catch**：`callJetHub` 失败是 **throw**，不接住则回退永不执行
   （我第一版就漏了，自查时发现）；
2. **回退必须传 `canonicalId`**：无参时宿主回 `lastActiveProvider`
   （「任意虚拟模型最近一次成功」）—— 正是用户 2026-10-16 报障
   「用 glm5.3 显示腾讯 codebuddy」的成因。

**真机因果 A/B（最强证据）**：同一会话、同一选中模型，只换 client.js 版本 ——

| 阶段 | 服务端发出的字节 | 页面徽标 |
|---|---|---|
| A 未打 J | `badge endpoint fallback` **0 次** | `聚合 · 待首次请求`（占位） |
| B 打上 J | **1 次** | **`Loomy (讯飞) · 30160积分`** |

⇒ **刷新页面即生效，无需重启。**

⚠️ **本轮两处自我修正**：
1. 上轮只验了「宿主侧要重启」，**没问「有没有别的端点现在就能用」**；
2. A/B 之后恢复时**拷错了备份**（把 `.pre-patch-j` 当成 J 版拷回线上），
   靠字节数 + 服务端命中数 + 语法三项核对发现并改用工作区那份恢复。
   另：补丁 J 自己的守卫也曾用**字面量**核对缩进（14 vs 实际 16 空格）而误报，
   已改成正则只核对语义。

### 9.5 持久性加固（防下次同步静默回退）

- `update.mjs` 已把补丁 J 加为 **`[3.5/7]`**（排在 F 之后 —— 它改的正是 F 注入的那段）、
  补丁 I 为 **`[6/7]`**（排在 H 之后）。顺序都有约束，见文件内注释。

- `patch-capsule-port.mjs`：`CARRY_FILES` 改**候选路径列表**（已装 → 工作区 → /tmp）；
  徽标修复**由脚本自己产出**（新编辑 `capsule: two-key`）；新增 `doneIf` 幂等判据。
- `update.mjs`：补上补丁 F/G 的重放，**顺序在 phone-port 之后**（锚点是 C/F 改写过的那个）。
- 本地副本 `pack.js`/`active-route.ts` 同步为与已装**逐字节一致**——否则
  `install-to-phone.mjs` 会把陈旧本地副本拷回去、**回退掉修复**。
- ⚠️ **不要删** `node_modules/dsh-providers-hub`：补丁 G 的唯一来源。
