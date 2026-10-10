# 「在用模型」胶囊外挂层

构建时外挂到 `vendor/dsh-codearts-auth` 的实时读数胶囊：在聊天输入区最下方
显示**当前这一次请求实际发往的渠道与模型**（`aggregate` 与 `jet-hub-auto`
两家路由 provider），点开有明细。

## 为什么这样做

本仓库 main 是上游 `jwoo1982217-eng/dsh-phone` 的纯镜像（每日自动同步）。
胶囊若直接改上游文件，下次 sync 就会产生冲突或被覆盖。因此：

```
git 仓库（main 分支）
├── 上游内容（sync 全权管理，永不改动）
└── .github/capsule/   ← 本目录：胶囊的全部源材料

构建时（build-apk.yml）：
  1. apply.sh 把胶囊文件复制/覆盖到工作区（临时，git 无感知）
  2. vendor 重新编译（tsc + esbuild，lib/ 由接线后的 src 生成）
  3. 胶囊单元测试必须通过（active-route / active-model-pill 两个 spec）
  4. build-assets 打进 APK → 工作区随构建结束丢弃
```

`sync-upstream.yml` 合并上游时**永远看不到胶囊改动** —— 胶囊不进 git 历史，
所以既不会被覆盖，也不会破坏任何未来的上游更新。

## 目录内容

| 路径 | 说明 |
|---|---|
| `files/` | 胶囊独有源文件（`active-route.ts` 核心注册表、`active-model-pill.js` 客户端组件、build-wasm 辅助、两个单元测试），全新增路径 |
| `overrides/` | 5 个「上游 0.1.60 + 接线」覆盖文件：`src/types.ts`、`src/jet-hub-rpc.ts`、`src/aggregate-adapter.ts`、`src/auto-adapter.ts`、`plugin-src/client/index.js` |
| `patches/` | 仍能与上游上下文精确匹配的补丁（当前仅 `jet-hub-styles.js` 样式） |
| `apply.sh` | 构建时应用 + 接线自检 |

`lib/` 产物不需要保存：`overrides` 里的源文件接线后由 CI 的
`pnpm run build:all`（tsc + esbuild）重新编译生成，类型错误会直接构建失败。

## 上游更新后的维护

- 上游**没改**被覆盖的 5 个文件：无事发生，胶囊照常。
- 上游**改了**其中某个文件：`overrides` 的旧基线会覆盖掉上游新改动
  （tsc/测试仍会过）。判定方法：看构建日志里上游该文件的最近提交；
  此时需按新版上游重新落位接线（对照 `docs/agent-notes/` 与补丁语义），
  更新对应 override 文件。
- 补丁（样式）打不上时构建会失败并提示，不会静默丢样式。

## 接线点速查（重做 override 时对照）

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
