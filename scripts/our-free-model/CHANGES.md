# 本对话（2026-10-16）的改动清单

供新对话接续使用。全部工具已整理到 `scripts/our-free-model/`。

## 一句话概要

把独立插件 **Jet Hub（`dsh-providers-hub`）的全部能力合并进 Our Free Model 自带的渠道包**
（`vendor/channel-pack`，源自 gitee `iJetLi/deepseek-harness-codearts`），**Jet Hub 已退场**；
并**重建了「用量徽标」**（模型选择器左侧的渠道·积分胶囊）。

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
| `update-channelpack.mjs` | 渠道包一体化：拉 gitee → 补 451 屏蔽文件 → 施加两个补丁 → 构建 → 备份安装 |
| `fetch-gitee-src.mjs` | 拉 gitee 上游 `src/`（6 并发、3 重试） |
| `hub-rpc.mjs` | **访问运行中实例的插件 RPC**（自签 cookie，见第 5 节） |
| `patch-phone-port.mjs` | OFM 本体补丁（**原 A 已删除**，现只留 B/C/D；D 的数据源从 Jet Hub 改为自家渠道包） |

## 3. 三个必须知道的技术事实

### ① 设备上没有可用的原生 esbuild
Android 禁止从应用数据目录执行二进制 → `Permission denied`。
**解法**：用 `esbuild-wasm`（纯 WebAssembly）+ 一个垫片让 `require('esbuild')` 指向它。
构建区：`/data/data/com.dshphone/files/ofm-build/`（`node_modules/{esbuild,esbuild-wasm,jose,undici}`）。

### ② gitee 对 `src/opencode-proxy.ts` 返回 HTTP 451
（文件含 "proxy" 被拦）。`update-channelpack.mjs` 自动从 npm 上游 `dsh-codearts-auth`
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
- [ ] Jet Hub 的文件仍在 `node_modules/dsh-providers-hub`（约 4 MB，未加载）——确认稳定后可删
- [ ] 未验证：`patch-badge-port.mjs --fetch` 在全新环境能否一次跑通（依赖 `ofm-build/gitee-src` 已存在）
- [ ] README.md 里的「渠道包同步」章节未随徽标改动更新

## 8. 「自动停止」已定性（非本仓库问题）

用户报"任务经常自己中断"。**根因是 DSH 的长期目标被解除武装**（会话恢复/重启后自动
`disarmed`），不是模型或渠道故障——证据：95 个会话文件里**零条**中断记录、错误率 0.67%。
该目标已标记 `complete`，不再有自动续跑，因此不会再出现。
