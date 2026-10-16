# 第八轮 · 项目审查 · 发现并修复一个真实 BUG（2026-10-14 10:00–10:35）

> **用户指令**：「继续并审查本项目。有没有BUG。」
> **结论一句话**：全面审查了第七轮移植的四处改动 + 全部 errorDetail 分类面 +
> 下游错误码行为 + 接线静态判据，**发现一个真实移植缺口**——
> `DsmlContentExtractor`（DSML 原生模式的心脏）漏掉了上游 `dsml.ts` 的
> **三重归一**，后果是「工具参数凭空消失」级缺陷。已修复、写 spec、
> 反向验证 2 场景全红、推送（`a0cac15825`）。

---

## 0. 三十秒速览

| 审查面 | 结论 |
|---|---|
| ① detail 腿分类面（21 处调用点逐个过目） | ✅ 无漏改：分类点全部收原始 body |
| ② fixDsmlMarkers 前视 `[tcip]` + 8 出口三件套 | ✅ push/flush/兜底齐全（llm-adapter 的兜底由 extractor 承担，与上游同构） |
| ③ opencode `PERMISSION_DENIED` 下游三侧 | ✅ 宿主实测：ui-chat 不替换、dsh-llm 不重试、无误记死模型 |
| ④ loop-recovery 接线与声明合并 | ✅ spec 读源码文本判据 CI 可跑；`declare module` 与手机 dsh-llm 合并编译通过 |
| ⑤ apply.sh / 检查脚本覆盖 | ✅ UI 层与本改动无交集；vendor 接线由 spec 第 4 点锁 |
| **⑥ DSML extractor 通道** | ❌ **发现真实 BUG**（详见 §1），已修复 |

| 修复验证 | 结果 |
|---|---|
| commit | `a0cac15825`（`cfa53cca35` → `a0cac15825`，3 文件） |
| tsc | 错误数 1 = 基线，零新增 |
| 新 spec `dsml-extractor-normalize`（10 例） | 10/10 绿 |
| 反向验证①：退掉 feed 归一 | **8 红** |
| 反向验证②：退掉 isDsmlLabelPrefix | **7 红** |
| 全部 7 spec | **103 passed / 0 failed** |
| UI 层全套 | 全绿 |

---

## 1. BUG：DsmlContentExtractor 缺三重归一（移植缺口）

### 1.1 怎么发现的

审查第②项「fixDsmlMarkers 与 8 出口一致性」时，发现上游把 extractor 从
`llm-adapter.ts` 移到了共享层 `dsml.ts`，且 `feed()` 入口多了一行：

```ts
this.buffer = normalizeDsmlText(this.buffer)
```

手机版（第七轮移植后）的 `feed()` **没有这一行**——`dsmlFix.push` 只服务
text-delta 累积通道，`extractor.feed(delta.content)` 吃的是**原文**，
两条路径独立 ⇒ extractor 的 buffer 从不归一。

### 1.2 缺陷全貌（上游三次事故的实录，手机版全部复现）

| 笔误形态 | extractor 不认的后果 |
|---|---|
| `<｜DSML｜ calls>`（缺 `tool_`） | 开闭标签 `indexOf` 不认 ⇒ 永不进 in-dsml ⇒ 整段当正文 |
| `<｜DSML｜ invoke name="…">`（标签空白） | `DSML_INVOKE_OPEN_PREFIX` 的 `indexOf` 恒不命中 ⇒ `parseDsmlToolCalls` 返回**空数组**（不是 undefined）⇒ 调用方把整块当成「解析成功但无调用」⇒ **工具参数凭空消失**（用户看到「模型很快就结束了，没有原因」） |
| `<｜｜DSML｜｜tool_calls>`（双竖线） | 同样 indexOf 全不命中 ⇒ 当正文 |

上游实测受害模型：**deepseek-v4.1-flash**（三种笔误全犯）。

**为什么第七轮没带上**：第七轮的移植清单是「Gitee 增量的**非 provider 部分**」，
`dsml.ts` 本身被归为「OfficeAce 共享层、有意不引入」——但**它的
extractor 归一化部分并不是 OfficeAce 专属**，是 llm-adapter（codearts 通道）
的心脏。分类时误把整个文件归为 provider 专属了。

### 1.3 修复（自上游 dsml.ts 移植，手机版不引入共享层）

给 `llm-adapter.ts` 本地补四件：

1. **`normalizeDsmlText(text)`**：三重归一（双竖线 → 别名 `calls`→`tool_calls`
   → 标签空白），顺序有意（双竖线必须先修，否则 `<｜｜DSML｜｜ calls>` 里的
   双竖线让后续 `｜DSML｜` 定位失败）。幂等。
   在 `feed()` 的 buffer 累积**之后**调用——别名/空白形态可能被拆成多帧，
   只有 buffer 拼齐才改得动（流式增量不能用它，模式跨帧）。
2. **`normalizeDsmlLabel(tag)`**：压掉 `｜DSML｜` 与**任意标签名**之间的空白
   （`invoke`/`parameter` 同样中招——上游事故之二）。
3. **`DSML_OPEN_ALIASES`**：三个别名串进 `keepLen` 前缀集（拆帧到达时不
   提前放行）。
4. **`isDsmlLabelPrefix` + `longestOpenPrefixTail` 升级**：从「最后一个 `<`」
   起判，防「空白够多绕过固定窗口」（`｜DSML｜` 后空白 `\s*` 长度无上限，
   任何固定 `maxCheck` 都会被绕过）。
   ⚠️ 正则两侧必须是 `｜+` 而非 `｜{2,}`——上游实测回归：后者漏掉规范的
   单竖线形态（`<｜DSML｜ tool_calls>`），恰是别名最常见的一条路。

另导出 `DsmlContentExtractor`（测试需要）。

### 1.4 新 spec：`dsml-extractor-normalize.spec.ts`（10 例）

核心策略是**拆帧穷举**（别名/空白形态可能被上游切成任意片段，与既有
`dsml-marker-normalizer.spec.ts` 的二分帧穷举同型）：

| # | 用例 |
|---|---|
| ①②③ | `calls` 别名三形态（缺 tool_ / 直连 / 多空白）→ 必须解出 1 个调用 |
| ④ | `invoke`/`parameter` 带空白（内容凭空消失的根因）→ 参数不得丢 |
| ⑤⑥ | 双竖线在 extractor 通道也要修；三笔误混合形态 |
| ⑦ | 规范输入逐字节不变（幂等 + 不误伤） |
| ⑧ | 「最后一个 `<`」起判：12 个空白 + `calls>` 拆帧不提前放行 |
| ⑨ | 竖线拆帧：`<｜｜` 单独到达时扣住（不放行成正文） |
| ⑩ | 普通文本不受扣留影响（无过度缓冲） |

### 1.5 反向验证（判别力自证）

| 破坏场景 | 结果 |
|---|---|
| 退掉 `feed()` 的 `normalizeDsmlText` 一行（= 修复前的真实形态） | **8 红**（①②③④⑤⑥ + 穷举内多个切法） |
| 退掉 `isDsmlLabelPrefix` 块（保留归一） | **7 红**（含 ⑧⑨ 的 keepLen 两例） |
| 退掉别名集（保留另两件） | 10 绿 —— 如实记录：别名集单独被退时，
`isDsmlLabelPrefix` 仍能扣住跨帧半截形态、归一在拼齐后仍能改写，
故此破坏在本 spec 的用例下**不单独变红**。其保护价值在「与另两件
互补」，不是独立判据。（这不是判别力缺陷：别名集是归一改写所需的
数据，退掉它等价于归一少改一种形态——① 用例已覆盖该形态。） |

---

## 2. 其余审查面（未发现问题）

### 2.1 detail 腿的分类面（21 处调用点逐个过目）

全部 `errorDetail(` 调用点（node 扫描，不依赖 grep）：

- **展示点**（拼进 LlmError message 或用户文案）：buddy×5、cline×2、
  lobsterai×1、loomy×3、qoder×3、raccoon×2、trae×4、llm-adapter 的
  `errorDetail(body)` 展示出口——全部**合法**用展示出口。
- **分类点**：
  - `llm-adapter.httpErrorCode`：已改走 `errorDetailForClassify` ✓
  - `llm-adapter.isSseQuotaExhaustedErrorCode(errorDetailForClassify(...))` ✓
  - 共享 `openai-compat.httpErrorCode`（6 家 import）：体内**不消费**
    errorDetail，只收原始 body + `isContextOverflowBody` ✓
  - `buddy.httpErrorCode`：收原始 body（注释说明刻意）✓
  - `zcode.httpErrorCodeForZcode`：收原始 body ✓
  - `isQuotaExceededError`（qoder 定义，llm-adapter 经 dsh-llm 宿主版）：
    吃的是 `errorDetailForClassify` 的产物或 LlmError 实例 ✓

**结论：无漏改的分类点。**

### 2.2 `PERMISSION_DENIED` 下游三侧（手机版宿主实测）

| 侧 | 手机版宿主实测 | 判定 |
|---|---|---|
| ui-chat 替换文案 | `failureMessage` 只替换 `AUTH`/`QUOTA`/`ACCOUNT_*` ⇒ PERMISSION_DENIED 的 message 完整送达 | ✓ |
| 重试表 | `dsh-llm` 的 `DEFAULT_RETRYABLE_CODES = [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` ⇒ 不含它，不重试 | ✓ |
| 死模型误记 | 手机宿主**没有** dead-model-store 包（那是上游 opencode 注释里的引用）⇒ 无此风险面 | ✓ |

### 2.3 loop-recovery 接线与声明合并

- 接线判据（spec 第 4 点）是**读 index.ts 源码文本**（`toContain('installLoopResume(ctx)')`），
  CI 无宿主模块也能跑 ✓
- `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'loop-resume': … } }`
  与手机 dsh-llm 0.2.1-alpha.1 的 interface 声明**合并编译通过**
  （tsc 全量零新增错误佐证）✓
- `ctx.inject(['agents'], …)`：手机宿主有 `dsh-agent` 包；服务缺席的 profile
  里整体不生效（不永久 pending）——与上游设计一致 ✓

### 2.4 检查脚本覆盖

- 本次改动全在 vendor 源码 + 一个新 spec + rebuild-vendor.sh 名单——
  apply.sh 的 UI 自检与本改动无交集（预期内）。
- vendor 接线由 `loop-recovery.spec.ts` 的接线判据锁（CI 真跑）✓
- 新 spec 已登记 `rebuild-vendor.sh` 的显式 vitest 名单 ✓

---

## 3. 验证汇总

| 项 | 结果 |
|---|---|
| tsc（src + 9 spec 一次编译） | 错误数 **1** = 基线（qoder-wasm 既有），零新增 |
| 7 个 spec 逐个跑 | **103 passed / 0 failed**（11+14+4+10+14+39+11） |
| UI 层（锚点在线/离线、槽位清单、CSS 结构、图层、兼容下限） | 全绿 |
| 推送 | `a0cac15825`（3 文件：llm-adapter.ts + 新 spec + rebuild-vendor.sh） |
| DRY-RUN 审计 | 3 文件全部正确判为需更新 |

---

## 4. 方法论备注（本轮新踩/复核的工具坑）

1. **`edit` 工具的并发锁**：同一文件连续两次 edit 之间如果隔了 bash 写入，
   第二次会报「file changed since it was read」——需 re-read 再 edit。
   本轮踩了 3 次，均以 re-read 恢复。
2. **一次自我破坏实验翻车**：验证 keepLen 判别力时，我用字符串替换法把
   `if (lastLt !== -1)` 改成 `if (false) { const lastLt …`，破坏了花括号配平，
   编译产物语法错误。第二次改用**精确整块删除 + 未使用引用补丁**完成。
   教训：对带花括号的代码做破坏实验，替换目标必须以配平单元为界。
3. **「别名集单独退掉不变红」的判读**：第一反应以为是 spec 判别力缺陷，
   复盘后确认——别名集是 `normalizeDsmlText` 改写所需的数据，退掉它等价于
   「归一少改一种形态」，该形态本身已被 ① 用例锁住；而跨帧半截形态由
   `isDsmlLabelPrefix` 独立扣住。三件是互补关系，不是三条独立判据。

---

## 5. 本轮改动清单

| 文件 | 改动 |
|---|---|
| `llm-adapter.ts` | +`normalizeDsmlText`/`normalizeDsmlLabel`/`isDsmlLabelPrefix`/`DSML_OPEN_ALIASES`；feed() 加归一行；keepLen 加别名集；升级 longestOpenPrefixTail；导出类 |
| `tests/unit/dsml-extractor-normalize.spec.ts` | 新增（10 例，含拆帧穷举） |
| `rebuild-vendor.sh` | 名单登记新 spec |
