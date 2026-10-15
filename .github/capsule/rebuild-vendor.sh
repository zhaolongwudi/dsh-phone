#!/usr/bin/env bash
# vendor 插件重建（胶囊接线 → tsc 类型检查 → esbuild 重建 bundle）。
# 纯净构建（.github/capsule/DISABLED 存在）时跳过：上游代码不经 tsc（其 CI 用
# 预编译 lib），直接使用仓库提交的 lib/ 产物，保证纯净 APK 与上游行为一致。
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -f .github/capsule/DISABLED ]; then
  echo "纯净构建：跳过 vendor 重建与胶囊测试，使用仓库预编译 lib"
  ls -l vendor/dsh-codearts-auth/lib/index.js vendor/dsh-codearts-auth/lib/client/jet-hub.js
  exit 0
fi

cd vendor/dsh-codearts-auth
# ⚠️ **Issue F-31**：本目录**没有提交 lockfile**（`vendor/` 下无 pnpm-workspace.yaml、
# 包内无 pnpm-lock.yaml），而 devDependencies 全是 `^` 范围（esbuild / typescript /
# vitest / tsx / cross-env）⇒ 固定用 `--no-frozen-lockfile` 就等于「每次 CI 都重新
# 解析一次版本」：仓库没有任何变更，装到的 esbuild 也可能比上次新 —— 而
# `ui-verify-installed.mjs` 的字节判定正是拿 bundle 字节做比较，一漂移就误报 stale。
# 故：**有 lockfile 就冻结**（`--frozen-lockfile`，与 runtime 侧同口径）；没有则退化为
# 非冻结安装，但把这件事**显式报成 CI 注解**，不再静默漂移。
if [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile --ignore-scripts
else
  echo "::warning::vendor/dsh-codearts-auth 无 pnpm-lock.yaml（Issue F-31）：本次 install 会重新解析 ^ 范围，装到的 esbuild/typescript/vitest 可能与上次不同。修复方式 = 先跑 pnpm install --lockfile-only 生成 vendor/dsh-codearts-auth/pnpm-lock.yaml，再在仓库根提交它。"
  pnpm install --no-frozen-lockfile --ignore-scripts
fi
pnpm exec vitest run tests/unit/active-route.spec.ts tests/unit/active-model-pill.spec.ts tests/unit/dsml-marker-normalizer.spec.ts tests/unit/dsml-normalizer-coverage.spec.ts tests/unit/dsml-label-boundary.spec.ts tests/unit/dsml-extractor-normalize.spec.ts tests/unit/detail-field-text.spec.ts tests/unit/loop-recovery.spec.ts tests/unit/loop-recovery-reentry.spec.ts tests/unit/context-window-learn.spec.ts tests/unit/llm-adapter-context-overflow.spec.ts tests/unit/context-overflow-channels.spec.ts tests/unit/openai-gateway-server.spec.ts tests/unit/minimax-adapter.spec.ts tests/unit/minimax-messages.spec.ts tests/unit/tool-result-image-coalescing.spec.ts tests/unit/login-poll-terminal-failure.spec.ts tests/unit/probe-dispatch-guard.spec.ts tests/unit/auto-badge-rpc.spec.ts tests/unit/auto-badge-restore.spec.ts tests/unit/auto-adapter.spec.ts tests/unit/badge-model.spec.ts tests/unit/aggregate-adapter.spec.ts tests/unit/rpc-catalog-heal.spec.ts tests/unit/openai-gateway-host-binding.spec.ts tests/unit/zcode-captcha-upfront.spec.ts tests/unit/zcode-model-entitlements.spec.ts
pnpm run build:all
ls -l lib/index.js lib/client/jet-hub.js
