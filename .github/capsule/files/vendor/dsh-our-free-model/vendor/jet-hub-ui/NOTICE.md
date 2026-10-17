# 补丁 G 的客户端产物（固化素材）

> 补丁 G（`patch-jet-hub-ui.mjs`）把上游 Jet Hub 客户端**整体**注入 OFM 的 `client.js`。
> 本目录是它唯一允许的权威源；设备路径只作回退。

## 当前在用

| 项 | 值 |
|---|---|
| 版本 | **`dsh-providers-hub@1.8.261017`**（`lib/client/jet-hub.js`） |
| 大小 | 607798 字节 |
| sha256 | `50ef48b1bacf54d11d3138c664c274016c5d33eac7c285a0f455bb193f2de8a8` |
| 来源 | 官方 npm tarball `https://registry.npmjs.org/dsh-providers-hub/-/dsh-providers-hub-1.8.261017.tgz` |
| 换源日期 | 2026-10-18 |

## 归档版本

| 文件 | 版本 | 大小 | sha256 |
|---|---|---|---|
| `archive/jet-hub-1.6.261016.js` | 1.6.261016 | 562429 | `e3042ec1be5c01f87a908f9d4b69f2d89f5674c1662cde0a1a599240f975a763` |

## ⚠️ 为什么 1.8 能让补丁 H / I / K 退役（2026-10-18 实测）

1.6 时代 npm 上没有比它更新的版本，所以「聚合排序/拖动（I）」「聚合候选三态（H）」
「CodeBuddy 补偿面板（K）」这三项**只能手工移植**进老 UI（§17.1 的原话是
「整体升级 G 源这条路当前不可用」）。

1.8.261017 发布后这条路可用了 —— 实测：

| 判据 | 结果 |
|---|---|
| 端点集 | 1.6 调 47 个 / **1.8 调 52 个**；新增 `aggregate.setOrder`、`aggregate.setOrderMode`、`aggregate.rejectNonExpiring`、`buddy.compensationStatus`、`buddy.claimCompensation`、`modelscope.setApiKey` |
| 三态 / 排序 | 1.8 含 `expiryWired`、`orderMode`、`draggable`、`dragOver` |
| 补偿面板 | 1.8 含 gitee 那套**同名纯函数**：`isClaimable` / `isClaimed` / `scanCompensation` / `toCompensationState` / `claimAllCompensation` / `compensationHeadline` / `compensationHint` |
| **聚合面板渲染** | `render-aggregate.mjs` 对「1.8 产物（未打 I）」与「老产物（打了 I）」**可见文本逐字相同**（24,564 字符，含「排序：按临期 / 拒绝非临期」与三态文案） |
| 锚点 | H 的五条、K 的六条中四条在 1.8 上**恒 0 次命中**（UI 已重构）⇒ 想打也打不上 |

⇒ H / I / K 已从 `update.mjs` 重放链**下线**（脚本与 `compensation-src/` 素材保留，供回退）。

## 为什么要固化（2026-10-17 起）

补丁 G 的抽取断言要求产物**带 CJS 导出接线**
（`module.exports = __toCommonJS(client_exports)`）。实测各来源：

| 来源 | 版本 | 能否抽取 |
|---|---|---|
| **本目录（npm 发布版）** | 1.8.261017 / 1.6.261016 | ✓ |
| 设备 profile 的 `dsh-providers-hub` | 0.2.0-rc.11（退役版，未更新） | ✗ 无导出接线 |
| 设备 `ofm-build/npm-pkg`（更早一次 npm 安装） | 1.3.261015 | ✓ 但**版本倒退**，不可用 |
| APK tree 里 CI 构建的那份（573952B） | — | ✗ 无导出接线 |
| 仓库 `vendor/dsh-codearts-auth` 的 esbuild 产物 | — | ✗ 无导出接线 |

⇒ **只有 npm 发布版的构建形态可复用**。本目录是**不随构建漂移**的权威源；
脚本在它缺失时按「**能否抽取**」逐份回退到设备路径（而不是按文件是否存在）。

## 换源流程（上游再发新版时照此做）

```bash
cd _ofm
# ① 先拉新版 npm tarball，解出 lib/client/jet-hub.js
# ② 用环境变量在**副本**上演练整条链，通过后再固化：
OFM_JET_HUB_SRC=<新版 jet-hub.js> OFM_G_TARGETS=<副本/client.js> node patch-jet-hub-ui.mjs --apply
node headless-client-check.mjs <副本/client.js>
node render-check.mjs <副本/client.js> --id jet-hub
node render-aggregate.mjs <副本/client.js>
# ③ 固化：旧版移入 archive/，新版覆盖 jet-hub.js，更新本文件与三处副本
# ④ node check-jet-hub-source.mjs   # 校验「产物里记的源 sha256 == 当前源」
```

## 三处副本必须一致

`_ofm/jet-hub-client/jet-hub.js`（工作区权威源）、
`_ofm/dsh-our-free-model/vendor/jet-hub-ui/jet-hub.js`（随 OFM 发行物走）、
`dsh-phone-gh/.github/capsule/files/vendor/dsh-our-free-model/vendor/jet-hub-ui/jet-hub.js`（出厂）。

后两处的存在意义：**任何拿到 OFM 安装副本的机器都能重放补丁 G**，
不再依赖 `_ofm/` 本地素材或设备上那份已退役的插件文件。