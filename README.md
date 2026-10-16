# DSH 手机版：在 Android 手机上运行 AI 助手
<!-- APK-LINK:BEGIN -->
## 📱 下载

- 国内加速直连：https://gh-proxy.com/https://github.com/zhaolongwudi/dsh-phone/releases/download/build-20261016-1608/app-debug.apk
- GitHub 直连：https://github.com/zhaolongwudi/dsh-phone/releases/download/build-20261016-1608/app-debug.apk

- 构建版本：`build-20261016-1608`

<!-- APK-LINK:END -->




---

## 🙏 致谢与上游项目

本项目是社区适配封装，全部核心能力来自以下开源项目，向各位作者致谢：

| 上游项目 | 本项目用到了什么 | 来源 |
| --- | --- | --- |
| **DeepSeek 官方 DeepSeek Harness** | AI 助手主引擎、聊天界面、插件体系、账号协议 | [GitHub](https://github.com/deepseek-ai/deepseek-harness) · [官方文档](https://deepseek-harness.github.io/deepseek-harness/) · MIT |
| **jwoo1982217-eng：dsh-phone** | 本仓库的上游基底：Android 手机壳、构建流水线与手机适配 | [GitHub](https://github.com/jwoo1982217-eng/dsh-phone) |
| **Jet／iJetLi：deepseek-harness-codearts** | Jet Hub 多供应商账号登录、模型接入、本机模型网关 | [Gitee](https://gitee.com/iJetLi/deepseek-harness-codearts#dsh-codearts-auth) · MIT |
| **ZSeven-W：dsh-noema／Noema** | 长期记忆插件与记忆引擎 | [GitHub](https://github.com/ZSeven-W/dsh-noema) · MIT |
| **Termux 与 NapCatQQ** | 手机 Linux 运行环境、QQ 登录／OneBot 连接 | [Termux](https://github.com/termux/termux-app) · [NapCatQQ](https://github.com/NapNeko/NapCatQQ) |

各组件按各自上游许可使用和分发，原作者版权与许可声明全部保留：DeepSeek 许可见 [phone-account/vendor/LICENSE.deepseek](phone-account/vendor/LICENSE.deepseek)，Jet Hub 许可见 [vendor/dsh-codearts-auth/LICENSE](vendor/dsh-codearts-auth/LICENSE)，QQ 通道许可见 [vendor/dsh-channel-qq/LICENSE.openclaw](vendor/dsh-channel-qq/LICENSE.openclaw)，原生组件（Node/Bash/ripgrep/Noema）的固定版本与重建方法见 [原生引擎说明](native/README.md)。

---

## 这是什么

一个 **DeepSeek Harness（DSH）的 Android 封装**：把 AI 聊天、模型账号管理、QQ 机器人、技能、长期记忆和代码工作区装进一个手机应用，数据全部存在手机本机，日常使用无需连电脑。

- **手机 AI 助手**：与模型对话，管理会话、账号和文件。
- **多渠道模型账号（Jet Hub）**：DeepSeek、ChatGPT 会员、智谱、ZCode 等多家账号统一管理，额度不足自动换号接续。
- **QQ 机器人**：给机器人设置性格和模型，在 QQ 私聊或群聊里交代任务。
- **技能与记忆**：导入中文 Markdown 或技能 ZIP 保存工作方法；Noema 管理长期记忆。
- **代码工作区**：手机上读写代码，本地执行 Node.js／Bash。
- **远程扩展**：扫码连接家里电脑、远程 Hermes、把手机工具共享给外部 AI（MCP）。

- 当前应用版本：**0.1.62 / versionCode 65**，包名 `com.dshphone`，**Android 9+ / arm64**。
- 覆盖安装升级，自动保留账号、对话、技能和配对数据。
- AI 模型请求发往你自己配置的云服务，需要网络和自己的账号。

## 快速开始

1. 安装 APK，等待顶部显示「运行中」。
2. 顶部「账号」登录 DeepSeek；其他供应商在「设置 → Jet Hub」配置，然后回聊天页选模型。
3. 需要 QQ 机器人：顶部「QQ」按三步向导授权环境、装 QQ 登录端、扫码登录。配置模板见 [phone-qq/qq-config-template.json](phone-qq/qq-config-template.json)。

## 深入了解

| 主题 | 说明 |
| --- | --- |
| [第一次使用与功能详情](README.details.md) | 完整功能清单、上传/技能/图片等细节 |
| [配置机器人和模型](phone-qq/README.md) | QQ 导入、群聊权限、模型 API 配置 |
| [源码目录与构建](README.details.md) | 目录结构、构建步骤、测试方法 |
| [版本历史](README.details.md) | 0.1.9 至今的全部版本更新记录 |
| [电脑版说明](desktop/README.md) | 电脑独立运行 DSH 的安装方法 |
| [手机操作插件](phone-control/README.md) | 操作手机 App、Shizuku 日志、Termux 命令 |
| [远程连接说明](peer/README.md) | 扫码连电脑、API 同步、模型网关 |
| [通用接入包](phone-cloud-tools/README.md) | 把手机工具共享给 Codex、桌面 DSH 等 MCP 客户端 |
| [公开版配置说明](docs/github-public-config.md) | Gemini OAuth 自备客户端 ID |
| [原生引擎说明](native/README.md) | Node/Bash/Noema 原生组件的来源与重建 |

## 构建

需要 JDK 17+、Android SDK 36、Python 3、Node 22.19+ 或 24+、pnpm 10+。完整步骤（含原生组件准备）见 [README.details.md](README.details.md)：

```sh
git clone https://github.com/zhaolongwudi/dsh-phone
cd dsh-phone && cd runtime && pnpm install --frozen-lockfile --ignore-scripts && cd ..
python3 scripts/prepare-native.py
python3 scripts/build-noema-android.py && python3 scripts/build-flock-android.py && python3 scripts/build-landlock-android.py
python3 scripts/build-assets.py
./gradlew :app:clean :app:assembleDebug
```

产物在 `app/build/outputs/apk/debug/app-debug.apk`。资源有变动时增加 `NodeRunner.ASSET_VERSION`；不要删除使用者的整个 `dsh-home`。
