# dsh-phone 两仓库对比报告

日期：2026-10-10
对比对象：
- **GitHub 最新版**：`github.com/jwoo1982217-eng/dsh-phone`（main，2026-10-09 推送，应用版本 **0.1.60 / versionCode 63**）
- **CNB 自己修改版**：`cnb.cool/zhaolongwudi/dsh-phone`（main，2026-10-10 推送，应用版本 **0.1.58 / versionCode 61**）

两者同源（原始上游为 `applecabal/dsh-phone`）。2026-10-08 双方都合并过 Jet Hub 上游
`iJetLi/deepseek-harness-codearts 0.2.0-rc.3`（固定提交 `8bf1c6f`）；GitHub 版在 **10-09 又追加了一批 Jet Hub 修正**，
自己的 CNB 版没有跟上这批。

方法：下载双方 main 分支 tar 包全量 `diff -qr`。共 **132 项差异**（内容不同 98、仅 GitHub 有 21、仅 CNB 有 13），
其中约 90 项集中在 Jet Hub 插件 `vendor/dsh-codearts-auth/`。完整清单见 `.scratch/dshdiff/diff-all.txt`，
两份解压源码在 `.scratch/dshdiff/gh` 与 `.scratch/dshdiff/cnb`。

---

## 一、GitHub 版多出来的（值得拉取，按价值排序）

### 1. Jet Hub 账号接续策略改版 ⭐ 最重要
- **语义变化**：旧版（CNB 版现状）是"两个以上账号时，每次请求按列表顺序循环使用"；
  新版（GitHub）改为"**同一模型持续使用当前可用账号，额度不足或账号限流时才由下一个可用账号接续；已有输出的请求不会换号重放**"。
  依据：`docs/jethub-upstream-sync-20261008.md` 末节「2026-10-09 后续修正」（CNB 版的这份文件没有这一节）。
- 新模块 `vendor/dsh-codearts-auth/src/account-failover.ts`：只对明确的额度/限流错误换号
  （`QUOTA_EXCEEDED`、`INSUFFICIENT_BALANCE`、`RATE_LIMITED` 及中文"额度用尽/余额不足"消息匹配）；
  内容拒绝、上下文超限、HTTP 401/403、网络错误**不**换号；`3009/14003` 错误码特判排除。
- 接线范围：`account-rotation.ts`、`autoclaw.ts`、`opencode-adapter.ts`、`zcode-source-stream.ts`。
- ChatGPT 会员侧 `phone-account/chatgpt-account.js`：`rotationLast` 由单值改为**按模型**记忆（Map），
  实现每模型粘住当前账号、失败才接续下一个。
- 配套测试：`tests/unit/account-exhaustion.spec.ts`（仅 GitHub 有）。

### 2. ZCode 账号额度来源选择
- 新模块 `src/zcode-sources.ts` + `src/zcode-source-stream.ts`（+ 测试 `zcode-sources.spec.ts`）。
- 功能：ZCode 账号卡片可选择 自动 / 每日赠送 Start Plan / 个人 BigModel 套餐 / 机构流量 / 团队来源；
  只读取账号已有凭据，不创建云端密钥、不向客户端返回密钥。
- 接线：`index.ts`、`jet-hub-rpc.ts`（管理 RPC）、`zcode.ts`、面板 `plugin-src/client/jet-hub.js`。

### 3. 聊天回车换行 + 文字发送按钮
- 新 overlay：`runtime/overlays/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
  （桌面和手机 Enter 换行、输入框回车提示、文字发送按钮；保留 IME 候选确认、Ctrl/Cmd+Enter 等原有流程）。
- 新测试 `scripts/composer-newline.test.mjs`；样式改动在 `phone-qq/presentation.css` 与 `app/src/main/assets/dsh-phone.css`
  （`data-composer-send` 发送按钮规则）；`runtime/overlays/README.md` 增加对应条目。

### 4. Jet Hub 面板大改
- `vendor/dsh-codearts-auth/lib/client/jet-hub.js` 一个文件就差 **2121 行**（供应商排序、ZCode 来源选择 UI、
  发送按钮等 10-09 全部面板改动）；另有 `plugin-src/client/{jet-hub,index,badge-model,usage-badge,jet-hub-styles}.js` 同步更新。

### 5. 版本号推进
- `app/build.gradle`：versionCode 63 / versionName 0.1.60；`NodeRunner.kt`：ASSET_VERSION "63"；README 相应说明。

### ⚠️ 拉取时的一个坑：Gemini OAuth 密钥
- GitHub 版 `src/gemini-oauth.ts:85-96` 因公开仓库合规**移除了内置 Google OAuth 客户端 ID/SECRET**：
  环境变量 `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET` 缺失时直接抛错；
  并新增 `docs/github-public-config.md` 说明。
- CNB 版同位置是**环境变量缺省时回退到内置 `GEMINI_DEFAULT_CLIENT_ID/SECRET`**。
- 影响：若整目录照搬 GitHub 版，构建出的 APK 在 Gemini 浏览器授权前必须先配置这两个环境变量。
  合并时这一处建议保留 CNB 版行为（除非有意同步公开合规策略）。

## 二、CNB 版独有的（合并上游时必须保留）

1. **云构建流水线**：`.cnb.yml` + `ci/`（每天 08:00/20:00 检查 applecabal/dsh-phone 上游 → 合并 → push → build-apk → 邮件通知，见 `ci/README.md`）。
2. `scripts/prepare-node-android.py` + `native/termux-node.json`（构建期 node 准备）。
3. `scripts/prepare-native.py` 的 curl 加固：`--connect-timeout 30 --max-time 300 --retry 5 --retry-delay 5`（比 GitHub 版的 `--retry 3` 更稳）。
4. `vendor/dsh-codearts-auth/` 内 5 个孤立文件：`src/active-route.ts`（+lib 产物）、
   `plugin-src/client/active-model-pill.js`、`plugin-src/client/build-wasm.mjs` + 测试 `active-route.spec.ts`、`active-model-pill.spec.ts`。
   **全仓库 grep 无任何引用**——是"在用模型实时读数胶囊"的未接线半成品（有实现、有测试、无接线）；
   两侧 `package.json` 一致且 `qoder:wasm` 实际指向 `scripts/extract-qoder-wasm.mjs`，`build-wasm.mjs` 同为孤儿。
   合并上游不会冲突；若想启用胶囊功能需另行接线。
5. `gemini-oauth.ts` 的内置密钥兜底（见上）。

## 三、结论与建议

- **有参考价值、需要获取的就是 GitHub 版 10-09 那一批**：账号接续改版 + ZCode 来源选择 +
  回车换行/发送按钮 + 面板大改 + 版本号 0.1.60/vc63。其余差异全是你自己的 CI 资产，方向相反（要保留）。
- 你的 CI 定时任务跟的是 `applecabal/dsh-phone`（CNB 镜像）；这批修正目前只在 GitHub 仓库。
  等镜像同步即可自动获得；急用则手动拉 GitHub 版做一次三方合并。
- 建议合并策略：
  - 以 GitHub 版为主干：`vendor/dsh-codearts-auth/`、`phone-account/`、`app/`（版本号与 ASSET_VERSION）、
    两处 css、`runtime/overlays/`、`scripts/composer-newline.test.mjs`、`docs/github-public-config.md`；
  - 保留 CNB 版：`.cnb.yml`、`ci/`、`scripts/prepare-native.py`（加固版）、`scripts/prepare-node-android.py`、
    `native/termux-node.json`、`gemini-oauth.ts` 的内置密钥兜底、active-route/active-model-pill/build-wasm 孤儿文件。
- 小提醒：CNB 版 README 写"0.1.56 / versionCode 59"，与 `app/build.gradle` 的 0.1.58/61 不一致，是 README 滞后，顺手可修。

## 附：证据位置

| 结论 | 证据 |
|---|---|
| 10-09 修正清单 | `gh/docs/jethub-upstream-sync-20261008.md` 末节（cnb 版无此节） |
| 故障转移判据 | `gh/vendor/dsh-codearts-auth/src/account-failover.ts:1-16` |
| ZCode 来源 | `gh/vendor/dsh-codearts-auth/src/zcode-sources.ts:1-50` |
| ChatGPT 轮换改 Map | `phone-account/chatgpt-account.js` diff（rotationLast 单值 → Map） |
| OAuth 密钥差异 | 两侧 `vendor/dsh-codearts-auth/src/gemini-oauth.ts:85-96` |
| CI 流程 | `cnb/ci/README.md` |
| 版本号 | 两侧 `app/build.gradle`、`app/src/main/java/com/dshphone/NodeRunner.kt` |
| 孤儿文件验证 | `grep -rln active-model-pill cnb/` 仅命中自身与测试 |
