# 移植状态快照 · 手机版 vs Gitee 上游

> 建于 2026-10-11 16:30（基于当轮实测比对）。**用途**：下次想继续移植上游内容时，
> 新对话读本文件 + `PORTING-GITEE-HANDOFF.md`，即可精确判断「已移植什么 / 上游新更新了什么」。
> **更新规则**：每当 Gitee master 前进、或本仓库发生新移植，重新跑一遍第九节的比对流程，
> 更新本文件的三个表与快照时间。

---

## 0. 快速用法（下次对话怎么判断）

1. **上游有没有动**：跑 `node .scratch/port-gitee/nc/gitee-tree-now.mjs`
   （拉当前 master 全树，与 `nc/trees/gitee-tree-5a61117f.json` 基线逐 sha 比对，
   直接打印新增/修改/删除清单）。
   - 无输出差异 ⇒ 上游没动，本文件结论继续有效，收工。
   - 有差异 ⇒ 把差异文件与下面「一、已移植对照表」对号：文件不在表里 = **新素材**，按
     `PORTING-GITEE-HANDOFF.md` 第 9.1 节约定评估移植；文件在表里 = 检查该行「已移植到的
     提交/版本」之后是否又有上游改动（用 compare API 看增量 patch）。
2. **本仓库侧对齐**：跑 `node .scratch/port-gitee/nc/phone-tree.mjs` +
   `node .scratch/port-gitee/nc/effective-tree.mjs`（重建手机版有效树快照），
   再 `node .scratch/port-gitee/nc/compare-trees.mjs` —— 可复现本文件第三节的全景表。
3. 上游提交级别增量：`compare/旧sha...新sha`（Gitee API，UA `Mozilla/5.0`），脚本范例
   `nc/gitee-commits-detail.mjs`。

## 1. 基线锚点（本文件编制时刻）

| 侧 | 锚点 |
|---|---|
| Gitee master | **`1cd01ba2`（2026-10-12 02:20）—— 已全部移植**（10 提交，提交 `61213a5b`+`36048380`，CI typecheck `482 passed` / 完整构建 success，见 HANDOFF 9.20） |
| Gitee 树基线快照 | `.scratch/port-gitee/nc/trees/gitee-tree-5a61117f.json`（610 blobs，**已落后一个提交**） |
| 手机版 main | `22505b79`（9.21 构建，Release **`build-20261011-2337` / versionCode 120**）；上游 jwoo `85c62fdd`（0.1.63，**未合并**，待用户定夺） |
| 手机版有效树快照 | `nc/trees/effective-tree.json`（1282 blobs = 上游镜像 + capsule 30 覆盖 + 22 独有） |
| 设备 | `dsh.version`=115；**最新包 `build-20261011-2337`（versionCode 120，含 9.20 上游全量 + 9.21 聚合窗口机制修复）待安装验收** |

## 2. 树比对方法（为什么用「有效树」）

手机版 main 的 git 树里 vendor 是**纯上游镜像**，自有代码全在 `.github/capsule/`
（构建时 apply）。直接比 git 树会得出「全部没移植」的错误结论。
故「手机版有效树」= 镜像 blob sha + capsule `files/`+`overrides/` 本地文件内容算出的
git blob sha，覆盖/新增同名路径。比对脚本：`nc/effective-tree.mjs`。

## 3. 全景表（2026-10-11 16:30 实测）

### 3.1 Gitee src 独有文件（手机版有效树没有的）—— 5 个，全部**有意不移植**

| 文件 | 行数 | 用途 | 上游消费方 | 决议 | 理由 |
|---|---|---|---|---|---|
| `src/model-catalog.ts` | 344 | 14 家 listModels/resolveModel 共享骨架 | buddy/cline/gemini/llm/lobsterai/loomy/minimax/qoder/raccoon/trae/zcode 各适配器 | **不移植**（Phase 6） | 手机版各适配器仍是自带骨架版（如 minimax 本地 892 行 vs 上游 447 行的差值即此）；移植=接入注册表生态，回归风险高，待实机稳定 |
| `src/credential-resolver.ts` | 477 | 13 个 resolveCredential 闭包收敛为单一分派点 | index.ts | **不移植**（Phase 6） | 同上，属注册表化重构；结构性收益非功能收益 |
| `src/provider-credits.ts` | 519 | credits.balances 的 11 段 if 链 → 查表化（`createProviderCredits`） | index.ts、jet-hub-rpc.ts | **不移植**（Phase 6） | 手机版 jet-hub-rpc.ts:3170 的 credits.balances 已有共享骨架 collectCreditBalances + 10 段内联分支（含手机版自有 fetchBalanceDetailed 三态文案增强，比上游更细）；移植须先手术保留这些增强 |
| `src/provider-onboarding.ts` | 222 | onboarding status/claim 查表化（loomy/raccoon） | index.ts、jet-hub-rpc.ts | **不移植**（Phase 6） | 手机版 jet-hub-rpc.ts:2514/2641 仍是 if-else，但只有 2 家、功能完整，查表化属纯重构 |
| `src/chromium-session.ts` | 1262 | zcode captcha 的 chromium 会话重构 | zcode-captcha.ts | **不移植**（Phase 6） | 9.5 已评：手机版自有 zcode-carrier/zcode-sources 链路深耦合，风险>>收益 |

### 3.2 手机版 src 独有（Gitee 没有，**移植时绝不能丢**的自有功能）—— 8 个

`account-failover.ts` / `account-rotation.ts` / `autoclaw-api.ts` / `autoclaw.ts` /
`zcode-source-stream.ts` / `zcode-sources.ts` / `active-route.ts`（手机版自有胶囊组件）/
`context-window-learn.ts`（本仓库自研动态窗口学习器，上游没有此功能）。
另有分散在共同文件里的自有功能（sourceQuota/pendingNote、autoclaw/chatgpt 面板接线等），
清单见 HANDOFF 第三节。

### 3.3 src 共同文件差异 —— 79 个，全部定性完毕

- 31 个在 capsule override/新增里（手机版手术版 + 已移植内容），**均已移植/有意差异**
  （HANDOFF 9.17：31 个 override 全部做过基线漂移检查，差异=我方有意改动）。
- 48 个纯分叉演化（手机版镜像本身是 jwoo 适配版，与 Gitee 在共同祖先上各自演化：
  buddy-auth/gemini-*/opencode-* 等 auth/RPC 类文件），**无单侧新功能需要移植**——
  Gitee 与手机版在这些文件上是「两个下游」关系，不是超集关系。
- 上游 `04de37c1 → 5a61117f` 涉及的 7 个 src 文件全部已处理：
  `account-probe.ts`/`minimax-adapter.ts`/`minimax-messages.ts`/`openai-gateway/server.ts`
  （9.17 已移植）；`index.ts`（+44/−30 = minimax 的 probe 登记，手机版在 account-probe
  override 里已用 else-if 链实现等价语义）；`provider-runtime.ts`（纯注释改动）。

### 3.4 Gitee tests 独有（28 个）与 tests 差异（77 个）

tests 独有文件分三类：① 属上游 Phase 6 生态的（provider-registry/runtime/credential-resolver/
model-catalog/claim-runtime-parity 等 parity spec）——随对应 src 决议不移植；② 上游 helper
（jet-hub-auths/rpc-refresh/provider-sets）——服务上游测试体系；③ 手机版已用**自己的等价
spec** 覆盖的（zero-output-guard/catalog-broadcast/catalog-prewarm/backup-convert/backup-payload
在手机版胶囊里各有同名或同型 spec）。⇒ 无需单独移植。

---

## 4. 已移植功能对照表（Gitee 提交 → 手机版落点）

> 判据：Gitee master 到 `5a61117f` 为止的全部功能，在手机版是否已有。

| Gitee 内容 | Gitee 提交 | 手机版落点 | 状态 |
|---|---|---|---|
| Phase 1 基础设施 provider-registry/provider-runtime/provider-expiry | ≤04de37c1 | 胶囊 files/（#22） | ✅ 已移植 |
| Phase 2 aggregate-expiry 查表化（zcode 进临期清单） | ≤04de37c1 | override aggregate-expiry.ts（#23） | ✅ |
| Phase 3 零输出换号 zero-output-guard | ≤04de37c1 | 胶囊 files/ + auto-adapter 手术（#25） | ✅ |
| Phase 4 备份升级 merge 模式/转换/载荷裁剪 | ≤04de37c1 | override backup.ts/account-pool/jet-hub-rpc/types + client 两文件（#26/#27） | ✅ |
| Phase 5 catalog-broadcast/catalog-prewarm | ≤04de37c1 | 胶囊 files/（#28） | ✅ |
| aggregate contextWindowFor 动态窗口 | ≤04de37c1 | override aggregate-adapter.ts | ✅（并走得更远：手机版另有自研 context-window-learn 动态学习，上游没有） |
| loomy/raccoon probe 分派修复（第 5 次同型缺陷） | ≤04de37c1 | override account-probe.ts（06a301cf，#46） | ✅ |
| opencode probe 豁免修正（第 6 次同型缺陷） | ≤04de37c1 | 手机版 else-if 链形态（已核无此缺口；上游修复含在重写链里） | ✅ |
| 网关超限回 413（IKKUBJ） | `5a61117f` | override openai-gateway/server.ts（3ff2f70e，#44） | ✅ |
| minimax 请求级换号 + 冷却（IKJW32） | `8a0fd86b12` | override minimax-adapter/minimax-messages/account-probe（3affe241，#45） | ✅ |
| minimax probe 登记（index.ts +44/−30） | `5a61117f` | override account-probe.ts else-if 等价分支（#45/#46） | ✅ 语义等价，形态不同（手机版未用注册表） |
| provider-runtime 注释修正 | `5a61117f` | 胶囊 files/provider-runtime.ts | ✅ 纯注释，无行为 |

**结论：Gitee master 到 `5a61117f` 为止，无遗留未移植功能**（未移植项全部是上面 3.1
的 Phase 6 有意不移植 + 4.x 的分类决议）。
✅ **2026-10-11 19:55 更新**：Gitee master 已前进到 **`93d20230`**（auto 徽标恢复 + 8 处
缺陷修复），**已全部移植**（提交 `b7b8454d`，构建 #49 全绿，见第 5 节首行）
⇒ 本文件结论的适用终点现为 `93d20230`。

---

## 5. 未评估/待定项（下次的候选池）

| 项 | 状态 | 备注 |
|---|---|---|
| ✅ **Gitee `93d20230` auto 徽标恢复 + 8 处缺陷修复** | **已移植完成**（2026-10-11 19:55，提交 `b7b8454d`，构建 #49 全绿，Release `build-20261011-1150`） | 上游 `ba10f4f` 重写 aggregate 时附带删除了旧 `jet-hub-auto` 整套徽标支持 ⇒ 用户选中 auto 后**徽标整块消失**。移植内容：新增 `src/auto-badge.ts`（172 行纯判定模块，零 import）；`auto-adapter` +10 处（lastDispatch/lastExpiryAt/priceByModel/autoState/两个 getter/DispatchTarget.expiryAt/带图改道 viaImageFallback/零输出改道参数顺序）；`aggregate-adapter` 新增 `pickerNameOf`（倍率下界表达「最低 x…」）；`jet-hub-rpc` 加 `usage.badge` 改写块 + `ModelCatalogSource.autoState`；`types` 三要素；`index` 把 `registerAutoLlm` 上移并注册进 `modelAdapters` 表（**不加位置参数**，保住形参不变量）；客户端 `badge-model`（+autoBadgeName/expiryCountdownText/shortProviderName/unsupported provider 翻译）、`usage-badge`（auto 门控放行 + 聚合占位胶囊）、`jet-hub-styles`（占位胶囊样式）。**8 处缺陷全修**：D1 预测倒计时恒缺席（getter 活值）、带图改道倒计时张冠李戴、D2 聚合倍率与路由判据不符、D3 catch 吞 AbortError、D4 `UNUSABLE=-1` 渲染成 1970 年、D5 旧宿主裸英文、删除幽灵字段 `readError`、两处 nit。**验证**：真 tsc 与改动前逐字节一致；行为探针 59/59（反向验证旧树 4/55）；CI 登记 14 spec **482 passed / 0 failed**；回归对比 base 13 = new 13（**零回归**）。⚠️ 手机版形态适配 3 处：位置参数 registerJetHubRpc（非 Gitee 命名对象）、动态窗口兜底 1M（非上游 200K）、扇出解析 6 次（非上游 3 次）—— 均为**有意差异**，已在 spec 注明 |
| Gitee 未并回分支 `issue/IKJOF7-benefit-diagnostics`（`16e246e6`） | **未移植**，本轮已评估内容 | 1 commit：codearts benefit 去头重试**可观测性**（诊断日志 `log?` 选项注入 ctx.logger + benefitCodeOf 鸭子类型判码 + 199 行 verify spec）。纯诊断，无行为变更；上游未合并 ⇒ 等它并回 master 再随轮移植（届时改动可能变化），暂不抢先移植 |
| 上游 jwoo `85c62fdd`（0.1.63） | 待用户定夺 | 大 JSON 上传新功能 + versionCode/ASSET_VERSION 65→66 与注入步骤同域；合并走手动 dispatch sync-upstream（HANDOFF 9.17 详述） |
| Step B 已知边界 | 待用户定口径 | buddy 图片视觉 token 预算 100000 被学习器当窗口上限（HANDOFF 文首） |
| 中文超限措辞 | 等真实报文 | 2026-10-11 16:10 三轮重扫 46 会话仍 0 命中（HANDOFF 9.18） |
| Phase 6 | 默认不做 | = 上面 3.1 的五个文件 + registry 化生态，等实机稳定 |

## 6. 一句话状态（给最短对话用）

> Gitee master `93d20230` 全部功能已移植进手机版（33 个 capsule override + 10 个胶囊新文件，
> 最新构建 `build-20261011-1150` / versionCode 114）；未移植的只有 5 个 Phase 6 重构基建（有意不做）与 1 个未并回的诊断分支；
> 下次先跑 `nc/gitee-tree-now.mjs` 看上游动了没有，动了就对本文件第 4 节的表对号入座。
>
> ✅ **2026-10-11 19:55 更新**：上游 `93d20230`（auto 徽标恢复 + 8 处缺陷修复）**已移植完成**
> （提交 `b7b8454d`，构建 #49 全绿）⇒ Gitee master 至 `93d20230` 无遗留未移植功能。
> 🆕 **2026-10-11 21:00 追加（`248e8eb2` / #50 / Release `build-20261011-1257`）**：修
> 「开始对话后徽标/胶囊整块消失」——根因是目录解析 4 次显式退避（4.5s）会全部落在
> 对话开始的流式期 RPC 拥塞窗口里，badge 与 pill 都走「安静放弃」且直到重挂载不恢复；
> 改为退避用尽后**常驻低频重试（每 5s）**，成功即恢复。待用户装 115 实机验收。
> 下次开工先跑 `nc/gitee-tree-now.mjs` 看上游是否又动了。
>
> 🆕 **2026-10-12 07:20 追加（9.20，提交 `61213a5b` / Release `build-20261011-2312` / versionCode 118）**：
> Gitee master 前进到 **`1cd01ba2`**（10 提交 / 50 文件）**已一次性全部移植**——新增 12 个
> capsule 文件（`session-title.ts` + 11 个 override，含首次 override 化的 buddy/gemini）、
> 修改 17 个。**验证**：真 tsc 与改动前逐字节一致（零新增类型错误）+ 反向验证（移除
> session-title ⇒ 12 处报错）+ 行为探针 9/9 + 源码断言 42 条全中；CI typecheck
> **`Tests 482 passed (482)`**、完整构建 success。⚠️ 首轮 CI 红过 1 条，原因是**我方 spec
> 仍断言旧额度码 `'QUOTA'`**（本移植有意改为 `'QUOTA_EXCEEDED'`），已同步 spec。
> 待用户实机验收四个新行为（会话自动起标题 / codearts 解禁时间文案 / 下架模型中性提示 /
> qoder 不再 unreachable）。
>
> 🆕 **2026-10-12 08:10 追加（9.21）**：修「聚合层对外报 1M、实际候选只有 26 万 ⇒ 反复截断」。
> 五项：A 学习值可收窄声明值（与 zcode 同构）、B `finish: max-tokens` 也算证据、
> C 派发前按本轮体积跳过太窄候选、D spark-x 声明值按 Loomy 客户端口径改 262144、
> F 聚合层接线零输出改道（此前只有 auto 接了）。CI `491 passed`，Release `build-20261011-2337`（120）。
>
> 📌 **2026-10-11 21:35 定性（用户报「badge 开始对话就消失」）**：**官方设计，非缺陷**——
> DSH 前端 `dsh-client-ui-conversation` 在会话运行中（activity=true）对整个
> `standardControls` 区（含 `conversation.input.right` 槽位的用量徽标与模型选择器）
> 置 `hidden`，为运行状态条/停止按钮让位；对话结束自动恢复。
> 外挂胶囊挂 `composer.dock` 不受影响（对话中常驻）——恰好与徽标形成互补：
> **对话中看 pill（在用谁），对话后看徽标（还剩多少）**。若用户对话结束后徽标仍异常再立项。

---

## 7. 本轮比对证据链（可复现）

- `nc/gitee-tree-now.mjs`：Gitee 当前树 vs 缓存树（输出 17 个变化文件 = 04de37c1→5a61117f 的 2 提交）。
- `nc/phone-tree.mjs`：GitHub main vendor 树（1260 blobs）。
- `nc/effective-tree.mjs`：+ capsule（files+overrides 52 文件，30 覆盖 22 独有）→ 有效树 1282 blobs。
- `nc/compare-trees.mjs`：有效树 vs Gitee 树 ⇒ 79 src 差异 / 5 src 独有 / 8 手机版独有 / 77+28 tests。
- `nc/gitee-commits-detail.mjs`：`compare/04de37c1...5a61117f` = 2 commits、18 files。
- 5 个独有文件消费方扫描（raw 全 src grep import）：见 3.1 表格列「上游消费方」。
- IKJOF7 分支：`compare/master...16e246e6` = 1 commit、3 files（patch 已读）。
- 树快照存 `nc/trees/`（gitee-tree-5a61117f.json / phone-tree-main.json / effective-tree.json）。

> 🆕 **2026-10-14 16:00 追加（第九轮，提交 `7813bbbaff` + `7ae4954840`）**：
> Gitee master 前进 4 个提交（`4ec67a853b`/`e93e40213f`/`b37dbf4315`/`0dd27ca0e4`），
> **三项非 provider 专用的真实缺陷修正已全部移植**：IKLIFH（工具结果图片与提问合条
> ——修「模型看不见图却自称不支持图片」）、PR#93（minimax `tool-call-delta` 携带 name
> + 空名 tool_call 防线）、IKLI7J（`login.poll` 终态失败通道——修「登录失败只剩 5 分钟
> 静默转圈」）。**不移植**：accio/officeace 两个新 provider、依赖升级。
> **验证**：tsc 零新增；3 个 spec **119 passed / 0 failed**；反向验证 13 组全独立变红；
> CI #176 与 **#177 全绿**（Tests **747 passed**），Release `build-20261014-0716` / `-0803`。
> 随后按用户要求做**项目审查**，发现并修掉 3 处真实缺陷（详见
> [移植第九轮报告](../reports/移植第九轮-Gitee三项修正与项目审查-20261014.md)）：
> ① `combined` 判据漏 `pendingOwnParts` ⇒ **延后正文被静默丢弃**（上游同段等价同样存在）；
> ② 客户端终态失败分支 `stopPoll()` 排在 await 之后（1 秒轮询重入）；
> ③ 验证手段自身 5 处缺陷（驱动污染 / 沙箱陈旧 / 注释自匹配 / 转义丢失 / indexOf 命中注释）。

> 🆕 **2026-10-14 17:15 追加（第十轮，提交 `c56abfcdd4`）——★ 官方引擎 alpha.1 → alpha.2 升级**：
> 用户指令「上游官方引擎没有移植完毕，请继续移植」。查证结论：官方引擎**仍钉在
> `0.2.1-alpha.1`**，alpha.2（`d7432673`，10-09）**从未移植** ⇒ 这是**引擎版本升级**，
> 不是文件移植。**已完成并验收**：
> - **结构**：引擎以 npm 包装进 `runtime/`，靠 `runtime/overlays/@deepseek-ai/`（23 包 40 文件）
>   覆盖安装产物（`build-assets.py:153`）。升级必须**同时重做 overlays**。
> - **方法**：三方比对（alpha.1 官方 / 本地 overlay / alpha.2 官方）⇒
>   13 需重新套用 + 12 可沿用 + 13 未改动 + 2 本地新增。
> - **合并**：自研 Myers 三方合并器（10/10 自测）⇒ **0 冲突**，13 个文件内容更新。
> - **依赖**：`package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` 同步；
>   lock 用 APK 自带 pnpm 10.34.6 重建（298 包真实安装成功）。
> - **落地**：用户定夺走**胶囊 `overrides/runtime/`**（因 `runtime/` 与上游 jwoo 仓库
>   **逐字节一致**，1121/1121，属「永不直接改的上游内容」）；`apply.sh` 新增 6 条
>   runtime 版本自检（4 组反向验证逐组独立变红）。
> - **验证**：vendor tsc 两版错误输出**逐字节相同**（零新增类型错误，105 源文件）；
>   胶囊 27 spec **747 passed / 0 failed**（与第九轮 CI 数字一致）；
>   55 个 UI 哈希 **0 消失** + 3 槽位 + 5 语义属性同包不变。
> - **交付**：45 文件（44 新增 + 1 更新）/ 0 删除；**CI #222 全绿**；
>   Release `build-20261014-0911`（136.6 MB）；
>   **从 APK 反解 `dsh-tree.tar` 验收 9/9**（引擎=alpha.2 + Android 适配生效 + 上游新内容在场）。
> 详见 [移植第十轮报告](../reports/移植第十轮-官方引擎alpha2升级-20261014.md)。
> ⚠️ **Gitee 线**在本轮期间又前进 3 提交（`8bb1035605` IKLMIY / `46ed99d443` merge /
> `32681a8b13` IKLIFH 补修），**本轮未处理**，是下一轮的候选。

> 🆕 **2026-10-14 18:55 追加（第十轮补丁，提交 `46e2cb7f94` + `ff58bb8064`）——★ 引擎升级引发的 Jet Hub 事故**：
> **用户报障**：装本轮 APK 后**「jethub 插件不见了」**。
> **根因**（引擎源码逐行确认）：`dsh-app-boot/lib/index.js:286` 的
> `evaluatePluginCompatibility` 用 `semver.satisfies(runtime, range, {includePrerelease:true})`
> 校验插件的 `peerDependencies`；`vendor/dsh-codearts-auth/package.json` 把
> `@deepseek-ai/dsh-llm` **精确**钉在 `0.2.1-alpha.1` ⇒ 对 alpha.2 判不兼容；
> `loadProfileDirectory`（:1011）遇不兼容直接 **throw** ⇒ **整个 profile bundle 被跳过**。
> **⚠️ 本轮验证为何全绿却漏掉**：tsc/747 spec/UI 契约/apply.sh/APK 产物验收
> **全是编译期或静态证据**，而门禁**只在运行期生效**；`runtime/overlays` 改得再对，
> 也管不到另一个文件的 `peerDependencies` 字段。⇒ **「构建绿」证明不了「能跑」**。
> **修复一（用户完成，`46e2cb7f94`）**：新增 `overrides/vendor/dsh-codearts-auth/package.json`，
> peer + dev 同步 alpha.2；`apply.sh` 加 §5.95。实测 profile 声明的 6 个 bundle
> **全部放行（0 个被跳过）**。
> **修复二（本轮补做，`ff58bb8064`）**：泛化排查发现 **`dsh-channel-qq` 仍钉 alpha.1**
> （同型地雷）。经逐条核实三条门禁路径（不在 `profile.bundles` / patch 为空数组 /
> 走 phone-qq 动态 import）⇒ **潜伏地雷，非现症，未观测到 QQ 异常**。已新增同型覆盖，
> 并补两件防复发工具：`scripts/check-plugin-peers.mjs`（泛化扫描，判定权威 = 引擎自身判据，
> semver 取自仓库自带 pnpm ⇒ CI 无需 install）+ `ui-tests/plugin-peers.test.mjs`
> （判别力反证 20/0，防「静默变恒真」），接入 `apply.sh` §5.97。
> 详见 [第十轮报告 §12](../reports/移植第十轮-官方引擎alpha2升级-20261014.md)。
