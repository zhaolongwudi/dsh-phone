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

# 1) 胶囊独有源文件（须为全新增路径，不覆盖任何上游文件 —— 由 1.5 的门禁保证）
#
# ⚠️ 门禁必须在**铺开之前**取快照：`files/` 一铺开，上游工作树里哪些路径本来就有
#    就再也分不清了（Issue F-03）。
UPSTREAM_TREE_SNAPSHOT="$(mktemp)"
find . -type f -not -path './.github/capsule/*' -not -path './.git/*' \
  | sed 's|^\./||' | sort > "$UPSTREAM_TREE_SNAPSHOT"
# ⚠️ AndroidManifest.xml 是**整份覆盖**（见 overrides/app/src/main/AndroidManifest.xml
#    的维护须知）：上游日后新增组件会被这份覆盖**静默遮蔽**。故先取其 `android:name`
#    清单，覆盖后由 2.7 的门禁比对（Issue F-28 的配套防线）。
UPSTREAM_MANIFEST_NAMES="$(mktemp)"
grep -o 'android:name="[^"]*"' app/src/main/AndroidManifest.xml | sort -u > "$UPSTREAM_MANIFEST_NAMES" || true
cp -a .github/capsule/files/. .

# 2) 接线覆盖文件（基线 = 上游 0.1.60 同名文件 + 胶囊接线）
cp -a .github/capsule/overrides/. .

# 1.5/2.5) 防撞自检（Issue F-03）：`files/` 必须是**全新增路径**。
#
# ⚠️ 为什么需要它：`files/` 的语义是「全新增，不覆盖上游」，但原实现**没有任何检查**
#    —— 上游日后新增一个与我们同路径的文件时，`cp -a files/. .` 会**静默覆盖**它，
#    构建、类型检查、单测全绿，谁也不知道上游那份文件没了。
#    （该风险不是假设：本轮审查就查出 `files/` 下有三个测试 spec 与上游同名，
#     一直在静默遮蔽上游的同名测试 —— 已迁到 `overrides/` 表明「这是有意的覆盖」。）
# ⚠️ 判据是**路径存在性**，不是内容：内容相同也会在将来漂移，不值得开例外。
if [ -s "$UPSTREAM_TREE_SNAPSHOT" ]; then
  COLLIDING_FILES="$(
    cd .github/capsule/files && find . -type f | sed 's|^\./||' | sort \
      | comm -12 - "$UPSTREAM_TREE_SNAPSHOT"
  )"
  if [ -n "$COLLIDING_FILES" ]; then
    echo "::error::capsule files/ 下有与上游工作树同路径的文件（会静默覆盖上游内容，Issue F-03）。"
    echo "::error::若确实要覆盖上游同名文件，请把它移到 overrides/（那是覆盖的既定位置）："
    echo "$COLLIDING_FILES"
    exit 1
  fi
fi

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

# 2.6) 覆盖文件与上游同名的**清单登记**（Issue F-03）。
#      与 1.5 互补：1.5 管「files/ 不许撞上游」，这里管「overrides/ 撞了上游是**有意**的」。
#      ⚠️ 只打印清单、不做断言 —— overrides/ 撞上游是它的本职。
#      之所以要打印：一旦上游大改被覆盖的文件，构建会以 tsc/测试失败告警（见 README），
#      但那需要人知道「这个文件是被覆盖的」；清单一目了然。
echo "── overrides/ 覆盖的上游同名文件（$(comm -12 \
    <(cd .github/capsule/overrides && find . -type f | sed 's|^\./||' | sort) \
    "$UPSTREAM_TREE_SNAPSHOT" | wc -l) 个）"
rm -f "$UPSTREAM_TREE_SNAPSHOT"

# 2.7) AndroidManifest.xml 整份覆盖的**漂移门禁**（Issue F-28 的配套防线）。
#      overrides/app/src/main/AndroidManifest.xml 是整份覆盖，只为给 MainActivity 加一个
#      `android:configChanges`。上游日后新增 service / receiver / activity / provider
#      （或新增权限声明）时，这份覆盖会**静默遮蔽**它们 —— 表现为「上游加了个组件，
#      但装出来的 APK 里没有」，而构建、类型检查、单测全绿。
#      ⚠️ 判据取**超集**（覆盖 ⊇ 上游）而非相等：我们只允许加，不允许丢。
MISSING_MANIFEST_NAMES="$(
  comm -23 "$UPSTREAM_MANIFEST_NAMES" \
    <(grep -o 'android:name="[^"]*"' app/src/main/AndroidManifest.xml | sort -u)
)"
rm -f "$UPSTREAM_MANIFEST_NAMES"
if [ -n "$MISSING_MANIFEST_NAMES" ]; then
  echo "::error::AndroidManifest.xml 的胶囊覆盖丢失了上游声明的 android:name（整份覆盖遮住了上游新增项）："
  echo "$MISSING_MANIFEST_NAMES"
  echo "::error::请把上游新增项同步进 .github/capsule/overrides/app/src/main/AndroidManifest.xml。"
  exit 1
fi

# 2.8) rc.11 包改名迁移（dsh-codearts-auth → dsh-providers-hub）
#
# 背景：上游 0.2.0-rc.11 的提交「改名，版本」把包名从 `dsh-codearts-auth` 改成
#       `dsh-providers-hub`。DSH 是**按包名字符串寻址 bundle**的（profile 的
#       dependencies 键 + bundles 项），故改名必须**整链一致**；改一半就是静默失效。
#       作者在包的 `cordis.patch.yml` 里也写了同样的注意事项。
#
# ⚠️ 上游自己只改了 3 个文件（package.json / cordis.patch.yml / README），
#    `plugin-src/client/build.mjs` 的 loaderId **漏改** ⇒ bundle 仍按旧名注册，
#    而宿主按新名校验（客户端期望的 id 取自 package.json 的 name —— 见
#    dsh-client-modules 的 `graphRow(packageName, …)`）⇒ 装上就起不来：
#      `loaded without registering "dsh-providers-hub" via __ModuleLoader__.load`
#    该漏改由本胶囊修（overrides/.../plugin-src/client/build.mjs 的 loaderId）。
#
# ⚠️ 为什么用**就地精确替换**而不是往 overrides/ 丢整份文件：
#    这两个文件上游仍在演进，整份覆盖会**静默遮蔽**上游后续修复（overrides/ 不受
#    §1.5 防撞门禁保护）。就地替换 + 每处**落地断言**：上游一旦挪动这段文本就立刻
#    硬失败，不会静默漂移成「以为改了其实没改」。
#
# ⚠️ 本段跑在 workflow「注入资源版本」**之后**，故不会把 ASSET_VERSION 冲回硬编码值
#    （那会让 scripts/build-assets.py 的 validate_asset_version 硬失败）。
node - <<'CAPSULE_RENAME_PATCH'
const fs = require('fs');
let bad = 0;
let patched = 0;
const patch = (file, from, to, label) => {
  if (!fs.existsSync(file)) { console.error('::error::改名迁移：找不到 ' + file); bad++; return; }
  const s = fs.readFileSync(file, 'utf8');
  const hits = s.split(from).length - 1;
  if (hits !== 1) {
    console.error('::error::改名迁移：' + label + ' 的锚点命中 ' + hits + ' 次（应为 1）。');
    console.error('::error::上游挪动了这段文本 —— 请对照新版上游重写 apply.sh §2.8。');
    bad++;
    return;
  }
  fs.writeFileSync(file, s.replace(from, to));
  patched++;
  console.log('  ✓ ' + label);
};

// ① 部署清单一：build-assets.py 的 BUNDLES 与部署目标名
patch('scripts/build-assets.py',
  "BUNDLES = ('dsh-codearts-auth',",
  "BUNDLES = ('dsh-providers-hub',",
  'build-assets.py BUNDLES');
patch('scripts/build-assets.py',
  "    for name, source in [('dsh-codearts-auth', ROOT / 'vendor/dsh-codearts-auth'),",
  "    for name, source in [('dsh-providers-hub', ROOT / 'vendor/dsh-codearts-auth'),",
  'build-assets.py 部署目标名（源路径不变）');
patch('scripts/build-assets.py',
  '    # ESM tests and local editing resolve the same hoisted dependency tree.',
  [
    '    # rc.11 改名：runtime 的依赖键仍是旧名（改它会牵动 pnpm-lock 的 peer 解析哈希，',
    '    # 而本机无法忠实重算）⇒ pnpm 装出的是旧名目录；部署树只用新名，故清掉旧名副本',
    '    # （避免同一份插件在树里存两份，也避免被残留的旧 profile 条目解析到）。',
    "    shutil.rmtree(MODULES / 'dsh-codearts-auth', ignore_errors=True)",
    '    # ESM tests and local editing resolve the same hoisted dependency tree.',
  ].join('\n'),
  'build-assets.py 清理旧名副本');

// ② 出厂 profile 模板（新装用户的 profile）
patch('home-template/profiles/phone/package.json',
  '    "dsh-codearts-auth": "file:./node_modules/dsh-codearts-auth",',
  '    "dsh-providers-hub": "file:./node_modules/dsh-providers-hub",',
  'profile 模板 dependencies 键');
patch('home-template/profiles/phone/package.json',
  '        "dsh-codearts-auth",',
  '        "dsh-providers-hub",',
  'profile 模板 bundles 项');

// ③ 恢复模式的保护清单（RecoveryManager.protectedBundles）：
//    它决定「快照回滚时哪些 bundle 不受影响」。用旧名会让插件**不被识别为受保护**
//    ⇒ 一旦走恢复流程，它可能被当作用户安装的条目回滚掉。
patch('app/src/main/java/com/dshphone/RecoveryManager.kt',
  '"dsh-codearts-auth", "dsh-phone-account"',
  '"dsh-providers-hub", "dsh-phone-account"',
  'RecoveryManager 保护清单');

// ④ 受保护内置清单（peer/controlled-market/catalog.mjs 的 BUILTINS）：
//    它经 protectedName() 被**活跃使用** —— 受控市场的「不能覆盖安装」
//    （trials.mjs）、试装按钮 canTrial（index.mjs）、workflow-hub 的 guard 都看它。
//    旧名不在新名上 ⇒ 核心插件失去保护、并会冒出「试装」按钮（可被社区版覆盖）。
patch('peer/controlled-market/catalog.mjs',
  "export const BUILTINS = new Set(['@zseven-w/dsh-noema', 'dsh-codearts-auth',",
  "export const BUILTINS = new Set(['@zseven-w/dsh-noema', 'dsh-providers-hub',",
  'peer 受保护内置清单');

// ⑤ 设备端**升级**迁移（老设备的 profile 里已是旧名，必须双向改）
patch('app/src/main/java/com/dshphone/NodeRunner.kt',
  [
    '            listOf("dsh-codearts-auth", "dsh-phone-account", "dsh-phone-qq", "@zseven-w/dsh-noema").forEach { bundle ->',
    '                if ((0 until bundles.length()).none { bundles.optString(it) == bundle }) bundles.put(bundle)',
    '                dependencies.put(bundle, "file:./node_modules/$bundle")',
    '            }',
  ].join('\n'),
  [
    '            /* ⚠️ 手机版改名迁移（rc.11：dsh-codearts-auth → dsh-providers-hub，见 apply.sh §2.8）。',
    '               必须**双向**：只加新名 ⇒ 旧入口残留 ⇒ 同一插件被加载两次',
    '               （client-modules 报 resolves from multiple active Loader sources）；',
    '               只删旧名不加新名 ⇒ 插件完全不加载。两者都是静默失效。 */',
    '            for (legacy in listOf("dsh-codearts-auth")) {',
    '                for (i in bundles.length() - 1 downTo 0) if (bundles.optString(i) == legacy) bundles.remove(i)',
    '                dependencies.remove(legacy)',
    '                File(installedModules, legacy).deleteRecursively()',
    '            }',
    '            listOf("dsh-providers-hub", "dsh-phone-account", "dsh-phone-qq", "@zseven-w/dsh-noema").forEach { bundle ->',
    '                if ((0 until bundles.length()).none { bundles.optString(it) == bundle }) bundles.put(bundle)',
    '                dependencies.put(bundle, "file:./node_modules/$bundle")',
    '            }',
  ].join('\n'),
  'NodeRunner 双向 profile 迁移');

// ④ 落地断言：三处新名必须真的出现（防「patch 静默没生效」）
let checked = 0;
for (const [file, needle, label] of [
  ['scripts/build-assets.py', "'dsh-providers-hub',", 'build-assets.py'],
  ['home-template/profiles/phone/package.json', '"dsh-providers-hub"', 'profile 模板'],
  ['app/src/main/java/com/dshphone/NodeRunner.kt', '"dsh-providers-hub"', 'NodeRunner.kt'],
  ['app/src/main/java/com/dshphone/RecoveryManager.kt', '"dsh-providers-hub"', 'RecoveryManager.kt'],
  ['peer/controlled-market/catalog.mjs', 'dsh-providers-hub', 'peer BUILTINS'],
]) {
  checked++;
  if (!fs.readFileSync(file, 'utf8').includes(needle)) {
    console.error('::error::改名迁移后校验失败：' + label + ' 里没有新包名');
    bad++;
  }
}
if (bad > 0) { console.error('::error::改名迁移未完成（' + bad + ' 处）'); process.exit(1); }
console.log('  ✓ 改名迁移落地（' + patched + ' 处替换 + ' + checked + ' 处校验）');
CAPSULE_RENAME_PATCH

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
# 抽屉打开期间必须**禁用上游侧栏自带的折叠开关**（2026-10-13 用户报障「菜单与侧边栏
# 小按钮冲突」的修复）。三层证据链见 dsh-phone.css 内注释，这里锁住的是「规则在场」
# 这一最低条件 —— 选择器写错/被误删都属同一类静默失效（CSS 规则不报错，只是不命中，
# 表现是抽屉里点一下小按钮就折叠出 224px 空白）。
# ⚠️ 形态判据必须同时含 **drawer-open 事实**与**上游 toggle 哈希**：只查后者会与
#    「宽屏常驻列的折叠开关」混为一谈（那条必须保留，不能一刀切禁用）。
# ⚠️ 选择器边界必须收紧到逗号/花括号（2026-10-13 反向验证实测）：`[^{]*toggle`
#    这种写法分不出哈希被拼错（.hHd-Xa_toggleX 也匹配前缀）——自检若无区分力，
#    等于没有。故加 `[,{]` 边界，并用第三条排掉「toggle 后跟单词字符」的变体。
grep -qE "html\[data-dsh-drawer-open\][^{]*\.hHd-Xa_toggle[,{]" app/src/main/assets/dsh-phone.css \
  || { echo "::error::抽屉打开态未禁用上游侧栏折叠开关（hHd-Xa_toggle）——用户报障的空白将复现"; exit 1; }
if grep -qE "\.hHd-Xa_toggle[A-Za-z0-9_-]" app/src/main/assets/dsh-phone.css; then
  echo "::error::上游 toggle 哈希被拼成变体（规则永不命中）"; exit 1
fi
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


# 5.9) 引擎版本自检（2026-10-14 引擎 alpha.1→alpha.2 升级引入）。
#      runtime/ 是**上游仓库内容**，本层通过 overrides/runtime/ 覆盖它。这类覆盖的
#      失效形态很隐蔽：文件铺过去了，但版本号仍是旧值 ⇒ pnpm 装回旧引擎，
#      而构建照样成功，只有设备上跑的是旧引擎（「静默退回」）。
#      故在此把「铺的是 alpha.2」钉成硬断言。
ENGINE_VER_EXPECT='0.2.1-alpha.3'
grep -q "\"@deepseek-ai/dsh\": \"$ENGINE_VER_EXPECT\"" runtime/package.json \
  || { echo "::error::runtime/package.json 未指向 $ENGINE_VER_EXPECT（覆盖失效，会装回旧引擎）"; exit 1; }
grep -q "'@deepseek-ai/dsh-llm': $ENGINE_VER_EXPECT" runtime/pnpm-workspace.yaml \
  || { echo "::error::runtime/pnpm-workspace.yaml 的 dsh-llm override 未同步到 $ENGINE_VER_EXPECT"; exit 1; }
grep -q "specifier: $ENGINE_VER_EXPECT" runtime/pnpm-lock.yaml \
  || { echo "::error::runtime/pnpm-lock.yaml 未随引擎升级重建（frozen-lockfile 会装回旧版）"; exit 1; }
#      overlay 目录本身不能为空：全空会让 build-assets.py 的复制步骤静默无操作，
#      设备上跑纯上游产物 ⇒ Android 适配（bash/flock/session 原子发布）整块丢失。
test -d runtime/overlays/@deepseek-ai \
  || { echo "::error::runtime/overlays 缺失（Android 适配补丁整块丢失）"; exit 1; }
grep -q "DSH_PHONE_SHELL" runtime/overlays/@deepseek-ai/dsh-bash-local/lib/index.js \
  || { echo "::error::bash-local overlay 丢了 Android shell 适配"; exit 1; }
grep -q "materializeAndroid" runtime/overlays/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js \
  || { echo "::error::session-persistence overlay 丢了 Android 原子发布适配"; exit 1; }
# 5.95) vendor 插件 peer 版本自检（2026-10-14 alpha.1→alpha.2 事故引入）。
#      失效形态：引擎升到 alpha.2，而 vendor/dsh-codearts-auth 的 peerDependencies
#      仍钉 alpha.1 ⇒ 引擎的精确版本门禁判「不兼容」，**静默跳过整个 profile bundle**
#      （启动日志只有一行 "skipping profile bundle: ..."）⇒ 设备上 Jet Hub 整块消失，
#      构建、类型检查、单测全绿。与 §5.9 的 runtime 覆盖失效是同一类「静默退回」，
#      故同样钉成构建期硬断言；修复文件 = overrides/vendor/dsh-codearts-auth/package.json。
#      ⚠️ **2026-10-15 改造**：原判据是「peer 精确串等于 $ENGINE_VER_EXPECT」。
#      随后 Gitee rc.11 把 peer 改成**宽松范围**（`^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1`）——
#      实测该范围对 alpha.3 判定为 **true**，且**天然抗引擎升级**（不必每次升版都改 peer），
#      是上游的改进。精确串比对会把它误判为失配 ⇒ 被迫退回精确钉版，反而丢掉该设计。
#      故改为与 §5.97 同源：**调用引擎自身的判据**判定兼容性，而不是比字符串。
#      （判据权威 = `evaluatePluginCompatibility`，见 scripts/check-plugin-peers.mjs 文件头。）
#      ⚠️ **2026-10-15 改造（第二次）**：把 §5.95 的判定**并入 §5.97 的通用扫描**，
#      不再在这里自己写一份半成品判定。原因（CI run 38739058216 实测）：
#      第一版改造用 `node -e` + 内联 semver，并把「设备树路径」写死 —— 那只在本机成立，
#      CI 上没有该路径 ⇒ 打印「找不到 semver」硬失败。而 §5.97 的 check-plugin-peers.mjs
#      早已解决同一问题：它用 `runtime/tools/pnpm/dist/node_modules/semver`（仓库自带、永远在），
#      且**全扫** `runtime/package.json` 的全部 `file:` 依赖（含 dsh-codearts-auth）。
#      ⇒ 两套同义的 peer 判据必须合一（本仓库首条红线：一份判据，一处实现）。
#      本段只保留一条**清单登记**断言：dsh-codearts-auth 必须仍在受检清单里
#      （若它被从 runtime/package.json 摘掉，通用扫描就不再覆盖它 —— 那才是真正的静默缺口）。
VENDOR_MANIFEST="vendor/dsh-codearts-auth/package.json"
test -f "$VENDOR_MANIFEST" \
  || { echo "::error::缺少 $VENDOR_MANIFEST（Jet Hub 插件清单不在，引擎会整包跳过它）"; exit 1; }
grep -q '"dsh-codearts-auth": "file:' runtime/package.json \
  || { echo "::error::runtime/package.json 的 file: 依赖里没有 dsh-codearts-auth —— §5.97 的通用扫描将不再覆盖它（Jet Hub 会被引擎静默跳过而无人拦）"; exit 1; }
#      真正判定兼容性 = 下面 §5.97 的通用扫描（引擎判据 + 仓库自带 semver）。

# 5.97) **同类地雷的泛化扫描**（2026-10-14 同日追加）。
#      §5.95 只钉住了 Jet Hub 一个包，但事故的**成因是普遍的**：任何会被引擎当插件
#      加载的包，只要 peerDependencies 里 @deepseek-ai/dsh* 钉了一个**精确旧版**，
#      就会被同一条门禁判不兼容。故这里不逐个列举，而是**扫全部插件清单**：
#        · 判定权威 = 引擎自身的 evaluatePluginCompatibility（semver + includePrerelease）
#        · 覆盖范围 = runtime/package.json 的 file: 依赖（= build-assets.py 打进 APK 的插件）
#      实测教训：dsh-channel-qq 在 Jet Hub 修复后仍钉 alpha.1；它**当前不发作**
#      （不在 profile.bundles，patch 为空数组，走动态 import 不过门禁），
#      属**潜伏地雷**而非现症 —— 但一旦被加进 bundles/patch 就会立刻复现同类事故。
node scripts/check-plugin-peers.mjs
#      该门禁自身的**判别力反证**：它的失效形态是「静默变恒真」，必须双向断言
#      （精确旧版/空范围必须检出；caret 范围/非 dsh peer 必须放行）。详见该文件头。
node scripts/ui-tests/plugin-peers.test.mjs


# 6) UI 锚点门禁（离线层）：CSS 与 JS 引用的上游哈希必须全部登记在映射表里。
#    这是「上游升级导致样式/逻辑静默失效」的第一道防线，CI 无引擎树也能跑。
#    ⚠️ 两个消费面都要查：只查 CSS 会漏掉仅 JS 使用的锚点（如 .hHd-Xa_toggle
#    用来展开抽屉、.uV2eYG_add 用来点开上传菜单）——那类失效表现为「少了个功能」
#    而不报错，因为 querySelector 返回 null 后被 ?. / if(!x) 静默跳过。
node scripts/check-ui-anchors.mjs

# 6.2) **跨层类名契约门禁**（Issue F-19，2026-10-14 新增）。
#      6) 管的是**上游哈希**锚点；这一条管**插件侧类名** —— `.dim-jh-*` 由
#      dsh-codearts-auth 的 plugin-src 产出、由本层 app（dsh-phone.js/css）消费，
#      此前**无版本号、无断言、无测试锁**：插件侧改名即静默失效，而构建、类型检查、
#      单测全绿。F-15（窄屏徽标读数整块消失）与 F-16（账号拖拽触屏无效）正是因此
#      长期无人发现 —— 插件侧 CSS 是桌面口径，手机可用性完全靠本层注入维持。
#      ⚠️ 本脚本在资产不全时打印「跳过」并 exit 0（与 6) 同款），不会假红。
node scripts/check-plugin-contract.mjs
node scripts/ui-tests/check-plugin-contract.test.mjs

# 6.3) **胶囊提交产物的「产物↔源码」一致性门禁**（Issue F-68，2026-10-14 新增）。
#      `files/vendor/.../lib/active-route.js` 是**提交进胶囊的 tsc 产物**（不是构建期
#      生成的），而纯净构建（DISABLED）直接用仓库预编译 lib ⇒ 源码改了而产物没同步时，
#      设备上跑的还是旧代码，且**没有任何报错**。本步用设备树 typescript 现场 emit
#      再逐行比对。
#      ⚠️ 需要 typescript：本机由设备树提供；**CI 在本阶段拿不到**（vendor 的
#      devDependencies 要到后面 `rebuild-vendor.sh` 才安装，而本步在它之前跑）。
#      故脚本在 CI 且无 TS 时打印「⏭ 跳过」并 exit 0，由 build-apk.yml 的
#      「门禁：胶囊产物与源码一致（F-68）」步骤在 vendor 依赖就绪后带
#      `CAPSULE_ARTIFACT_GATE_REQUIRED=1` **补跑**；那一步缺 TS 是硬失败，
#      不存在「两边都跳过」的静默失效。本机缺 TS 仍是硬失败（判据缺失 ≠ 通过）。
node scripts/check-capsule-artifacts.mjs

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

# 15) 2026-10-14 深度审查（P0/P1）修复的**接线自检**。
#     这一段全部是「抽出的实现正确 ≠ 被正确调用」形态的锚点：丢掉它们不会报错，
#     只会静默退回缺陷态。每条都注明 Issue 编号。
#
# —— F-01 发布包不得是 debuggable ——
#   init script 必须存在；**胶囊模板** workflow 必须真的用 `-I` 引它；产物门禁必须还在。
#   ⚠️ 判据只钉**胶囊模板**（`.github/capsule/build-apk.yml`）—— 它才是本仓库可控的
#      真相源：`.github/workflows/build-apk.yml` 由 `sync-upstream.yml` 从模板恢复。
#      在**尚未 sync 的检出**（如本地新克隆、CI 首次跑）里，运行期 workflow 仍是上游
#      原版、**不含** `-I`，此时硬失败会误报（实测：干净树上 apply.sh 因此 exit 1）。
#      ⇒ 运行期那份改为**提示**（不是断言）：它一旦被 sync 覆盖就会带上。
test -f scripts/no-debuggable.gradle
grep -qF -e "debuggable = false" scripts/no-debuggable.gradle
grep -qF -e "-I .github/capsule/files/scripts/no-debuggable.gradle" .github/capsule/build-apk.yml
grep -qF -e "application-debuggable" .github/capsule/build-apk.yml
#   运行期 workflow：**与胶囊模板逐字节相同**才算「已由 sync-upstream 恢复」，
#   那时才断言（否则它仍是上游原版，断言会误报）。
#   ⚠️ 不能用「内容里出现 capsule 字样」当判据 —— 上游原版 build-apk.yml **本身就**
#      引用 `.github/capsule/apply.sh` / `update-readme.py`（实测：该判据让干净树上的
#      apply.sh 假红）。
if [ -f .github/workflows/build-apk.yml ]; then
  if cmp -s .github/capsule/build-apk.yml .github/workflows/build-apk.yml; then
    grep -qF -e "-I .github/capsule/files/scripts/no-debuggable.gradle" .github/workflows/build-apk.yml
    grep -qF -e "application-debuggable" .github/workflows/build-apk.yml
  else
    echo "::warning::.github/workflows/build-apk.yml 与胶囊模板不一致（尚未由 sync-upstream 恢复）；恢复后即带上 F-01 的 -I 与产物门禁。"
  fi
fi
#   WebView 远程调试必须显式关闭（默认值随 debuggable 走，不能依赖默认）。
grep -qF -e "setWebContentsDebuggingEnabled(false)" app/src/main/java/com/dshphone/MainActivity.kt
#
# —— F-68 产物一致性门禁的「补跑点」必须存在 ——
#   该门禁在 apply.sh 里跑时 CI 还没有 typescript（vendor devDependencies 要到
#   rebuild-vendor.sh 才装），故 CI 上它打印「⏭ 跳过」，真正的判定被**延迟**到
#   workflow 的补跑步骤。⇒ 补跑步骤就是这道门禁在 CI 上的唯一执行点：
#   一旦它被误删/被改名，CI 会**全绿地失去这道门禁**（本步只是普通调用，
#   不带 REQUIRED，跳过不报错）。故这里把「补跑点存在」钉成构建期断言。
#   跑在**胶囊模板**上（真相源）；运行期那份同 F-01，一致时才断言。
grep -qF -e "CAPSULE_ARTIFACT_GATE_REQUIRED" .github/capsule/build-apk.yml
grep -qF -e "check-capsule-artifacts.mjs" .github/capsule/build-apk.yml
if [ -f .github/workflows/build-apk.yml ]; then
  if cmp -s .github/capsule/build-apk.yml .github/workflows/build-apk.yml; then
    grep -qF -e "CAPSULE_ARTIFACT_GATE_REQUIRED" .github/workflows/build-apk.yml
    grep -qF -e "check-capsule-artifacts.mjs" .github/workflows/build-apk.yml
  elif ! grep -qF -e "check-capsule-artifacts.mjs" .github/workflows/build-apk.yml \
    && ! grep -qF -e "CAPSULE_ARTIFACT_GATE_REQUIRED" .github/workflows/build-apk.yml \
    && grep -qF -e "no-debuggable.gradle" .github/workflows/build-apk.yml; then
    # ⚠️ 运行期**既不是**胶囊模板、**也不含**补跑点，但它确实是本仓库的 workflow
    #    ⚠️ 判据用「含 `no-debuggable.gradle`」而不是「含 `capsule/apply.sh`」：前者
    #    （实测上游原版 0 命中、胶囊模板 2 命中），后者上游原版也有（1 命中）⇒ 用它会把
    #    「尚未 sync 的干净检出」误判成「门禁被改坏」（有牙测试 C 场景实测）。
    #    三者同时成立才判为「本仓库的 workflow 被人改过、且补跑点没了」。
    #    「本仓库的 workflow 被人改过、且补跑点没了」）。
    #    这与 F-01 的「尚未 sync」不同：那是合法的中间态；这里是**门禁被改坏**。
    #    若不硬失败，CI 会全绿地失去 F-68 产物一致性门禁（apply.sh 内那次调用不带
    #    REQUIRED、CI 上必然打印「⏭ 跳过」，补跑点是它唯一的真实执行点）。
    echo "::error::.github/workflows/build-apk.yml 既不是胶囊模板、也没有 F-68 补跑点（check-capsule-artifacts.mjs / CAPSULE_ARTIFACT_GATE_REQUIRED）。"
    echo "::error::该门禁在 CI 上的唯一执行点就是那个补跑步骤 —— 它消失等于门禁全绿地失效。"
    echo "::error::修复：用 .github/capsule/build-apk.yml 覆盖运行期那份（sync-upstream 会做），或把补跑步骤补回。"
    exit 1
  fi
  # 其余情形（运行期是上游原版、尚未 sync）与 F-01 同款：由上面的 warning 提示，不硬失败。
fi
#
# —— F-02 / F-17 破坏性操作确认按钮文案 + `alert()` 接管 ——
#   肯定按钮不得再是「更新」；必须有 `onJsAlert`。
! grep -qF -e 'setPositiveButton("更新")' app/src/main/java/com/dshphone/MainActivity.kt
grep -qF -e 'setPositiveButton("确定")' app/src/main/java/com/dshphone/MainActivity.kt
grep -qF -e "override fun onJsAlert" app/src/main/java/com/dshphone/MainActivity.kt
#
# —— F-27 不在胶囊内的上游 asset 必须存在 ——
#   这两个文件由上游提供（胶囊既没有它们、也没法在 tsc/单测里发现缺失），
#   缺失时手机端表现是「页面白屏」，而构建全绿 ⇒ 必须显式 test -f。
test -f app/src/main/assets/dsh-phone.compat.js
test -f app/src/main/assets/dsh-phone.export.js
grep -qF -e "移动端样式 dsh-phone.css 读取失败" app/src/main/java/com/dshphone/MainActivity.kt
#
# —— F-28 旋转/深色不重建 Activity ——
grep -qF -e "android:configChanges=" app/src/main/AndroidManifest.xml
grep -qF -e "override fun onConfigurationChanged" app/src/main/java/com/dshphone/MainActivity.kt
grep -qF -e "override fun onSaveInstanceState" app/src/main/java/com/dshphone/MainActivity.kt
#
# —— F-04 聚合层「上下文窗口」必须按候选集推导、且瞬时故障不记忆化 ——
#   ⚠️ **2026-10-15 更新**：Gitee rc.11 用 `contextWindowFor`（从候选集**推导**窗口上限）
#      取代了胶囊此前的「按会话分桶观测 + 超限主动抛 CONTEXT_WINDOW_EXCEEDED」机制 ——
#      两套是不同架构，而 `context-window-learn.ts` 的注释里明确写着「**不要**拿历次观测的
#      峰值（`lastContextTokens` 那种跨轮累积值）」，即上游**有意淘汰**了旧机制。
#   ⇒ 断言改钉 rc.11 的机制：窗口推导存在、且「瞬时故障不记忆化」这条纪律仍在
#      （后者是该 issue 的真正要害：把瞬时故障固化会变成持续错误）。
grep -qF -e "private async contextWindowFor(" vendor/dsh-codearts-auth/src/aggregate-adapter.ts
grep -qF -e "resolved: boolean" vendor/dsh-codearts-auth/src/aggregate-adapter.ts
grep -qF -e "后者绝不能" vendor/dsh-codearts-auth/src/aggregate-adapter.ts
#
# —— F-05 / F-06 / F-07 / F-09 图片与工具回执形态（三个适配器必须同型）——
for adapter in openai-compat buddy-adapter lobsterai-adapter; do
  # F-06：有图无文时不得降级为字面量 `(no output)`
  grep -qF -e "resultText = joined.length > 0 ? joined : TOOL_RESULT_IMAGE_TEXT" \
    "vendor/dsh-codearts-auth/src/$adapter.ts"
  # F-05：纯图无文本的独立 user 条必须补回说明文本
  grep -qF -e "ownText.length > 0 ? ownText : [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }]" \
    "vendor/dsh-codearts-auth/src/$adapter.ts"
  # F-09：无图时必须 join 回字符串（纯文本 parts 数组会被上游 400）
  grep -qF -e "allText ? ownParts.map((part) => String(part.text)).join('') : ownParts" \
    "vendor/dsh-codearts-auth/src/$adapter.ts"
  # F-21：延后判据必须把「有挂图」与「有延后正文」都算进来。
  #   ⚠️ **2026-10-15 更新**：原断言钉的是**跨行写法**（`|| pendingToolImages.length > 0`），
  #      而 rc.11 用**单行写法**（`pendingToolImages.length > 0 || hasImage || pendingOwnParts !== undefined`）。
  #      语义相同、排版不同 ⇒ 改为**语义判据**：两个条件都必须出现在同一处 combined 判据里。
  #      （教训：断言钉排版会随上游格式调整而假红 —— 本仓库反复记录过这类「验证手段自身腐坏」。）
  grep -qE "pendingToolImages\.length > 0.*pendingOwnParts !== undefined|pendingOwnParts !== undefined.*pendingToolImages\.length > 0" \
    "vendor/dsh-codearts-auth/src/$adapter.ts"
done
# F-07：gemini 工具结果内层图必须提升为 inlineData
grep -qF -e "toolResultInlineImages" vendor/dsh-codearts-auth/src/gemini-messages.ts
grep -qF -e "pendingToolImages.push(...innerImages)" vendor/dsh-codearts-auth/src/gemini-messages.ts
#
# —— F-18 workbuddy 不得下发 reasoning_effort ——
grep -qF -e "suppressesProseWhenEffortSent" vendor/dsh-codearts-auth/src/buddy-adapter.ts
grep -qF -e "!suppressesProseWhenEffortSent(this.product.id)" vendor/dsh-codearts-auth/src/buddy-adapter.ts
#
# —— F-20 网关空名工具调用必须剔除而非 400 ——
grep -qF -e "isUsableToolCallId" vendor/dsh-codearts-auth/src/openai-gateway/messages.ts
grep -qF -e "collectCallAvailability" vendor/dsh-codearts-auth/src/openai-gateway/messages.ts
grep -qF -e "callIdAvailability" vendor/dsh-codearts-auth/src/openai-gateway/responses.ts

echo "胶囊外挂应用完成"
