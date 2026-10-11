# 胶囊外挂层（.github/capsule/）

构建时外挂到 `vendor/dsh-codearts-auth` 的**全部自有代码**。起点是「在用模型」
实时读数胶囊（输入区最下方显示当前这次请求实际发往的渠道与模型），2026-10-11
起扩展为 Gitee 原作者功能移植的载体（Phase 1–5 + Step A/B + 9.17 上游增量，
详见仓库根 `PORT-STATUS.md` 与 `PORTING-GITEE-HANDOFF.md`）。

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

## 目录内容（2026-10-12 07:00 状态）

| 路径 | 说明 |
|---|---|
| `files/` | 胶囊/移植**全新增**路径：10 个 src 模块（active-route、provider-registry/runtime/expiry、zero-output-guard、catalog-broadcast/prewarm、context-window-learn、auto-badge、session-title）+ 客户端组件（active-model-pill、backup-convert、backup-payload 等）+ spec（当前 28 个文件） |
| `overrides/` | **44 个**「上游某版 + 我方改动」覆盖文件（src 34 个 + plugin-src/client 5 个 + spec 4 个）；另有 1 个 `lib/`（胶囊自带的 d.ts 源）。每个的基线版本见 `PORTING-GITEE-HANDOFF.md` 各轮次记录 |
| `apply.sh` | 构建时应用 + 接线自检（自检项缺失即构建失败）+ **2.5 步防撞自检**（files/ 与 overrides/ 同路径即红）；`DISABLED` 空文件 = 一键纯净构建 |
| `rebuild-vendor.sh` | vendor 重建：vitest **显式名单 14 个 spec** → tsc → esbuild。⚠️ **新增 spec 必须同时登记进该名单，否则静默不跑** |
| `build-apk.yml` | 完整构建 workflow 模板（sync 后由 sync-upstream.yml 恢复到 .github/workflows/） |
| `update-readme.py` | README 下载区块自动改写（[skip ci] 防循环） |

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
  ⇒ **每次 sync 后必做基线漂移检查**：44 个 override 逐个与上游同路径比对，
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
> `PORTING-GITEE-HANDOFF.md` 9.5–9.17，重做对应 override 前先读该节。
