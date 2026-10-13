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
# ⚠️ 移植 Gitee master（2026-10-13 第四轮，d14636e6→30e718d3，20 提交）的**静默失效**接线。
#    共同形态同样是「抽出的函数正确 ≠ 被正确调用」，而丢掉它们的后果都是**用户可见**
#    却**不报错**：
#    ① zcode 额度按模型判定（issue：8M = 3M(GLM-5.3) + 5M(GLM-5.3-Flash)）——
#       丢掉 `exhaustedModelsOf` 接线后，专属桶烧光仍判「账号没用完」⇒ **不换号**；
#    ② cline 图片能力三态（IKKZUG）—— 丢掉 `undefined` 分支后，目录未就绪被谎报成
#       「不支持图片」⇒ DSH 把图片**静默**投影成占位文本；
#    ③ cline 目录健康快照（IKKZUG 第 5 点）—— 丢掉后「没拉到」不可观测，排障只能靠推演；
#    ④ 网关 host 可配 + 通配拒绝（IKL7UN）—— 丢掉 fail-closed 白名单后，一个
#       `0。0。0。0` 形态就能让网关**绑全部网卡**（审计实测局域网 4/4 可反连）。
grep -q "exhaustedModelsOf" vendor/dsh-codearts-auth/src/aggregate-expiry.ts
grep -q "describeCatalogHealth" vendor/dsh-codearts-auth/src/jet-hub-rpc.ts
grep -qE "if \(entry\?\.supportsImage === undefined\) return undefined" vendor/dsh-codearts-auth/src/cline-adapter.ts
grep -q "isLegalHostText" vendor/dsh-codearts-auth/src/openai-gateway/config.ts
grep -q "DSH_OPENAI_GATEWAY_HOST" vendor/dsh-codearts-auth/src/openai-gateway/config.ts
# trae 缓存命中率恒为 0 的修复（用户报障直指）：丢掉 `cacheReadTokens` 后
# DSH 作 `cacheReadTokens ?? 0` ⇒ 界面显示「缓存命中 0%」而非「—」。
grep -q "traeUsageFromTokenUsage" vendor/dsh-codearts-auth/src/trae.ts
grep -q "traeUsageFromTokenUsage" vendor/dsh-codearts-auth/src/trae-adapter.ts
# zcode captcha 首发主动带（读上游 skip_model_request 开关，省一发必然 3007 的先探）。
grep -q "noteUpfrontCaptcha" vendor/dsh-codearts-auth/src/captcha-requirement.ts
test -f vendor/dsh-codearts-auth/src/active-route.ts
test -f vendor/dsh-codearts-auth/src/context-window-store.ts
test -f vendor/dsh-codearts-auth/plugin-src/client/active-model-pill.js
test -f vendor/dsh-codearts-auth/src/zcode-entitlements.ts

# 5) UI 形态标记层接线自检（2026-10-12 新增）
# ⚠️ 为什么必须盯住：本层发布的 data-dsh-* 事实被 dsh-phone.css 消费。若 JS 里
#    的发布代码被上游覆盖或被人删掉，CSS 里的 [data-dsh-*] 选择器**不会报错**，
#    只会静默不命中 —— 表现是「抽屉/设置面板在窄屏下排版错乱」，而构建、
#    类型检查、单测全绿。这与胶囊既有各条自检防的是同一类形态。
#
# ⚠️ 匹配**代码形态**而非裸字符串（2026-10-12 实测踩到）：文件头注释里也列了这
#    5 个属性名，若只 `grep -q "data-dsh-mobile-form"`，把那几段实现整体删空、
#    只留注释，自检照样通过 —— 正是「假绿」。故一律锚定真实调用/赋值形态：
#    syncFlag(document.documentElement, 'data-dsh-…') 与 const X_TAG = 'data-dsh-…'。
#    ⚠️ 实现改用 syncFlag 而非 toggleAttribute 是为兼容上游极简测试垫片 ——
#    改实现时必须同步本段，否则自检失配会让构建直接中断（实测踩过）。
grep -qE "syncFlag\(document\.documentElement, 'data-dsh-mobile-form'" app/src/main/assets/dsh-phone.js
grep -qE "FRAME_TAG = 'data-dsh-frame'" app/src/main/assets/dsh-phone.js
grep -qE "SETTINGS_TAG = 'data-dsh-settings-dialog'" app/src/main/assets/dsh-phone.js
grep -qE "syncFlag\(document\.documentElement, 'data-dsh-modal-open'" app/src/main/assets/dsh-phone.js
grep -qE "syncFlag\(document\.documentElement, 'data-dsh-settings-open'" app/src/main/assets/dsh-phone.js
# 抽屉开合状态（三期的共享通道：槽位组件与 dsh-phone.js 都读这一份）
grep -qE "syncFlag\(document\.documentElement, 'data-dsh-drawer-open'" app/src/main/assets/dsh-phone.js
# 抽屉打开时必须**展开**被折叠的侧栏（2026-10-13 用户报障修复的接线）。
# ⚠️ 这一条防的正是「逻辑存在但没被调用」：展开代码原先只写在旧自绘按钮专属的
#    开合函数里，三期把开关迁进槽位后就走不到了 ⇒ 抽屉弹出却只有图标列 + 大片空白。
#    那种失效构建/类型/单测**全绿**，只有真机点一下才看得见，与本节其它条同类。
# 锚定「上升沿」形态：若哪天被改成持续条件（open && collapsed），用户手动折叠侧栏
# 会被立刻弹回 —— 那是把旧 bug 换成新 bug，故一并锁住形态。
grep -qE "open && !drawerWasOpen && frame\.hasAttribute\('data-sidebar-collapsed'\)" app/src/main/assets/dsh-phone.js
grep -qE "let drawerWasOpen = false" app/src/main/assets/dsh-phone.js
# 宽屏下菜单按钮必须**代理**给上游侧栏开关（否则是死按钮：属性翻转被 adapt 当场撤销）
grep -qF "__dshWideProxy = true" app/src/main/assets/dsh-phone.js
grep -qF "railToggle.click()" app/src/main/assets/dsh-phone.js
# 侧栏实体标签（4 条规则优先用它，抽掉则退回哈希依赖）
grep -qE "RAIL_TAG = 'data-dsh-rail'" app/src/main/assets/dsh-phone.js
# 断点必须与 CSS 一致（JS 767 而 CSS 700 会造成 701-767px 区间的半态）
grep -qE "MOBILE_FORM_MAX_WIDTH = 767" app/src/main/assets/dsh-phone.js
# CSS 侧必须真的消费标记层（否则标记发布了也没人用，等于白做）
grep -qF "[data-dsh-frame]" app/src/main/assets/dsh-phone.css
# 标记识别必须与覆盖层过滤解耦（设置面板若渲染进 [data-shell-overlay]，前者被
# 连带过滤掉就会静默永不发布 settings-open；实测该形态无任何报错）
grep -qE "querySelector\('\[data-shortcut-modal=" app/src/main/assets/dsh-phone.js
test -f app/src/main/assets/ui-anchors.json
test -f scripts/check-ui-anchors.mjs
test -f scripts/ui-anchor-scan.mjs
test -f scripts/ui-slot-inventory.mjs
test -f scripts/ui-slot-register-audit.mjs
test -f scripts/ui-baseline-merge.mjs
# 三期抽屉开关的接管事实：组件发布、CSS 消费，两处缺一即静默失效。
# ⚠️ 形态层 JS **刻意不读**该事实（纯视觉交接，与遮罩的行为交接不同）——故只查这两处。
grep -qE "data-dsh-toggle-mounted" phone-qq/cards-client.js
grep -qE "html\[data-dsh-toggle-mounted\]" app/src/main/assets/dsh-phone.css
test -f scripts/ui-native-token-plan.mjs
# 原生 token 的双态**必须成对**：深色缺同名 token 时，运行期会静默取不到值。
# （实测 9 个 token 全部浅深不同 —— 正是接入的目的；缺一个就少一处跟随系统深色。）
for tok in ds_bg ds_surface ds_border ds_text_primary ds_text_secondary ds_accent ds_ok ds_warn ds_danger; do
  grep -q "name=\"$tok\"" app/src/main/res/values/ds_colors.xml || { echo "::error::浅色缺 token $tok"; exit 1; }
  grep -q "name=\"$tok\"" app/src/main/res/values-night/ds_colors.xml || { echo "::error::深色缺 token $tok（双态必须成对）"; exit 1; }
done
# 原生 token **接入自检**：文件铺过去还不够，必须真的被 Kotlin 引用 ——
# 否则「token 定义了但没人用」，深色模式依旧不跟随，且**不报错**（正是本方案反复防的形态）。
grep -q "R.color.ds_" app/src/main/java/com/dshphone/MainActivity.kt || { echo "::error::MainActivity.kt 未消费 ds_* token（接入失效）"; exit 1; }


# 6) UI 锚点门禁（离线层）：CSS 与 JS 引用的上游哈希必须全部登记在映射表里。
#    这是「上游升级导致样式/逻辑静默失效」的第一道防线，CI 无引擎树也能跑。
#    ⚠️ 两个消费面都要查：只查 CSS 会漏掉仅 JS 使用的锚点（如 .hHd-Xa_toggle
#    用来展开抽屉、.uV2eYG_add 用来点开上传菜单）——那类失效表现为「少了个功能」
#    而不报错，因为 querySelector 返回 null 后被 ?. / if(!x) 静默跳过。
node scripts/check-ui-anchors.mjs

# 6.5) UI 图层健康检查：拦「代码与样式对不上且不报错」的三类腐化 ——
#      状态类无 CSS 消费（切换是死代码）、死 CSS、未定义变量。
#      实测这套判据在开发中先后误报过 5+2+3 项（创建标记/外部契约/拼接设置被
#      当成问题），修正后才只剩真问题；故 test 里对「能检出」与「不误报」双向断言。
node scripts/ui-layer-audit.mjs
node scripts/ui-tests/layer-audit.test.mjs

# 6.7) CSS 结构校验：本轮对 dsh-phone.css 做了多轮机械替换，花括号配平不足以
#      证明结构合法（注释未闭合/声明体混入文字/空选择器都会让浏览器**静默丢弃规则**）。
node scripts/ui-css-validate.mjs
node scripts/ui-tests/css-validate.test.mjs

# 6.75) Android 资源校验：本层新增 3 个 res 文件（语义色双态 + 尺寸）。格式不对会让
#       gradle 资源编译**直接失败**（硬阻断，非静默）。本机无 gradle/java 跑不了
#       aapt2，故用等价的结构+格式检查提前拦住常见错法。
node scripts/ui-res-validate.mjs
node scripts/ui-tests/res-validate.test.mjs

# 6.85) WebView 兼容下限：本项目 compat.js 在运行时补 Chrome 97–119 的新 API，说明
#       目标内核可能相当老。本层若引入更老的越界特性，设备上会静默失效或抛错。
node scripts/ui-compat-floor.mjs
node scripts/ui-tests/compat-floor.test.mjs

# 6.8) 上游语义锚点清单（**信息性，不阻断**）：找出本层仍在裸用 hash、但上游同元素
#      发布了稳定语义属性的位置（如 [data-rightbar-col] ↔ .pI_x6G_rightbarCol）。
#      替换是渐进的，故本步恒 exit 0，只打印候选项供维护者继续降低脆弱面。
DSH_TREE="${DSH_TREE:-/data/user/0/com.dshphone/files/tree}"
if [ -d "$DSH_TREE/node_modules/@deepseek-ai" ]; then
  node scripts/ui-semantic-anchors.mjs --tree "$DSH_TREE" || true
else
  echo "跳过语义锚点清单（本环境无引擎树）"
fi

# 7) 槽位契约校验（方案 B 三期的前置）：三期的迁移目标是「把硬塞 DOM 的控件
#    改注册到上游槽位」。槽位名写错或上游删槽时，注册代码**不报错**——slots.inject
#    永远等服务、控件静默不出现（本项目实测：settings.dev.item 在 0.2.1-alpha.1
#    已不存在，而参考项目恰是按它写的）。故把这份契约钉在构建期。
node scripts/ui-slot-inventory.mjs --check

# 8) 槽位注册审计：dsh-phone-qq 与 dsh-peer 由同一份 client-source.js 产出，天然
#    同 id。只要两者都进 profile bundles，keyed 槽就「先到者赢、后者静默消失」
#    （用户只看到面板没了，无任何报错）。本步在「真实冲突」出现时构建失败；
#    「潜在冲突」（生成关系 / 未装包）只登记不阻断。
node scripts/ui-slot-register-audit.mjs

# 9) 槽位注册**运行时**验证：静态审计只能发现「表里的冲突」，发现不了
#    「bundle 根本跑不起来」（factory 抛错 / 漏声明 inject / register 形态不符上游
#    契约）。本步按壳侧真实装载协议（window.__ModuleLoader__.load）执行产物并断言
#    注册行为——这正是三期迁移时最需要的那层保险。
#    注：被审产物属上游文件，胶囊工作区不含；无输入时该测试自行跳过（不算失败）。
node scripts/ui-tests/slot-register-runtime.test.mjs

# 9.5) 三期配方的**可执行性**：把 MIGRATION[].recipe.code 当源码真正跑一遍。配方若
#       引用了未定义的组件或错误的 ctx API，设备上才发现就太晚了（那时已改完一堆
#       文件）。本步实测已抓出 2 条配方缺组件定义（照抄即 ReferenceError）。
node scripts/ui-tests/recipe-executable.test.mjs

# 9.7) 真实 SlotCore 契约：用上游实现验证「注册到未声明的槽会怎样」。实测：
#       未声明 → 直接 throw「slot "X" is not declared」；同 id 二次注册 → 也 throw。
#       ⇒ 「host 未声明该槽」是硬失败（先前据注释推断为「只是到达顺序」是错的）。
#       无引擎树时本步自行跳过（不假装通过）。
node scripts/ui-tests/slot-core-contract.test.mjs

# 9.8) 端到端链路（**三期最大未知的确证**）：真实 renderer + 真实 SlotCore + 真 React，
#       串起「加载 renderer → 建槽 → 注册 → 查出 → 渲染」完整链路。此前各层只能分别
#       证明局部，这是唯一把三者串起来的验证。无引擎树时自行跳过。
node scripts/ui-tests/slot-chain-e2e.test.mjs

# 10) 客户端模块表契约：三期槽位组件能否用 react hooks / ctx.slots，完全由壳侧
#     静态模块表（seed）决定——表里没有就解析失败，且失败形态是「组件静默不渲染」
#     而非报错。故把这张表钉住：上游移除条目时构建期报红。
#     注：表在前端产物里（dist/assets），胶囊工作区无引擎树时本步自行跳过。
#
#     ⚠️ 守卫必须判断**树实际存在**，不能用 `-n "${DSH_TREE:-}"`：
#        第 6.8 步已给 DSH_TREE 赋了默认值（手机路径）⇒ `-n` 恒真 ⇒ CI 上必然带着
#        不存在的路径进 ui-module-seed ⇒ exit 2 中断整个构建。
#        2026-10-13 实测踩到（run 38318714316：apply.sh 步骤失败，日志末行
#        「引擎树不存在：/data/user/0/com.dshphone/files/tree」）。
#        ui-module-seed 本身也已改为「缺树即跳过」，此处再补一道守卫，双保险。
SEED_TREE="${DSH_TREE:-/data/data/com.dshphone/files/tree}"
if [ -d node_modules/@deepseek-ai/dsh-web-frontend/dist/assets ] ||
   [ -d "$SEED_TREE/node_modules/@deepseek-ai" ]; then
  node scripts/ui-module-seed.mjs --tree "$SEED_TREE"
else
  echo "跳过模块表契约校验（本环境无引擎树产物：$SEED_TREE）"
fi

# 11) CI 兼容性：本层多数检查依赖「引擎树」（本地有、CI 没有）。本步在缺引擎树的
#     前提下逐个跑关键脚本，确保它们「跳过而非崩」—— 否则 CI 会红得像代码坏了。
#     实测踩过：ui-slot-register-audit 早期找不到上游文件时 exit=2，而 CI 恰好没有；
#     slot-inventory 的占用断言在 DSH_TREE 指向不存在路径时假红。
node scripts/ui-tests/ci-compat.test.mjs

# 12) 上游垫片兼容性：本层产物会被 build-assets.py 复制成 phone-qq/presentation.js，
#     而上游自带的 presentation.test.js 会用**极简 document 垫片**执行它。
#     本层若依赖垫片缺失的 DOM 方法（实测踩过 toggleAttribute），上游测试会直接抛错 ——
#     这是「本层把上游测试打红」的跨包回归，不在本层测试视野里。
node scripts/ui-tests/host-test-compat.test.mjs

# 13) 三期迁移自检：抽屉遮罩已迁到 shell.overlay 座位，采用「挂载即接管 + 失败降级」。
#     本步核查三件事：
#       · 接管机制完整（JS 读事实让位、CSS 能压过原显示规则 —— 否则两遮罩重叠）
#       · 降级路径保留（组件未渲染时本地实现照常工作，不会「遮罩彻底消失」）
#       · 产物已重新生成（源改了而产物没同步 ⇒ 设备上跑的还是旧代码）
#     另核查 inject 前置条件：shell.overlay 由 dsh-client-ui-layout 声明，上游所有
#     同槽注册者都声明了它；未声明则无法保证 layout 先到达 —— 而注册未声明的槽会 throw。
node scripts/ui-tests/mask-takeover.test.mjs
grep -q '"@deepseek-ai/dsh-client-ui-layout"' phone-qq/package.json
# 14) 产物装载：按真实 __ModuleLoader__ 协议装载本层**生成的** bundle，
#     调用它的 factory 与 apply，并用**上游真实 SlotCore** 校验每条注册被接受。
#     静态断言保证「该有什么」，本步保证「真的能被装载并被 host 接受」。
node scripts/ui-tests/plugin-bundle-load.test.mjs
# 行为复核（不只看代码形态）：真的执行 dsh-phone.js，检查「接管事实在场时
# 本地遮罩是否让位」。静态断言只看得到代码里写了什么。
node scripts/ui-tests/mask-takeover-behavior.test.mjs
echo "胶囊外挂应用完成"
