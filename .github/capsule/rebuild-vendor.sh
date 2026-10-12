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
pnpm install --no-frozen-lockfile --ignore-scripts
pnpm exec vitest run tests/unit/active-route.spec.ts tests/unit/active-model-pill.spec.ts tests/unit/context-window-learn.spec.ts tests/unit/llm-adapter-context-overflow.spec.ts tests/unit/context-overflow-channels.spec.ts tests/unit/openai-gateway-server.spec.ts tests/unit/minimax-adapter.spec.ts tests/unit/minimax-messages.spec.ts tests/unit/probe-dispatch-guard.spec.ts tests/unit/auto-badge-rpc.spec.ts tests/unit/auto-badge-restore.spec.ts tests/unit/auto-adapter.spec.ts tests/unit/badge-model.spec.ts tests/unit/aggregate-adapter.spec.ts tests/unit/rpc-catalog-heal.spec.ts
pnpm run build:all
ls -l lib/index.js lib/client/jet-hub.js
