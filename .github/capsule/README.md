# 胶囊外挂层（.github/capsule/）

构建时外挂到 `vendor/dsh-codearts-auth` 的**全部自有代码**。起点是「在用模型」
实时读数胶囊（输入区最下方显示当前这次请求实际发往的渠道与模型），2026-10-11
起扩展为 Gitee 原作者功能移植的载体（Phase 1–5 + Step A/B + 9.17 上游增量，
详见仓库 `docs/porting/PORT-STATUS.md` 与 `docs/porting/PORTING-GITEE-HANDOFF.md`（本地工作区另存完整轮次报告于 docs/reports/）。

## 为什么这样做

本仓库 main 曾是上游 `jwoo1982217-eng/dsh-phone` 的纯镜像（2026-10-11 起自动
同步已停，仅手动 dispatch）。胶囊若直接改上游文件，sync 就会产生冲突或被覆盖。
因此：

```
git 仓库（main 分支）
├── 上游内容（永不直接改动）
└── .github/capsule/   ← 本目录：胶囊 + 全部移植产物的源材料

构建时（build-apk.yml）：
  1. apply.sh 把胶囊文件复制/覆盖到工作区（临时，git 无感知）
  2. vendor 重新编译（rebuild-vendor.sh：vitest 胶囊 spec → tsc → esbuild）
  3. build-assets 打进 APK → 工作区随构建结束丢弃
```

`sync-upstream.yml` 合并上游时**永远看不到胶囊改动** —— 胶囊不进 git 历史，
所以既不会被覆盖，也不会破坏任何未来的上游更新。

## 目录内容（2026-10-12 17:00 状态）

| 路径 | 说明 |
|---|---|
| `files/` | 胶囊/移植**全新增**路径：11 个 src 模块（active-route、provider-registry/runtime/expiry、zero-output-guard、catalog-broadcast/prewarm、context-window-learn、context-window-store、auto-badge、session-title）+ 客户端组件（active-model-pill、backup-convert、backup-payload 等）+ spec（当前 30 个文件） |
| `overrides/` | **51 个**「上游某版 + 我方改动」覆盖文件 = vendor 49 个（src 40 + plugin-src/client 5 + spec 4）+ **UI 层 2 个**（`app/src/main/assets/dsh-phone.{js,css}`，2026-10-12 新增）；另有 1 个 `lib/`（胶囊自带的 d.ts 源）。每个的基线版本见 `docs/porting/PORTING-GITEE-HANDOFF.md` 各轮次记录 |
| `overrides/runtime/` | **官方引擎适配（2026-10-14 新增）**：3 个版本文件（`package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml`）+ `overlays/@deepseek-ai/`（23 包 40 文件）。上游 `runtime/` 与本仓库**逐字节一致**（属「永不直接改」的上游内容），故引擎升级走这里覆盖。当前基线 **`0.2.1-alpha.2`** |
| `apply.sh` | 构建时应用 + 接线自检（自检项缺失即构建失败）+ **2.5 步防撞自检**（files/ 与 overrides/ 同路径即红）+ **UI 接线自检与锚点门禁**（2026-10-12 新增，见下节）+ **runtime 引擎版本自检**（2026-10-14 新增：6 条断言，防「文件铺了但装回旧引擎」的静默退回）；`DISABLED` 空文件 = 一键纯净构建 |
| `rebuild-vendor.sh` | vendor 重建：vitest **显式名单 15 个 spec** → tsc → esbuild。⚠️ **新增 spec 必须同时登记进该名单，否则静默不跑** |
| `build-apk.yml` | 完整构建 workflow 模板（sync 后由 sync-upstream.yml 恢复到 .github/workflows/） |
| `update-readme.py` | README 下载区块自动改写（[skip ci] 防循环） |

### UI 层（2026-10-12 新增，方案 B 一期+二期）

手机形态以前只有「CSS 直接锚上游 hash 类名」一条路，上游一升级就整块静默失效。
现补上标记层与锚点资产化：

| 路径 | 落位 | 说明 |
|---|---|---|
| `app/src/main/assets/dsh-phone.js` | **overrides**（上游文件） | 新增形态标记层：发布 `html[data-dsh-mobile-form]`、`[data-dsh-frame]`、`html[data-dsh-modal-open]`、`[data-dsh-settings-dialog]`、`html[data-dsh-settings-open]`；断点由 700 对齐上游 768px 阈值为 **767** |
| `app/src/main/assets/dsh-phone.css` | **overrides**（上游文件） | 断点同步 767；文件头加分块地图；`[data-dsh-frame]`/`[data-shortcut-modal="settings"]` 与 hash 并列作兜底 |
| `app/src/main/assets/ui-anchors.json` | files | 52 个上游 hash 的语义/归属映射表（隐式依赖显式化）+ `knownDead` 已失效登记 |
| `app/src/main/res/values/ 与 values-night/ 下成对的 ds_colors.xml`、`values/dimens.xml` | files | 原生壳面语义色（双态）与 8pt 网格尺寸 token。⚠️ **当前仅定义、未被 Kotlin 消费**（`MainActivity.kt` 硬编码色仍在原处） |
| `scripts/check-ui-anchors.mjs`、`scripts/ui-anchor-scan.mjs` | files | 锚点门禁与哈希扫描器 |
| `scripts/ui-tests/*.mjs` | files | 标记层行为测试（16 例）+ 门禁判别力测试（16 例） |

**门禁两层**（`apply.sh` 与 `typecheck.yml` 都跑离线层）：

```sh
node scripts/check-ui-anchors.mjs                      # 离线：CSS 引用的 hash 必须全部登记
node scripts/check-ui-anchors.mjs --tree <dsh树根>      # 在线：额外校验 hash 在上游真实存在
node scripts/ui-tests/marker-layer.test.mjs            # 标记层行为（12 例）
node scripts/ui-tests/check-ui-anchors.test.mjs        # 门禁判别力反证（16 例）
```

**自检必须锚代码形态，不能锚裸字符串**（2026-10-12 实测踩到）：本层 JS 的文件头
注释里也列了那 5 个 `data-dsh-*` 属性名。若自检写成 `grep -q "data-dsh-mobile-form"`，
把实现整体删空、只留注释，自检照样通过 —— 属「假绿」。故 `apply.sh` 一律锚定真实
调用/赋值形态（`toggleAttribute(data-dsh-…)`、`const X_TAG = data-dsh-…`），
并额外确认 CSS 侧真的消费了 `[data-dsh-frame]`（发布了没人用等于白做）。

**槽位契约（三期前置）**：`scripts/ui-slot-inventory.mjs` 从引擎树提取真实槽位名并
校验三期迁移表。槽位名写错或上游删槽时注册代码**不报错**（slots.inject 永远等服务、
控件静默不出现），故 `apply.sh` 与 CI 都跑它。三期五个候选的现状/目标槽/风险见
`docs/porting/SHELL-UI-PORT-PLAN.md` §9.6。

**槽位注册审计**：`scripts/ui-slot-register-audit.mjs` 拦「跨包同 id / 同槽同
order / 槽名失效」三类静默失效。本仓库 `dsh-phone-qq` 与 `dsh-peer` 由同一份
`client-source.js` 产出、天然同 id（8 项潜在）——只在两者都进 bundles 时才阻断。

**模块表契约（三期技术前提）**：`scripts/ui-module-seed.mjs` 校验壳侧静态模块表
（`dsh-web-frontend/dist/assets` 里的 `staticModules`）是否提供 `react`/`react-dom`/
`cordis`/`ui-slots` 等条目。三期槽位组件的依赖**只能**从这张表解析——表里没有就
解析失败，且失败形态是「组件静默不渲染」而非报错。实测 0.2.1-alpha.1 含 9 项，
故组件可写成真 React 函数组件（`useState`/`useEffect`）。

### UI 层工具清单（11 个脚本 / 15 个测试套件）

| 脚本 | 作用 | 离线可跑 |
|---|---|---|
| `check-ui-anchors.mjs` | **锚点失效门禁**：CSS/JS 引用的上游 hash 必须全部登记；校验 `data-slot` 存在性 | ✓（在线更强） |
| `ui-anchor-scan.mjs` | 哈希扫描器（从引擎树提取 hash → 包）；供门禁与探针复用 | ✓ |
| `ui-anchor-live-probe.mjs` | **维护期工具**：从运行中的引擎 HTTP 面校验锚点真实下发 | 需引擎 |
| `ui-layer-audit.mjs` | 图层健康：状态类无消费 / 死 CSS / 未定义变量 三类腐化 | ✓ |
| `ui-css-validate.mjs` | CSS 结构：注释、括号、声明形态、空选择器、**hash 兜底是否丢失** | ✓ |
| `ui-res-validate.mjs` | Android 资源：XML 结构、色值/dimen 格式、深浅色成对 | ✓ |
| `ui-compat-floor.mjs` | **WebView 兼容下限**：新增特性是否超出目标内核支持面 | ✓ |
| `ui-slot-inventory.mjs` | 槽位清单 + 三期迁移表 + 配方（`--recipe <id>`）+ 占用/通道验证度 | ✓（在线更全） |
| `ui-slot-register-audit.mjs` | 注册审计：跨包同 id / 同槽同 order / 槽名失效 | ✓ |
| `ui-module-seed.mjs` | 客户端静态模块表契约（react 等是否可用） | 需引擎树 |
| `ui-semantic-anchors.mjs` | **信息性**：列出仍裸用 hash、但上游有稳定语义属性的位置 | 需引擎树 |

`scripts/ui-tests/` 下 15 个套件（**265 例**）与之配套，每个都有判别力自证；
其中 `slot-chain-e2e.test.mjs` 用**真实 renderer + 真实 SlotCore + 真 React**
串起「加载 → 建槽 → 注册 → 查出 → 渲染」完整链路。

**上游升级后的动作**：跑在线门禁。报红的项即失效锚点，按其 `semantic` 与 `pkg`
去对应上游包里找新类名，改 CSS 与该映射表。首次运行即已查出 4 条**一直在静默失效**
的规则（登记在 `knownDead`）——这正是本门禁要抓的形态。


⚠️ **落位判据**（2026-10-12 明确）：**main 的 vendor 镜像里已有该文件 ⇒ 进 `overrides/`**
（要纳入基线漂移检查）；**main 完全没有 ⇒ 进 `files/`**。两者在 `apply.sh` 里落到
同一处，但语义与维护纪律不同（`files/` 不会被上游"改回"）。

样式（jet-hub-styles.js）已改为**完整 override 文件**（基线 = 上游 0.1.60 + 胶囊样式）。
旧 `patches/` 目录（git apply 补丁）已于 2026-10-11 废弃删除——多 hunk 上下文漂移时
补丁不可靠，一切以 override 整文件为准。

## 上游更新后的维护（基线漂移，最重要）

- 上游**没改**被覆盖的文件：无事发生，胶囊照常。
- 上游**改了**其中某个文件：`overrides` 的旧基线会**静默覆盖**掉上游新改动
  （tsc/测试仍会过——这正是 #15「zcode 增强丢失」事故的形态）。
  ⇒ **每次 sync 后必做基线漂移检查**：51 个 override 逐个与上游同路径比对
（⚠️ 既有脚本 `.scratch/port-gitee/drift-check*.mjs` 只扫 `overrides/vendor/`，
**不含 UI 层那 2 个** —— 上游若改了 `app/src/main/assets/dsh-phone.{js,css}`，
需手工比对 jwoo 上游同路径文件，基线见方案 §4 与本源文件头部注释），
  差异应全部为我方有意改动（脚本范例 `.scratch/port-gitee/drift-check.mjs`）。
  有漂移时按新版上游重定基线：**不要用 `patch` 命令**（toybox 对多 hunk 上下文
  漂移会整份静默跳过），用 node 脚本按精确锚点字符串逐块替换/拼接，
  每步 `grep -c` 核对标记数（流程见 HANDOFF 踩坑 6 与 9.17 环境坑 1）。

## 接线点速查（「在用模型」胶囊原始 5 处，重做 override 时对照）

1. `src/types.ts`：`RpcAggregateActiveProviderResponse.model?` 字段 + `RpcActiveRouteResponse` 接口
2. `src/jet-hub-rpc.ts`：import `activeRoutes`；RpcMap 注册 `RpcActiveRouteResponse`；
   `activeTarget` 接口声明；`aggregate.activeProvider` 处理器补 `model` 字段；
   新 `case 'router.activeRoute'`（纯内存读、安静降级）
3. `src/aggregate-adapter.ts`：import；`activeTargetByModel`/`lastActiveModel` 字段；
   `activeTarget()` 方法；`dispatch` 候选循环开头 `activeRoutes.record(AGGREGATE_PROVIDER, target.provider, target.realId)`；
   成功提交点（`activeProviderByModel.set` 旁）同步写 target
4. `src/auto-adapter.ts`：import；`dispatch()` 函数体开头 `activeRoutes.record(AUTO_PROVIDER, target.provider, target.model)`
5. `plugin-src/client/index.js`：import `ActiveModelPill`；挂载到
   `conversation.composer.dock`（order 2，含 `router.activeRoute` →
   `aggregate.activeProvider` 的旧宿主回落）

> 移植引入的其余接线点（Phase 1 注册块、zero-output-guard、备份 merge、
> catalog-broadcast/prewarm、minimax 换号、探测分派分支等）逐文件记录在
> `docs/porting/PORTING-GITEE-HANDOFF.md` 9.5–9.17，重做对应 override 前先读该节。
