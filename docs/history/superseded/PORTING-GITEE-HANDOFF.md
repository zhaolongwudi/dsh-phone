# Gitee 原作者功能移植 · 接力文档

> 交接时间：2026-10-11 凌晨。本文档供新对话直接开工，自包含全部背景与流程。
> 目标：**开测试分支，把 Gitee 原作者（桌面版）的新功能完整移植到手机版**。

---

## ⚡ 新对话从这里读（2026-10-12 17:35 更新，30 秒版）

**状态**：Phase 1–5 已移植并**合并回 main**；**上游每日自动同步已停止**（仅手动，演练通过）；**撞上下文窗口会如实归成 `CONTEXT_WINDOW_EXCEEDED`** —— **四条通道 + 聚合兜底网已全部同源**（唯一判据 `isContextOverflowBody`）：Step A **切片一**（聚合层，见 9.11）+ **切片二**（共享协议层，见 9.12）+ **尾巴 ①**（codearts 400，见 9.15）+ **③④+兜底网**（lobsterai 流内 / zcode 400 / 聚合网，见 9.16）；**动态窗口已推广到两处真·拿不到上限的路径** —— Step B **切片一**（聚合兜底，见 9.13）+ **切片二**（zcode 目录，见 9.14）。**main 现有 typecheck 快环**（`.github/workflows/typecheck.yml`，仅手动，约 30 秒，见 9.16）。**聚合窗口机制已修 A/B/C/D/F**（学习值可收窄、截断也算证据、按体积筛候选、零输出改道，见 9.21）+ **P0/P1**（筛选索引错配、全装不下主动压缩、已学上限落盘，见 9.22）。
**🆕 2026-10-11 下午第二轮（见 9.17）**：上游 Gitee master 从 `04de37c1` 前进到 **`5a61117f`**（两个新提交，均已移植）——① 网关超限回 413 而非断连（IKKUBJ）② minimax 请求级换号 + 冷却（IKJW32）；移植过程中**连带发现并修掉手机版一个用户可见缺陷**（loomy/raccoon 探测分派缺失，上游记为「第 5 次同型缺陷」）。
**🆕 2026-10-12 第二轮（见 9.20）**：上游 `93d20230` → `1cd01ba2`（10 个提交 / 50 文件）已全部移植（session-title 接线 ×14 适配器、codearts 额度文案、abort 499 判据、qoder wasm 泄漏、图片字节上限、模型开关留痕）。
**🆕 2026-10-12 第三轮（见 9.23，最新）**：上游 `1cd01ba2` → **`d14636e6`**（**11 提交 / 25 文件**）已全部移植并**推送 + CI 全绿**——积分按需自愈续期（IKKHL5）、`fullCatalogIds` 两来源并集（IKJW33 相邻）、腾讯风控指纹补 assistant 正文 + wire 首条 system、gemini 续期补超时、image 探针外推订正。推送 commit `f2cfa6e1`（13 个 capsule 文件），build-apk **#58 全绿**、`Tests 516 passed`。
**🆕 移植状态全景（2026-10-11 16:30 起，继续移植先读它）**：[PORT-STATUS.md](PORT-STATUS.md) —— 16:30 全树比对结论：Gitee master 至 `5a61117f` 已**全部移植完**（上游 index.ts/provider-runtime 增量也已语义覆盖）；未移植的只有 5 个 Phase 6 基建（有意不做）与未并回分支 IKJOF7（已评估：codearts 诊断日志，等并回）。⚠️ **该文件停在 `5a61117f`，9.20 与 9.23 两轮之后需按 9.23 的逐提交表复核**。下次继续移植：先跑 `node .scratch/port-gitee/gitee-refs.mjs` + `gitee-commits2.mjs` 看上游动了没有（本轮就这么开场的）。
**最新可用包**：`build-20261012-0919`（versionCode **123** = 9.23 的 11 提交移植，#58 全绿，`Tests 516 passed`）。上一版 `0125`（120 = 9.21 聚合窗口修复）；再往前 `0056`（119 = 9.22 的 P0/P1）/`2337`（118 = 9.20 的 10 提交移植）/`2312`（117）/`0746`（111）/`0728`（110）/`0657`（109）/`0615`（108）/`0552`（107）/`0513`（106）/`0420`（105）/`0406`（104）/`0341`（103）/`0238`（102）/`0152`（101）/`0135`（100）/`0053`（99）可作对照。**分支**：`main` 是**主线**（改代码直接改它）；`port-gitee` 已落后于 main，仅作历史留存。
**⚠️ 设备仍装 111**（`dsh.version`=111，vendor `lib/` mtime 15:47 = build-20261011-0746）—— 2026-10-12 15:25 复核。9.20/9.21/9.22/9.23 四轮的包**都未在本机装过** ⇒ **实机验收仍待用户**（建议直接装 `build-20261012-0919`）。
**🆕 9.23 移交的两条方法教训**：① **「上游新文件 = 可整文件覆盖」只对纯镜像文件成立** —— Gitee 的网关两文件依赖更新的 dsh-llm 类型，整份覆盖会报 11 条类型错，必须「手机版镜像 + 只移植增量」；② **基线快照与远端比对必须逐字节（`Buffer.equals`）+ 重试**，本轮 raw 拉取抖动一度把一致的 `jet-hub.js` 误判成「基线≠远端」。
**工作区**：本目录（`.scratch/port-gitee/*.mjs` = 现成的部署/查询脚本；`.scratch/baseline/` = Gitee 全树与已拉文件缓存；`.scratch/round-20261012/` = 本轮的上游对照/移植产物/漂移脚本）。⚠️ **设备 `/data/data/com.dshphone/files/tmp/` 会随机清空**（9.23 连踩两次）⇒ 产物一律放工作区 `.scratch/`。

### 动手前必读四条

1. **部署无 git/gh**：走 GitHub trees API 三件套（node .mjs 脚本，照 `.scratch/port-gitee/slice*-push.mjs` 改）。token 写在脚本里（⚠️ 长期暴露，收尾后应撤销换新）。
2. **验证环（2026-10-11 起的新常态）**：**main 是主线**，push main **会自动出完整 APK + Release**（约 5–6 分钟）。
   - 只想要快反馈时，**手动 dispatch `.github/workflows/typecheck.yml`**（**约 30 秒**，只跑 vitest 胶囊 spec + tsc + esbuild，不出包/不发布/不改 README）—— 这是 9.16 新增的正式快环，已实测全绿。
   - `port-gitee` 分支已落后于 main（仅历史留存）；旧的手动 dispatch 流程只在那条分支上还有意义。
   - ⚠️ 改了 `.github/capsule/rebuild-vendor.sh` 的 vitest 名单才跑得到新 spec —— 新增胶囊 spec **必须同时登记**（否则静默不跑）。
3. 🚨 **用户报"实测无变化"时，第一步查设备是否真加载了新代码**：`files/dsh.version` 与 `tree/node_modules/dsh-providers-hub/lib/*.js` 的 mtime。装新包 vendor 不更新曾是老坑（`ASSET_VERSION` 恒 65），已修（构建时注入 versionCode+run_number），但这条排查永远优先。
4. **Gitee 动态核对**（每轮移植前）：`https://gitee.com/iJetLi/deepseek-harness-codearts.git/info/refs?service=git-upload-pack`（UA `git/2.40`，绕 API 限流，一次拿全部分支/PR refs）；raw 拉文件 UA 必须 `Mozilla/5.0`。**`refs/pull/N/MERGE` 存在 ≠ 已合并**，要以内容 sha1 比对为准。
5. **上游同步已停**：`sync-upstream.yml` 只剩 `workflow_dispatch`（可手动补同步，9.16 已演练）；恢复每日同步 = 把 `schedule` 段加回。
6. 🚨 **两条验证红线（9.17 新踩，都会把结论写反）**：
   - **本机 `patch` 命令不可靠**：多 hunk 上下文漂移时它**整份静默跳过**（`exit=1` 却**不留 `.rej`、文件一字未改**）。
     ⇒ 合并「上游新版 + 手机版手术」一律用 **node 脚本按精确锚点字符串**逐块替换/拼接，每步 `grep -c` 核对标记。
   - **影子 vitest shim 会制造假绿**：`toThrow()` 忽略 matcher ⇒ 所有 `rejects.toThrow(/…/)` 无条件通过；
     `beforeEach()` 空实现 ⇒ 有状态 spec 串状态假失败。⇒ **必须用改动前的树做反向验证**
     （判别用例在旧树失败、新树通过才算证据）。详见 9.17「本轮新踩的环境坑」。

### 三条设计约定（用户定，勿违背）

1. **冲突保留**：共同文件上手机版自有功能/更好实现一律保留（下载系统保存、触屏拖拽、autoclaw/chatgpt/zcode-sources 等）。
2. **上下文窗口不搞一刀切**：候选有声明→取最大（有"未吐内容即换候选"兜底）。**不要**用池内最大声明去猜未声明模型（用户明确否决，会让低窗口模型超限）。
   - ⚠️ **本条中「候选无声明→保守 200K」已被约定 3 取代**（现走**动态方案**）。保留原文只为记录沿革，**以约定 3 为准**。
3. **窗口来源优先级（2026-10-11 用户口径，取代此前对"二层规则"的纠结）**：**能从供应商拿到的上限一律用真值**；**只有拿不到供应商上限的模型**，才允许用动态方案（起步给大 → 撞墙报错 → 收窄 → 配合 DSH 自带压缩）。
   - ⚠️ 现行代码里有若干处「拿不到就**写死 200K**」：`zcode-upstream.ts:739`（`contextWindow ?? 200_000`）、`trae-product.ts:215-228`（十几个 `custom_*` 全写 200_000，其中 `custom_model_1M`/`custom_model_1M_text`/`custom_model_gpt-5`/`custom_model_kimi` **名字与值明显不符**）、`aggregate-adapter.ts:737,761` 与 `auto-adapter.ts:199`。这些值与供应商真值**在下游无法区分**（聚合只会"取最大"）⇒ 它们是"永远显示 200K"的根源，也是本条口径要优先处理的对象。
   - ⚠️ **DSH 硬约束**：`context` 为空时压缩链**直接抛错**（`dsh-compaction-basic/lib/index.js:939` `compaction-basic: no context capacity for <provider>/<model>`）⇒ **"不声明窗口"不是一个可选项**，必须给出一个正数——这正是各处 200K 兜底存在的理由。

### 当前待办

- [ ] 🎯 **唯一还需用户操作的事：实机验收**（⚠️ 设备仍装 **111**，最新包已是 **123**；建议装 `build-20261012-0919`）：零输出换号（Phase 3）、备份三场景（Phase 4）、临期排序含 zcode（Phase 2）、目录冷启动自愈（Phase 5）、胶囊"在用模型"显示、聚合上下文动态（GLM-5.3-Flash → ~1M）；9.17 两项：minimax 额度耗尽换号、网关超限回 413 而非断连（用 Codex 类客户端传超长历史验证）、raccoon「重测」按钮；9.21 一项：回答**不再被上游静默截断**（零输出改道 + 按体积筛候选）；9.22 两项：①杀掉 DSH 重开后，此前撞过墙的模型**不再重新撞一次**（已学上限落盘生效的直接证据）②换回宽窗口候选时上限**恢复**（不再被窄候选粘性压低）；**9.23 三项（本轮新增）**：①积分行不再报「账户信息查询失败：HTTP 401」、卡片红字自愈（睡眠/挂起恢复后**直接点刷新面板**即可，不必重启）②「关闭全部/关闭供应商」不再出现「关了一半」（关完对话框里那些模型应真的消失）③排查风控类问题后，腾讯系（buddy/workbuddy）会话**不再整轮 400/11128**（此前的形态是「换任何腾讯系模型都一样」）
- [x] **2026-10-11 下午第二轮：移植上游两个新提交**（见 9.17；#44/#45/#46）
  - [x] ① 网关超限回 413 而非断连（上游 `5a61117f`，IKKUBJ）—— 新增 override `openai-gateway/server.ts` + spec
  - [x] ② minimax 请求级换号 + 冷却（上游 `8a0fd86b12`，IKJW32）—— 新增 override `minimax-adapter.ts`/`minimax-messages.ts`/`account-probe.ts` + 两份 spec
  - [x] ③ **连带修复**：loomy / raccoon 探测分派缺失（上游「第 5 次同型缺陷」，手机版从未移植）+ 新增行为守卫 spec
- [x] **2026-10-12 第二轮：移植上游 10 个提交 `93d20230`→`1cd01ba2`**（见 9.20；#53 全绿，Release `build-20261011-2312`，versionCode 118）
- [x] **2026-10-12 第三轮：移植上游 11 个提交 `1cd01ba2`→`d14636e6`**（见 9.23；commit `f2cfa6e1`，#58 全绿，Release `build-20261012-0919`，versionCode **123**，`Tests 516 passed`）
  - [x] ① 积分按需自愈续期 + gemini 续期补超时（IKKHL5）—— `jet-hub-rpc.ts` 自愈核心块 + 两端点接线；`gemini-auth.ts` 两处 signal；`jet-hub.js` 静默补读
  - [x] ② `fullCatalogIds` 两来源并集 + `complete` 判据（IKJW33 相邻）—— 四个调用点 + `readableCatalogIds` 收敛
  - [x] ③ 腾讯风控指纹补 **assistant 正文** + **DSH 直连路径** + wire 首条 system 兜底
  - [x] ④ image 探针外推订正、buddy-growth 安全路标
  - [x] ⑤ 新增 `rpc-catalog-heal.spec.ts`（16 条行为用例）+ 登记 CI 名单 + `apply.sh` 两条接线自检
- [x] 给"窗口不足导致换候选"加显式识别 + 日志点名（2026-10-11 09:40 完成，见 9.8）
- [x] **合并回 main**（2026-10-11 09:53 完成：快进、无 README 冲突，见 9.9）+ **停止上游每日自动同步**（改为仅手动）
- [x] **Step A 切片一：撞窗口归码（聚合层 + zcode）**（2026-10-11 10:38 完成，见 9.11；#37 全绿，Release `build-20261011-0238`）
- [x] **Step A 切片二：共享协议层 + lobsterai/trae**（2026-10-11 11:45 完成，见 9.12；#38 全绿，Release `build-20261011-0341`）
- [x] **Step A 尾巴 · ① codearts `llm-adapter.ts` 的 400 判据**（2026-10-11 13:17 完成，见 9.15；#41 全绿，Release `build-20261011-0513`，versionCode **106**）
- [x] **Step A 尾巴 · ③ lobsterai 流内失败 + ④ zcode 400 判据 + ② 防分叉闸门**（2026-10-11 14:00 完成，见 9.16；#42 全绿，Release `build-20261011-0552`，versionCode **107**）
  - ③ 已做：lobsterai 流内失败改用共享 `sseFailureCode`（不再固定 `SERVER`）。
  - ④ 已做：zcode 400 改用共享 `isContextOverflowBody`（补上 Anthropic 原生措辞漏判）；其余状态码经核实**无证据、不改**。
  - ② 已做（**换了做法**）：两份常量**逐字相同**，合并需冻结 102KB 的 buddy 适配器（漂移风险 > 收益）⇒ 改为**新增 CI 闸门**断言两份必须逐字一致（分叉即红）。
  - trae 流内**有意不动**：它是 SOLO 业务码驱动（`1005`/`4008` 等），非措辞判据，无证据不改。
- [x] **Step B 切片一：动态窗口（聚合兜底）**（2026-10-11 12:06 完成，见 9.13；#39 全绿，Release `build-20261011-0406`）
- [x] **Step B 切片二：动态窗口（zcode 目录）**（2026-10-11 12:20 完成，见 9.14；#40 全绿，Release `build-20261011-0420`）
- [ ] **Step B 剩余（经核实**有意不做**，除非用户另有指示，理由见 9.14）**：
      ① `trae-product.ts` 静态表 —— **不能**改：trae 适配器注释记录「未开 Max 却声明 1M 会让
      DSH 把超长上下文直接发出去，而上游按 200K 校验后拒绝」⇒ **声明过大在 trae 是错的**；
      且 `contextWindowFor` 本就远端优先（`meta.maxContextWindow` / `meta.contextWindow`），
      静态表只在远端没给时才用。② `auto-adapter.ts` 无选型时的 200K —— auto 的失败**不经聚合层**
      （无归一化点）⇒ 学不到东西，且它平时继承目标 provider 的目录值。
      ⇒ 若将来要给 auto 做动态，须先在 auto 里**新增**失败归一化点（属新功能，另立项）。
- [x] **main 的 typecheck 快环 workflow**（2026-10-11 14:00 完成，见 9.16）：新增 `.github/workflows/typecheck.yml`（**仅 `workflow_dispatch`**，不打包 APK/不出 Release/不改 README），实测 **#1 全绿、约 30 秒**（对比完整构建 5–6 分钟）。push main 仍走完整版，两条流水线互不影响。
- [x] **sync 演练**（2026-10-11 14:00 完成，见 9.16）：手动 dispatch `sync-upstream` → **#3 全绿**，日志 `上游领先本仓库：0 个提交 / 上游无更新，本次跳过`，main 未变；另做**基线漂移检查**（21 个 vendor override 逐个与上游同路径比对，全部为「有意差异」）。
- [ ] ⚠️ **中文超限措辞待补**：宿主分类器只认英文；设备 44 个会话里**没有**真实超限报文可依据（见 9.10 / 9.15 取证结论）⇒ 等真实发生（失败原因原文会落在会话记录里，可用 `.scratch/port-gitee/session-decode.mjs` + `scan-overflow*.mjs` 取证）再按证据补，**不要猜**
  - ↳ **2026-10-11 16:10 三轮复核仍为 0**：设备升级 111 后重扫全部 46 个会话，改用「只收非转录失败帧」的判据（排除 tool/result、reasoning 等自身转录，脚本留 `tmp/scan-real-fail.mjs`）⇒ 真实失败帧 87 条（cline/opencode/buddy/workbuddy 等 TIMEOUT、QUOTA、TRANSPORT、PI_AI_ERROR），**超限措辞命中 0**（中英文均无）⇒ 结论不变，继续等真实报文。
- [ ] **实机验收**：见文首第 1 条（唯一还需用户操作的事，不再重复）。
- [ ] ⚠️ **已知边界（2026-10-11 14:05 实测确认，未修——需先定口径）**：Step B 的动态窗口学习器把报文里
      「`N tokens > M maximum`」的 **M** 当窗口上限，但 `protocol-wire.md` 记录 **buddy 的 `100000`
      其实是「单次请求图片视觉 token 预算」**（该模型声明的真实窗口是 **1,000,000**；同会话纯文本到
      345,687 仍被接受）。实测确认：该报文喂进学习器 ⇒ 记成 **100000**（不是 1M）。
      **影响有限且方向保守**：① 聚合层只在**候选全无声明**时才用动态值（`widest ?? 动态值`）——
      有一家给真值就仍用真值；② zcode 侧只在「学到的值**更小**」时才覆盖声明值 ⇒ 声明 1M 的模型会被
      压到 100K（更早压缩，**浪费上下文但不致命**）。
      ⇒ **不擅自改**：改法有多种口径（按 provider 排除？只认 `maximum context length is N` 一族？
      加「是否图片相关」判据？）需用户定夺；**暂记为已知边界**。
- [ ] Phase 6 大重构（cline/account-pool/registry 化）：默认不做，等实机稳定
- [ ] （历史背景，已并入上方 Step A/B 条目）窗口来源 + 撞墙恢复的口径见上方「设计约定 3」。

> 详细历史、全部踩坑与逐 Phase 记录见下方 9.x（重点：**9.2 环境事实**、**9.6 workflow**、**9.7 完成度总览**，以及 9.5 里 ASSET_VERSION 那两条）。

---

## 一、项目背景（30 秒版）

- **手机版仓库**：GitHub `zhaolongwudi/dsh-phone`（分支 main）。⚠️ **2026-10-11 起已停止**从上游 `jwoo1982217-eng/dsh-phone` 的每日 07:30 自动 sync（改为**仅手动** dispatch，见 9.9 / 9.16 演练）。
- **真正原作者**：Gitee `iJetLi/deepseek-harness-codearts`（**桌面版 JetHub 插件本体仓库**，结构 = 手机版 `vendor/dsh-providers-hub/` 去掉 vendor 包装：`src/` ↔ `src/`、`plugin-src/client/` ↔ 同路径）。
- **本机部署工具**：`ghp_REDACTED_revoked`（⚠️ 一直在对话中暴露，移植完成后应提醒用户撤销换新）。
- **本地工作区**：`/storage/emulated/0/Download/dsh/ai/dsh-phone-gh/`（部分 checkout：`.github/capsule/`、workflow、README 等，其余在 GitHub 上）。
- **缓存资产**（可复用）：`/storage/emulated/0/Download/dsh/ai/.scratch/baseline/` 下有 Gitee 全树 `gitee-tree.json`、已拉文件缓存 `gitee-files/`（46 个）、上游 274bf823 tarball 解压 `upstream/`。

## 二、胶囊外挂架构（移植的载体，必须理解）

上游 main 保持纯镜像；**全部自有代码住在 `.github/capsule/`**，构建时由 `apply.sh` 应用，git 历史里从未改过任何上游文件，因此 sync 永不冲突：

```
.github/capsule/
├── apply.sh              # 构建时应用脚本（有 DISABLED 一键开关）
├── rebuild-vendor.sh     # vendor 重建（tsc+vitest+esbuild；DISABLED 时跳过，用仓库预编译 lib）
├── build-apk.yml         # workflow 模板（sync 后由 sync-upstream.yml 恢复 .github/workflows/ 的本子）
├── update-readme.py      # README 下载区块（构建开始时更新链接，[skip ci] 防循环）
├── files/                # 全新增文件（胶囊组件、spec 等）
└── overrides/            # 覆盖文件（基线 = 上游某版本 + 接线），当前 6 个：
    ├── vendor/dsh-providers-hub/src/aggregate-adapter.ts   # 含已移植的 contextWindowFor
    ├── vendor/dsh-providers-hub/src/auto-adapter.ts
    ├── vendor/dsh-providers-hub/src/jet-hub-rpc.ts         # 已重定基线到 274bf823（保留上游 zcode 增强）
    ├── vendor/dsh-providers-hub/src/types.ts
    ├── vendor/dsh-providers-hub/plugin-src/client/index.js # 胶囊挂载接线
    └── vendor/dsh-providers-hub/plugin-src/client/jet-hub-styles.js
```

**基线版本**：overrides 当前对齐上游 **274bf823**（上游最新）。`aggregate-adapter.ts` 额外含移植自 Gitee 的 `contextWindowFor`（聚合上下文窗口动态化，build-20261010-1854 已发布验证）。

## 三、Gitee 与手机版的分叉现状（对比结论）

- Gitee src/ 178 文件，手机版 src/ 164 文件；191 个共同文件里 169 个有差异。
- **Gitee 大路线**：「能力注册表」重构——新增 `provider-registry.ts`(385行,零依赖)、`provider-runtime.ts`(699行) 两个基础文件 + 十几个 refactor 提交（credits/expiry/onboarding/refresh-targets 查表化）+ `zero-output-guard.ts`、`model-catalog.ts`、`catalog-broadcast.ts`、`catalog-prewarm.ts`、`chromium-session.ts`、`credential-resolver.ts`。
- **手机版自有功能**（Gitee 没有，**移植时绝不能丢**）：account-failover、account-rotation、autoclaw-api/autoclaw、zcode-source-stream/zcode-sources、client 的 account-login-window/autoclaw-login/chatgpt-plan-panel/chatgpt-plan-rpc/zcode-sources、credits.ts 的 `sourceQuota`/`pendingNote` 字段、badge-subscription 的 sourceQuota 门控。
- **已移植**：aggregate-adapter 的 `contextWindowFor`（上下文取候选集最大窗口，兜底 200_000）。
- **小差异多为注释行号清理，无独立价值**。

## 四、移植总计划（按依赖顺序的 Phase）

> 原则：**每个 Phase 一次构建验证**；测试分支上做；Gitee 版是超集时直接替换，冲突时以手机版功能为准手工合并。

### Phase 1 · 基础设施（provider-runtime/registry）
1. 新增 `src/provider-registry.ts`（385 行，零 import，直接拷）。
2. 新增 `src/provider-runtime.ts`（699 行，依赖全是手机版已有文件）。
3. `overrides/.../index.ts` 加 runtime 注册块（Gitee index.ts L2638-2700 约 60 行：`registerProviderRuntime({...})`，引用 descriptor + pool + llm ctx）。注意 overrides 的 index.ts 已含胶囊接线，**在接线之外追加，别覆盖**。

### Phase 2 · 临期折算查表化
1. 用 Gitee `src/aggregate-expiry.ts`（830 行）替换手机版（591 行）。
2. **签名已验证兼容**：`createExpiryProbe(pool, firstModelIdOf, options)` 三消费方（aggregate-adapter 的 `expiryProbe()`、auto-adapter L529、index.ts L2207 共享探针）**零改动**。
3. 收益：zcode 加入临期清单（此前被排除，上游核实后加入）、查表化防漏。
4. ⚠️ 该文件含 `runtimeOf()` 调用，依赖 Phase 1 注册块先于 expiry 使用（index.ts apply 顺序天然保证）。

### Phase 3 · 零输出换号守卫
1. 新增 `src/zero-output-guard.ts`（Gitee 新文件，未拉取，需 raw 拉）。
2. `auto-adapter.ts` 加 `replaceAfterZeroOutput`（Gitee 独有方法，符号级 diff 已确认）。
3. 价值：回答零输出时自动换号重试，而非静默失败。

### Phase 4 · 备份升级
1. Gitee `src/backup.ts`（642 行 vs 手机 232 行，新增 `mergeAccounts`、`BackupExportOptions/BackupImportOptions`）。
2. 新增 `plugin-src/client/backup-convert.js`、`backup-payload.js`。
3. ⚠️ 检查与手机版备份 RPC/设置页的兼容（jet-hub-rpc.ts 的 backup 端点）。

### Phase 5 · 杂项
- `plugin-src/client/provider-icons.js`（渠道图标，看依赖的 UI 槽位是否手机版存在）。
- `src/model-catalog.ts`、`catalog-broadcast.ts`、`catalog-prewarm.ts`（目录预热/广播，评估独立价值后决定）。
- `src/chromium-session.ts`（zcode captcha 重构，依赖 zcode 链路，谨慎）。

### Phase 6 · 大重构（默认不做，除非前 5 个 Phase 全部稳定）
- cline-adapter 重写（1587 行差）、account-pool 扩展（+328 行）、aggregate-expiry 之外的 registry 化（buddy/gemini/loomy adapter）、gemini-messages 类型改造。
- 依赖整个能力注册表生态，回归风险高。

## 五、已验证的操作流程（直接照做）

### 5.1 拉 Gitee 文件
```js
// raw 接口（API 限流时用），UA 必须 Mozilla，否则 403
const r = await fetch('https://gitee.com/iJetLi/deepseek-harness-codearts/raw/master/src/xxx.ts',
  { headers: { 'User-Agent': 'Mozilla/5.0' } });
// 树清单：https://gitee.com/api/v5/repos/iJetLi/deepseek-harness-codearts/git/trees/master?recursive=1
// 提交列表：/api/v5/repos/.../commits?per_page=20
// ⚠️ API 约 160 次请求后 403 限流 → 转 raw；.patch/.zip 归档被 anti-bot 拦截不可用
```

### 5.2 接口兼容性检查（每个文件移植前必做）
1. 导出符号对比（Gitee 必须是手机版超集，否则 adapter 消费方要适配）。
2. 消费方盘点（`grep` 该文件导出符号在手机版 src/ 的全部引用点）。
3. 手机版自有字段保护清单：`sourceQuota`、`pendingNote`、zcode-sources 相关、rotation/failover 相关——Gitee 版没有的，合并时保留手机版实现。

### 5.3 部署（trees API 三件套）
```js
// 1) tree: POST /repos/{repo}/git/trees  {base_tree: 当前tree, tree:[{path,mode:'100644',type:'blob',content 或 sha:null 删除}]}
// 2) commit: POST /repos/{repo}/git/commits {message, tree, parents:[当前head]}
// 3) push: PATCH /repos/{repo}/git/refs/heads/{branch} {sha}
```
每次只改必要文件；新文件直接 content，删除用 `sha:null`。

### 5.4 构建与验证
- push 自动触发 build-apk；缓存命中时约 5-6 分钟（NDK 跳过、gradle 缓存）。
- 步骤链：checkout → 生成 TAG+更新 README → **应用胶囊外挂（apply.sh）** → pnpm → **编译 vendor（rebuild-vendor.sh：vitest 胶囊 spec + tsc + esbuild）** → 组装 → gradle → Release → README 幂等更新。
- tsc 会真实验证移植代码的类型（上游自己从不跑 tsc，暴露的错误是移植引入的）。

### 5.5 测试分支专用注意
- 分支名建议 `port-gitee`；`workflow_dispatch` 可手动触发，push 也触发（workflow 在分支上以分支版本执行）。
- **README 更新脚本在分支构建时也会跑**（指向分支 TAG），合并回 main 时会有 README 冲突 → 建议移植期间**手动触发构建用 TAG 后缀区分**，或接受合并时手工解决（update-readme.py 会重写整块，冲突好处理）。
- Release TAG 生成规则在 workflow 步骤 3（`build-YYYYMMDD-HHMM`），分支并发构建可能与 main 撞 TAG → 可在分支的 workflow 里给 TAG 加 `-port` 后缀。

### 5.6 回滚
- 文件级：git revert 单 commit。
- 整体级：`.github/capsule/DISABLED` 空文件 = 一键纯净构建（apply.sh 与 rebuild-vendor.sh 都会跳过）——**测完移植版如果异常，用户可先回纯净版对比**。

## 六、踩坑清单（全部真实踩过，务必规避）

1. **toybox grep 转义失效**：`grep "a\|b"` 返回假 0。用 `grep -F` 固定串或 node 处理。
2. **node -e 转义地狱**：含模板字符串/反引号的代码一律写成 .mjs 脚本文件再 `node file.mjs`；`execSync` 在本机不可用（无 shell）。
3. **插入代码切断链式调用**：往 `a = b()\n  .filter(...)` 中间插行会把 `.filter` 接到上一语句——插锚点前先看完整语句结构（`contextWindowCache.clear()` 教训，#20 构建失败）。
4. **Gitee API 限流**：约 160 请求后 403，转 raw（UA: Mozilla/5.0）；`.patch`/`.zip` 归档接口有 anti-bot 拿不到。
5. **DISABLED 开关**：测试纯净版后**必须记得删**，否则后续构建全白做（#19 教训）。
6. **overrides 基线漂移**：上游改了被覆盖的文件 → 新功能被静默抹掉（#15 教训：zcode 增强丢失）。**每次 sync 后对比基线**，重定基线流程：老基线 vs overrides diff 出接线 → patch 应用到新基线（`patch` 命令可用，先 `--dry-run`）。
7. **README 页面缓存**：GitHub README 渲染有几分钟缓存，用户看到旧链接先强刷。
8. **toybox sleep 后台任务会挂起**：等待用前台 `sleep N; query`（设 timeoutMs），别挂后台 sleep 任务。
9. **patch 后必须 grep 验证实际内容**（`-F` 固定串），不能只看行数。
10. **Gitee 版的注释大量引用它自己的行号/测试名**——移植后这些注释里提到的测试文件若不存在不影响运行，但别被误导去手机版找同名测试。

## 七、验收清单（每个 Phase 完成后）

> ⚠️ **2026-10-11 14:05 现状**：下面**只有「实机人工验收」那几项还没做**（需用户装包操作）。
> 构建/CI 侧自 #36 起**每次都全绿**（#36–#42 + typecheck #1），已由 CI 自动覆盖。

- [x] 构建全绿（CI：#36–#42 全绿；typecheck 快环 #1 全绿）
- [ ] 胶囊仍显示（输入区最下方两行小字）—— **需实机**
- [ ] 聚合上下文仍动态（选 GLM-5.3-Flash → 讯飞应 ~1M 口径）—— **需实机**
- [ ] 新功能按 Phase 各自验收 —— **需实机**：
  - Phase 2：聚合候选含 zcode 账号时临期排序生效
  - Phase 3：构造零输出场景（可问一个会被安全策略拒的问题）观察是否换号
  - Phase 4：设置页导出/导入备份新格式
  - Phase 5：目录冷启动自愈
- [ ] 手机版自有功能无回归：自动换号、zcode 额度来源、签到、ChatGPT 面板、备份旧格式读取 —— **需实机**
- [x] sync 演练（2026-10-11 14:00，见 9.16）：手动跑通 sync workflow（`上游无更新，本次跳过`），
      并做基线漂移检查（21 个 override 全部为「有意差异」）。
      ⚠️ 如实说明：**只走到「无更新即跳过」这一支**，合并/冲突兜底两支需等上游有新提交才能演练。

## 八、当前最新基线（2026-10-11 14:05 复核更新）

- **main 最新 commit**：`1036bf8c`（#42 构建 `build-20261011-0552` 成功后由步骤 20 推的 README 下载链接提交）。
  本仓库已**不再跟随上游**（自动同步已停，仅手动）。
- **最新 Release**：`build-20261011-0552`（versionCode **107** = Phase 1–5 + Step A 全部 + Step B 全部 + typecheck 快环）。
  **⚠️ 用户手机尚未安装任何新包**（设备仍 `dsh.version`=99）⇒ **实机验收仍待用户**。
- 上游（jwoo1982217-eng）最新：`274bf823`，本仓库 **ahead 76 / behind 0**（完全领先）。
- Gitee 最新：`04de37c1`（2026-10-11 00:24），git 协议 info/refs 复核 master 无漂移、无 PR #87+；
  四个关键文件（index/provider-registry/provider-runtime/aggregate-expiry）raw sha1 与本地缓存完全一致 ⇒ Phase 1/2 材料仍有效。

## 九、执行轮次记录 · 2026-10-11 凌晨（本轮约定与决议）

### 9.1 用户本轮明确约定（后续轮次必须遵守）

> ⚠️ **2026-10-11 09:53 起第 1、2 条已被取代**（见 9.9）：移植已合并回 main，
> **main 现在是主线**（改代码直接改 main），`port-gitee` 仅作历史留存；
> 「每个 Phase 一次构建验证」也已改为「CI 自动验证 + 需要时用 typecheck 快环」。
> 第 3、4、5 条**仍然有效**。

1. **（已被 9.9 取代）** 开 `port-gitee` 测试分支，移植全部在分支上做，不直接动 main。
2. **（已被 9.9/9.16 取代）** Phase 1→2 先行，每个 Phase 一次构建验证；现在 push main 即自动构建，另有 typecheck 快环。
3. **对比原作者一周以内的更新提交，以及其他发起人提交的合并（PR）**：每轮移植前先核对 Gitee master/分支/PR 动态，有新内容先评估再移植。
4. **冲突保留原则（重要）**：手机版自有功能绝不能丢（清单见第三节）；**共同文件上如果"我"（手机版）有修改的、更好的功能实现，保留"我"的**——Gitee 版只在它是超集/无冲突时直接替换，冲突时以手机版实现为准手工合并。
5. 本节即"把我表达的意思写进接力文档"的落实，后续轮次在此基础上续写。

### 9.2 本轮环境事实（新发现的坑与捷径）

- **Gitee API 限流绕过**：`https://gitee.com/{owner}/{repo}.git/info/refs?service=git-upload-pack` 匿名可达（UA: git/2.40），一次拿到全部分支/PR refs，不受 API 403 影响。PR 是否已合并看有无 `refs/pull/N/MERGE`。
- **Gitee 动态（本轮快照）**：master=`04de37c1` 无新提交；工作分支 `fix/IKKHL5-credits-self-heal`、`issue/IKJOF7-benefit-diagnostics` 未并回；PR 已到 **#86**（head=`0523e74`，与 fix/IKKHL5 同 sha，**未合并**）；#81–#85 有 MERGE ref（已合并），#81 有 squash 前备份分支 `backup/pr81-before-squash-3`。PR 详情（作者/标题）因 API 限流暂缺，限流恢复后补查。
- **本机无 git/gh**，部署只能走 GitHub trees API 三件套（node .mjs 脚本）。

### 9.3 上下文窗口 200K→1M（本轮已完成的前置小任务）

- 病根：上游 `resolveModel`（GUI 显示路径）硬编码 `contextWindow: 200_000`（prepareCall 派发路径已是动态 1M）。手机仓库 overrides 已改为 `contextWindowFor` 动态版（与 Gitee 04de37c1 口径一致），**但用户未装新构建**。
- 临时措施（已执行）：直接改 App 私有目录两份 lib 产物 `files/tree/node_modules/dsh-providers-hub/lib/aggregate-adapter.js` 与 `files/dsh-home/profiles/phone/node_modules/dsh-providers-hub/lib/aggregate-adapter.js`，各替换 2 处 `contextWindow: 200_000` → `1_000_000`（node --check 语法 OK），原文件备份为同目录 `*.orig-200k`。**需重启 App 生效**（运行中进程持旧模块）。装新构建后此临时改动自然被覆盖。
- auto-adapter 的 `resolveModel` 硬编码 200_000：Gitee 04de37c1 也未改，本轮保持一致不动。

### 9.4 Phase 1 设计决议（比原计划更精确）

- 新增 3 文件（`files/` 全新增路径）：`provider-registry.ts`（385 行零 import 直拷）、`provider-runtime.ts`（699 行，全部 type import 均已验证手机版存在：credits 三类型、types 四 RPC 类型、AccountPool(class)、LlmAdapter）、`provider-expiry.ts`（106 行查表，import 全部已验证）。
- **注册块做最小域**：13 家只注册 `{descriptor, expiry}`，不注册 auth/credits/onboarding/probe 域——手机版没有 wiredRefreshTargets/account-probe/creditsTable 基础设施，这些域注册了也无消费方；Phase 5/6 需要 RPC 查表化时再补。`createProviderExpiry()` 表内容与手机版现有 7-case switch 逐项等价（buddy/workbuddy/loomy/codearts/zcode/lobsterai/trae）。
- 插入点：overrides index.ts 的 `registerJetHubRpc(...)` 调用之前；import 追加在文件头。

### 9.5 轮次进度

- [x] Phase 1 材料复核（sha1 一致）+ tsc 预检（全部依赖符号存在）
- [x] 上下文窗口临时修改（见 9.3）
- [x] port-gitee 分支创建：`604f4829` → `34d4d18c`
- [x] **Phase 1 push + 构建验证**：#22 完整构建 **success**（34d4d18c；构建期在分支上追加了 README 提交 df7facec，属正常）
- [x] **Phase 2 push + 验证**：#23 **success**（5f7fe86a，约 1 分钟；commit 链 b6487ef6=workflow 裁剪 → 5f7fe86a=Phase 2）
- [x] PR 对比结论：master `04de37c1` 已包含 #81–#86 全部合并内容（移植基线已覆盖；03:40 复核 #86 head 的 credits.ts 与 master sha1 相同。⚠️ `refs/pull/N/MERGE` 的存在**不能**确证已合并，要以内容 sha1 比对为准）。PR 标题/作者详情因 API 限流未取得（不影响移植判断）。
- [x] **Phase 3 push + 验证**：#24 失败（spec 源码锚点 `private dispatch(` 过期）→ 修 spec 锚点后 **#25 success**（f2a41199，约 1 分钟）。
  - 新增 `src/zero-output-guard.ts`（190 行零依赖：max-tokens 且零输出判据 + 目标级冷却 10 分钟）。
  - `auto-adapter.ts` 手术式移植：guard import、zeroOutputCooldowns 字段、imageTargetFor 复核、dispatch 重构为 async generator（零输出顺位改道 + withTranslatedEffort 拆分）、selectProvider 加 exclude/冷却/账号复核、ensureChoice 缓存命中前冷却复核、hasUsableAccountFor 新方法。
  - **手机版接线保留**：`activeRoutes.record(AUTO_PROVIDER, ...)` 及其 import（Gitee 无此机制）；record 移入 async generator 体内，仍先于 `ctx.llm.stream` 调用，语义保持。与 Gitee 剩余 diff 全部为注释措辞/变量名（imgModel），无行为差异。
  - 教训：胶囊 spec 有**源码文本断言**（active-route.spec.ts），改方法签名会挂测试——改签名后先 grep spec 里的锚点字符串。
- [x] **Phase 4 push + 验证**：4a **#26 success**（86e4d02d，后端全链路）→ 4b **#27 success**（80978bb5，设置页 UI）。分两步各验证一次。
  - **4a 后端**：overrides `backup.ts`（641 行：merge/replace 模式 + 身份判重 access_key_id/sub/uid/user_id 等并集 + ref 一致性第⑤层校验）；`types.ts`（+BackupImportMode/RpcBackupExportRequest/mode?/accountsSkipped）；`account-pool.ts`（+mergeAccounts：只追加 + notifyAccountAdded 收口，override 基线 = 上游 274bf823 版 + 35 行）；`jet-hub-store.ts`（+export providerOfAccountRef，同源正则与前缀表）；`jet-hub-rpc.ts`（backup.export 加 accountIds / backup.import 加 mode 白名单透传 + merge 日志）；files 新增 `backup-convert.js`（第三方账号列表→插件格式）/ `backup-payload.js`（merge 前载荷裁剪）。
  - **4b UI**：BackupPanel 手术式移植：导出账号勾选（renderAccountPicker + 单账号文件名后缀）、导入模式单选（整体还原/单独导入）+ merge 前裁剪 + 「已跳过 N 个已存在」显式告知、第三方列表自动转换并默认 merge、转换摘要展示；jet-hub-styles.js 加 accountPick/modePick 样式类。
  - **手机版自有保留**：downloadJson 系统保存（__dshPhoneJsonExport）+ 取消检测（Gitee 是纯浏览器版，未移植）；触屏拖拽排序；autoclaw/chatgpt-plan/zcode-sources 接线零触碰。
  - ⚠️ 新增 override 文件：account-pool.ts / jet-hub-store.ts / jet-hub.js（基线 = 上游 274bf823 对应版 + 手术），**每次 sync 后需按踩坑 6 对比基线漂移**。
  - Phase 4 剩余观察项：Gitee 的 `BackupImportMode` 白名单与 `trimBackupPayload` 的 disabledModels 不裁剪语义已如实移植；设置页实测待装新构建后人工验收（导出勾选/合并导入/第三方转换三场景）。
- [x] **Phase 5 push + 验证**：**#28 success**（950cd20b）。
  - **移植（2 项）**：`catalog-broadcast.ts`（66 行，广播唯一化：同 tick 合并 + microtask 防重入 + emit 后清标记防广播风暴；jet-hub-rpc 内联实现改委托，index.ts 的 OpenCode 能力回调同改）；`catalog-prewarm.ts`（184 行，冷启动链式有界预热 [0,35s,75s]，间隔>闸门30s 冷却，首拉失败自愈；index.ts registerJetHubRpc 后挂 ctx.effect）。
  - **评估后不移植（3 项，理由已核）**：`model-catalog.ts`（createModelCatalog 在 Gitee master 的 index/rpc 零消费方，疑似未完成基建）；`chromium-session.ts`（zcode-captcha 重构，手机版自有 zcode-carrier/zcode-sources 链路深耦合，风险>>收益，归 Phase 6）；`provider-icons.js`（依赖 jet-hub.js 的 provider 列表从 registry 派生，会触碰手机版自有 autoclaw 等清单，美化类低收益）。

### 9.7 Phase 完成度总览（2026-10-11 07:30）

| Phase | 状态 | 验证 |
|---|---|---|
| 1 基础设施（registry/runtime/expiry + 注册块） | ✅ | #22 完整构建 |
| 2 临期查表化（aggregate-expiry） | ✅ | #23 |
| 3 零输出换号守卫（zero-output-guard + auto） | ✅ | #25 |
| 4 备份升级（后端 + 设置页 UI） | ✅ | #26 + #27 |
| 5 目录广播 + 预热 | ✅ | #28 |
| 6 大重构（cline 重写 / account-pool 扩展 / registry 化 / gemini-messages） | ⏸ 未做 | 按原约定等前 5 Phase **实机稳定**后再议 |

- 分支链：`604f4829 → 34d4d18c(1) → df7facec → b6487ef6(ci) → 5f7fe86a(2) → 29fe7f8e(3✗) → f2a41199(3) → 86e4d02d(4a) → 80978bb5(4b) → 950cd20b(5) → acc6e6fc(ci恢复完整版)`，全部在 `port-gitee`，main 未动。
- **实机验收构建（2026-10-11 08:10 北京时间）**：#29 完整构建 success，Release **build-20261011-0010**（135MB app-debug.apk）。⚠️ Release 页 target 显示 main 是 workflow 硬编码 `--target main` 所致，产物 = port-gitee Phase 1–5 全量。⚠️ 分支 workflow 当前为**完整版**（验收期间保留；验收完成后用 capsule 的 typecheck 版内容覆盖分支 `.github/workflows/build-apk.yml` 换回）。
- **上下文窗口实测轮（2026-10-11 08:20–09:00）**：
  - 另一台设备装 0010 实测：聚合分组虚拟模型显示 200K（应为候选真实声明）。
  - 误判一次：曾按"用户拍板 1M"推兜底 1M（95d0df25/#30，**被用户否决、构建自动取消**）——用户澄清：同一虚拟模型 5 家候选的窗口声明**各不相同**，兜底一刀切（1M 或 200K）都不符合真实。
  - **真正根因（已修，f3f81ef1/#31 → Release build-20261011-0023）**：`contextWindowFor` 记忆化条件只看"无抛错"——渠道目录未就绪时 `resolveModelInfo` 成功返回但不带声明（undefined），兜底 200K 被当成"解析成功"**固化进缓存**，此后即使各家目录就绪（声明各异）也恒返回固化值。修复：缓存只存"确实解析到声明"的结果；解析不出不缓存、下次重试；兜底恢复上游原值 200_000（仅瞬时回落）。
  - **用户实测佐证机制正常**：另一台设备用聚合 auto 显示 **262K**（=256K 真实声明，非任何硬编码值）——动态取候选真实声明的路径工作正确。
  - auto-adapter 的 resolveModel 仍为上游原值 200_000（Gitee 未做动态化）；如需 auto 也动态取候选真实声明，待用户确认后另立项。
- 🚨 **重大发现：装新 APK 后 vendor 从不更新（验收循环失效的元凶，2026-10-11 09:00 定位并修复）**：
  - 机制：`NodeRunner.ensureExtracted` 仅在 `files/dsh.version != ASSET_VERSION` 时解压 assets（`dsh-tree.tar` → `files/tree/`，vendor 在其中）。ASSET_VERSION 是源码常量（上游恒 `"65"`），自动构建从不改它 ⇒ 装 0010/0023/0039 后 `tree/node_modules/dsh-providers-hub/*` 的 mtime **始终不变**，设备跑的一直是首次解压时的旧 vendor。**本设备实测一直是 2026-10-11 01:31 解压的 vendor（另叠加了 03:24 的手工临时补丁）**。
  - 上游设计：`scripts/build-assets.py` 的 `validate_asset_version` 强制断言 `versionCode == ASSET_VERSION`（防"APK 更新后保留陈旧运行时资源"），靠发布时**人为把这一对值一起 +1** 触发解压。自动构建必须自己注入。
  - 修复（`00e66530`/#34 → Release **build-20261011-0053**）：workflow 新增「注入资源版本」步骤，`VCODE = 基线 versionCode + github.run_number`（本次 65+34=99），同时 sed 进 `app/build.gradle` 的 `versionCode` 与 `NodeRunner.kt` 的 `ASSET_VERSION`（二者相等、单调递增、每包唯一）。capsule 模板已同步。
  - 中间踩坑：#33（`ca510301`）首版只改 ASSET_VERSION，被上游断言拦下 → 改为两者同步注入后 #34 全绿。
  - ⚠️ **教训（后续轮次必读）**：**任何"用户实测新构建无变化"的报告，先查 `files/dsh.version` 与 `tree/node_modules/.../lib` 的 mtime，确认设备真的加载了新代码**，再谈行为问题。
  - 副作用提醒：注入使每个新包首次启动都重解压程序树（用户数据保留）；手工改 `files/tree/` 下的文件（如临时补丁）会在下次装包时被清除。
- ✅ **2026-10-11 09:10 结案：上下文窗口问题解决，Phase 1–5 首次真正上线**。
  - 用户装 **build-20261011-0053** 后实测：聚合分组下用三个不同模型开三个新对话，**全部显示 1M**（此前恒 200K）。
  - 本设备远程验证全绿：`files/dsh.version` = **99**；`tree/node_modules/dsh-providers-hub/lib/aggregate-adapter.js` mtime 刷新为 08:53（profile 侧 09:03）；Phase 1–5 新文件 `provider-registry.js` / `zero-output-guard.js` / `catalog-prewarm.js` 全部就位；固化修复标记 `widest !== undefined` 存在。
  - **结论**：1M 只可能来自动态路径**解析到的真实声明**（兜底恒 200K，不可能是 1M）⇒ 渠道声明链本来就是通的（codearts `CONTEXT_WINDOWS` 的 `glm-5.3-flash=1M`/`deepseek-v4.1-flash=1M`、buddy 产品表 1M）。历史现象是双重 bug 叠加的假象：①固化 bug；②vendor 从不更新使①的修复到不了设备。两者在 0053 首次同时生效。
  - 注：`[jet-hub] 窗口解析` 诊断日志未落 `files/dsh-console.log`（该文件只含 dsh web 启动行），logger 走 App 的 Logcat；本次已无需日志（行为已自证）。日志代码保留在 `aggregate-adapter.ts` 供将来排查。
  - **遗留待用户定夺**：海量单渠道第三方模型（doubao/qwen/gpt-5/6 等，zcode/autoclaw 渠道，目录无窗口数据）仍走兜底 200K。已提议「二层规则」——候选全部无声明时用**聚合池内已知最大声明**做动态兜底（全池统一、随目录演进、不写死值），等用户确认后实施。
    - ⇒ ⚠️ **该提议已被取代**：用户 2026-10-11 定下「**起步给大 → 撞墙收窄**」的动态方案（见「设计约定 3」与 9.13/9.14），**不再**用池内最大声明去猜未声明模型。本节仅作历史留存。
- **下一步**：见文首「⚡ 新对话从这里读」的待办清单（本节为历史记录，最新待办以文首为准）。

### 9.6 测试分支 workflow 现状（2026-10-11 14:05 更新 —— ⚠️ 本节前半已被 9.9/9.16 取代）

> ⚠️ **现状请看这里**（下面的 09:20 原文仅作历史留存）：
> - **main 是主线**：`build-apk.yml` 保持**完整版**（push main 即出 APK + Release，5–6 分钟），
>   capsule 模板 `.github/capsule/build-apk.yml` 已同步；「注入资源版本」步骤两侧都在。
> - **快环已在 main 落地**（9.16）：`.github/workflows/typecheck.yml`，**仅手动**、**约 30 秒**、
>   只跑 `rebuild-vendor.sh`（vitest 胶囊 spec + tsc + esbuild），**不出包/不发布/不改 README**。
>   ⇒ **不再需要**「把分支 workflow 换成 typecheck 版」那套操作（`workflow-port-gitee.yml` 已成历史）。
> - `port-gitee` 分支已落后于 main，仅作历史留存。

- **（历史，09:20）当前**：port-gitee 分支的 `.github/workflows/build-apk.yml` 是**完整版** + 新增「注入资源版本」步骤（`versionCode = 基线+run_number` 且与 `ASSET_VERSION` 同步——修「装新包 vendor 不更新」）。capsule 模板 `.github/capsule/build-apk.yml` 已同步（main 侧长期生效）。
- **（历史，09:20）快速验证环**：如需只跑类型检查（约 1 分钟，跳过 APK/Release/README），把本地 `dsh-phone-gh/workflow-port-gitee.yml` 的内容推到分支 `.github/workflows/build-apk.yml` 再 dispatch；需要出实测包时换回完整版（本地 `dsh-phone-gh/build-apk.yml`）。
- **（历史）**触发方式：push 到 port-gitee **不自动构建**（`on.push.branches: [main]`），必须手动 `workflow_dispatch {ref:"port-gitee"}`。
- **（历史）合并回 main 时**：main 的 workflow 本就是完整版（capsule 模板恢复），无需从分支带 workflow 改动；README 块冲突手工解。
  ⇒ ⚠️ 9.9 已证实该合并是**纯快进**，README 冲突根本不会发生（该预案作废）。

### 9.8 轮次记录 · 2026-10-11 09:15–09:45（新对话第一轮）

**开工前动态复核（两个都查了，结论：无新素材）**

- Gitee `info/refs`（UA `git/2.40`）快照与上轮**逐字节一致**：master=`04de37c1`；
  #86 head=`0523e74` 且其内容已含于 master；`fix/IKKHL5-credits-self-heal`=`0523e74`；
  `issue/IKJOF7-benefit-diagnostics`=`16e246e6`（**未并回**）。⇒ 四个关键文件 sha1 结论继续有效。
- 本机设备复核（`/data/data/com.dshphone/files`）：`dsh.version`=**99**、vendor `lib/` mtime=**08:53**、
  `provider-registry.js` / `zero-output-guard.js` / `catalog-prewarm.js` 就位 ⇒ 与 09:10 结案一致。
- （本机 toybox `curl` 已损坏：`CANNOT LINK EXECUTABLE "curl" ... EVP_MD_CTX_create`；
  相关查询一律走 `node --input-type=module` + fetch，与既有 .mjs 脚本一致。另 `toybox ls` 不支持
  `--time-style`；`/tmp` 不可写，临时文件放 `/data/data/com.dshphone/files/tmp/`。）

**本轮完成**：待办·可选「窗口不足导致换候选」的显式识别 + 日志点名（**纯日志，不改行为**）。

- **落点唯一**：全仓 `grep -F '切换下一个候选'` 只命中 `aggregate-adapter.ts` 的 dispatch
  （`auto-adapter.ts` 无对应日志；窗口逻辑也只在 `contextWindowFor`）。
- **判据全部取自宿主**（红线：同一语义不得两套判据，无本地措辞重实现）：
  ① `code === CONTEXT_WINDOW_EXCEEDED_CODE`（`@deepseek-ai/dsh-llm` 规范码，已核实
  `dsh-llm-pi-ai`（含 usage 超已解析容量这条用量侧判据）与 `dsh-llm-deepseek` **真会下发**）；
  ② 否则退回同一模块的共享判定器 `isContextWindowExceededError(code + message)`
  —— 有些渠道仍沿用通用码、只把原因写在文案里。
- ⚠️ **不把失败改归成** `CONTEXT_WINDOW_EXCEEDED`：那会触发 DSH 的
  `agent/request-error → 压缩重试`链（理由全文在 `zero-output-guard.ts` 模块头），
  也会改变重试语义。本改动只动那一行 warn 文案。
- 代码 `aab54ab2`（+46/−2、3 个差异块；与分支版 diff 逐块核对 ⇒ **无基线漂移**）→
  **#35 全绿** → Release **build-20261011-0135**。构建期 README 提交把 head 推到 `29449c03`。
- **#35 关键证据（取自 job 日志）**：vitest `Test Files 2 passed (2)`（两个胶囊 spec）；
  `pnpm run build:all`（tsc + esbuild）完成；`versionCode 100` 与 `ASSET_VERSION = "100"`
  同步注入（基线 65 + run 35）⇒ 装 0135 会**强制重新解压 vendor**。
- 本地实证（本机无 pnpm/vitest，改用设备树自带 `typescript/bin/tsc`）：
  `--strict` 探针（逐字复用新 import 与 helper 用法）**exit 0**；运行时探针 7 例全符合设计
  （规范码→true；`code:'SERVER'`+`context_length_exceeded`→true；限流文案→false；
  `RATE_LIMIT`→false；`null`/裸字符串/无码错误→false）。
- 反向检查：`active-route.spec.ts` / `active-model-pill.spec.ts` 确实读
  `src/aggregate-adapter.ts` 的**源码文本**，但断言对象是 `activeRoutes.record(...)` 与
  `AGGREGATE_PROVIDER` 常量 ⇒ 本次改动不触及（#24 那类锚点过期风险已排除）。
- **未加单测（有意，待定）**：`rebuild-vendor.sh` 只跑 `active-route` / `active-model-pill`
  两个胶囊 spec，新 spec 必须**同时改该脚本的 vitest 名单**才会运行；纯日志文案改动暂与
  `[jet-hub] 窗口解析` 诊断日志同例（后者亦无单测）。要补可另开。
- **本机取不到 App 日志**：`phone_control_status` 显示 Shizuku 日志后端 `available:false`
  （未启动/未授权）、Termux 未安装 ⇒ 验收阶段的 `[jet-hub]` 行为只能由用户实机观察。

**⚠️ 本轮新踩坑：trees API 多提交拼装时 `base_tree` 必须取「上一个提交」的 tree**

本轮先建 ci 提交 `a15f7901`（本意把分支 workflow 换回 typecheck 快环，建树用 head tree = 正确），
但紧随其后的代码提交**仍传了原始 head tree** ⇒ 代码提交的树**不含** ci 改动，
`a15f7901` 在分支上变成 **no-op**（其改动被下一个提交的树覆盖），分支 workflow **仍是完整版**。
后果无害（分支状态与本轮开工前一致），但**别在历史里把它当作「已换回 typecheck」** ——
以后判定一律以 `.github/workflows/build-apk.yml` 的**实际内容**为准。若确需换回：
以代码提交的 tree 为 `base_tree` 重新提交一次。

**下一步**：见文首待办（该批待办已在 9.9 里更新）。

---

### 9.9 轮次记录 · 2026-10-11 09:50–10:00（合并回 main + 停止自动同步）

**用户指令**：「现在把仓库的分支和 main 合并吧，然后（阻）止不要自动拉取上游了」。

**① 合并（快进，零冲突）** —— 关键事实：`GET /compare/main...port-gitee` 返回
`status=ahead`、`behind_by=0` ⇒ **main 是 port-gitee 的直接祖先**，合并 = **纯快进**，
**README 块冲突根本不会发生**（9.6 里"合并时 README 手工解"的预案作废）。main 无分支保护
（`/branches/main/protection` = 404），故 `PATCH /git/refs/heads/main {sha, force:false}`
即可（`force:false` ⇒ 只允许快进，防误覆盖）。

**② 停自动同步** —— 唯一会拉上游的通道就是 `.github/workflows/sync-upstream.yml`
（`build-apk.yml` 里已确认**没有**任何 upstream/jwoo 拉取）。改动：**删掉 `schedule` 触发器**
（原 `cron: '30 23 * * *'` = 北京时间每天 07:30），**保留 `workflow_dispatch` 与全部合并逻辑**
（需要时可手动补一次），并加了「2026-10-11 起停止每日自动同步」的显式注释。
选择「改触发器」而非「删文件」：**可逆、不丢逻辑、意图同样达成**。

**③ 刻意采用的顺序（避免竞态、且保住快进）**：先把②的 workflow 改动**提交到 port-gitee**，
再把 main **快进**到新的 port-gitee head —— 若先改 main，main 就不再是 port-gitee 的祖先，
快进不成立（会被迫做 merge commit）。最终：`port-gitee 29449c03 → 3c6fb09c`，
`main 604f4829 → 3c6fb09c`（**合并瞬间两分支同一提交**；随后 #36 构建的 README 提交把 main
推进到 `949c64d9`，故此刻 main 领先 port-gitee 1 个提交 —— `compare main...port-gitee`
= `behind 1 / ahead 0`，即 port-gitee 已全部含于 main）。

**④ 合并触发的 main 构建（自动）**：`push: branches:[main]` ⇒ **#36** 自动跑，**全绿**，
Release **build-20261011-0152**；`versionCode 101` 与 `ASSET_VERSION="101"` 同步注入
（基线 65 + run 36）；vitest `Test Files 2 passed (2)`（步骤 16 = vitest+tsc+esbuild）。
构建的步骤 20 又往 main 推了 `949c64d9 docs: APK 下载链接更新为 build-20261011-0152 [skip ci]`
（正常，是该 workflow 的既有行为）。

**⑤ 核验（全部实测）**：main 的 `sync-upstream.yml` **已无 `schedule:`、无 `cron`**、
仍有 `workflow_dispatch`；`provider-registry.ts` / `zero-output-guard.ts` / `catalog-prewarm.ts` /
`backup-convert.js` / `backup-payload.js` / `aggregate-adapter.ts` / `backup.ts` /
`.github/workflows/build-apk.yml` / `.github/capsule/build-apk.yml` 的 blob sha
**main 与 port-gitee 逐一致**；main 的 `aggregate-adapter.ts` 含标记
「上下文超限：请求超出该候选窗口」。

**回滚方式（万一要退）**
- 退自动同步：把 `schedule: [{cron: '30 23 * * *'}]` 加回 `sync-upstream.yml` 的 `on:` 即可。
- 退合并：`PATCH /git/refs/heads/main {sha: 604f4829, force: true}`（**会丢掉 Phase 1–5 与本轮全部移植**，
  慎用；port-gitee 仍在，可再快进回来）。

**⚠️ 合并后的新常态（后续轮次必读）**
1. **main 现在是主线**：胶囊（`.github/capsule/`）的改动**直接提交到 main** 即可，
   不必再走 port-gitee（分支已与 main 同源，可留作备份或删除）。
2. **push 到 main 会自动出完整 APK + Release**（`on.push.branches:[main]`）——
   移植期那种「1 分钟 typecheck 快环」在 main 上**不存在**。若要快环，需要**新增**一条
   只做 `bash .github/capsule/rebuild-vendor.sh` 的 workflow（仅 `workflow_dispatch`），
   而不是改 `build-apk.yml`（它在主线上必须保持完整版）。这一步**待用户定夺**。
   ⇒ ✅ **已于 2026-10-11 14:00 落地**（用户授权后）：`.github/workflows/typecheck.yml`，
   实测 **#1 全绿、约 30 秒**，详见 9.16。
3. **上游不再自动进来**：上游若修了 bug 不会自动到货；要拿就手动 dispatch
   `sync-upstream.yml`（它仍会 merge upstream/main，并保留 README 冲突兜底逻辑）。
   ⚠️ 手动同步前注意：本仓库现在**领先上游一大截**（Phase 1–5 + 胶囊），冲突面比以往大。
4. 主线的 README 下载链接由构建自动改写（`[skip ci]`），**不要手工去改那一块**。

---

### 9.10 开工前准备：撞墙恢复（Step A）改动清单（2026-10-11 10:30，**未实施，等用户批准**）

**三家现成模板（都写了「归错码代价不对称」的理由，直接照抄口径）**
- `buddy-adapter.ts:677-690`：`httpErrorCode(status, body)` —— 401/403→`AUTH`、429→`RATE_LIMIT`、
  **400 先判超限再退 `INVALID_REQUEST`**、≥500→`SERVER`；超限判据 = 宿主
  `isContextWindowExceededError(body)` **或**本仓库补的 `GATEWAY_PROMPT_TOO_LONG`（`:663`，
  要求「prompt is too long」与「N tokens >」**同时**出现，防把内容类 400 误判成溢出）。
- `llm-adapter.ts:582-593`（codearts）：同类实现 —— 先 `errorDetail(body)`，quota 优先，400 再判超限。
- `gemini-adapter.ts:175-181`：同款理由注释（`INVALID_REQUEST` 连一次压缩机会都没有）。

**落点清单（按覆盖范围排序）**
1. 共享 `openai-compat.ts` 的 `httpErrorCode(status)` → 加 body 参数并按上面 400 分支改造；
   调用点 7 家（cline / loomy / minimax / opencode / qoder / raccoon / gemini），
   多数调用处**手上已有** `errorDetail(errorText)`（loomy:737,748 / qoder:831,842 / raccoon:676,687 等）。
2. 共享 `consumeOpenAiSse` 的错误帧分支：`:505`（`data.error`→`SERVER`）、`:550`（顶层 code/message→`SERVER`）
   也应先用同一分类器判一次 —— 一处改动覆盖 8 家的**流内错误帧**通道（含 zcode / autoclaw）。
3. 3 家私藏且未归类：`lobsterai-adapter.ts`（自带 `httpErrorCode`，`:506`）、`trae-adapter.ts`、`zcode-adapter.ts`
   （0 处共享调用，走 `describeUpstreamError` + 自有映射，`zcode-adapter.ts:1120` 一带）。
4. 最低成本覆盖聚合场景：`aggregate-adapter.ts` 的失败归一化处（`upstreamCode` 附近 ~L1294-1323）
   把带超限特征的失败重归为 `CONTEXT_WINDOW_EXCEEDED` —— 一处覆盖所有走 aggregate / auto 的模型。

**⚠️ 两个必须先解决的坑**
- 分类器**只认英文**（`@deepseek-ai/dsh-llm/lib/types/error.js:63`：`context length/window`、
  `maximum context length`、`too large for context`…，**无中文关键词**）⇒ **中文上游报错不会被识别**。
  zcode 是中文产品，很可能中文报错 ⇒ 要么先抓真实报文再加判据（但会碰「同一语义不得两套判据」红线），
  要么只认结构化字段（`code` / `type`）不认中文文案。
- 现有用例 `aggregate-adapter.spec.ts` 的 C1 两条（`:775` QUOTA_EXCEEDED、`:803` 无 code 退 SERVER）
  喂的都是**非超限文案** ⇒ 按本方案不会改判、不会假失败。但 ⚠️ **那两个 spec 不在 CI 门内**
  （`rebuild-vendor.sh` 只跑 `active-route` / `active-model-pill`），要自己跑全量才能验证。

**Step B（动态窗口）依赖 Step A 先落地**：没有 A，「默认给大窗口」= 让用户在那些渠道**直接吃报错**。

**⚠️ 新环境事实：设备会话记录是「多帧 zstd」**
- `dsh-home/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd` 每个文件是**上百个追加的 zstd 帧**
  （实测某会话 161 帧）。`zlib.zstdDecompressSync` 与 `createZstdDecompress` **都只解出第一帧**
  （288KB 的文件只得到 290 字节的会话头）⇒ 必须**逐帧解压再拼接**。
- 解码器已留在 `.scratch/port-gitee/session-decode.mjs`（含伪魔数吸收：解不开就并入下一帧）。
- 用途：以后排查「某渠道报错」可直接在设备上取证，不必依赖 Shizuku 日志（本机 Shizuku 日志后端未启用）。

**⚠️ 取证结论（2026-10-11 10:45）：现有会话里没有真实超限错误帧**
- 扫了 42 个会话（已排除本对话自身）、解压后约 150MB，按「错误帧（`failure` / `失败原因` / `code:…`）
  **+** 超限措辞」双条件匹配 ⇒ **命中 0**。
- ⇒ **zcode 等渠道的中文超限措辞无法从证据判定**，不能凭猜写判据。
- ⇒ 推荐做法：Step A 先只认**结构化字段**（`code` / `type`）+ 宿主英文分类器，并**加一条探针日志**
  把 400 的原始 body 记下来；等真实发生一次再补判据（避免又造一套猜出来的措辞匹配）。

---

### 9.11 轮次记录 · 2026-10-11 10:30–10:45（Step A 切片一：撞窗口归码）

**用户选定切片**：聚合层一处 + zcode 适配器。**代码 `2043e7d2` → #37 全绿 → Release `build-20261011-0238`**（versionCode/ASSET_VERSION=**102**）。

**问题（本轮定量确认）**：DSH 的「撞窗口 → 剪工具结果 + 压缩 → 重试」链在
`dsh-compaction-basic/lib/index.js:862` **只认** `CONTEXT_WINDOW_EXCEEDED`；而聚合候选里
多数适配器把「输入超限」按**通用码**抛出（HTTP 400 被 `openai-compat.ts` 的
`httpErrorCode` 一律映射成 `INVALID_REQUEST`）⇒ 用户看到裸错误、且**长会话越过窗口后每轮报废**。

**改动（2 个文件、仅 +38/−4 行级）**
1. `aggregate-adapter.ts`（已有 override）：新增 `resolveUpstreamCode(upstreamCode, message)`
   —— 只对**泛化码**（`SERVER` / `INVALID_REQUEST` / 缺码）再判一次，**不覆盖** `AUTH` /
   `QUOTA_EXCEEDED` / `RATE_LIMIT` 等已归好的语义；判据复用本轮新增的
   `isContextOverflowFailure`（宿主规范码 + 宿主措辞分类器）。⇒ **一处覆盖所有走 aggregate / auto 的模型**。
2. `zcode-adapter.ts`（**新增 override，基线 = main 当前版 `aa7252d1`**）：`httpErrorCodeForZcode`
   的 `status === 400` 分支先判超限、再退回 `INVALID_REQUEST`；其余分支（3007 / 1005 / 1002 /
   余额不足 / 5xx…）**一律未动**。

**验证（都在本机真跑过）**
- **真 tsc**：在设备临时目录搭「应用后的 vendor 树」（克隆 src + 覆盖两个改动文件 + 补胶囊新增文件
  + `node_modules` 软链到设备树），用**设备树自带 typescript** 跑 `tsc --noEmit`；
  再搭一份**未打补丁的基线树**跑同一命令 ⇒ 两次 `src/` 错误集合**完全一致**（唯一那条
  `qoder-wasm.ts` 是设备 TS 版本差异造成的既有报错）⇒ **未引入任何新类型错误**。
- **行为探针 12/12 通过**（把应用后的树 `tsc --outDir lib` 编译成 JS 后直接驱动）：
  - 聚合：`maximum context length` + `SERVER` → **CONTEXT_WINDOW_EXCEEDED**；`context_length_exceeded`
    + `INVALID_REQUEST` → 同上；`prompt is too long for this model` + `SERVER` → 同上；
    **反向**：`上游挂了`+`SERVER` → 仍 `SERVER`；`额度用尽`+`QUOTA_EXCEEDED` → 仍 QUOTA；
    `AUTH` + 超限文案 → **仍 AUTH**（不覆盖具体码）；空失败 → `SERVER`。
  - zcode：英文超限体 + 400 → **CONTEXT_WINDOW_EXCEEDED**；普通 400 → 仍 `INVALID_REQUEST`；
    `{"code":1005}` → 仍 `QUOTA_EXCEEDED`；500 + 超限文案 → 仍 `SERVER`（本补丁只管 400）。
- **CI**：#37 全绿 —— vitest `Test Files 2 passed (2)` / `Tests 46 passed (46)`、步骤 16（tsc+esbuild）、
  18（APK）、19（Release）全 success。

**⚠️ 已知边界（未做，勿误认为已覆盖）**
- **流内（SSE）错误帧**这条通道没动：`openai-compat.consumeOpenAiSse` 的 `:505`（`data.error`→`SERVER`）
  与 `:550`（顶层 code/message→`SERVER`）。聚合层那一处能兜住**所有走聚合**的模型（无论错误来自
  HTTP 还是流内），但**直连 zcode** 的流内超限仍未归类。
- 其余 9 家适配器（cline/lobsterai/loomy/minimax/opencode/qoder/raccoon/trae 等）未动。
- **中文措辞未判**（见 9.10）：宿主分类器只认英文，且本机无真实报文可依据。

**⚠️ 新增 override 基线（后续 sync 前必看）**：`overrides/.../zcode-adapter.ts`
（基线 = main 的 `aa7252d1`）。与既有 6+ 个 override 一样，**手工同步上游/上游改动该文件时要重定基线**
（流程见踩坑 6）。

---

### 9.12 轮次记录 · 2026-10-11 11:15–11:50（Step A 切片二：共享协议层 + lobsterai/trae）

**开工前复核（两项都查了）**
- Gitee `info/refs`（UA `git/2.40`）：master 仍 `04de37c1`；分支仍 `fix/IKKHL5-credits-self-heal`=`0523e74`、`issue/IKJOF7-benefit-diagnostics`=`16e246e6`；PR 到 **#86**（head=`0523e74`，已含于 master），**无 #87+** ⇒ 无新素材。
- GitHub：main `fb5aa221`，#37 全绿，Release `build-20261011-0238`（102）。**本机设备仍是 `dsh.version`=99**（vendor `lib/` mtime 08:53）⇒ 文首第一条待办（Phase 1–5 实机验收）**尚未在本机发生**。
- 用户本轮选定：**Step A 切片二** + **改完直接 push main**（会自动出完整 APK + Release）。

**改动（9 个文件；全部是 capsule override，main 的上游文件一行未动）**
1. `openai-compat.ts`（**新增 override**）：
   - `httpErrorCode(status, body = '')` —— **400 分支**先判上下文超限，再退回 `INVALID_REQUEST`；401/403→`AUTH`、429→`RATE_LIMIT`、≥500→`SERVER`、其余 `HTTP_n` **顺序与语义一律未动**。
   - 判据 = 宿主 `isContextWindowExceededError(body)` **或**本仓库既有的网关措辞 `PROMPT_TOO_LONG_BODY`（`prompt is too long: N tokens > M`，要求两个特征共现；**与 buddy-adapter.ts 那份逐字相同，本次刻意不合并**——那属于与任务无关的重构）。
   - 判定喂**完整报文**、展示仍用 `errorDetail()`（buddy 注释已记录：只喂 detail 会丢掉 `extError.code` 而漏判）。
   - `consumeOpenAiSse` **三处流内错误帧**（`data.error` / 顶层 `code,message` / 网关形态 `statusCodeValue|stackTrace|type`）改用**同一判据**（`sseFailureCode`）⇒ HTTP 层与流内**同一语义、同一判据**。
2. **6 家共享调用点改传原始报文**：`cline`(717) / `minimax`(422) / `opencode`(568) / `qoder`(831,842) / `raccoon`(676,687) / `loomy`(737,748)。
3. `lobsterai-adapter.ts` / `trae-adapter.ts`（**均新增 override**）：**删除各自那份逐字相同的私有 `httpErrorCode`**，改为 `import { httpErrorCode } from './openai-compat.js'`，调用点传原始报文（trae 3 处、lobsterai 2 处）⇒ 少两份同义判据。
   - ⚠️ 两文件**只复用这一个函数**；序列化与各自 SSE 实现未动（`openai-compat.ts` 模块头那条「buddy / lobsterai 刻意不改用它」针对的是约 200 行协议层逻辑，已在 import 处写明）。
   - **gemini-adapter.ts 有意未动**：它的两处 400 超限判据（`:702` / `:781`，`isGeminiContextOverflow` = 宿主分类器 + 自己的 `token count … exceeds the maximum`）都**挡在换端点/换号之前**，400 已在更早分支 return，`httpErrorCode(400)` 到不了 ⇒ 传 body 无行为收益（最小改动优先）。
4. 未新增源文件、未改 `apply.sh`/workflow/README。

**验证（都在本机真跑过）**
- **真 tsc**：用设备树自带 `typescript 5.9.3`，对 **main 全量 `vendor/dsh-providers-hub/src`（159 文件）** 搭两棵树（基线 / 应用后override），`tsc -p tsconfig.json --noEmit` ⇒ **两份错误输出逐字节一致**（唯一那条 `qoder-wasm.ts(474,43)` 是设备 TS 版本差异造成的既有报错，与 9.11 同一条）。
- **行为探针 21/21 通过**（把应用后的树 `tsc --outDir probe-out` 编译成 JS 后直接驱动）：
  - `httpErrorCode`：`maximum context length`→溢出；`extError.context_length_exceeded`→溢出；网关措辞→溢出；普通 400→仍 `INVALID_REQUEST`；空报文→仍 `INVALID_REQUEST`；**401/403 + 超限文案→仍 `AUTH`**（状态码优先）；429/500/418 未变。
  - `consumeOpenAiSse`：三种错误帧形态的超限文案均→`CONTEXT_WINDOW_EXCEEDED`；普通失败三种形态→仍 `SERVER`；**额度帧→仍 `QUOTA_EXCEEDED`**；**正常流照常产出**；**排队帧→仍 `QUEUE`**。
- **反向验证**：同一探针跑**基线树** ⇒ **恰好 6 个溢出用例失败**（三条 HTTP + 三条流内），其余 15 条全一致 ⇒ 探针非同义反复、改动无附带行为变化。
- **CI #38 全绿**：步骤 16（vitest `Test Files 2 passed` / `Tests 46 passed` + `tsc -p tsconfig.json` + esbuild）、18（APK）、19（Release）全 success；`versionCode 103` 与 `ASSET_VERSION="103"` 同步注入（基线 65 + run 38）⇒ 装新包**会强制重解压 vendor**。
- **产物核对**：main 上 9 个 override 的 blob sha 与本地**逐一致**；关键标记 `PROMPT_TOO_LONG_BODY` / `sseFailureCode` / `httpErrorCode(status: number, body = ` 均在。
- **无既有单测被改判**：全仓 `src/` 里 `httpErrorCode` 调用点已穷举（其余是 buddy/llm-adapter/gemini/zcode 各自的私有实现，均未动）；`tests/unit` 里**没有**任何用例对共享层喂超限措辞，也没有断言流内错误帧固定 `SERVER`（设备上无 vitest，故未跑全量单测——如实记录）。

**结果**：代码提交 `1223f288` → **#38 全绿** → Release **`build-20261011-0341`**（versionCode 103）；构建的步骤 20 把 main 推到 `35a2e42a`（README 下载链接，正常）。
**回滚锚点**：推送前 main = `fb5aa221`（`PATCH /git/refs/heads/main {sha: fb5aa221, force: true}`；或只回滚 override 文件）。脚本：`.scratch/port-gitee/slice2-push.mjs`（推送）、`slice2-verify.mjs`（取证）、`slice2-watch.mjs`（构建监控）、`slice2-fetch.mjs`/`slice2-base-fetch.mjs`（拉基线）；快照：`slice2-base/` = main 原始版（含**有意未改**的 `gemini-adapter.ts`），`slice2/` = 应用改动后的版本（改动的 9 个文件 + 该未改文件）⇒ `diff -u slice2-base/X slice2/X` 即本轮补丁。

**⚠️ 本轮新发现（已写进文首待办「Step A 尾巴」，本轮按最小改动**未做**）**
1. **`llm-adapter.ts`（codearts）的 400 判据喂的是 `errorDetail(body)` 而非完整报文**（`:582-591`）——`buddy-adapter.ts:642-651` 的注释明确记录：`errorDetail` 在能提取 `error.*`/`message` 时会丢掉 `extError`/`displayMsg`，**「仅 msg」形态会漏判**。它还没有网关措辞兜底。
2. `buddy-adapter.ts:663` 的 `GATEWAY_PROMPT_TOO_LONG` 与共享层新增那份**逐字重复**（本次刻意不合并，避免动线上验证过的实现）。
3. `lobsterai`/`trae` 的**流内**失败仍固定 `SERVER`（本切片只改了它们的 HTTP 映射）；zcode 除 400 外其余状态码未判。
4. **未加 400 原文探针日志**（9.10 曾建议）：失败原因原文（`errorDetail` 结果）本就会落进会话记录，而设备上已有 `session-decode.mjs` + `scan-overflow*.mjs` 取证链 ⇒ 加日志属重复建设。等真实超限发生后再按证据补中文判据。

**⚠️ 环境事实**
- **toybox `grep "a\|b"` 假 0 又踩一次**（9.x 踩坑 1）：本轮 `grep 'GATEWAY_PROMPT_TOO_LONG\|...'` 返回空，误以为正则不存在。**一律 `grep -E` 或 `grep -F`**。
- 本机取不到 App 日志这一点未变（Shizuku 日志后端未启用、无 Termux）⇒ 实机行为仍只能由用户观察。
- 设备临时目录可用：`/data/data/com.dshphone/files/tmp/`（本轮类型检查树在该处，含 `base/`、`new/` 与探针 `probe-slice2.mjs`）。

---

### 9.13 轮次记录 · 2026-10-11 11:55–12:15（Step B 切片一：动态窗口 · 聚合兜底）

**开工前复核**：Gitee `info/refs` 仍 master=`04de37c1`、PR 到 #86（内容已含于 master）、无新分支；本机设备仍 `dsh.version`=99（未装任何新包）⇒ 文首第一条待办（实机验收）仍待用户。
**用户选定**：待办选 **Step B 动态窗口**；口径选 **「起步 1M + 从报文抓真上限，进程内记忆」**（不落盘、不动 `state.json`）。

**改动（4 个文件）**
1. **新增 `src/context-window-learn.ts`**（胶囊全新增文件，零依赖）：
   - `DYNAMIC_CONTEXT_WINDOW_START = 1_000_000`（起步给大）、`DYNAMIC_CONTEXT_WINDOW_FLOOR = 32_768`（收窄下限）；
   - `dynamicContextWindowFor(key)` = 学过用学到的，否则起步值；
   - `contextWindowFromFailureText(text)`：**只认两族英文数字形态**（`maximum context length is N`、`… > M maximum`），
     合理性区间 `[1024, 1e8]`，**不从任意数字里猜**；
   - `rememberContextWindowFailure(key, text)`：**报文里的真实上限 > 当前值减半**，返回收窄后的值；
   - 键 = `provider` + NUL + 模型；**进程内 Map，不落盘**（重启重学，换取「不会把学错的值永久固化」）。
2. **`aggregate-adapter.ts`**（既有 override）：兜底由 `AGGREGATE_FALLBACK_CONTEXT_WINDOW = 200_000`（**该常量已删除**）
   改为 `widest ?? dynamicContextWindowFor(contextWindowKey(AGGREGATE_PROVIDER, modelKey))` —— **候选一旦声明了窗口就用真值**；
   撞墙处（`resolveUpstreamCode` 之后、且仅在 `code === CONTEXT_WINDOW_EXCEEDED_CODE` 时）调 `rememberContextWindowFailure`
   并打一行 `[jet-hub] 窗口学习 …`。动态值**不进** `contextWindowCache`（记忆化条件仍是 `allResolved && widest !== undefined`）⇒ 学过立刻生效。
3. **新增 `tests/unit/context-window-learn.spec.ts`**（12 条）：起步/记忆/键隔离、报文上限解析 + 3 条反向用例、
   减半收敛与下限、中文报文走兜底、以及**聚合层两处接线的源码文本断言**（含「`widest ??` 顺序不得颠倒」「写死常量已删除」）。
4. **`rebuild-vendor.sh`**：把新 spec 加进 CI 的 vitest 名单（否则它不会被跑 —— 9.8 记录过这个坑）。

**验证（都在本机真跑过）**
- **真 tsc（本轮改用忠实构建树）**：`main 全量 src + 胶囊 files/ + 全部 overrides`（等价 `apply.sh` 后的树）跑
  `tsc --noEmit`，与「把 aggregate-adapter 换回 main 旧版、并去掉新模块」的基线树比对 ⇒ **错误集合逐字节一致**
  （唯一那条 `qoder-wasm.ts(474,43)` 仍是设备 TS 5.9.3 与仓库 TS 版本的既有差异）。
- **行为探针 24/24 通过**（编译产物直驱）：起步 1M；学后立刻生效；`> N maximum` / `maximum context length is N`（含千分位）
  正确取数；仅 token 数 / 限流报文 / `> 512 maximum` 三条**反向不取数**；减半序列 500K→250K→125K 并停在下限；
  中文报文不猜措辞、走减半；键隔离；重置；**聚合层 5 条接线源码断言**。
- **反向验证**：同一批源码断言在基线（main 旧版）上恰好失败（旧版 `dynamicContextWindowFor` 0 次、
  `rememberContextWindowFailure(` 0 次、写死常量 2 次）⇒ 断言可判别、非同义反复。
- **spec 文件本身真跑过**：设备无 vitest，故写了个**影子 shim**（`describe/it/expect/beforeEach`）把 spec 改写后直接跑
  ⇒ **12/12 通过**（既验证断言成立，也验证文件可执行）。
- **CI #39 全绿**：步骤 16 日志实证 `✓ tests/unit/context-window-learn.spec.ts (12 tests)`、
  `Test Files 3 passed (3)`、`Tests 58 passed (58)`（46 + 12 —— 新 spec **确实在 CI 里跑**）、
  步骤 18/19 全 success；`versionCode 104` 与 `ASSET_VERSION="104"` 同步注入。
- **产物核对**：main 上 4 个文件 blob 与本地**逐一致**；提交 `e97932cb` 恰好 4 个文件
  （`aggregate-adapter.ts +34/-9`、两个新增、`rebuild-vendor.sh +1/-1`）。

**结果**：代码提交 `e97932cb` → **#39 全绿** → Release **`build-20261011-0406`**（versionCode 104）；构建的步骤 20 把 main 推到 `80e54505`（README 下载链接，正常）。
**回滚锚点**：推送前 main = `35a2e42a`。脚本/快照：`.scratch/port-gitee/sliceB-{push,verify,watch}.mjs`、`sliceB-base/aggregate-adapter.ts`（main 旧版基线）；设备侧忠实构建树与探针在 `/data/data/com.dshphone/files/tmp/sliceB/`（`new/probe-sliceB.mjs`、`new/vitest-shim.mjs`、`new/rewrite-spec.mjs`）。

**⚠️ 覆盖边界（写进文首待办「Step B 切片二」）**
- 本切片**只覆盖 `aggregate/*` 的兜底路径**。`jet-hub-auto/auto` 的失败**不经聚合层**（auto 只做转发，
  没有失败归一化点）⇒ auto 不会学习；它的声明平时继承目标 provider 的目录值。
  ⚠️ **顺带修正 9.11 的一处不准确表述**：那句「一处覆盖所有走 aggregate / auto 的模型」对 auto **不成立**
  （auto 的失败直接由目标适配器抛出，不经过 `aggregate-adapter` 的归一化）。
- `zcode-upstream.ts`（远端缺字段 200K）、`trae-product.ts`（自认是估值的静态表）未动 —— 属切片二。

**⚠️ 环境事实（本轮新踩）**
- **toybox `grep` 的 `\|` 假 0 又踩一次**（本会话第三次）：`grep 'contextWindowFor\|200_000'` 返回空，
  一度以为「capsule 版聚合没有 contextWindowFor」。**一律 `grep -E`（或 `grep -F`）**。
- **push 脚本的模板字符串被反引号截断**（踩坑 2 变体）：commit message 里写 `` `… > N maximum` `` 这类
  Markdown 行内代码会提前闭合模板字符串 ⇒ 脚本语法错。**message 里的引用改用「」或转义**。
- 设备上**没有 vitest**（也无 pnpm/npm）⇒ 需要跑 spec 时用「影子 shim 改写后直跑」的办法（本轮脚本已留在设备 tmp）。

---

### 9.14 轮次记录 · 2026-10-11 12:15–12:30（Step B 切片二：动态窗口推广到 zcode）

**用户指令**：「继续」（承接 9.13 的下一步）。

**开工先做了「哪些兜底真的该改」的核实（重要，结论改写了原计划）**
- 原待办写的是三处一起改（zcode 目录 / trae 静态表 / auto 兜底）。逐处读码后**只改了 zcode**：
  - **trae 不能改**：`trae-adapter.ts:719-730` 的注释明写「⚠️ 开启 Max 模式时改用
    `context_window_tokens.max`（1M）。两者**不能混用**：未开 Max 却声明 1M 会让 DSH 把
    超长上下文直接发出去，而上游按 200K 校验后拒绝」⇒ **声明过大在 trae 是错的**，而
    `contextWindowFor` 本就远端优先（`meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS` /
    `meta?.contextWindow ?? 静态表`），静态表只在远端没给时才用 ⇒ 改它属**制造**问题。
  - **auto 兜底改不了**：`auto-adapter.ts` 的失败**不经聚合层**（它只做转发，没有失败归一化点）
    ⇒ 挂不上学习钩子；且它平时继承目标 provider 的目录值，200K 只在「没选到目标」时出现。
    要动它得先**新增**一个失败归一化点（新功能，另立项）。
  - **zcode 是真·拿不到**：`fetchZcodeModels` 从上游 `builtinModels` 取 `contextWindow`，
    **第三方模型没有这个字段**（历史注释记「兜底表当时填的是 200_000 / 32_768（凭空估的）」），
    此前一律写 200K。
- ⇒ 本切片只做 zcode 一处；trae/auto 的「不做」理由已写进文首待办。

**改动（4 个文件）**
1. `context-window-learn.ts`：新增 `learnedContextWindow(key)`（**没学过返回 `undefined`**，
   供 zcode 区分「回落声明值」）；模块头补「接入点」说明（聚合兜底 + zcode 目录）。
2. **`zcode-upstream.ts`（新增 override，基线 = main 当前版）**：`fetchZcodeModels` 对
   缺 `contextWindow` 的模型改给 `DYNAMIC_CONTEXT_WINDOW_START`（1M）；**上游给了真值仍用真值**。
3. `zcode-adapter.ts`（既有 override）：
   - `resolveModel`：`effective = learned !== undefined && (contextWindow === undefined || learned < contextWindow) ? learned : contextWindow`
     —— **只在学到的值更小时**才覆盖目录声明值（约定 3：能拿到真值就用真值）；
     该方法**不被 DSH 缓存**（每次请求都调）⇒ 收窄立刻生效；
   - 失败路径：`const code = httpErrorCodeForZcode(...)` 提出一行，`code === CONTEXT_WINDOW_EXCEEDED_CODE`
     时用**同一个学习表**记录（键 `contextWindowKey(this.product.id, options.model)`），
     并打一行 `zcode: 窗口学习 …`；**不另写措辞匹配**（本仓库红线）。
4. `context-window-learn.spec.ts`：+4 条（`learnedContextWindow` 语义、zcode 目录起步值、
   适配器覆盖条件、zcode 学习钩子）+ 一段「zcode 接线」源码文本断言（含
   `expect(upstream).not.toContain(': 200_000,')`）。

**验证（都在本机真跑过）**
- **真 tsc（忠实构建树）**：`main 全量 src + 胶囊 files/ + 全部 overrides` 与基线
  （= 切片一之后的版本）比对 ⇒ **错误集合逐字节一致**（仍只有 `qoder-wasm.ts(474,43)` 那条
  设备 TS 5.9.3 的既有差异）。
- **行为探针 17/17 通过**：目录缺窗口→1M；目录给真值（1M / 262144）→仍用真值；
  学过更小（128K）→覆盖 1M；学过更大→不覆盖；目录缺窗口+学过→用学到的；
  目录缺窗口+没学过→`undefined`（不编造）；聚合与 zcode 的键**互不影响**；6 条源码接线断言。
- **反向验证**：同一批断言在基线（切片一版）上失败 —— 该版本**连 `learnedContextWindow`
  导出都没有**（import 即报错），zcode 两文件的学习调用计数为 0，且目录里仍有 `: 200_000,`。
- **spec 影子运行 16/16 通过**（设备无 vitest，用等价 shim 验证文件可执行 + 断言成立）。
- **CI #40 全绿**：步骤 16 日志实证 `✓ tests/unit/context-window-learn.spec.ts (16 tests)`、
  `Test Files 3 passed (3)`、`Tests 62 passed (62)`（46 + 16）；`versionCode 105` 与
  `ASSET_VERSION="105"` 同步注入；4 个文件 blob 与本地逐一致；提交 `acc66abc` 恰好 4 个文件。

**结果**：代码提交 `acc66abc` → **#40 全绿** → Release **`build-20261011-0420`**（versionCode 105）；
构建的步骤 20 把 main 推到 `01b1f095`（README 下载链接，正常）。
**回滚锚点**：推送前 main = `80e54505`。脚本/快照：`.scratch/port-gitee/sliceC-{push,verify,watch}.mjs`、
`sliceC-base/{zcode-adapter,zcode-upstream,context-window-learn,context-window-learn.spec}.ts`；
设备侧忠实构建树与探针在 `/data/data/com.dshphone/files/tmp/sliceC/`。

**⚠️ 遗留（写进文首待办）**
- zcode 的**中文超限报文**仍不会被识别（宿主分类器只认英文）⇒ 那条路会落到「减半」兜底，
  照样收敛，只是多撞几次。等真实报文出现再按证据补（见 9.10 的取证链）。
- zcode 目录里 `maxTokens` 缺字段仍写 `32_768`（本切片未动，属另一语义，无证据不改）。
- **未做**：trae 静态表、auto 兜底（理由见上）。

**⚠️ 环境事实（本轮新踩）**
- 又一次 `grep 'a\|b'` 假 0（本会话第四次）：`grep -nE 'ZcodeRemoteModel\b|interface ZcodeRemoteModel'`
  里混了 `\b`，toybox 直接报 `trailing backslash`；**toybox grep 对 `\b`/`\|` 支持都很差，
  统一用 `grep -E` + 不依赖 `\b`**（或 `grep -F`）。
- 取基线时差点取错文件：`capsule/overrides/.../zcode-adapter.ts` 与**上游 vendor 的同名文件
  不是一份**（override 是「上游某版 + 手机版手术」）。**做 diff 的基线必须从 main 拉
  capsule 路径下的那份**，不能拿 `.scratch/.../vendor/...` 直接比。

---

### 9.15 轮次记录 · 2026-10-11 12:35–13:10（Step A 尾巴 ①：codearts 400 判据）

**开工前复核（两项都查了，结论：无新素材）**
- Gitee `info/refs`（UA `git/2.40`）：master 仍 `04de37c1`；分支仍 `fix/IKKHL5-credits-self-heal`=`0523e74`、
  `issue/IKJOF7-benefit-diagnostics`=`16e246e6`；**无 #87+** ⇒ 无新素材。
- GitHub：main `01b1f095`，#36–#40 全绿，Release `build-20261011-0420`（105）；
  `compare main...port-gitee` = ahead 0 / behind 9（port-gitee 已全含于 main）。
- 本机设备仍是 `dsh.version`=**99**、vendor `lib/` mtime **08:53** ⇒ 文首第一条待办
  （Phase 1–5 实机验收）**仍未在本机发生**（用户尚未装新包）。
- **中文超限措辞的取证复核**：重跑 `scan-overflow-3.mjs`（44 个会话、已排除本会话），
  命中的 14 条**全部是本对话自身的转录**（工具结果/推理里引用了「超限」字样），
  **没有一条真实上游超限错误帧**；另跑 `scan-codearts-err.mjs` 专查 codearts/HTTP 类
  「失败原因」文案 ⇒ **命中 0** ⇒ 「等真实报文再补中文判据」的结论**继续有效，不能猜**。

**用户选定**：待办里唯一可动项 **Step A 尾巴 ①**（codearts `llm-adapter.ts` 的 400 判据）。

**改动（3 个文件；全部是 capsule override / 胶囊新增，main 的上游文件一行未动）**
1. `openai-compat.ts`（既有 override）：`isContextOverflowBody` **加 `export`** + 注释说明
   「导出是给 llm-adapter 用的，两处必须同源」。**相对切片二快照只多了 export 与一段注释**，
   切片二的实现一行未动（已 `diff` 核对）。
2. `llm-adapter.ts`（**新增 override，基线 = main 当前版 `01b1f095`**）：
   - `httpErrorCode` 的 400 分支由 `isContextWindowExceededError(detail)`（detail =
     `errorDetail(body)`）改为 **`isContextOverflowBody(body)`**（喂**完整报文**、
     复用共享判据）；
   - 顶部 import：去掉 `isContextWindowExceededError`（本文件已不再用），加
     `import { isContextOverflowBody } from './openai-compat.js'`。
   - 其余分支（401/403→AUTH、quota 优先、429、≥500、`HTTP_n`）**顺序与语义一律未动**。
3. 新增 `tests/unit/llm-adapter-context-overflow.spec.ts`（7 条）+ `rebuild-vendor.sh`
   把该 spec 加进 CI 的 vitest 名单（否则不会被跑 —— 9.8 记录过这个坑）。

**为什么这样改（依据全部来自仓库内既有结论，未新造判据）**
- `buddy-adapter.ts:641-651` 的注释**已实测记录**：`errorDetail` 在能提取 `error.*` /
  `message` 时返回拼接短文本，**丢掉 `extError.code`**，而
  `extError.code = context_length_exceeded` 恰是稳定命中的结构化字段 ⇒
  「仅 msg」形态会被漏判成 `INVALID_REQUEST`。
- 后果**不对称**：`INVALID_REQUEST` 不在 `DEFAULT_RETRYABLE_CODES`，且
  `dsh-compaction-basic` 的 listener 第一行就 `if (code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
  ⇒ 连一次压缩机会都没有，长会话越过窗口后**每轮报废**。
- 复用共享判据而非再写一份：本仓库红线「同一语义不得两套判据」。
- **有意未做**（属 Step A 尾巴剩余项，勿顺手改）：`buddy-adapter.ts` 的
  `GATEWAY_PROMPT_TOO_LONG` 合并（要先把它变成新 override）、`lobsterai`/`trae` 的流内固定
  `SERVER`、zcode 除 400 外的状态码。

**验证（都在本机真跑过）**
- **真 tsc（忠实构建树）**：`main 全量 src + 胶囊 files/ + 全部 overrides`（等价 `apply.sh` 后）
  与基线（= 本轮改动前的同款树）各跑 `tsc -p tsconfig.json --noEmit`（设备自带 TS **5.9.3**）
  ⇒ **两份错误输出逐字节一致**（唯一那条 `qoder-wasm.ts(474,43)` 仍是设备 TS 版本差异造成的
  既有报错，与 9.11–9.14 同一条）⇒ **未引入任何新类型错误**。
- **行为探针 10/10 通过**（把应用后的树 `tsc --outDir probe-out` 编译成 JS 后**直驱真实
  `adapter.stream()`**，不是重写一份判据）：
  - 判别用例（修复前必挂）4 条：`error_code/error_msg` 可提取 + `extError.code` 是唯一依据 →
    **CONTEXT_WINDOW_EXCEEDED**；`message` 可提取 + 顶层 `extError` → 同上；嵌套
    `error.message` + 顶层 `extError` → 同上；仅 `error_code/error_msg` 承载网关措辞
    `prompt is too long: 100001 tokens > 100000 maximum` → 同上。
  - 反向 6 条：可提取的普通 400 / 空报文 / 宽泛「too long」但无 `N tokens > M`
    → **仍 INVALID_REQUEST**；401 + 超限文案 → **仍 AUTH**；429 → 仍 RATE_LIMIT；500 → 仍 SERVER。
- **反向验证（关键，防同义反复）**：同一探针跑**基线树**（未打补丁）⇒ **恰好那 4 条判别用例失败**
  （全部得到 `INVALID_REQUEST`），其余 6 条逐条一致 ⇒ 探针可判别、改动**无附带行为变化**。
- **既有 spec 不受影响**：把 `llm-adapter.spec.ts` 里**全部** `status: 400` 的报文
  （TM.00001041 排队 / `OTHER`+`bad request` / `InferHub.4291.200 insufficient quota`）
  逐条在「打补丁前 / 后」两棵树上驱动 ⇒ **三例同码**（QUEUE / INVALID_REQUEST / QUOTA）
  ⇒ 不会改判既有用例（那些报文都不含超限措辞）。
- **新 spec 本身真跑过**：设备无 vitest，故用**异步版影子 shim**（`describe/it/expect` + 真
  `await`）把 spec 编译后直跑 ⇒ **7/7 通过**；再对基线源码/产物跑同一 spec ⇒
  **恰好 3 条失败**（两条溢出行为 + 一条源码文本断言）⇒ spec 可判别、非同义反复。
  spec 自身类型检查（忠实 ESM + 仓库 tsconfig 语义）**无错误**；设备上唯一那条
  `Cannot find module 'vitest'` 是**环境限制**（设备未装 vitest），已用「CI 已通过的
  `context-window-learn.spec.ts` 在同样环境下报同一条」证实。

**结果（已 push 并全绿）**
- 代码提交 `05cb10b9`（恰好 4 个文件：`llm-adapter.ts +2364`（新增 override）、
  `openai-compat.ts +5/-1`（仅 export + 注释）、新 spec `+147`、`rebuild-vendor.sh +1/-1`）
  → **#41 全绿** → Release **`build-20261011-0513`**（versionCode **106** = 基线 65 + run 41，
  与 `ASSET_VERSION="106"` 同步注入 ⇒ 装新包会强制重解压 vendor）。
- **#41 关键证据（取自 job 日志）**：步骤 16 实证
  `✓ tests/unit/llm-adapter-context-overflow.spec.ts (7 tests)`、
  `Test Files 4 passed (4)`、`Tests 69 passed (69)`（46 + 12 + 7 + 4 —— **新 spec 确实在 CI 里跑**）；
  `> tsc -p tsconfig.json` 通过、`lib/index.js` / `lib/client/jet-hub.js` 均产出。
- **产物核对**：main 上 4 个文件的 blob sha 与本地**逐一致**；构建的步骤 20 把 main 推到
  `69e7ddd2`（README 下载链接，正常）。
- **回滚锚点**：推送前 main = `01b1f095a86063669eb5ce8354ddad44e6c0f671`。
  脚本：`.scratch/port-gitee/sliceD-{push,watch,verify,final}.mjs`、`fetch-files.mjs`（单文件拉取）、
  `fetch-vitest-cfg.mjs`。

**⚠️ 新增 override 基线（后续 sync 前必看）**：`overrides/.../llm-adapter.ts`
（基线 = main 的 `01b1f095`）。与既有 8 个 override 一样，**手工同步上游或上游改动该文件时
要重定基线**（流程见踩坑 6）。

**⚠️ 环境事实（本轮新踩）**
- **toybox `grep` 的 `\|` 假 0 又踩（本会话第五次）**：`grep 'isContextWindowExceededError\|CONTEXT_WINDOW_EXCEEDED_CODE'`
  返回空；`grep -E '...|...\b'` 又报 `trailing backslash`。**一律 `grep -E` 且不写 `\b`**
  （或 `grep -F`）。
- **GitHub tarball 下载在本机不稳**：`codeload .../tar.gz` 两次都只打印 status/bytes 前就挂住
  （16MB 级）；改用 **contents API 单文件拉取**（`Accept: application/vnd.github.raw`）稳定可用
  —— 脚本 `.scratch/port-gitee/fetch-files.mjs`。
- **`cp` 新建的文件必须先 `read` 才能 `edit`**（fs-observation-policy）：本轮 `cp` 出
  `llm-adapter.ts` 后首次 `edit` 被拒，读一次即通过。
- 设备临时目录仍可用：`/data/data/com.dshphone/files/tmp/sliceD/`（`base/`、`new/` 两棵树 +
  `probe-disc.mjs`、`probe-existing.mjs`、`shadow-ts/` 影子 spec 运行环境）。

---

### 9.16 轮次记录 · 2026-10-11 13:25–14:05（Step A 尾巴 ③④ + ② 闸门 + typecheck 快环 + sync 演练）

**用户指令**：「后续不用问我，按你建议继续操作，争取把这个文档内容都收尾。」

**开工前复核（均无新素材）**：Gitee master 仍 `04de37c1`、无 #87+；
GitHub main `69e7ddd2`（#41 后由构建推到）；上游 `jwoo1982217-eng/dsh-phone` main 仍
`274bf823`（本仓库 ahead 76 / behind 0）；设备仍 `dsh.version`=99（实机验收仍待用户）。

**先做的核实（结论改写了原计划）**
- **② 的「重复常量」经核实是逐字节相同**（用脚本比对两行正则 ⇒ `true`）。
  ⇒ 合并**零功能收益**，却要求把 102KB 的 `buddy-adapter.ts` 变成 override
  ⇒ 与上游脱钩（**踩坑 6 / #15 的基线漂移风险**，且它是流量最大的适配器）。
  ⇒ **换做法**：不合并，改为**新增 CI 闸门**断言两份必须逐字一致。
- **③ 的落点**：`lobsterai` 的流内失败（HTTP 200 + SSE 错误帧）此前固定写 `SERVER`
  （`buildLobsteraiFailure` 的 `fromStream ? 'SERVER' : …`）。归成 `SERVER`
  **不触发** DSH 压缩恢复链 ⇒ 直连的长会话越过窗口后每轮报废。
- **④ 的落点（新证据）**：zcode 的端点是 **Anthropic 协议**的
  `/api/v1/zcode-plan/anthropic/v1/messages`，而 Anthropic 原生的超限报文正是
  `prompt is too long: N tokens > M maximum` —— 宿主分类器**认不出这句**。
  实测：改动前 `httpErrorCodeForZcode(400, 该报文)` = `INVALID_REQUEST`（漏判）。
  ⚠️ zcode 的**其余**状态码/业务码（3007/3012/1005/边缘页短路）**经核实无新证据、一律未动**。
- **trae 流内有意不动**：它是 SOLO **业务码**驱动（`1005`/`4008`/`4001`），
  不是措辞判据 ⇒ 套用措辞分类器属制造问题。

**改动（6 个文件；全部 capsule / workflow，main 的上游文件一行未动）**
1. `openai-compat.ts`（既有 override）：`sseFailureCode` 加 `export`（+5/−1，实现未动）。
2. `lobsterai-adapter.ts`（既有 override）：import 加 `sseFailureCode`；
   `buildLobsteraiFailure` 的码改为 `fromStream ? sseFailureCode(text) : httpErrorCode(status, text)`。
3. `zcode-adapter.ts`（既有 override）：import 加 `isContextOverflowBody`
   （去掉已不再用的 `isContextWindowExceededError`）；400 分支改用共享判据。
4. `tests/unit/context-overflow-channels.spec.ts`（**新增 12 条**）：zcode 400 判别 +
   反向（既有业务码一条不动）、lobsterai 流内判别 + 反向、三条通道同源源码断言、
   **buddy 防分叉闸门**（两份正则必须逐字一致）。
5. `rebuild-vendor.sh`：新 spec 加进 CI 的 vitest 名单。
6. `.github/workflows/typecheck.yml`（**新增**，用户定夺的第 12 条）：
   main 的**类型检查快环**，**仅 `workflow_dispatch`**，只跑 `rebuild-vendor.sh`
   （vitest 胶囊 spec + tsc + esbuild），**不打包 APK / 不出 Release / 不改 README**。

**验证（都在本机真跑过）**
- **真 tsc（忠实构建树）**：与改动前**错误集合逐字节一致**（唯一那条 `qoder-wasm.ts(474,43)`
  仍是设备 TS 5.9.3 的既有差异）。
- **行为探针 19/19 通过**（编译产物**直驱真实 `adapter.stream()` 与真实导出**）：
  - ③：流内帧 Anthropic 措辞 / 宿主英文措辞 → `CONTEXT_WINDOW_EXCEEDED`；
    普通流内错误 → 仍 `SERVER`。
  - ④：zcode Anthropic 原生措辞 → `CONTEXT_WINDOW_EXCEEDED`；宿主英文措辞 → 同上；
    反向 9 条（普通 400 / 空报文 / 宽泛 too long / 3007 / 3012 / 1005 额度 / 并发文案 /
    401 / 1002 / 500 / `13012` 不误判 / 边缘页）**全部不变**。
- **反向验证（关键）**：同一探针跑**改动前的树**（从 main 拉回那三个 override 重建）
  ⇒ **恰好 3 条判别用例失败**（2 条 lobsterai 流内 + 1 条 zcode），其余 9 条逐条一致
  ⇒ 探针可判别、改动**无附带行为变化**。
- **新 spec 真跑过**：设备无 vitest，用**异步影子 shim** 编译后直跑 ⇒ **12/12 通过**；
  另对 **buddy 防分叉闸门做反向验证**：故意把 buddy 常量改一个字 ⇒ **该用例立刻红**，
  还原后转绿 ⇒ 闸门真的能挡住静默分叉（非同义反复）。spec 自身类型检查**无错误**。
- **既有 spec 不受影响**：`llm-adapter` / `lobsterai` / `zcode` 三份 spec 的 400 与流内
  断言逐条对照改动前后**同码**（lobsterai 的 402/400/503 与 zcode 的 3007/3012/1005/
  并发/边缘页全部不变）。
- **CI #42 全绿**：步骤 16 实证 `✓ tests/unit/context-overflow-channels.spec.ts (12 tests)`、
  `Test Files 5 passed (5)`、`Tests 81 passed (81)`；`versionCode 107` 与
  `ASSET_VERSION="107"` 同步注入；6 个文件 blob 与本地逐一致。
- **新 workflow 实测**：GitHub 已注册（`typecheck` state=active）；手动 dispatch ⇒
  **#1 全绿、约 30 秒**（`Test Files 5 passed` / `Tests 81 passed` / `lib/index.js` 产出）
  —— 对比完整构建 5–6 分钟，达到「1 分钟级反馈环」的设计目标。
- **sync 演练**：手动 dispatch `sync-upstream` ⇒ **#3 全绿**，日志
  `上游领先本仓库：0 个提交` / `上游无更新，本次跳过`，main **未变**
  ⇒ 确认「停掉 schedule 后仍可手动补同步」且跳过路径正常。
  ⚠️ 如实说明：本轮演练**只走到「无更新即跳过」这一支**（上游确实没动），
  **合并/冲突兜底两支未被执行**；真正的合并演练需等上游有新提交。
  另做了**基线漂移检查**（`drift-check.mjs`）：21 个 vendor override 逐个与上游同路径比对，
  差异全部来自我方有意改动（上游停在 `274bf823`，无 override 失效）。

**结果**：代码提交 `ca0784ce`（恰好 6 个文件）→ **#42 全绿** → Release **`build-20261011-0552`**
（versionCode **107**）；构建的步骤 20 把 main 推到 `1036bf8c`（README 下载链接，正常）。
**回滚锚点**：推送前 main = `69e7ddd26d9bb5e966de081297d09e327fcd64d5`。
脚本：`.scratch/port-gitee/sliceE-{push,verify}.mjs`、`fetch-overrides.mjs`（取改动前基线）、
`dispatch-typecheck.mjs` / `check-typecheck.mjs`、`dispatch-sync.mjs` / `check-sync2.mjs`、
`drift-check.mjs`（基线漂移）、`fetch-all-src.mjs`（main 全量 src）。

**⚠️ 新增/变更的 override 基线（后续 sync 前必看）**：本轮改了三个**既有** override
（`openai-compat.ts` / `lobsterai-adapter.ts` / `zcode-adapter.ts`），**没有新增 override 文件**。
新增的是 **workflow**（`.github/workflows/typecheck.yml`）与一个 spec。
⚠️ `typecheck.yml` **不在** `sync-upstream.yml` 的恢复名单里（那份只恢复 `build-apk.yml`）；
上游没有同名文件 ⇒ 手动 sync 不会覆盖它。若上游将来引入同名 workflow，需把它也纳入恢复逻辑。

**⚠️ 环境事实（本轮新踩）**
- **`cp` 出来的文件必须先 `read` 才能 `edit`**（fs-observation-policy）—— 本轮在
  `lobsterai-adapter.ts` / `zcode-adapter.ts` 上各踩一次（第二次是「读后又被自己的
  上一次 edit 改过」⇒ 需**重新 read**）。
- **toybox `grep` 的 `\|` 假 0 与 `\b` 报错**（本会话第五、六次）：一律 `grep -E` 且不写 `\b`。
- **tsc 不会清掉旧产物**：影子 spec 运行前若只改源码，`out/` 里的旧 JS 会被继续使用
  ⇒ 必须 `rm -rf out` 再编（本轮因此误判一次「闸门不生效」）。
- **tsc 的输出目录结构会随 `rootDir` 推断而变**（同一 tsconfig，有时 `out/unit/`、
  有时 `out/tests/unit/`）⇒ 跑影子 spec 前先 `ls` 确认实际路径。
- 设备临时目录：`/data/data/com.dshphone/files/tmp/sliceD/`（`prev/`=改动前、`new2/`=改动后
  两棵忠实树 + 各自 `probe-out/`；`shadow4/`=影子 spec 运行环境）。

**⚠️ 本轮新发现的已知边界（已写进文首待办，未擅自改）**
- Step B 的动态窗口学习器会把报文里 `N tokens > M maximum` 的 **M** 当窗口上限，
  但 `protocol-wire.md` 明确记录：**buddy 的 `100000` 是「单次请求图片视觉 token 预算」**，
  该模型声明的真实窗口是 **1,000,000**（同会话纯文本到 345,687 仍被接受）。
- 本机实测确认：`contextWindowFromFailureText('… prompt is too long: 100001 tokens > 100000 maximum')`
  ⇒ **100000**（而非 1M）。
- **影响有界且方向保守**：聚合层只在「候选全无声明」时才采用动态值（`widest ?? 动态值`）；
  zcode 侧只在「学到的值更小」时才覆盖声明值 ⇒ 最坏是「声明 1M 的模型被压到 100K」，
  即**更早触发压缩（浪费上下文，但不致命）**，不会把超长请求发出去。
- **不在本轮擅自修**：改法口径有多种（按 provider 排除 / 只认 `maximum context length is N` 一族 /
  加「是否图片相关」判据），需用户定夺 ⇒ 如实记为**已知边界**。

**⚠️ 9.16 收尾补记：聚合兜底网也同源（`487b7f85` / #43 / Release `build-20261011-0615`，versionCode 108）**
- **发现过程**：写文档时核验「四条通道同源」这句声明，用脚本检查聚合层的兜底网
  `aggregate-adapter.ts` 的 `isContextOverflowFailure` —— 发现它**只喂宿主
  `isContextWindowExceededError`**，没有网关措辞兜底（那是**切片一**时代的形态，
  早于切片二引入共享判据）⇒ **网关措辞（`prompt is too long: N tokens > M maximum`）
  在这道网上漏判**，而它正是 `resolveUpstreamCode` 的依据（决定聚合/auto 路径的失败归码）。
  ⇒ 与 ①③④ 修的是**同一类**缺陷，属同一收尾范围。
- **改动（2 个文件）**：`aggregate-adapter.ts` 改 import 共享 `isContextOverflowBody`
  （去掉已不再用的 `isContextWindowExceededError`），兜底网第 2 条判据改调它；
  spec +1 条源码接线断言。
- **验证**：真 tsc 错误集合与改动前**逐字节一致**；行为探针 **9/9**；
  **反向验证**：同一批接线断言在改动前的树上**恰好 4 条失败**、5 条行为用例一致
  ⇒ 可判别、非同义反复；spec 影子运行 **13/13**；**CI #43 全绿**
  （`✓ context-overflow-channels.spec.ts (13 tests)`、`Test Files 5 passed`、
  `Tests 82 passed`、`versionCode 108`）。
- **结果**：main 推到 `8ffab2ab`（构建的 README 提交）；回滚锚点 `1036bf8c`。
  脚本：`.scratch/port-gitee/sliceF-{push,verify}.mjs`。
- ⚠️ **本条也修正了 9.16 正文里「四条通道已全部同源」的表述**：现在是
  **四条通道 + 聚合兜底网**共五处调用同一个 `isContextOverflowBody`。

---

### 9.17 轮次记录 · 2026-10-11 14:30–15:55（上游两个新提交 + 连带修一个用户可见缺陷）

**用户指令**：「读 PORTING-GITEE-HANDOFF.md 文首『⚡ 新对话从这里读』，按里面的待办继续。」

**开工前复核（三项都查了，结论：上游有新素材）**
- **Gitee master 前进了**：`04de37c1` → **`5a61117f`**（本会话首次发现上游漂移）。新增两个提交：
  ① `5a61117f` fix(gateway): 超限回 413 而非断连（IKKUBJ）；
  ② `8a0fd86b12` fix(minimax): 接上请求级换号 + 冷却（IKJW32）。PR 仍到 #86（无 #87+）。
- **设备已装 108**（`dsh.version`=108、vendor `lib/` mtime 14:15）—— 与文首旧记录「仍是 99」不同，
  说明用户已装了含 Step A/B 全量的包（**实机行为验收仍待用户反馈**）。
- **上游 `jwoo1982217-eng/dsh-phone` 也前进了**：`274bf823` → **`85c62fdd`**
  （feat(phone): support large JSON analysis uploads in 0.1.63，1 个提交、18 个文件）。
  ⇒ **本轮有意不合并**（理由见文末「未做项」）。

**① 移植：网关超限回 413 而非断连（上游 `5a61117f`，Issue IKKUBJ）**

- **可行性**：手机版 `vendor/.../src/openai-gateway/server.ts` 与该提交**之前**的上游版本
  **逐字节相同**（`cmp` 实测）⇒ 缺陷同源、无手机版自有改动 ⇒ 可直接替换。
- **缺陷**：网关对超过 body 上限的请求**销毁 socket**，而那条 413 要等 `withRequest` 的
  catch 才写出，socket 已死 ⇒ 客户端只看到连接重置。后果不是「一次请求失败」而是
  **该会话永久不可用**（Codex 每轮回传全量历史，越过上限就再也回不去；它的自动压缩
  只看 token 不看字节 ⇒ 永不触发。报障者实测 157,599 / 950,000、压缩事件 = 0）。
- **改动（3 个文件，全部 capsule）**：新增 override `src/openai-gateway/server.ts`
  （基线 = main 当前版）+ override 的 spec + `rebuild-vendor.sh` 登记。
  四条修复：`BODY_LIMIT` 16 MiB → **300 MiB 并导出**（原值与自家 `DEFAULT_IMAGE_LIMITS`
  自相矛盾：允许一条消息 200 MiB 图片，base64 膨胀 4/3 ⇒ 光图片 266.7 MiB；实测连
  12 MiB 的图片都在读到 body 时被拒）；判超限后**排空但不销毁 socket**；`keepAliveTimeout`
  显式 120s（`headersTimeout` 130s，必须更大）；新增 `maxBodyBytes` 选项（唯一理由是**可测**）。
- **验证**：真 tsc 与改动前**错误集合逐字节一致**；影子 spec **28/28 通过**
  （设备无 vitest ⇒ 等价异步 shim 编译后直跑，该 spec 真的起 HTTP server 走真实往返）；
  **反向验证**：同一 spec 跑改动前的树 ⇒ **恰好 5 条判别用例失败**
  （超限回 200 / responses 回 400 / keep-alive 报 `timeout=5` / 自洽性 got 16777216
  want >= 279620268），其余 23 条逐条一致 ⇒ 可判别、非同义反复。
- **结果**：`3ff2f70e` → **#44 全绿** → Release **`build-20261011-0657`**（versionCode **109**）。

**② 移植：minimax 请求级换号 + 冷却（上游 `8a0fd86b12`，Issue IKJW32）**

- **可行性**：手机版 minimax 是 14 家里**唯一**没有任何换号 / 冷却记账的适配器
  （`getAvailableAccount` / `updateModelRateLimit` 全文件零命中）⇒ 缺陷同源。
- **缺陷**：首号额度耗尽就把硬失败抛给用户，而池的取值顺序不因失败而变 ⇒ 下次请求
  仍是同一个号（「卡死在一个号上」），池里其余账号完好却永远轮不到。
- **改动（6 个文件，全部 capsule）**：
  1. override `src/minimax-adapter.ts`：新增「类别→动作」判据表（照 loomy / raccoon 逐格搬，
     **刻意不与它们对拍** —— 本家是 Anthropic Messages，协议不同源）；`stream()` 改为
     `send()` 闭包 + 请求级轮换（每号只试一次、上限 8、全试完带**最后一次**真实原因）；
     HTTP 200 + 流内错误帧同样纳入轮换，但**已产出内容后绝不重发**；401/403 先续期再换号
     并**重新反查账号 id**（防冷却记到无辜账号头上）。
  2. override `src/minimax-messages.ts`（新增）：流内错误帧**message 回退读顶层** + 带
     `type`/`code`。实测服务端**混用两种信封**（Anthropic 形状 与 自家信封
     `{"code":401,"message":"auth failed"}`），只认 `frame.error.message` 会让自家信封
     退化成「未知错误」⇒ 额度信息整段丢失 ⇒ 判 `other` ⇒ **换号静默失效**。
     另加响应原文样本 + 提前离开流时 **`cancel()`** 响应体（不能只 `releaseLock`）。
  3. override `src/account-probe.ts`（新增）：给探测分派链**加 minimax 分支** ——
     这是换号带出的**必需**配套（接上冷却后会写 `modelRateLimits`，而 `else` 兜底会把
     minimax 凭据交给华为云 HMAC 签名的 `CodeArtsAdapter`）。
  4. 两份 spec + `rebuild-vendor.sh` 登记。
- **两处**必须适配手机版形态**（上游与手机版不同源，不能整文件替换）**：
  - 手机版 `AccountPool.getAvailableAccount` **未泛型化**（上游 Phase 6 才加类型参数）
    ⇒ 轮换处按 loomy / raccoon 同款经 `unknown` 转换；
  - 手机版 `throwCurrent()` 有 9.15 的改进（`httpErrorCode(status, errorText)` 传**原始报文**）
    ⇒ 保留手机版，**不回退**成上游的 `status` 单参形态。
- **验证**：真 tsc 与改动前**错误集合逐字节一致**；行为探针 **33/33**（直驱真实导出：
  四条通道 + 8 条反向，含「`insufficient max_tokens` 不得判额度」「auth 绝不写冷却」）；
  真实上游 spec 影子运行 **minimax-adapter 61/61、minimax-messages 62/62**；
  **反向验证**：同一批 spec 跑改动前的树 ⇒ minimax-messages **恰好 4 条判别用例失败**、
  minimax-adapter **整份 import 失败**（新导出不存在 = 功能整体缺失）。
- **结果**：`3affe241` → **#45 全绿** → Release **`build-20261011-0728`**（versionCode **110**）。

**③ 连带发现并修复：loomy / raccoon 探测分派缺失（上游「第 5 次同型缺陷」）**

- **发现过程**：给 minimax 加探测分支时，机械核对「**谁会写 `modelRateLimits` ⇒ 谁就必须有
  分支**」，发现手机版 `probeWithAdapter` 是 **else-if 链 + else 兜底到 `CodeArtsAdapter`**，
  而 **loomy / raccoon 没有分支**。上游 2026-10-08 已把这一处记为「第 5 次同型缺陷」并修
  （在 `probeById` 登记这两家），**手机版从未移植该修复**（手机版仍是 else-if 链；
  上游后来改成查能力注册表，那属 Phase 6）。
- **实测确认（本机真跑，非推理）**：驱动真实 `retestAccount`，raccoon 账号带标记：
  - 改动前：`无法确认：codearts: no usable credential; log in first`，**请求 URL 为空**；
  - 改动后：请求发往 `https://xiaohuanxiong.com/api/web/llm/v2/chat/completions`，
    文案变成 `raccoon: code=401 …`。loomy 同款：`codearts: no usable credential`
    → `https://loomyad.xunfei.cn/api/v1/chat/completions`。
- **影响（方向不对称，故不属「顺手改」）**：**raccoon 是用户可见缺陷** —— 客户端
  `RATE_LIMIT_CAPABILITIES` **未**登记 `raccoon: {rateLimit:false}` ⇒ 按钮**会渲染**，
  而 raccoon 额度受限**每次都会**写 `modelRateLimits` ⇒ 点重测必然失败、标记**永远清不掉**
  （重测是唯一清除入口）。loomy 按钮被隐藏（登记了 `rateLimit:false`），但 RPC 仍可达
  ⇒ 属纵深防御，不能因此省掉分支。
- **改动（3 个文件）**：`account-probe.ts` 加两个分支（按手机版既有 else-if 形态，
  未动其它家、未改 else 语义）+ **新增** `tests/unit/probe-dispatch-guard.spec.ts`
  （三条**行为判据**守卫，断言请求发往**该家自己的 host** 且绝不发往华为云；
  刻意不用 `vi.mock` 构造记录 —— 它锁的是用户可观测的后果，且不依赖桩的接线正确性）
  + `rebuild-vendor.sh` 登记。
- **验证**：真 tsc 逐字节一致；CI 名单 8 个 spec 影子复跑 **202 passed / 0 failed**；
  **反向验证**：守卫 spec 跑改动前的树 ⇒ **3/3 全红**（`toBeGreaterThan: got 0, want > 0`
  —— 一个请求都没发出），改动后 3/3 绿。
- **结果**：`06a301cf` → **#46 全绿** → Release **`build-20261011-0746`**（versionCode **111**，
  CI `Test Files 9 passed (9)` / **`Tests 236 passed (236)`**）。

**⚠️ 本轮新增/变更的 override 基线（后续 sync 前必看）**

- **新增 4 个 override**：`src/openai-gateway/server.ts`（基线 = main 的 `3ff2f70e` 前版）、
  `src/minimax-messages.ts`、`src/account-probe.ts`（基线 = main 当前版）、
  以及 3 个 spec（`openai-gateway-server.spec.ts` / `minimax-adapter.spec.ts` /
  `minimax-messages.spec.ts` / `probe-dispatch-guard.spec.ts`）。
- **改动的既有 override**：`src/minimax-adapter.ts`（本轮从「手机版手术版」升到
  「上游新版 + 手机版手术」）、`src/account-probe.ts`（本轮两次改）。
- 全部 31 个 override 已做**基线漂移检查**（`drift-check2.mjs`）：差异全部来自我方有意改动。
  ⚠️ 其中 `src/minimax-adapter.ts` 本地 892 / 上游 447 行 —— 差值是「上游 Phase 6 的
  `createModelCatalog` 骨架尚未移植」（手机版仍是自带骨架版），**属有意差异**。

**⚠️ 本轮新踩的环境坑（后续轮次必读）**

1. **`patch` 命令在本机不可靠**：toybox 的 `patch` 对「多 hunk 上下文漂移」会**整份静默跳过**
   （`exit=1` 但**不留 `.rej`、文件一字未改**）—— 本轮因此空跑了两轮才察觉。
   ⇒ **凡是要把「上游新版」与「手机版手术」合并，一律用 node 脚本按**精确锚点字符串**
   逐块替换/拼接**（本轮 `work2.ts` / `work-messages.ts` / `work-probe*.ts` 都是这么做的），
   并在每步后 `grep -c` 核对标记数。
2. **影子 vitest shim 会制造假绿**（本轮连踩两次，代价是差点把结论写反）：
   - `toThrow()` 若忽略 matcher 参数 ⇒ 所有 `rejects.toThrow(/…/)` **无条件通过**；
   - `beforeEach()` 若是空实现 ⇒ 有状态 spec（`context-window-learn`）会**串状态**假失败。
   ⇒ **影子 shim 必须实现 matcher 语义**，且跑完要**用改动前的树做反向验证** ——
   只有「判别用例在旧树上失败、在新树上通过」才算证据。
3. **tsc 不会清旧产物**（9.16 已记，本轮又踩）：改源码后跑影子 spec 前必须 `rm -rf out`。
4. **`it.each` / `vi` / `toMatchObject` / `toContainEqual` / `rejects` / `resolves`**
   在 shim 里都要单独实现，否则 import 期就炸（不是断言失败，而是整份 spec 加载不了）。
5. 本机 **`/tmp` 不可写**（踩坑 8 的变体）：临时文件一律放
   `/data/data/com.dshphone/files/tmp/sliceG/`。

**⚠️ 本轮未做项（如实登记，非遗漏）**

- **上游 `jwoo1982217-eng/dsh-phone` 的 `85c62fdd`（0.1.63）本轮有意不合并**：
  它带一个**新功能**（peer/chat-files 大 JSON 上传），动到 `app/build.gradle`（versionCode
  65→66）、`NodeRunner.kt`（ASSET_VERSION 65→66）、`scripts/build-assets.py`（bundle 名单
  加 `chat-files`）。这三处与我们的「注入资源版本」步骤**同域**（构建时 sed 覆盖
  versionCode/ASSET_VERSION）⇒ 合并需重跑完整验证。而本仓库**已停自动同步、改为仅手动**
  （9.9），且当前 `ahead 1 / behind 86` 的比对因 fork 关系拿不到准确 ahead/behind
  ⇒ **建议由用户定夺是否手动 dispatch `sync-upstream`**（它是既有的正式通道，
  9.16 演练过「无更新即跳过」分支）。
- **中文超限措辞**仍待真实报文（本轮又确认：设备 108 的会话里仍无真实超限错误帧）。
- **Step B 已知边界**（图片视觉 token 预算被当成窗口上限，见文首待办）未动，仍需用户定口径。
- **Phase 6**（cline/account-pool/registry 化）默认不做。

---

### 9.18 轮次记录 · 2026-10-11 16:06–16:15（开工复核：上游无新素材，设备已装 111）

**用户指令**：「读 PORTING-GITEE-HANDOFF.md 文首『⚡ 新对话从这里读』，按里面的待办继续。」

**开工前复核（三项都查了，结论：上游无新素材；一项新发现）**
- **Gitee** `info/refs`（UA `git/2.40`）：master 仍 `5a61117f`（= 9.17 移植后的最新，无第三个新提交）；
  分支仍 `fix/IKKHL5-credits-self-heal`=`0523e74`、`issue/IKJOF7-benefit-diagnostics`=`16e246e6`（未并回）；
  PR 仍到 **#86**（head=`0523e74`，与 fix 分支同 sha），无 #87+ ⇒ **无新素材可移植**。
- **GitHub**：main `7091cb93`（#46 构建的 README 提交）；最近 4 次构建 #43–#46 全 success；
  最新 Release `build-20261011-0746`（versionCode 111）。上游 `jwoo1982217-eng/dsh-phone` main 仍
  `85c62fdd`（0.1.63）⇒ 9.17 登记的「上游合并待用户定夺」状态不变。
- **🆕 设备已装 111**：`dsh.version`=**111**、vendor `lib/` mtime **15:47**（此前文档记录是 108/14:15）
  ⇒ 用户已装 build-20261011-0746，**实机验收条件就绪**（验收结果待用户反馈）。
- **中文超限措辞重新取证（设备升级后全量重扫）**：46 个会话，改用「只收非转录失败帧」的
  收紧判据（按 JSON 帧类型排除 tool/* 与 reasoning 转录，避免把本轮对话自身当证据）⇒
  真实失败帧 **87 条**（cline OpenRouter / opencode QUOTA、MISSING_CREDENTIAL / buddy TIMEOUT /
  workbuddy TRANSPORT、PI_AI_ERROR 等），**超限措辞命中 0**（中英文均无）⇒ 既有结论
  「等真实报文再补中文判据，不要猜」**继续成立**。脚本：`tmp/scan-real-fail.mjs`（只读）。

**本轮改动**：仅文档——文首设备状态更新为 111；「中文超限措辞待补」条目下补 16:10 复核结论；
追加本节。**代码零改动**（无新素材；其余待办均为「需用户操作/定夺」项）。

**待办现状**（与文首一致，此处只列「谁能动」）：
- 可由用户推进：**实机验收**（文首第 1 条，设备已就绪 111）；上游 `85c62fdd` 是否手动 dispatch
  `sync-upstream` 合并；Step B 已知边界（图片视觉预算 vs 窗口上限）的口径定夺。
- 需等事件：中文超限措辞（等真实报文）；Phase 6（等实机稳定）。

---

### 9.19 轮次记录 · 2026-10-12 05:30–06:05（维护轮：审查 + 本地 checkout 清理 + apply.sh 防撞自检）

**用户指令**：审查本移植项目，随后「根据你的建议，能处理的都处理掉」。

**审查结论（全部实测）**
- vitest 显式名单（rebuild-vendor.sh 14 个）与 capsule 实际 spec **逐一致**，无「静默不跑」。
- capsule `build-apk.yml` 模板与远端 main **逐字节一致**（179 行）；`typecheck.yml`/`apply.sh`/`rebuild-vendor.sh` 远端均在。
- 全部脚本 token 已脱敏（`ghp_REDACTED_revoked`），`.scratch` 与散副本均无真 token。
- 本地 `sync-upstream.yml` 与远端**去注释后一致**（仅本地是旧注释版，无需回拉）。

**本轮改动（全部只动本地，未 push 远端）**

1. **本地 checkout 清理（逐 blob sha 比对远端 main 3032 blobs 后定性）**：
   - 删除 `data.tar.xz`（10.3MB）：实测与 Termux nodejs `26.4.0-1_aarch64.deb` 内的
     `data.tar.xz` 段**逐字节一致** = `prepare-node-android.py` 解 deb 的中间产物残留，
     公开包内容、无敏感数据，可随时重新生成。
   - 11 个散副本（`upload.mjs`/`deploy2|3.mjs`/`capsule-deploy.mjs`/`apk-link*.py`/
     `prepare-node-android.py`/`patch-check.mjs`/旧 `build-apk.yml`/旧 `sync-upstream.yml`/
     旧 `README.current.md`）与 `.scratch-test/` **移入** `.scratch/archive-20261012/`，
     均为部署期一次性产物（远端无同名文件）。
   - `README.current.md` 以远端 main 现版刷新（下载链接 `build-20261011-1257`）。
   - ⚠️ 方向教训：**不能拿 mtime 判断本地/远端谁新**——trees API 推送不更新本地 mtime，
     本轮 capsule README 一度误判为「远端更新」。
2. **`apply.sh` 新增 2.5 步「files/ 与 overrides/ 防撞自检」**（P2-3 落地）：
   `comm -12` 求两目录同路径交集，非空即 `::error::` + exit 1（overrides 会静默遮蔽 files/）。
   沙盒实测三态：冲突路径 exit 1 ✅ / 正常路径 exit 0 ✅ / 真实仓库回归 exit 0 ✅。
3. **文档零冲突**：本节即全部文档改动。

**⚠️ 遗留项（需 push 远端才能生效，本机无法直接推）**
- `apply.sh` 的防撞自检与 capsule `README.md`（本地 10-11 版仍写着「每日自动同步」的
  旧话术已被本地更新，但**远端 main 还是 10-10 旧版**）——两处需随下一次部署脚本
  （trees API 三件套，`.scratch/port-gitee/` 有现成模板）或手动 sync 一起推上 main。
  推送前跑一次基线漂移检查确认无新增差异。

> ✅ **9.19 遗留已清**：`apply.sh` 防撞自检 + capsule README 已于 2026-10-12 06:10 推送
> 远端 main（提交 `b025643b`，typecheck 快环 success）。下面 9.20 是同一个上午的第二轮。

---

### 9.20 轮次记录 · 2026-10-12 06:30–07:20（上游 10 提交一次性移植 + CI 全绿）

**用户指令**：「上游又出了 9 次新提交」→「一把梭哈」（要求一轮做完）。

**开工核实（实测）**：Gitee master `93d20230` → **`1cd01ba2`**，实际是 **10 个提交 / 50 文件**
（用户记 9 个）：`c2546558` codearts 额度文案不被客户端替换（IKJVCW）、
`0840ae0c` **会话命名静默失败**（IKKVDH，14 适配器）、`ac79ed46`+`392e4bbd` lobsterai 余额判据收紧、
`173769dc`+`8e5e39e6` qoder wasm 泄漏致 `unreachable` + dispose 吞错、
`c3d9e9cc`+`c411fa80` abort 499 判据（aggregate/auto/raccoon 三处同构）、
`8f71268f` 图片字节上限 5 处漏赋（IKKX0T）、`1cd01ba2` 模型开关静默空操作留痕（IKJW33）。

**方法（本轮新踩即改正的两处）**
- **行尾符陷阱**：上游旧基线 `cline-adapter.ts` 是 **CRLF**、新版是 LF ⇒ 逐行对比得出
  「+994/−1092」的假差异（真差异只有 session-title 接线 17 行）。**对比前一律
  `\r\n → \n` 归一化**，否则整个文件的 hunk 会全部定位失败。
- **patch 应用引擎**：本轮写了临时工具 `apply-patch.mjs`（unified-diff hunk 解析 +
  上下文容差定位）与 `port-run2.mjs`（按提交拓扑序批量应用）。它有判别性（任一 hunk
  定位失败则整体不写盘），但**只适用于上下文接近的文件**；手机版与上游行数差
  200–500 行时仍需逐处锚点手术（本轮 12 家 session-title 全走锚点手术）。

**改动（29 个 capsule 文件，main 上游文件一行未动）**
- **新增 12**：`files/src/session-title.ts`（全新增）+ **11 个 override**：
  `buddy-adapter.ts`、`gemini-adapter.ts`（两家是 main 纯镜像，本轮首次 override 化）、
  以及 9 个「上游新版 = 覆盖 main 镜像」的**零手术 override**
  （`cline-product`/`image-budget`/`lobsterai-credits`/`lobsterai-product`/`lobsterai`/
  `qoder-product`/`qoder-wasm`/`trae-product`）。
  ⚠️ **落位判据本轮明确写进 capsule/README.md**：main 的 vendor 镜像已有该文件 ⇒ `overrides/`
  （纳入基线漂移检查）；main 完全没有 ⇒ `files/`。最初把 9 个镜像覆盖文件放进 `files/`，
  已按此判据改正。
- **修改 17**：15 个适配器做 session-title 接线（12 家含 `off`/`none` 档者关思考、关不掉的抬预算）；
  `aggregate-adapter` 的 `isAbortLike` 升级为**四判据**并把三处内联判断收敛过去；
  `auto-adapter` 两处同构；`raccoon-adapter` 新增 `abortLikeOrNormal`（保留手机版
  `httpErrorCode(status, errorText)` 双参形态）；
  `qoder-adapter` 的 `buildRequest` 包 `try/finally + describeWasmFailure` 且 dispose 失败**不上抛**；
  `llm-adapter` 新增 `CODEARTS_QUOTA_EXHAUSTED_CODE = 'QUOTA_EXCEEDED'`（三处产出点）+
  `errorDetail` 加顶层字符串 `error` 腿；`trae-adapter` 新增 `streamErrorCode`（4006 → 溢出，不重试）
  + 抬预算排在 Max 覆盖之后；`index.ts` 给 zcode 显式传 `imageMaxBytes`；
  `jet-hub-rpc.ts` +187 行（`CATALOG_READ_TIMEOUT_MS`/`withTimeout`/`readableCatalogIds`/
  `catalogWarnings` 与两个开关端点接线）；`types.ts` 加 `warnings?`；`jet-hub.js` 加
  `toggleWarnings` 状态与渲染。

**验证（全部真跑）**
- **真 tsc（忠实构建树）**：`main 全量 src + 全部 capsule + 设备 TS 5.9.3`，错误集合与
  **改动前逐字节一致**（唯一 `qoder-wasm.ts` 那条 TS2345 是设备 TS 版本差异的既有报错，
  行号由 474 → 643 因该文件换新版而位移）⇒ **零新增类型错误**。
- **反向验证**：从树里移除 `session-title.ts` ⇒ **12 处引用报错**（证明接线真实、类型检查有判别性）。
- **行为探针 9/9**：非标题请求逐字节不变（含 `compaction` 不处置）；有 `off`/`none` 档则关且
  **不抬预算**；关不掉才抬到 512 且**不变小**；`disableByOmission`（buddy deepseek 系裸请求）；
  `NaN`/`undefined` 原样返回（不编造）。
- **源码文本断言 42 条全部命中**（capsule spec 大量用源码断言，这是最易被打破的面）。
- **spec 名单 14/14 一致**（`rebuild-vendor.sh` 与实际）。
- **CI**：
  - 首轮 **typecheck 失败（481 passed / 1 failed）** —— 唯一红是 capsule 自己的
    `llm-adapter-context-overflow.spec.ts` 断言旧码 `'QUOTA'`，而本移植**有意**改成
    `'QUOTA_EXCEEDED'`（IKJVCW 的全部意义）。⇒ **这是「CI 抓到我方 spec 未同步」，
    不是回归**；已同步 spec（注释写明理由）并复跑。
  - 复跑 **typecheck success**：`Test Files 14 passed (14)` / **`Tests 482 passed (482)`**，
    `tsc -p tsconfig.json` 通过，`lib/index.js`(147145 B) 与 `lib/client/jet-hub.js`(575586 B) 产出。
  - **完整构建 success**：Release **`build-20261011-2312`**，`versionCode 118` 与
    `ASSET_VERSION="118"` 同步注入（基线 65 + run 53），APK sha256 `a84ed907…5961a37`。
- **产物核对**：本地 **77 个 capsule 文件与远端 main 逐 blob sha 全部一致**。

**⚠️ 遗留项（需用户操作）**
- **实机验收新包 `build-20261011-2312`（versionCode 118）**，重点看：
  ① **DSH 会自动起会话标题了**（IKKVDH，此前静默失败）；
  ② codearts 额度用尽时能看到**带解禁时间的原文**（不再是「当前请求的额度已用尽」）；
  ③ 关闭已下架模型时出现**中性色提示**（「不在当前模型目录…」）；
  ④ qoder 长会话不再随机 `unreachable`。
- 上游 spec 未整体移植（其断言基于上游实现细节，与手机版形态不同）；本轮只同步了
  capsule 自己的 spec。

---

### 9.21 轮次记录 · 2026-10-12 07:20–08:10（聚合窗口机制修复 A/B/C/D/F —— 用户实测报障）

**用户报障**：「自动聚合模型上下文给 1M，派给低上下文模型会触发 token 上限错误。我记得
做过『自动降低上限并压缩』，为什么完全没实现？」→ 澄清「失败就在本对话、就是两次『继续』」。

**取证（全部实测，非推测）**
- 本会话日志：`request/context: {"provider":"aggregate","model":"auto","contextWindow":1048576}`
  （05:30:23）；`turn/end {"turn":4,"reason":{"kind":"max-tokens"}}`（06:34:24）、turn 5 同
  （06:39:36，**13 秒**）。会话规模 `usage.totalTokens` 峰值 **208,711**。
- turn 4：121 步 / 120 次工具调用、正文合计仅 54 字符 ⇒ 收场是**输出预算耗尽**；
  turn 5：1 步、**零输出**即 `max-tokens` ⇒ 与「总量天花板已到」吻合。
- 近 30 小时全部会话真实失败帧 9 条（TRANSPORT×6 / UNKNOWN×2 / REASONING_LOOP×1），
  **超限帧 0** ⇒ 既有学习器（只挂失败路径）**一条信号都收不到**。
- 代码：聚合层 `widest ?? dynamicContextWindowFor(...)` —— 只要有任一候选声明窗口，
  学习值**永不生效**（本次 1048576 ≠ 动态起步值 1000000，证明确走 `widest`）；
  而 zcode 侧是 `learned < declared → learned`（**两处判据不一致**）；
  聚合 `resolveModel` 全文 `maxTokens` 出现 **0 次** ⇒ 输出预算完全交给上游默认。
- 既有线索印证：`auto-adapter.spec.ts` 早已记录同型缺陷（「spark-x 虚报 1M、真实 256K ⇒
  收下请求但 0 输出 + finish_reason=length ⇒ 报 max-tokens，DSH 不重试」），且
  `jet-hub-auto` 已接线 `zero-output-guard`，而**聚合层从未接线**（守卫模块头却
  把它列为调用方之一）。

**改动（5 项，全部在 capsule）**
| 项 | 内容 |
|---|---|
| A | `applyLearnedWindow`：学习值可**收窄**声明值（与 zcode 同构）；`contextWindowCache` 改存**纯声明值** `widest`（收窄值不固化 ⇒ 后来学到的更小值立刻生效） |
| B | `finish: max-tokens` 也算证据：用当轮观测规模记上限（新增 `rememberContextWindowCeiling`，只收窄/不放大/低于 32K 不记），同时记虚拟模型与**该候选** |
| C | 派发前按本轮体积（最近观测 ×1.05）**跳过太窄候选**；学习值优先于声明值；未知不筛；全被筛掉时**放弃筛选** |
| D | loomy `spark-x` 声明值 1_048_576 → **262_144**（Loomy 客户端自己的口径；触发条件「实测长上下文被拒」已满足） |
| F | 聚合层接线 `zero-output-guard`：**零输出 + max-tokens ⇒ 换下一个候选重发**（已吐内容/已开块则如实透出；末位候选如实上报）；冷却表用共享判据，派发前跳过冷却目标 |

**验证**
- 真 tsc（faithful 树）：错误集合与改动前**逐字节一致**（仅既有 `qoder-wasm` 那条）。
- 行为探针 **16/16**（新增：截断学习只收窄、更大观测不放大、低于下限不记、键隔离、
  报文真值回归、`dynamicContextWindowFor` 用学习值）。**反向验证**：基线模块
  **无** `rememberContextWindowCeiling` 导出 ⇒ 探针有判别性。
- **CI 首轮红 1 条**：`active-route.spec.ts` 的源码断言钉着旧循环头 `targets.length`，
  而 C 已改成 `attemptTargets.length`（**HANDOFF 9.5 记录过的同型坑**）⇒ 已同步 spec。
- 复跑 **typecheck success**：`Tests 491 passed (491)`（含 `context-window-learn.spec.ts`
  25 条：新增截断学习/收窄/筛选/零输出改道共 25-16=9 条）。
- **完整构建 success**：Release **`build-20261011-2337`**，versionCode **120**，
  APK sha256 `c70a826d…`。
- 本地 77 个 capsule 文件与远端 **逐 blob 一致**。

**⚠️ 留给下次的口径（未做，需用户定夺）**
- 聚合 `auto` 仍未声明 `defaultMaxTokens`（输出预算交给上游）；若要「聚合层也管输出上限」，
  需先定「取候选最小值还是最大值」——直接声明会改变输出语义，本轮**不擅自改**。
- A 让「学习值收窄声明值」生效，代价是**宽窗口候选的能力被让掉**（更早压缩）；
  若实测觉得压缩过早，可改为「只对撞过墙的那个候选收窄」（本轮已同时记候选级，改起来是接线问题）。

---

### 9.22 设想（用户 2026-10-12 提出；**P0 已实现**，见本节末「实现记录」）

**用户设想（原话意思）**：「我可以以后有时间把这些聚合模型、所有调用的模型，每个都给
**提前分配好它能使用的上限**、设定好。以后切换，它自动就知道了，不用等服务器上报。」

**为什么这条比现有的学习机制好**：把顺序从「出了事再学」（后验）变成「一开始就知道」（先验）：
① 不浪费请求（不必先撞一次墙）；② **重启不丢**（现行学习表只在内存，重启即忘）；
③ 不依赖上游报不报错 —— 9.21 的取证正说明「上游不报错、只截断」时学习器收不到信号。

**接入方式（优先级三层）**：
```
手动设定上限  >  撞墙/截断学到的（context-window-learn）  >  上游自己声明的
```

**⚠️ 关键结论：这一层**不必改架构**就能拿到大部分收益。**
方案 C（9.21）在派发前已按「该候选已知能装多少」筛候选，查询顺序是
`learnedContextWindow(...) ?? candidateWindow(...)`。把手动表插到该查询最前面即可：
会话超过某模型的手动上限 ⇒ **该模型自动被跳过**、派给装得下的候选 ⇒ 用户要的
「切换时自动知道」在**筛选层**就实现了，无需动「报窗口」的时序。

**但两件事互不替代**：手动表解决「这轮该选谁」；「**所有候选都装不下**时主动让 DSH 压缩」
（9.21 结论里的第 2 步）仍缺 —— 现在的兜底是「照常去试」，会落成静默截断。

**实现要点（做的时候逐条对照）**
1. **两张数**：每家模型要填**输入上限**（上下文）与**单轮输出上限**（max output）；
   后者顺手解决 9.21 遗留的「聚合 auto 不声明 defaultMaxTokens」问题。
2. **入口**：设置页可编辑表 / JSON 配置；必须能保存且**重启后仍在**（不能像学习表那样只在内存）。
3. **填错的后果不对称**：填大 → 仍会撞墙（由学习值/报错兜底）；填小 → 只是提前压缩，不致命。
   ⇒ UI 提示「填小安全、填大危险」。
4. **键的粒度**：`渠道 + 模型名`（与现行的 `contextWindowKey(provider, model)` 一致）；
   同一模型多账号不分开填。
5. **不与声明打架**：以手动值优先，但真撞墙/截断时**照常记学习并打日志提示
   「该手动值可能偏大」**，**不得静默改用户的值**。

**与 9.21 的关系**：9.21 已落地 A/B/C/D/F（学习值可收窄、截断可学、按体积筛候选、
spark-x 口径修正、零输出改道）。本条是它的**升级路径**，不是补丁。

---

### 9.22 实现记录 · P0（2026-10-12 08:28–08:45，**未推送、未构建**）

**用户口径**：「这些技术决定我看不懂，只希望优先实用性 —— 让聚合模型**完全发挥能力**，
且**不要我太多手动操作**。」⇒ 本轮据此重排优先级：**先修「自动筛选」不生效的真缺陷**
（零手动、直接提升能力），手动填表降为可选、后置。

**取证：方案 C（9.21 的候选筛选）与派发索引脱钩（真实缺陷）**
- `aggregate-adapter.ts` 筛选后把 `attemptTargets = kept`，但派发循环取元素仍是
  `const target = targets[index]!`（全文件**没有** `attemptTargets[index]`）。
  而 `kept` 是**子集而非前缀** ⇒ 窄候选排在前面时，**刚被判「装不下」的候选被重新派出去**，
  真正装得下的候选永远轮不到 —— 恰好在最需要筛选的场景里筛了个空。
- 同型第二处（日志级）：失败切换日志的判据用 `targets.length`，尾部候选被筛掉时会
  谎报「切换下一个候选」，而下一轮循环已结束。
- **为什么 9.21 没抓到**：方案 C 只有**源码文本**断言
  （`context-window-learn.spec.ts` 断「声明行 + 循环头存在」）——文本写对了、索引取错了
  它照样绿。这是 HANDOFF 9.5 记过的「源码断言钉写法」同型坑。

**改动（3 处，全在 `capsule/overrides/.../aggregate-adapter.ts`）**
| 项 | 内容 |
|---|---|
| P0-a | 派发索引 `targets[index]` → **`attemptTargets[index]`**（筛选结果即真实尝试范围） |
| P0-b | 失败切换日志判据 `targets.length` → **`attemptTargets.length`** |
| P0-c | **全被体积筛掉** ⇒ 不再「放弃筛选、照常硬发」，改为主动抛 `CONTEXT_WINDOW_EXCEEDED`，交给 DSH 的压缩链压缩后重发（9.22 要点 5）。⚠️ 与**零输出冷却**（瞬时针，不构成「装不下」的证据）**分开计**：只有冷却导致的「一个不剩」才照常尝试，不误报超限 |

**验证（本机无 pnpm/vitest，用设备树自带 typescript 5.9.3，9.21 同法）**
- **真 tsc**：`faithful3`（基线 gh 树）与 `faithful4`（应用后树）跑 `tsc -p tsconfig.json
  --noEmit` ⇒ 两份错误输出**逐字节一致**（唯一那条 `qoder-wasm.ts(643,43)` 是既有报错）。
- **行为探针 4/4 通过**（`.scratch/probe-922.mjs`，把树 `tsc --outDir probe-out` 编译成 JS
  后直接驱动 `prepareCall → call.stream`）：①窄候选排前时只发装得下的那个；②保留批次内
  失败切到**下一个被保留**的候选；③全部装不下 ⇒ 抛 `CONTEXT_WINDOW_EXCEEDED` 且**零发送**；
  ④全在冷却中 ⇒ 不误报超限、照常尝试。
- **反向验证（判别性）**：同一探针跑**基线树** ⇒ ①②③ **全部失败**（实际派发
  `buddy/m-shared` 这个装不下的窄候选）⇒ 探针确实能区分「修好了」与「碰巧对」。
- **CI 行为断言已补**：`aggregate-adapter.spec.ts` 新增 describe「方案 C：筛选结果与派发
  索引一致（行为）」（3 条，含 ②③）——补上 9.21 只有源码断言的空缺。
  ⚠️ 该 spec **已在** `rebuild-vendor.sh` 的名单里（未新增文件，避免「新增 spec 未登记」坑）。

**本轮发现的既有限制（未修，留待定夺）**
- **冷启动首请求时方案 C 静默不生效**：`prepareCall` 早于目录就绪时 `this.catalog` 为空 ⇒
  `contextWindowFor(aggregateCandidatePool())` 的候选池为空 ⇒ `candidateWindow` 拿不到任何值
  ⇒ 筛选条件恒不成立。真实链路里 GUI 通常已先 `listModels`，故只影响开机后**第一个**请求。
  （探针即因此先 `listModels` 预热才测到筛选。）

**P1 已实现 · 自动学到的上限落盘（2026-10-12 08:50–09:10，零手动、重启不丢）**

采纳用户口径「**不要我太多手动操作**」⇒ **不做**手动填表，改为把**自动学到的**值落盘。
这**推翻了 9.11「只记进程内」的决定**（该决定防的是「把学错的值永久固化」），
用三道安全阀替代它：

| 安全阀 | 内容 |
|---|---|
| 只落硬证据 | ①上游报文里读出的真实上限；②截断/超限时的实测规模。「读不出 ⇒ 减半猜」的值**仍只留内存**（`rememberContextWindowFailure` 的回落分支不落盘） |
| 自愈 | `noteContextWindowSuccess`：**整轮正常结束**后用**当轮**实测规模把偏小的值放宽 —— 该值必然 ≤ 真实上限 ⇒ 不会「填大」（用户口径「填小安全、填大危险」） |
| 取更小 | 挂载 hydrate 时与内存已有值取**更小**的那个（更早压缩 = 安全方向） |

- 新文档 `context-windows.json`（**独立于** `state.json`，与账本/永久锁同因：防被旧代码整体重写抹掉）。
- 接线与账本同址、同纪律（令牌判据的 disposer，防 fiber 重启交错误摘；dispose 前 `flush`）。
- ⚠️ `noteContextWindowSuccess` **不得**喂「历次观测峰值」（`lastContextTokens` 那种跨轮累积值）：
  它可能来自窗口**宽得多**的候选，拿它放宽窄候选就是填大 ⇒ 故 `dispatch` 里另记**本次尝试**的
  `turnTokens`（`usage.totalTokens`），且只在流正常结束时使用。

**验证（P1）**
- **真 tsc**：faithful4（应用后）与 faithful3（基线）错误输出**逐字节一致**（仍只有既有的
  `qoder-wasm.ts(643,43)`）。
- **持久化探针 7/7 通过**（`.scratch/probe-922-persist.mjs`，跑**真文件**：
  `DSH_JET_HUB_STATE_DIR` 指向 `mkdtempSync` 临时目录）⇒ ①只落硬证据（减半猜不落盘）
  ②盘上确实生成 `context-windows.json` ③重启读回 ④自愈放宽并落盘 ⑤自愈只放大不缩小
  ⑥hydrate 取更小 ⑦disposer 只摘自己。
- **行为探针回归 4/4 通过**（P0 那四条未被本轮改动破坏）。
- **CI 断言已补**：`context-window-learn.spec.ts` 新增 describe「已学窗口持久化（9.22）」
  （5 条，含**真文件** round-trip 并恢复 `DSH_JET_HUB_STATE_DIR`）。该 spec 已在
  `rebuild-vendor.sh` 名单里（未新增文件，避免「新 spec 未登记即静默不跑」）。

**已推送并出包（2026-10-12 08:56 北京时间）**
- 本机**没有 git**（`git: command not found`）⇒ 改用 GitHub REST API（Git Data API）按文件提交。
  ⚠️ **只提交 8 个 capsule 文件**：本机 `dsh-phone-gh/` **不是**远端 main 的完整快照
  （缺 `build-apk.yml` / `sync-upstream.yml`），整目录覆盖会删掉远端文件；Git Data API 的
  `base_tree` 正好保证「只动这几个路径」。
- 推送前做了**只读基线核对**：远端 main head = `22505b79`，八个文件逐个与本地比对，
  差异**全部**出自本轮改动（`apply.sh`/`README.md` 的 diff 仅含新增自检与模块计数）。
- commit：**`fea0f041`** `fix(capsule): 9.22 候选筛选索引错配 + 全装不下主动压缩 + 已学窗口落盘`
  （parent = `22505b79`）。
- **CI 全绿**：`typecheck` **#7 success**（vitest 含本轮新增的行为断言 + tsc + esbuild）、
  `build-apk` **#56 success** ⇒ Release **`build-20261012-0056`**
  （`app-debug.apk` 135.4MB，2026-10-12T00:58:30Z 发布）。
  下载：`https://github.com/zhaolongwudi/dsh-phone/releases/download/build-20261012-0056/app-debug.apk`
  构建成功后 workflow 自动推了 `5bb03152`（更新 README 下载链接），故 main head 已是它
  —— 验证 CI 结论时要认准 `5bb03152` 的 **parent 是 `fea0f041`**，两者同一棵树。
- ⚠️ **实机验收仍待用户**：装上该包后重点看 ①是否还会出现回答被上游**截断**；
  ②杀掉 DSH 重开后，此前撞过墙的模型是否**不再重新撞一次**（持久化生效的直接证据）。

**修正轮 · 换回宽候选时上限恢复（2026-10-12 09:15–09:30，用户实测提问）**

**用户提问（原话意思）**：用 100 万窗口的模型 → 自动聚合因无积分切到 256K 的候选 →
再切回 100 万的模型时，「上下文**会不会从 256,000 恢复到 100 万**？」

**取证（代码链 + 探针复现）**
- 聚合对外只报**一个**窗口，DSH 压缩阈值 = 它 × 0.8（多处注释同口径）。
- 该值原为 `widest`（候选最大值）**再经 `applyLearnedWindow` 收窄**；而学习值是按
  **虚拟模型**记的（失败超限 1652 / 截断 1762 **两处都记虚拟键**，后者同时还记候选键）。
- ⇒ 一个窄候选撞墙 ⇒ 整个虚拟模型的对外声明被**粘性压低** ⇒ 之后换回宽候选
  **也不恢复**（`learned < declared` 恒成立）。
- **自愈救不了它**：自愈条件是「当轮实测规模 > 已学值」，而声明被压低后压缩阈值同步
  变低 ⇒ 会话长不到该值以上就被压缩 ⇒ 条件几乎永不成立。**持久化又让重启也不恢复**
  （原先重启会清空学习值）。
- **探针复现**：往学习表塞一个虚拟模型级的 100000、池里有 1M 候选 ⇒ **基线树返回
  100000**（正是用户描述的现象），修正后返回 **1000000**。

**改动（3 个文件）**
| 项 | 内容 |
|---|---|
| 删 `applyLearnedWindow` | 学习值**不再收窄**虚拟模型的对外声明。该层保护本就**多余**：虚拟声明取候选**最大值** ⇒ 池整体窄时它自然就窄、压缩自然早发生；真正需要「这个候选装不下」的只有**筛选**（方案 C），它读的是**候选键** |
| 两处学习只记候选键 | 失败超限（`rememberContextWindowFailure`）与截断（`rememberContextWindowCeiling`）都改为 `contextWindowKey(target.provider, target.realId)`；成功自愈同样只作用于候选键 |
| 记忆化分支 | `return remembered`（缓存里存的就是对外值） |

**验证**
- **真 tsc**：与基线错误输出**逐字节一致**（仍只有既有的 `qoder-wasm.ts(643,43)`）。
- **行为探针 5/5**（新增第 5 条「换回宽候选 ⇒ 声明恢复」）：基线树该条**失败**
  （返回 100000）⇒ 判别性成立；另四条（P0 的筛选/切换/压缩/冷却）无回归。
- **持久化探针 7/7** 无回归。
- **CI**：`typecheck` **#8 success**（head 即本 commit `1c75c57b` —— 我改的三条源码断言
  与新增行为用例都真跑了）；`build-apk` **#57 success** ⇒ Release
  **`build-20261012-0125`**（`app-debug.apk` 135.4MB，2026-10-12T01:27:26Z）。
  下载：`https://github.com/zhaolongwudi/dsh-phone/releases/download/build-20261012-0125/app-debug.apk`
- ⚠️ 未变动的 5 个文件 blob sha 与上一轮**完全相同**（推送前逐文件核对过），
  说明本轮确实只动了那 3 个文件。

**仍未做（需后续定夺）**
- 手动设定表（9.22 要点 1/3/4）**有意不做**：与「少手动」口径相反。若日后仍想要手动覆盖，
  它只是**可选覆盖层**，插在 `learnedContextWindow(...)` 之前即可（见 9.22 设想的接入点）。
- 冷启动首请求筛选不生效（见上「本轮发现的既有限制」）：未修。
- 旧持久化文档里可能残留的**虚拟模型键**值不再影响对外声明（已删该收窄），但仍会经
  `dynamicContextWindowFor` 影响「候选全无声明」时的兜底起步值 —— 方向保守（更早压缩），
  未处理。

---

### 9.23 轮次记录 · 2026-10-12 15:20–17:35（上游 11 提交移植 + 推送 + CI 全绿）

**用户指令**：「项目上游又多了很多新提交，可以移植进来」。

**开工核实（实测，上游确有新素材）**
- **Gitee master 前进**：`1cd01ba2`（9.20 的移植点）→ **`d14636e6`**，共 **11 个提交 / 25 个文件**。
  PR 也到 **#88**（`refs/pull/88/head` = `bea8a1bd`；#87 = `c411fa80` 已含于 master）。
  ⚠️ `refs/pull/N/MERGE` 存在 ≠ 已合并，仍以内容 sha1 为准（本轮 #87/#88 的内容都已在 master）。
- 逐提交（`compare/1cd01ba2...d14636e6`）：
  | 提交 | 内容 |
  |---|---|
  | `224bdfa0` | 「关闭全部/关闭供应商」不再只写兜底子集黑名单（IKJW33 相邻） |
  | `1731f5f2` | buddy 腾讯风控指纹改写补上 **assistant 正文**与 **DSH 直连路径** |
  | `c6e9da77` | buddy：wire 首条为 assistant 时补最小 system（修 space-bunny 的 11148） |
  | `c41ef3d2` | buddy 审计修两处真缺陷 + 凭据入库 |
  | `0523e74c` | 积分操作按需自愈续期 + gemini 续期补超时（IKKHL5） |
  | `6c259e9f` | 客户端：自愈后补读账号列表，消除卡片红字残留 |
  | `03044394` | 积分审计后修 3 处真缺陷 + 补 4 类零守卫 |
  | `95bf01b4` | docs(image)：订正「100001 哨兵」「617 px/token 外推」两条失实论证 |
  | `d14636e6` | !86 合并提交（= 上述 IKKHL5 系列落地 master） |
  | `8dc88c03`/`a3303e76` | 两个 merge 提交（无独立内容） |
- **本机设备仍是 `dsh.version`=111**（vendor `lib/` mtime 15:47 = build-20261011-0746）
  ⇒ 9.20/9.21/9.22 的包都**未在本机装过**；实机验收仍待用户。
- **GitHub**：main head `45545c1a`（9.22 的 README 提交）；最新 Release `build-20261012-0125`（120）。
- ⚠️ **9.22 记录里的部署 token 已失效**（实测 `401 Bad credentials`）；本轮改用用户新给的
  token 推送（**仍在对话里暴露，收尾后应撤销换新**——这是第二次提醒）。

**改动（13 个 capsule 文件；main 的上游文件一行未动）**

1. **零手术直接覆盖（4 个 override）**：
   - `image-budget.ts`（+42/−1）—— 探针外推订正；本文件在手机版是**纯镜像**（与 Gitee
     `1cd01ba2` 逐字节相同）⇒ 直接取新版。
   - `gemini-auth.ts`（+26/−2）—— 两处 `AbortSignal.timeout(GEMINI_OAUTH_TIMEOUT_MS)`。
     ⚠️ 这是**真缺陷**：`fetchGeminiUserInfo` / `refreshGeminiCredential` 只在
     `options.signal !== undefined` 时才设 signal，不传则那次 fetch **完全没有超时**，
     实测要等 undici 默认 `headersTimeout` **305 秒**；而本轮自愈把续期搬到了
     「用户点一下就等」的积分主路径上。
   - `openai-gateway/tencent-fingerprint.ts`（+82/−34）—— 新增 assistant 位置的实测行。
   - `buddy-growth.ts`（+9，纯注释）—— 「本文件是第三条直连腾讯端点的旁路、不过改写」
     的安全路标；值一个纯镜像 override（防将来改坏）。
2. **锚点手术（5 个）**：
   - `buddy-adapter.ts`（5 处）：指纹改写 import；`LEADING_SYSTEM_PLACEHOLDER` +
     `serializeMessages(..., provider)` 签名；assistant 正文改写；system 消息改写；
     调用点传 provider + `options.system` 改写 + **wire 首条 system 兜底**（判据
     `!== 'system'`，不是 `=== 'assistant'`）。
   - `openai-gateway/{messages,responses}.ts`：各加 assistant 正文改写。
     ⚠️⚠️ **不能整文件覆盖 Gitee 版**（这是本轮 tsc 抓到的真问题，见下）。
   - `jet-hub-rpc.ts`（9 处）：IKKHL5 自愈核心块（`SELF_HEAL_REFRESHABLE_PROVIDERS` /
     `balanceHealInFlight` / `refreshAccountByProvider` / `healExpiredAccountBeforeBalance` /
     `SELF_HEAL_ROUND_BUDGET_MS` / `healExpiredAccounts`）+ `FullCatalogResult` 并集重构 +
     四个调用点（`account.test` 尽力而为 / `setAllDisabled` 与 `setEnabled` 必须完整 /
     `provider.status` 的 `closed` 核实）+ `readableCatalogIds` 收敛到同一处目录来源 +
     `credits.balances` / `credits.claimAll` 两端点入口接线。
   - `jet-hub.js`（3 处）：`reloadAccountsQuietly`（不切 phase 的静默重读）+
     `loadCredits` 成功后**无条件**补读 + deps 加 `reloadAccountsQuietly`。
3. **新增 spec + 登记**：`rpc-catalog-heal.spec.ts`（**16 条行为用例**，真跑端点，
   按 `auto-badge-rpc.spec.ts` 的既有模式装配真实 `AccountPool` + `registerJetHubRpc`）+
   `rebuild-vendor.sh` 名单 **14 → 15** + `apply.sh` 两条新接线自检 + capsule README 计数
   （44 → 49 override / 28 → 30 files / 14 → 15 spec）。

**⚠️ 手机版适配点（上游与手机版不同源，不能整文件替换）**
- **网关两文件**：Gitee 新版依赖**更新的 dsh-llm 类型** —— `'plugin'` source kind、
  `'tool-result'` block、可变 `Message['content']`。整文件覆盖后 tsc 立刻报 **11 条**
  类型错（`Property 'push' does not exist on type 'readonly ContentBlock[]'` 等）
  ⇒ **已改为「手机版镜像 + 只移植 assistant 改写这一处增量」**。
  这是本轮最重要的方法教训：**「上游新文件 = 可直接覆盖」只对纯镜像文件成立**。
- **自愈分派**：上游走 `authOf(auths, provider)` 查表（Phase 6 的 provider 抽象重构），
  手机版没有 ⇒ 改为**直接复用 `account.refresh` 端点那份 switch 的同一批实例**写
  `refreshAccountByProvider`（不新建平行表 —— 那正是仓库反复踩的「两套同义判据必先腐坏一套」）。
- **`account.test` 的完整度要求**：上游注释强调它与两个关闭方向**刻意不同**
  （尽力而为 ≠ 必须完整），已照搬该语义与注释。

**验证（全部本机真跑）**
- **真 tsc（忠实构建树）**：`main 全量 src + 全部 capsule`，与改动前的基线树
  **错误集合逐字节一致**（唯一 `qoder-wasm.ts(643,43)` 是设备 TS 5.9.3 的既有差异）。
  ⚠️ 本轮它**抓到了真问题**（网关整文件覆盖的 11 条类型错）—— 这就是「上游自己从不跑
  tsc」的价值所在，别跳过这一步。
- **行为探针 49/49 通过**（把树 `tsc --outDir probe-out` 编译成 JS 后**直驱真实导出与真实端点**）：
  - 指纹改写 9 条（非腾讯系逐字节不变 / buddy+workbuddy 命中 / 大小写不敏感 /
    无指纹文本逐字符不变 / 混合文本只改指纹 / 幂等 / provider 判据）；
  - buddy 直连 7 条（assistant 与 `options.system` 两个产出点被改写、**user 原样**、
    非腾讯系原样、wire 首条补 system、已有 system 不重复插）；
  - gateway 两路径 5 条（chat / responses 的 assistant 改写 + user 与非腾讯系反向）；
  - `fullCatalogIds` 三态 9 条（并集 / 远端失败拒绝不落盘 / 远端为空拒绝且文案不同 /
    `account.test` 尽力而为）；
  - `provider.status` 6 条（子集误报被核实挡下 / 真全关仍报 closed / 远端失败保守 /
    未关闭零网络）；
  - 自愈 10 条（两端点入口触发 / 打到正确 provider / 未过期不触发 / loomy 静默跳过 /
    失败不上抛 / 字符串 `expiresAt` 不续期（`typeof` 判据）/ 逐账号顺序）。
- **反向验证（每条探针都做，这是判别性的唯一证据）**：同一探针跑**改动前的树** ⇒
  判别用例**恰好失败**：buddy 4 条、gateway 2 条、目录三态 7 条、status 3 条、自愈 6 条；
  其余逐条一致 ⇒ 探针可判别、改动**无附带行为变化**。
- **新 spec 反向验证**：同一 spec 跑基线树 ⇒ **10 failed / 6 passed**（6 条通过的都是
  「反向用例」：user 原样、非腾讯系原样、真全关、未关闭零网络、未过期不触发、loomy 跳过）
  ⇒ 断言非同义反复。
- **影子回归（全量）**：15 个 spec **483 passed / 0 failed**（含新增 16 条）。
  ⚠️ 影子 shim 本轮又缺一个 matcher（`toBeCloseTo`）——按 9.17 的规矩**补齐 matcher 语义**
  后才全绿，**不是**绕过断言。
- **基线漂移检查**：49 个 override 逐个与 Gitee `d14636e6` 同路径比对 ⇒
  **15 个逐字节一致**、30 个差异全部为我方有意手术（含本轮 4 个零手术 override）。
- **`files/` 与 `overrides/` 防撞自检**为空；`apply.sh` / `rebuild-vendor.sh` 语法 OK。

**推送与 CI（全部实测）**
- **commit `f2cfa6e1430d`**（13 个文件，parent = `45545c1a`）；
  推送前做了**只读基线核对**：改动前的快照与远端 main 逐字节一致 ⇒ 无回退。
- **build-apk #58 全绿**（20 个步骤全 success，含步骤 16「编译 vendor 插件」）。
- **关键证据（取自 job 日志）**：
  - `✓ tests/unit/rpc-catalog-heal.spec.ts (16 tests)` ⇒ **新 spec 确实在 CI 里跑**；
  - `Test Files 15 passed (15)` / **`Tests 516 passed (516)`**；
  - `versionCode 123` 与 `ASSET_VERSION = "123"` 同步注入 ⇒ 装新包会强制重解压 vendor；
  - 步骤 18（编译 APK）/19（发布 Release）全 success。
- **产物**：Release **`build-20261012-0919`**（`app-debug.apk` 135MB，
  2026-10-12T09:21:17Z）。构建的步骤 20 把 main 推到 `66f639fc`（README 下载链接，正常）
  —— 验证 CI 结论时要认准 `66f639fc` 的 **parent 是 `f2cfa6e1`**，两者同一棵树。
  下载：`https://github.com/zhaolongwudi/dsh-phone/releases/download/build-20261012-0919/app-debug.apk`
- **回滚锚点**：推送前 main = `45545c1a88dc`。

**⚠️ 本轮新增/变更的 override 基线（后续 sync 前必看）**
- **新增 5 个 override**：`image-budget.ts`、`gemini-auth.ts`、`buddy-growth.ts`、
  `openai-gateway/tencent-fingerprint.ts`、`openai-gateway/{messages,responses}.ts`
  （后两个是「手机版镜像 + 一处手术」）。
- **改动的既有 override**：`buddy-adapter.ts`、`jet-hub-rpc.ts`、`plugin-src/client/jet-hub.js`。
- 全部按 Gitee `d14636e6` 重定基线；漂移检查脚本：`.scratch/round-20261012/drift-923.mjs`。

**⚠️ 本轮新踩的环境坑（后续轮次必读）**
1. **设备 `/data/data/com.dshphone/files/tmp/` 目录会随机消失**（本轮连踩两次：建好的
   `round923/{cap,old,new,ph}` 与 `faithful9-base/` 里的文件在 10 分钟内不见了，且
   `cp -a` 复制出的目录会多一层同名子目录）⇒ **工作产物一律放工作区
   `/storage/emulated/0/Download/dsh/ai/.scratch/` 下**，设备 tmp 只放临时中间物。
2. **GitHub raw 拉取会 ETIMEDOUT / 静默截断**：本轮 `jet-hub.js` 一度被误判为
   「基线 ≠ 远端」，实际是两次 fetch 之间网络抖动导致的不完整读取 ——
   **逐字节比较（`Buffer.equals`）+ 重试**才得出正确结论（最终 `Buffer equal: true`）。
3. **toybox `diff` 对大文件会静默失败**（返回 0 且不输出）：本轮 `diff cap rpc old rpc`
   一度报 0 差异，实际两文件差 480 行。⇒ **统计差异一律用 node 脚本**，别信 toybox diff。
4. **影子 shim 缺 matcher 会假失败**（`toBeCloseTo` 本轮）：补 matcher 而不是删断言。
5. `@deepseek-ai/dsh-core` 不存在，`Context` 来自 **`@deepseek-ai/cordis`**（写探针时踩到）。

**⚠️ 本轮未做项（如实登记，非遗漏）**
- **上游的 docs 与 e2e 文件未移植**：`AGENTS.md`、`docs/agent-notes/*.md`、
  `tests/e2e/*`（含 `buddy-fingerprint-roles.e2e.spec.ts` 这份「指纹改写范围」的
  可复核凭据）、`tests/e2e/image-probe-shared.ts`。理由：手机仓库**不带** Gitee 的
  agent-notes 与 e2e 目录结构。⚠️ **代价要如实说**：上游明确写过「这个 e2e 不可省：
  单测只能锁『代码按这个范围改』，锁不住这个范围对不对」⇒ 我们移植了「范围」
  （只改 system + assistant），却**没有**移植验证该范围的用例。
- **上游 spec 未整体移植**：其断言基于 Phase 6 的 provider-runtime/registry 形态
  （手机版没有）；本轮只补了 capsule 自己的 16 条行为守卫。
- 中文超限措辞仍待真实报文；Step B 已知边界（图片视觉 token 预算 vs 窗口上限）未动；
  Phase 6 默认不做。
- **实机验收仍待用户**：设备停在本机记录的 111，而 9.20 起已出到 123
  （建议装 **`build-20261012-0919`**）。重点看：①积分行不再报 401、卡片红字自愈
  （睡眠/挂起恢复后直接刷新面板即可）；②「关闭全部/关闭供应商」不再出现「关了一半」；
  ③排查风控类问题后，腾讯系会话不再整轮 400/11128（换模型也没用那种）。
