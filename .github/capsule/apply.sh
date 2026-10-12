#!/usr/bin/env bash
# 「在用模型」胶囊外挂 · 应用脚本（构建时执行，git 仓库内容不变）
#
# 架构：上游 main 保持纯镜像；胶囊的全部文件住在 .github/capsule/ 下，
# 构建时复制/覆盖到工作区，随 APK 打包后丢弃 —— git 历史里胶囊从未修改过
# 任何上游文件，因此 sync 合并永不冲突、胶囊永远不会被上游更新覆盖。
#
# 上游大改某个被覆盖的文件时，tsc/测试会显式失败（不会静默丢功能），
# 需对照新版上游重新生成该 override（见本目录 README.md）。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 0) 一键开关：存在 .github/capsule/DISABLED 时跳过全部外挂（纯净构建 = 纯上游镜像）。
#    测试上游原版行为时创建该文件；恢复胶囊时删除即可，无需改 workflow。
if [ -f .github/capsule/DISABLED ]; then
  echo "胶囊外挂已禁用（.github/capsule/DISABLED 存在），本次构建 = 纯上游镜像"
  exit 0
fi

# 1) 胶囊独有源文件（全新增路径，不覆盖任何上游文件）
cp -a .github/capsule/files/. .

# 2) 接线覆盖文件（基线 = 上游 0.1.60 同名文件 + 胶囊接线）
cp -a .github/capsule/overrides/. .

# 2.5) 防撞自检：files/ 与 overrides/ 出现同路径 = 配置错误（overrides 会静默胜出）。
#      正常情况两者是互斥集合（全新增 vs 覆盖上游）；发现交集立即失败，防静默遮蔽。
if comm -12 \
    <(cd .github/capsule/files && find . -type f | sort) \
    <(cd .github/capsule/overrides && find . -type f | sort) | grep -q .; then
  echo "::error::capsule files/ 与 overrides/ 存在同路径文件（overrides 将静默遮蔽 files/），请二选一："
  comm -12 \
    <(cd .github/capsule/files && find . -type f | sort) \
    <(cd .github/capsule/overrides && find . -type f | sort)
  exit 1
fi

# 3) 胶囊样式：完整 override 文件已覆盖（基线 = 上游 0.1.60 + 胶囊样式），
#    不再使用 git apply 补丁（hunk 行数声明与体不符会被 git 拒绝）。

# 4) 自检：关键接线点缺一即失败（保证「胶囊失效」永远显式可见）
grep -q "activeRoutes.record(AGGREGATE_PROVIDER" vendor/dsh-codearts-auth/src/aggregate-adapter.ts
grep -q "activeRoutes.record(AUTO_PROVIDER" vendor/dsh-codearts-auth/src/auto-adapter.ts
grep -q "router.activeRoute" vendor/dsh-codearts-auth/src/jet-hub-rpc.ts
grep -q "RpcActiveRouteResponse" vendor/dsh-codearts-auth/src/types.ts
# ⚠️ 已学窗口上限的**持久化接线**（9.22）：丢掉它不会报错，只会静默退回「重启即忘」
#    （每次重启重新撞一次墙 ⇒ 回答被上游截断）—— 正是 9.22 要根治的形态，故显式自检。
grep -q "attachContextWindowStore" vendor/dsh-codearts-auth/src/index.ts
grep -q "ActiveModelPill" vendor/dsh-codearts-auth/plugin-src/client/index.js
# ⚠️ 移植 Gitee d14636e6（2026-10-12 第三轮）的两处**静默失效**接线：
#    ① 积分端点入口的按需自愈（IKKHL5）—— 丢掉这一行不会报错，只会退回
#       「睡眠恢复后卡片红着已过期、积分行报 HTTP 401」的缺陷态；
#    ② `fullCatalogIds` 的并集 + `complete` 判据（IKJW33 相邻）—— 丢掉后
#       冷缓存下「关闭全部」只关兜底子集却返回成功，用户以为关了整家。
#    两者都属「抽出的函数正确 ≠ 被正确调用」，故由构建自检显式盯住调用点。
grep -q "await healExpiredAccounts(accounts)" vendor/dsh-codearts-auth/src/jet-hub-rpc.ts
grep -q "if (!catalog.complete)" vendor/dsh-codearts-auth/src/jet-hub-rpc.ts
test -f vendor/dsh-codearts-auth/src/active-route.ts
test -f vendor/dsh-codearts-auth/src/context-window-store.ts
test -f vendor/dsh-codearts-auth/plugin-src/client/active-model-pill.js
echo "胶囊外挂应用完成"
