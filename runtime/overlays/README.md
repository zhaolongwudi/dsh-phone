# DSH 0.2.1-rc.5 适配补丁

全部 JS / YAML 基于官方 dsh-v0.2.1-rc.5 发布产物，保留 MIT LICENSE。

- app-boot：Android 使用已开启 --expose-internals 的内置加载器，避免加载没有 Android 包的 require-builtin 原生扩展。
- bash-local：手机使用应用随包提供的 Bionic bash。
- session-persistence-jsonl：Android 通过临时目录 fsync / rename 原子发布会话，避免不支持的硬链接；桌面沿用官方分支。
- client-connection：声明 Web 服务依赖，让独立管理 RPC 通道完成注册；本机回环地址不受浏览器的互联网离线提示阻断，页面从缓存恢复或回到前台时恢复断开的实时连接。保留官方 Host/Origin 和浏览器会话认证，不重发用户任务。
- client-ui-conversation：桌面和手机普通 Enter 换行，输入框声明回车键提示，并显示文字发送按钮；保留输入法候选确认、菜单选择、Ctrl/Cmd+Enter 与发送/排队/插话/停止原有流程。
- web-frontend：禁用浏览器整页翻译（`translate="no"` / `class="notranslate"` / `meta google notranslate`），避免翻译改写界面文案与输入内容。
- settings：把旧 noema-memory 设置迁入新版 dsh-noema 配置表单。
- web-app presets：标准、创作、PTC 预设启用 timed 提问（120 秒）；迟到的回答继续送入原会话，不产生默认许可。

上游源码：https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.5

## 升级历史

| 引擎版本 | 时间 | 说明 |
|---|---|---|
| `0.2.1-alpha.1` | 2026-10-09 | 基线（上游 jwoo 仓库自带） |
| `0.2.1-alpha.2` | 2026-10-14 | 本层升级：40 个 overlay 重新生成（13 个需重新套用本地适配 + 上游改动，25 个内容不变或纯上游继承），`package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` 同步 |
| `0.2.1-rc.2` | 2026-10-30 | 上游同步到 rc.2；overlay 文件随核心产物重铺（Android 补丁内容不变）。 |
| `0.2.1-rc.5` | 2026-10-30 | rc.2 → rc.5 仅 `client-ui-conversation/lib/client.js`、`web-frontend/dist/index.html` 两个 overlay 需重放；其余 overlay 与 rc.5 官方产物逐字节相同。`client.js` 的 12 个本地 hunk 用 `patch` 无 fuzz 套用到 rc.5，`index.html` 重新拼装 hash + 翻译标记。 |
