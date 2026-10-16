# 第七轮 · Gitee 三项修正 + loop-recovery 升级移植（2026-10-14 09:00–09:55）

> **用户指令**：「根据你的建议，尽量的去移植。几个上游的更新。」
> **结论一句话**：Gitee 上游 `dab6a7ca` → `1080923d80` 的增量主体是两个新
> provider（accio / officeace，均不移植）；与之无关的**三项真实缺陷修正 + 一项
> 升级**已全部移植，13 个文件推送，tsc 零新增错误，6 个 spec **93/93 全绿**，
> UI 层 18/18 全绿。

---

## 0. 三十秒速览

| 项 | 结果 |
|---|---|
| Gitee 增量规模 | 69 个内容变更 + 45 个新增（其中 11 个 accio/officeace 源文件 + 22 个 spec） |
| **移植** | DSML 前视修正、`detailFieldText` 收敛（IKLBSH A1）、opencode `AUTH`→`PERMISSION_DENIED`、loop-recovery 升级（IKLEOW） |
| **不移植** | accio / officeace 两个新 provider；gemini/minimax 的 `tool-result` 宽松读取；`login.ts` 无痕窗口 |
| commit | `988c2ccaa5`（`9312c34daa` → `988c2ccaa5`，13 文件） |
| tsc | 错误数 **1** = 基线（qoder-wasm 既有），零新增 |
| 6 个 spec | **93 passed / 0 failed** |
| 反向验证 | 3 个场景**全部变红**（9 红 / 3 红 / 2 红）；第 4 个未检出（如实记录） |
| UI 层 | 18 个测试 + 10 个脚本全绿 |

---

## 1. 增量量化（不依赖记忆，全部实测）

Gitee master 当前 HEAD `1080923d80`（2026-10-14 11:00），上次追平点 `dab6a7ca`：

```
src/plugin-src/tests 共 614 文件
与 dab6a7ca 镜像比对：相同 500｜内容变更 69｜新增 45
```

新增文件清单（节选）：

| 类别 | 文件 |
|---|---|
| accio（9 个源文件） | `accio.ts` / `accio-adapter.ts` / `accio-auth.ts` / `accio-credits.ts` / `accio-messages.ts` / `accio-oauth.ts` / `accio-product.ts` |
| officeace（3 个） | `officeace-adapter.ts` / `officeace-auth.ts` / `officeace-product.ts` |
| 共享层 | `dsml.ts` / `loop-recovery.ts` / `canonical-models.ts` / `provider-credits.ts` |
| opencode-proxy | `opencode-proxy.ts` + 客户端 modal + 2 spec |
| spec | 22 个（accio 11 + dsml 6 + officeace 8 − 重叠） |

> ⚠️ **抓取踩坑**：Gitee 的 `raw` 端点对 4 个文件返回 **HTTP 451**（地域限制/
> 风控），换 `git/blobs` API（base64）后全部拿到。

---

## 2. 逐文件判定：哪些该移植

对 69 个变更文件逐个做「增量是否 accio/officeace 专用」的分析。方法：
LCS 求真正的新增行，再过滤含 accio/officeace 的行。

**结论：除下述四项，全部增量都是两个新 provider 专用。**

| 文件 | 上游增量 | 非 provider 部分的实质 |
|---|---|---|
| `sse.ts` | +97 | DSML 前视二次修正（§3.1） |
| `openai-compat.ts` | +267 | `detailFieldText` + `errorDetail` 双出口（§3.2） |
| `buddy/lobsterai/trae-adapter.ts` | +35/+26/+24 | `detailFieldText` 接线（§3.2） |
| `llm-adapter.ts` | +153 | `detailFieldText` + 分类出口分离（§3.2） |
| `opencode-adapter.ts` | +19 | `AUTH` → `PERMISSION_DENIED`（§3.3） |
| `loop-recovery.ts` | 旧版 351 行 | IKLEOW 三处根因修复（§3.4） |
| `index.ts` / `jet-hub-rpc.ts` / `types.ts` / `provider-registry.ts` / `aggregate-expiry.ts` / `provider-expiry.ts` / `provider-runtime.ts` / `provider-credits.ts` / `canonical-models.ts` / `login.ts` | 合计 +1000 余 | **全部** accio/officeace 专用（含注释） |

---

## 3. 四项移植明细

### 3.1 DSML 归一化的二次审计修正（`sse.ts`）

**问题**：上轮（第五轮）移植的是修正**前**的版本。上游随后补了「前视必须含
协议标签名首字母」：

> 原前视只列 `｜|\s|>|\/|$`，**漏了字母** ⇒ 实测形态
> `<｜｜DSML｜｜invoke name="…">`（右侧双竖线后紧跟 `invoke` 的 `i`）
> **一条都修不了**：第一段把 `<｜｜DSML` 修成 `<｜DSML`，第二段却因
> `DSML｜｜` 后视遇到 `i` 而跳过 ⇒ 留下 `<｜DSML｜｜invoke` 这种**半修形态**，
> 比不修更糟（看起来修过、实际仍解析不了）。

**改法**：

```ts
const AFTER = '(?=｜|\\s|>|\\/|$|[tcip])'
return text
  .replace(new RegExp(`(<\\/?)｜{2,}DSML${AFTER}`, 'g'), '$1｜DSML')
  .replace(new RegExp(`DSML｜{2,}${AFTER}`, 'g'), 'DSML｜')
```

`[tcip]` = `t`ool_calls / `c`alls / `i`nvoke / `p`arameter / `t`hought 的首字母。
刻意**不**泛化成「任意字母」——那会让 `DSMLX` 这类以 DSML 开头的普通词
重新被误伤。

上游该修正与共享层 `dsml.ts` 的 `normalizeDsmlText` 同步（两份判据同源）。
手机版**不引入** `dsml.ts`（无 OfficeAce 通道，「协议只有一份」的动机不存在），
故此处是唯一一份实现，不存在同源漂移风险 —— 已在注释中说明。

### 3.2 `detail` 腿收敛为一份实现（IKLBSH A1，6 个文件）

**问题**：上游代理的顶层 catch 会把异常包成
`{"error":"acp-proxy failure","detail":"<真实原因>"}`。只认 `error` 那条腿时，
用户看到的是没有信息量的摘要，真正的原因全在 `detail` 里。

而本仓库有多份同义的 `errorDetail`（实测 **10 个文件**含该函数，上游点名 6 家），
各写一条判据必然漂移 —— 正是本仓库首条红线「同一语义两套判据」。

**改法**（在 `openai-compat.ts` 立唯一实现）：

```ts
export function detailFieldText(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const detail = (value as Record<string, unknown>).detail
  if (typeof detail === 'string') return detail.length > 0 ? detail : undefined
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    const message = (detail as Record<string, unknown>).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return undefined
}
```

五家在**最后一条腿**引用它（`openai-compat` 自己 + buddy / lobsterai / trae /
llm-adapter）。

**⚠️ 关键设计：分类出口必须排除 detail 腿**。上游两轮审计独立确证的真实净回归：

| 报文 | 只算既有腿 | 加上 detail 腿 |
|---|---|---|
| `{"message":"bad request","detail":"insufficient quota"}` | `INVALID_REQUEST` | **`QUOTA_EXCEEDED`** |
| `{"message":"bad request","detail":"prompt is too long for this model"}` | `INVALID_REQUEST` | **`CONTEXT_WINDOW_EXCEEDED`** |

后者还会触发 DSH 的上下文溢出压缩 ⇒ 纯展示改进换来行为变更。
故 `errorDetail(body, { forClassify: true })`，llm-adapter 的两处分类点
（`httpErrorCode`、`isSseQuotaExhaustedErrorCode`）改走 `errorDetailForClassify`。

**证据强度如实标注**（与上游一致）：866 个真实会话里 `"detail"` 零命中，
该形态属「结构上必然可达、但未实测」。

### 3.3 opencode 免费通道错误码（IKLBSH）

`'AUTH'` → `'PERMISSION_DENIED'`。

**为什么是缺陷**：`AUTH` 会让 DSH 客户端**丢弃本条 message、换成固定文案
「API 密钥无效」**（`dsh-client-ui-chat/lib/client.js` 的 `failureMessage`）。
而该分支的文案恰好是**唯一**能指路的那句 —— 「根因是 session id **形状**、
换 key 或换出口都无效」。换成「API 密钥无效」后用户会去换 key / 重新登录，
全是无效动作，真实报文也一并消失。

**上游取证**：866 个会话里两条真实 `turn/end` 失败事件的 code 就是 `AUTH`
（会话 `session-d7c80d34`，2026-10-02）—— 缺陷在真实流量上发生过。

`PERMISSION_DENIED` 三侧等价或更优：① 客户端不替换它；② `dead-model-store`
的 `IGNORED_CODES` 收它（模型不会被误记成下架 30 天）；③ 不在
`DEFAULT_RETRYABLE_CODES` 里（仍是不白退避）。

### 3.4 `loop-recovery.ts` 升级（IKLEOW，351 → 581 行）

**发现过程**：手机版 `index.ts` 早已 `import { installLoopResume }` 并调用，
但 `overrides/` 下没有该文件 ⇒ 它来自 `vendor/` **上游 rc.3 镜像**（351 行旧版）。
上游 master 是 581 行，含三处根因修复。

**三处修复**：

1. **脱离事件派发栈**（根因 1）。`idle` 由 `setPhase()` **同步派发**，若在其
   监听器里同步 `followup()`，`wakeDriver()` 会立刻把相位改回 `running` 并
   **再次同步派发** `agent/status` ⇒ 一次 idle 转换产生两个方向相反的信号，
   客户端采用哪一个取决于监听器注册顺序。
   实测（上游本机 `0.2.0-rc.2`）：`plugin-first` 顺序下序列为
   `[true,true,false,false]`，且第 2 次请求开始时 `agent=running` 而
   `clientRunning=false` ⇒ Stop 按钮消失、插话被置灰且在服务端被
   `session/steer-unavailable` 拒绝。
   ⇒ 投递一律经 `queueMicrotask` 挪出当前栈，并在投递时刻**重新复核**
   `status === 'idle'` 与收件箱为空。
2. **如实署名 source**（根因 3）。`{ kind: 'loop-resume' }` 而非 `'user'`：
   后者是宿主对「直接人类输入」的**证明**，`tool-goal` 的 create/edit/pause/
   resume 都据此授权 —— 伪造成 `user` 会让自动续跑**冒用人类授权**。
3. **介入清零判据**。只有真介入（用户手打、目标驱动器、子代理收尾）才清零
   连续计数；自动注入的上下文通知（`agent-instructions` / `tool-jobs` /
   `repeat-tool-reminder`）**不**清零，否则任何每步注入通知的插件都能架空上限。

**移植方式**：整份覆盖到 `overrides/`（手机版此前未改过它，`index.ts` 的
import 与调用形态两版逐字相同，属纯上游跟随）。

---

## 4. 有意不移植的四项（留档）

| 项 | 不移植的理由 |
|---|---|
| **accio / officeace 两个新 provider** | officeace 依赖 `credential-resolver` 等 Phase 6 基建且**用户不用华为**；accio 属新增 provider，两者合计约 2000 行 + 22 个 spec |
| **gemini/minimax-messages 的 `tool-result` 宽松读取** | 上游那是为**自己的** 0.2.0 类型变化（`ContentBlockMap` 删除 `'tool-result'` ⇒ TS2367）打的补丁。手机版的 `Message` 是 `RequestMessage` 别名 + 本地 `NormalizedHarnessMessage` 宽松类型，**不存在该缺陷**（tsc 实测零错误）⇒ 照搬只会引入无谓的 `as` 断言 |
| **`login.ts` 的 `openIncognitoWindow`** | win32 专用（读注册表取默认浏览器 + `spawn`），服务 officeace 无痕登录，手机版无此场景 |
| **`RequestMessage` 类型放宽（签名 + doc）** | 手机版早已用 `RequestMessage as Message` 别名达到同样效果；上游改的是命名与注释，无行为差异 |

---

## 5. 验证

### 5.1 tsc 与 spec

| 项 | 结果 |
|---|---|
| tsc（src + 8 spec 一次编译） | 错误数 **1** = 基线（`qoder-wasm.ts:643` 既有 TS2345），**零新增** |
| `dsml-label-boundary.spec.ts`（新） | 11 passed |
| `dsml-marker-normalizer.spec.ts` | 14 passed |
| `dsml-normalizer-coverage.spec.ts` | 4 passed |
| `detail-field-text.spec.ts`（新） | 14 passed |
| `loop-recovery.spec.ts` | 39 passed |
| `loop-recovery-reentry.spec.ts` | 11 passed |
| **合计** | **93 passed / 0 failed** |

> ⚠️ `loop-recovery-reentry.spec.ts` 是**用真实 agent-loop 的组合测试**
> （观测 `reentrant` 字段：同步投递会让续跑唤醒的 `running` 派发发生在外层
> `idle` 派发尚未返回时）。它在设备上找到宿主 `node_modules` 并 **11/11 通过**，
> 这是 IKLEOW 修复正确性的机制级证据。

### 5.2 反向验证（判别力自证）

| 破坏场景 | 结果 |
|---|---|
| DSML 前视退回旧版（去掉 `[tcip]`） | `dsml-label-boundary` **9 红**（5 个标签名 + 闭标签 + 半修 + 穷举 + 流式） |
| 删掉 `errorDetail` 的 detail 腿 | `detail-field-text` **3 红**（⑦⑧⑨） |
| 分类出口也计入 detail（去掉 `forClassify` 判断） | **2 红**（⑫⑬） |
| loop-recovery 调度器退回同步执行 | ⚠️ **未检出**（见下） |

**第 4 项未检出的原因（如实记录）**：mini-vitest 运行器自身 `await` 已让微任务
自然执行，掩盖了时序差异。真实判别力在上游的 `loop-recovery-reentry.spec.ts`
（观测 `reentrant` 字段），但那个特定破坏在本运行器下抓不到。
**不影响移植正确性结论**（实现与上游 master 逐字节一致），只说明本机运行器
的判别力边界。

### 5.3 UI 层（未改动，按惯例全跑）

18 个测试 + 10 个脚本全绿：锚点门禁（离线 53/57 一致 + 在线 4073 哈希全部有效）、
CSS 结构、图层健康、兼容下限、槽位清单、遮罩接管、产物装载、模块种子等。

### 5.4 spec 名单登记

4 个新 spec 已全部加入 `rebuild-vendor.sh` 的显式 vitest 名单
（不登记 = 静默不跑，本仓库既有教训）。核对：`overrides/` 下的 spec 与名单
**完全一致**，无「声明了跑不到」也无「有文件不跑」。

---

## 6. 推送

| 项 | 值 |
|---|---|
| commit | `988c2ccaa5`（`9312c34daa` → `988c2ccaa5`，13 文件） |
| 文件 | 8 个 src + 4 个新 spec + `rebuild-vendor.sh` |
| DRY-RUN | 逐文件列「远端 sha vs 本地 sha」，13 个全部正确判为需更新 |
| 推后核对 | 抽 6 个（含 4 个新增）逐字节比对远端 blob，**6/6 一致** |

---

## 7. ⚠️ 本轮抓到的两个工具/手段缺陷（留档）

### 7.1 本机 `diff` 命令间歇性失效

实测：两个明显不同的文件（62203 B vs 80358 B，`cmp` 报 differ at char 2773），
`diff` 却输出 **0 行**。同一对文件几分钟后重跑又正常输出 476 行。

⇒ **不可依赖**。本轮所有差异统计改用 node LCS / 集合法。此前几轮若有用到
`diff` 且结果为 0 的结论，均应存疑（本轮已用 cmp 复查 13 个文件，确实都不同）。

### 7.2 `grep` 同样不稳定

`grep -n "loop-recovery" index.ts` 无输出，而 node 读同一文件能稳定找到 2 处。

⇒ 关键结论一律用 node 读文件验证，不用 grep 的「无输出」当作「不存在」。

### 7.3 顺带订正一条此前的认知

第五轮报告 §2.4 写「手机版没有 `provider-registry.ts`」——**不准确**。
该文件在 `files/vendor/dsh-codearts-auth/src/` 下（胶囊全新增路径）。
同理「手机版没有 `loop-recovery.ts`」也不准确：它在 `vendor/` **上游镜像**里
（旧版）。⇒ 判断「手机版有没有某文件」必须同时查
`overrides/` + `files/` + `vendor/` 三处。

---

## 8. 三路上游当前坐标

| 上游 | HEAD | 与本轮起点对比 |
|---|---|---|
| Gitee 多账号 | `1080923d80`（10-14 11:00） | **已追平**（本轮移植了其全部非 provider 增量） |
| 官方引擎 | `d7432673`（10-09） | 无新增（alpha.2 阶段 0 已完成，哈希判决已出） |
| APK 壳 | `48efcc3c`（10-11） | 无新增 |

---

## 9. 下一步（待定夺）

| 选项 | 说明 |
|---|---|
| **alpha.2 阶段 1 试构建** | 哈希风险已清零（第七轮之前的单包判决），剩 overrides 43 文件在新版能否编译。需半天 |
| **继续追 Gitee** | 若上游再推 accio/officeace 之外的修正，按本轮同法移植 |
| **真机验收本轮移植** | DSML 半修形态、detail 文案、opencode 错误码均需真实流量才能观察；loop-recovery 的 Stop 按钮行为需手动复现 |
