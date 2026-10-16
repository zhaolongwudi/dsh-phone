# _ofm —— Our Free Model 移植与更新工作区

手机版 DSH（`dsh-phone`，内核 `@deepseek-ai/dsh 0.2.1-alpha.3`）上 **Our Free Model** 一个插件的
移植、渠道包同步与更新链路。

> **2026-10-16 架构变更**：原先由独立插件 `dsh-providers-hub`（代号 Jet Hub）充当渠道引擎，
> OFM 的渠道界面通过 RPC 读它的数据。现在 **OFM 自带的渠道包已同步 gitee 上游最新版**
> （含 Jet Hub 的全部功能），**Jet Hub 已退场**。详见第九节历史。

---

## 一、现在的架构

```
Our Free Model（手机上唯一的渠道插件）
  上游：GitHub Ebony-Vinyl/dsh-our-free-model
  ├── 免费车道（Kilo / EAC / 免费模型轮换）
  ├── 聚合路由（aggregate/* —— 跨渠道按临期积分自动选号）
  ├── 看板 / 运行日志 / 省 Token / combo 降级链 / Anthropic 网关
  └── vendor/channel-pack  ← 自带的渠道引擎
        上游：gitee iJetLi/deepseek-harness-codearts
        · 17 个渠道的登录、账号池、积分签到、模型黑名单
        · 本地 OpenAI 网关（端口 8326 —— dsh-phone-account 与 dsh-peer 的锚点）
        · 由 scripts/build-channel-pack.mjs 打包成单文件 pack.js
```

渠道包是**源码形态**（`vendor/channel-pack/src/*.ts`，197 个文件）随 OFM 一起走的，
`pack.js` 由构建脚本从它打出。

### 关键依赖

| 依赖 | 谁依赖它 | 谁在守 |
|---|---|---|
| 渠道包的 RPC 端点名为 `jet-hub` | OFM 渠道页（补丁 C） | `patch-phone-port.mjs` |
| 网关端口 `8326` | `dsh-phone-account` 的 chatgpt 页、`dsh-peer` | 渠道包默认值 |
| `provider-registry.ts` 的结构 | 补丁 D 读它对齐渠道清单 | `patch-phone-port.mjs --check` 报差集 |
| 渠道包 `apply(ctx, { disableOpencode, outlet })` 契约 | OFM 的 index.js 调用它 | `patch-channelpack-port.mjs` 施加 |
| `channel-fetch.ts`（OFM 独有） | 渠道请求走本插件出口 | 同步时从现有安装带过 |

---

## 二、两条更新链路

**① 更新 OFM 本体**（GitHub 上游）：

```bash
cd /storage/emulated/0/Download/dsh/ai/_ofm
node update.mjs            # 对比 commit → 拉取 → 重放补丁 B/C/D → 安装
# 完成后重启 DSH 应用
```

**② 更新渠道包**（gitee 上游）：

```bash
node update-channelpack.mjs --check   # 自检构建环境与目录
node update-channelpack.mjs --apply   # 拉上游 → 补屏蔽文件 → 带适配 → 施加 → 构建 → 备份安装
node update-channelpack.mjs --dry-run # 只构建不安装
# 完成后重启 DSH 应用
```

已建**每日 09:00 的提醒**（`schedule` id 见设置），发现 gitee 有新提交会提醒你，
**不会自动安装**。

---

## 三、文件清单

| 文件 | 作用 |
|---|---|
| `update.mjs` | OFM 本体：对比 GitHub commit → 拉取 → 重放补丁 → 安装 |
| `update-channelpack.mjs` | **渠道包一体化**：拉 gitee → 组装 → 施加适配 → 构建 → 安装 |
| `fetch-release.mjs` | 按上游 `files` 清单从 raw.githubusercontent 拉 OFM 发布文件集 |
| `fetch-gitee-src.mjs` | 拉 gitee 上游 `src/`（6 并发、3 次重试） |
| `patch-phone-port.mjs` | OFM 补丁 **B/C/D** 的唯一来源（`--check`/`--apply`/`--revert`） |
| `patch-channelpack-port.mjs` | 把 OFM 的本地适配施加到渠道包上游源码（7 处，幂等） |
| `install-to-phone.mjs` | 装 OFM 进 phone profile / 摘除 / 查看状态 |
| `hub-rpc.mjs` | 访问**运行中**实例的插件 RPC（自签 cookie，见第七节） |
| `check-imports.mjs` | 检查插件依赖是否都能解析 |
| `dsh-our-free-model/` | OFM 的**上游副本**（打过补丁，原版在 `*.pre-patch`） |
| `.ofm-upstream.json` / `.gitee-synced` | 记录已锁定的 OFM 版本 / 渠道包同步基线 |

> 历史文件：`update-all.mjs`、`update-hub.mjs` 是"双插件时代"的入口，Jet Hub 退场后不再需要
> （保留以便回滚参考）。

---

## 四、OFM 的补丁 B/C/D（只动 OFM 自己的文件）

| 补丁 | 文件 | 内容 |
|---|---|---|
| **B** | `index.js` | `distributionOf()` 一律返回 `managed`，停用应用内自升级——否则它会用上游原样文件覆盖 C/D。 |
| **C** | `client.js` | 渠道页 RPC 端点 `'channel-pack'` → `'jet-hub'`，让本插件界面驱动自带渠道包（它源自 gitee 上游，端点名就是 `jet-hub`）。 |
| **D** | `client.js` | 渠道清单与积分能力表对齐渠道包的 `provider-registry.ts`。本页两张表都是写死的静态数组，渠道包新增渠道后：少了卡片就**无法登录/刷新/看积分**，少了 credits 条目卡片就**不加载也不显示余额与签到**。每次运行都读 registry 补齐（只增不改）。 |
| **F** | `client.js` | 「用量徽标」——模型选择器左侧那枚「渠道 • 余额」胶囊（`patch-badge-port.mjs`）。 |
| **G** | `client.js` | **老 Jet Hub 的完整设置页**（`patch-jet-hub-ui.mjs`）—— 复用 `dsh-providers-hub/lib/client/jet-hub.js` 恢复 26 项丢失功能（19 个渠道面板 / 聚合 / 备份 / Token 用量 …）。⚠️ 唯一手术：摘掉它自带的徽标注册，避免与 F 并排显示两枚胶囊。 |

**补丁 A 已删除**：它原本用于阻止 OFM 挂载自带渠道包（避免与 Jet Hub 抢 8326 端口、
争 `.credentials.yaml` 里的凭据）。Jet Hub 退场后这个冲突不存在了，故移除——
现在**默认挂载**，无需任何环境变量。

补丁都**幂等**且带锚点校验：上游结构一变就**明确报错并停止**，不会静默写坏。
原文件备份为 `.pre-patch`（各补丁有自己的后缀），`node patch-phone-port.mjs --revert`
可整体还原。

### 客户端改动的三层验证（本机唯一可行的方式）

这台设备**跑不了** `pnpm test`（见第八节），故本轮建了三个验证器，**每个都先对
已知可用的基线跑一遍**才算数：

| 脚本 | 桩/真 | 守什么 |
|---|---|---|
| `headless-client-check.mjs` | 桩 React | **加载期/注册期**失败（语法、缺符号、槽位重复） |
| `render-check.mjs` | **真** `react-dom/server` | **渲染期**失败（白屏） |
| `probe-served-bundle.mjs` | — | 「改盘上文件后服务端发的是不是新内容」⇒ 判断要不要重启 |

> `probe` 的结论：服务端 combo 与盘上内容**同步** ⇒ **客户端改动刷新页面即生效**。

---

## 四点五、在用模型胶囊（Active Model Pill）

**输入区最下方一行实时读数**：显示本次请求**实际发往**的渠道与模型。两行竖排
（上行渠道、下行模型），点一下展开明细（渠道 / 模型 / 选择 / 虚拟模型 / 更新于）。

**为什么需要**：路由型 provider（`aggregate`、`jet-hub-auto`）在模型选择器里只显示一个
**虚拟**名字，用户看不到「这一次到底发给了谁、烧的是哪个渠道的额度」。

| 侧 | 文件 | 内容 |
|---|---|---|
| **服务端** | 渠道包（`patch-capsule-port.mjs`，7 处） | `active-route.ts`（进程内读数表）+ 两个路由适配器在**转发一开始**记录 + RPC 端点 `router.activeRoute` |
| **客户端** | OFM `client.js`（`patch-capsule-client.mjs`，**补丁 E**） | `ActiveModelPill` 组件 + 注册槽位 `conversation.composer.dock`（与官方 activity/usage 两枚胶囊同槽位，order 2） |

### ⚠️ 与新端点并存的老端点：判据相反，不要合并

| 端点 | 语义 | 写入时机 | 服务对象 |
|---|---|---|---|
| `aggregate.activeProvider` | 上次实际**成功**的渠道 | 整轮跑完且成功 | **余额徽标**（显示刚失败、已无额度的渠道会误导） |
| **`router.activeRoute`** | **本次正在发往**的目标 | **转发一开始** | **本胶囊**（长回答几十秒，等跑完就失去实时性） |

两者在「请求进行中」必然不同，这是规格如此。

### 实现上的两个致命细节（都来自真机事故）

1. **目录必须惰性取**：`ctx.modelDirectories.directoryFor(sessionId)` 内部访问
   `remote.session`，在槽位 `inject` 期求值会抛 `cannot get property "remote.session"
   without inject` —— 而它发生在**输入区渲染的同步路径**上，后果是**模型选择器整个
   点不动**，远不止胶囊不显示。故交出的是取值函数，由组件在自己的 effect 里调用。
2. **必须自己调 `load()`**：目录 store 初值是 `{ current: null, status: 'idle' }`，
   不 load 就永远拿不到 `current`，胶囊恒显示占位。

**无历史时的行为**：路由型 provider 显示**占位**（上行虚拟渠道名 + 下行「等待首次请求」），
而不是不渲染 —— 一个会自己冒出来的占位比"什么都不显示"更容易让人确认功能是活的。

**原实现**在 `/data/data/com.dshphone/files/tmp/capsule-repo/`（基于 0.2.0-rc.3 的 19 个
接线补丁），本次按 gitee 上游最新版重新接线；组件源码由 `patch-capsule-client.mjs`
从那里读取并改写成 ModuleLoader 形式，故**单一真相源仍在胶囊仓库**。

---

## 五、安装位置与备份

| 位置 | 说明 |
|---|---|
| `$DSH_HOME/profiles/phone/node_modules/dsh-our-free-model` | 运行时加载的插件 |
| `$DSH_HOME/profiles/phone/node_modules/dsh-our-free-model/vendor/channel-pack/` | 渠道包：`pack.js`（运行时加载）+ `src/`（源码，供下次带过适配与审计） |
| `$DSH_HOME/channel-pack-backup/<时间戳>/pack.js` | 渠道包更新前备份 |
| `$DSH_HOME/switch-backup-<时间戳>/` | **2026-10-16 弃用 Jet Hub 的完整切换前备份** |
| `$DSH_HOME/jet-hub/state.json.bak-*` | 手工治理模型前的账号池与黑名单备份 |
| `$DSH_HOME/profiles/phone/package.json.bak-*` | phone profile 清单备份 |

`$DSH_HOME` = `/data/data/com.dshphone/files/dsh-home`，
构建区 `$OFM_BUILD_DIR` = `/data/data/com.dshphone/files/ofm-build`。

### 回滚到 Jet Hub（如需）

```bash
P=/data/data/com.dshphone/files/dsh-home/profiles/phone
cp /data/data/com.dshphone/files/dsh-home/switch-backup-*/package.json "$P/package.json"
cd /storage/emulated/0/Download/dsh/ai/_ofm
cp /data/data/com.dshphone/files/dsh-home/switch-backup-*/ofm-index.js.pre-patch "$P/node_modules/dsh-our-free-model/index.js"
cp /data/data/com.dshphone/files/dsh-home/switch-backup-*/pack.js.old "$P/node_modules/dsh-our-free-model/vendor/channel-pack/pack.js"
# 重启 DSH
```

---

## 六、模型列表治理（重要，动手前必读）

### 选择器里为什么会有几百个模型

| 来源 | 规模 | 说明 |
|---|---|---|
| `cordis.patch.yml` 的 `juhe` provider | **85 个** `aggregate/*` | 手写的静态清单，聚合入口 |
| 渠道包的 17 个渠道 | **718 个**（各渠道 `listModels` 之和） | 每个渠道都注册成内核 LLM 路由 |
| OFM 免费车道 | 27 个 | |
| 内核官方 DeepSeek | 若干 | |

其中 **cline 一家就有 487 个**（代理 OpenRouter 长尾），是"极其乱"的最大来源。

### ⚠️ 不能用"关掉渠道模型"来只留聚合

聚合（`aggregate/*`）的候选目录是**从各渠道的模型目录推导**的：

- `aggregate-catalog.js` 模块头：「装配层把每个 provider 的 `ctx.llm.listModels(provider)` 结果
  传进来。⚠️ 该结果**已被各适配器按用户黑名单过滤** ⇒ 被用户关闭的模型**天然不会**成为候选」
- `aggregate-adapter.js` 的 `refreshCatalog`：`catalogs[provider] = await this.ctx.llm.listModels(provider)`
- 它自己的报错文案：`「xxx」当前没有任何可用候选（渠道被关闭、模型被关、或所有渠道都无可用账号）`

**推论**：关掉某渠道的模型 = 把该渠道从聚合候选里摘掉；全关 17 个渠道 = 聚合目录变空，
连默认模型 `aggregate/deepseek-v4-1-flash` 都会失效。

内核也**没有**「注册路由但不进选择器」的能力（`dsh-llm` 的 `visible` 是**流式输出**的可见性）。
⇒ 只能**逐渠道关闭**。

### 已执行的治理（2026-10-16）

关闭 cline 全部模型：`node hub-rpc.mjs provider.setEnabled '{"provider":"cline","enabled":false}'`

| | 治理前 | 治理后 |
|---|---|---|
| 可见模型总数 | 628 | **218** |
| cline 可见 | 410 | **0**（487 全禁） |
| 聚合虚拟模型 | 85 | **85（零损失）** |

**零损失的原因**：cline 的 487 个全是 OpenRouter 长尾，没有一个能归一化成聚合的规范模型键。

⚠️ `provider.setEnabled(false)` 会**连带把该渠道账号置为 `enabled: false`**。要保留账号用：
`node hub-rpc.mjs account.update '{"accountId":"<id>","patch":{"enabled":true}}'`

---

## 七、`hub-rpc.mjs`：怎么访问运行中的实例

Web 的启动令牌（`launchToken`）**只存在于进程内存**，日志里被 redact 成 `?token=[redacted]`，
所以外部 `fetch` 一律 401。

但 **cookie 的签名密钥是持久化的**：由 `dsh-client-connection` 首次启动时写入凭据库
（`.credentials.yaml` 的 `client-connection/browser-session` 记录）。校验就是普通 HMAC-SHA256，
故可照 `encodeCookie()` 逐字自签：

```
body      = base64url(JSON.stringify({ version:1, authority, issuedAt, expiresAt }))
签名      = base64url(HMAC-SHA256(secret, body))
cookie 值 = `v1.${body}.${签名}`
cookie 名 = 'dsh-auth-' + base64url(SHA256(authority))
authority = 请求的 host（http 下即 `127.0.0.1:3080`）
```

```bash
node hub-rpc.mjs provider.status '{"providers":["cline"]}'
node hub-rpc.mjs model.list '{"provider":"aggregate"}'
node hub-rpc.mjs account.list '{"provider":"codearts"}'     # ⚠️ provider 必填，缺省返回空
```

---

## 八、渠道包的构建环境（Android 特有）

**原生 esbuild 在这台设备上不可用**：Android 禁止从应用数据目录执行二进制，
esbuild 的 npm 包会 spawn 原生可执行文件 → `Permission denied`。

**解法**：用 **`esbuild-wasm`**（纯 WebAssembly，不受执行权限限制），
外面套一个垫片让 `require('esbuild')` 解析到它：

```
$OFM_BUILD_DIR/node_modules/
  esbuild/            ← 垫片：转发到 esbuild-wasm，并在首次 build 前自动 initialize()
  esbuild-wasm/       ← 真实现（含 13.98 MB 的 esbuild.wasm）
  jose      → 软链到 $TREE/node_modules/jose     （构建时要内联）
  undici    → 软链到 $TREE/node_modules/undici   （构建时要内联）
```

`build-channel-pack.mjs` 把 `@deepseek-ai/*` 与 `node:*` 保持外部（宿主提供），
`jose`/`undici` 内联，产物是单文件 `pack.js`（约 3.5 MiB）——
因为 OFM 的发布清单限制 80 个文件，而渠道包源码有 197 个。

**gitee 的 HTTP 451**：`src/opencode-proxy.ts` 因文件名含 "proxy" 被 gitee 拒绝访问。
`update-channelpack.mjs` 自动从 npm 上游发布版（`dsh-codearts-auth`）的同名**编译产物**补齐。

---

## 九、历史

- **2026-10-16 上午**：Jet Hub 从 `0.2.0-rc.11` 升到 npm 最新 `1.6.261016`。
  手机上前一份 Jet Hub 曾带「在用模型胶囊」定制，按用户决定不再保留（那 19 个接线补丁
  基于 0.1.58 上下文，上游一天发 3 个版本必然漂移）。
- **2026-10-16 下午·阶段 1**：验证 WASM 构建链路 —— 用官方脚本 + 当前 `src/` 重建
  `pack.js`，与官方产物仅差 **67 字节**，且差异全在文件头部 esbuild 的运行时 helper
  （`__esm`），业务代码逐字一致。
- **2026-10-16 下午·阶段 2**：对比 vendor 与 gitee master —— OFM 的本地适配只有
  **4 个文件**（`channel-fetch.ts` / `channel-pack-rpc.ts` / `channel-pack-store.ts` /
  `opencode-proxy.ts`），其余差异是上游 10 天的演进（**新增 42 个文件**，正是聚合路由、
  provider 框架、accio/officeace 等新渠道）。
- **2026-10-16 下午·阶段 3**：确认 OFM 需要移植的适配只有 **2 处**（网络出口 outlet、
  `disableOpencode` 开关），其余（`suppressAutoSettingsPage`/`registerProviderSettings`/
  `closeAllProxyDispatchers`）上游自带。写成 `patch-channelpack-port.mjs`（7 处，幂等）。
- **2026-10-16 下午·切换**：装上新渠道包、删除补丁 A、从 profile 撤下 Jet Hub。
  隔离验证：**默认挂载**成功、17 渠道、35 账号、`disableOpencode` 经内核确认
  （`no adapter registered for provider "opencode"`）、聚合 502 个虚拟模型含默认模型。
- **遗留**：Jet Hub 的文件仍在 `profiles/phone/node_modules/dsh-providers-hub`（未加载），
  保留以便回滚；确认稳定后可删除。
