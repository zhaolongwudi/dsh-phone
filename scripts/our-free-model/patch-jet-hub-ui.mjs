#!/usr/bin/env node
/**
 * 把**老 Jet Hub 的完整设置页**合并进 OFM 的客户端（补丁 G）。
 *
 * ## 为什么需要它
 *
 * 2026-10-16 把渠道引擎从独立插件 `dsh-providers-hub`（Jet Hub）换成 OFM 自带的
 * `vendor/channel-pack` 之后，**引擎能力全在、界面全丢**：
 *
 *   渠道包提供 62 个 RPC 端点，老 Jet Hub 客户端调用其中 **47** 个，
 *   而 OFM 自己的界面只接了 **23** 个。
 *
 * ⇒ 有 26 个端点对应的功能**在手机上没有任何入口**（逐项见 README 的对照表），
 * 包括聚合轮换面板、备份导入导出、Token 用量账本、短信登录、验证码、永久积分锁定、
 * 渠道重测/重置、供应商排序、原生搜索开关、已失效模型清理等。
 *
 * ## 做法
 *
 * 老客户端产物（`dsh-providers-hub/lib/client/jet-hub.js`，562 KB）**仍在设备上**，
 * 且满足三个条件，故可**整体复用**而不是逐功能重写：
 *
 *   1. 只 `require("react")`（宿主提供 18.3.1），**零其它依赖**；
 *   2. 调用的 47 个端点，渠道包**全部提供**（唯一不在 `jet-hub-rpc.ts` 里的
 *      `opencode.rotateFingerprint` 在同包的 `opencode-rpc.ts`）;
 *   3. 它要的 ctx 服务（slots / connection / modelDirectories / sessions /
 *      remote / remote.session）OFM 的 `inject` 已经全有（补丁 F 补齐）。
 *
 * 本脚本把它的 factory **函数体**抽出来，包成一个 IIFE 塞进 OFM 的 `client.js`：
 *
 *   · 内部符号全部落在 IIFE 作用域里 ⇒ 不污染 OFM 的模块作用域、不撞名；
 *   · 对外只暴露 `OFM_JET_HUB_UI`，OFM 在 `apply(ctx)` 里调一次它的 `apply`。
 *
 * ## ⚠️ 唯一一处「手术」：摘掉它自带的用量徽标
 *
 * 老 `apply` 会注册 `conversation.input.right` 槽位（id `jet-hub-usage`）。
 * 而 OFM 自己那枚徽标（补丁 F，id `our-free-model-usage`）**已经在同一槽位**上
 * —— 两个都注册就会在输入框里并排出现**两枚一模一样的胶囊**（用户可见的回归）。
 *
 * ⇒ 抽取时把那一段注册语句**整条删除**（它是自包含的一条语句，边界明确）。
 * 徽标本身不受影响：OFM 那枚现在是完整的（含本轮修的双键读数）。
 * `UsageBadge` 组件仍留在 IIFE 里成为未引用符号，无害。
 *
 * ## 保留的东西
 *
 * · `installJetHubStyles()` —— 设置页的样式表，**必须保留**；
 * · `startCarrierContribution()` —— zcode 内部载体贡献循环，在 Web 上是
 *   **安全空操作**（`readDesktopBridge()` 取不到 bridge 就直接返回 no-op），
 *   桌面端才有实际行为。
 *
 * 用法：
 *   node patch-jet-hub-ui.mjs --check
 *   node patch-jet-hub-ui.mjs --apply
 *   node patch-jet-hub-ui.mjs --revert
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const PROFILE = path.join(HOME, 'profiles/phone/node_modules');
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
/** 老客户端产物的候选路径：**先 profile，后 APK 树**（两份逐字节相同，互为兜底）。 */
const JET_HUB_CLIENT = [
  path.join(PROFILE, 'dsh-providers-hub/lib/client/jet-hub.js'),
  '/data/data/com.dshphone/files/tree/node_modules/dsh-providers-hub/lib/client/jet-hub.js',
].filter((p) => fs.existsSync(p));

const PLUGIN_DIRS = [LOCAL, path.join(PROFILE, 'dsh-our-free-model')];
const MARK = 'OFM_JET_HUB_UI';

/**
 * 目标 client.js 列表。
 *
 * ⚠️ `OFM_G_TARGETS`（冒号分隔）可覆盖为任意路径 —— **先对副本验证再动线上文件**。
 * 这是本仓库既有的取向：改客户端产物一旦出错会让整个 Web 界面白屏，必须先在
 * 副本上跑 `headless-client-check.mjs` 通过，才允许落到真实安装位置。
 */
const targets = () => {
  const override = process.env.OFM_G_TARGETS;
  if (override !== undefined && override.length > 0) return override.split(':').filter((s) => s.length > 0);
  return PLUGIN_DIRS.map((d) => path.join(d, 'client.js'));
};

/**
 * 老 factory 体的边界（都验证过唯一）。
 *
 * ⚠️⚠️ 起点是 `var exports = module.exports;` 这行的**前一行**（含 `var module`），
 * 原因有两层，两层都真实踩过：
 *
 * ① **导出接线在 `var module` 与 `var exports` 之间之后**：esbuild 的产物是
 *
 *      var module = { exports: {} };
 *      var exports = module.exports;
 *      var client_exports = {};
 *      __export(client_exports, { apply: () => apply, … });
 *      module.exports = __toCommonJS(client_exports);   ← 真正的导出在这里
 *
 *    只从 `var exports` 开始切，会丢掉 `module.exports = __toCommonJS(...)`，
 *    IIFE 返回空对象 ⇒ `OFM_JET_HUB_UI.apply` 为 `undefined`（实测：槽位从 4 掉到 0）。
 *
 * ② **`var exports = module.exports;` 必须与它自己的 `var module` 同处一个作用域**。
 *    若只切 `var exports` 而不带 `var module`，这行会去**外层**找 `module` ——
 *    也就是 OFM 包装器的 `module`，把老 bundle 的 `exports` 接到 OFM 的导出上，
 *    **反过来劫持 OFM 自己的 `exports.apply` / `exports.name`**（实测：OFM 的
 *    4 个槽位全没了，只剩 jet-hub 的 1 个）。
 *
 * ⇒ 两条合起来只有一个正确做法：**从 `var module` 开始切**（自带 `module` 声明，
 * 且把导出接线整段包含进来）。IIFE 内部因此是一个自洽的 CJS 作用域。
 */
const BODY_START = '    var module = { exports: {} };';
const BODY_END = '    return module.exports;';

/** 要摘掉的「重复徽标」注册语句（自包含，边界明确）。 */
const BADGE_START = '  ctx.slots.inject("conversation.input.right", () => ctx.slots.register({';
const BADGE_END = '  }, UsageBadge));';

/** OFM `apply(ctx)` 的首行 —— 补丁 F 已把它改写成带 RPC helper 的形式。 */
const APPLY_ANCHOR = '    function apply(ctx) {';

const mode = process.argv[2] || '--check';

/**
 * 抽取老 factory 的函数体，摘掉重复徽标注册，包成 IIFE。
 *
 * @returns {string} 可直接插进 OFM `apply` 之前的一段源码。
 */
function mergedSource() {
  if (JET_HUB_CLIENT.length === 0) {
    throw new Error(
      '找不到老 Jet Hub 的客户端产物（jet-hub.js）。\n'
      + `  候选：\n    ${[
        path.join(PROFILE, 'dsh-providers-hub/lib/client/jet-hub.js'),
        '/data/data/com.dshphone/files/tree/node_modules/dsh-providers-hub/lib/client/jet-hub.js',
      ].join('\n    ')}`,
    );
  }
  const srcPath = JET_HUB_CLIENT[0];
  const raw = fs.readFileSync(srcPath, 'utf8');

  const start = raw.indexOf(BODY_START);
  const end = raw.indexOf(BODY_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`${srcPath}: 找不到 factory 体边界（上游结构变了？）`);
  }
  let body = raw.slice(start, end);

  // ── 唯一手术：摘掉重复的用量徽标注册 ──────────────────────────────────────
  const bStart = body.indexOf(BADGE_START);
  const bEnd = body.indexOf(BADGE_END, bStart);
  if (bStart < 0 || bEnd < 0) {
    throw new Error(
      `${srcPath}: 找不到要摘除的徽标注册语句（锚点变了）。\n`
      + '  ⚠️ 不能跳过这一步：留着它会与 OFM 自己的徽标在同一槽位并排显示两枚胶囊。',
    );
  }
  const removed = body.slice(bStart, bEnd + BADGE_END.length);
  if (!removed.includes('jet-hub-usage')) {
    throw new Error(`${srcPath}: 待摘除的片段里没有 jet-hub-usage，锚点定位错了，拒绝改动`);
  }
  body = body.slice(0, bStart) + body.slice(bEnd + BADGE_END.length);

  // ── 自检：这几样必须在场，否则说明抽取切错了位置 ──────────────────────────
  for (const need of ['installJetHubStyles', 'JetHubPage', 'startCarrierContribution']) {
    if (!body.includes(need)) throw new Error(`${srcPath}: 抽取结果里缺少 ${need}，拒绝产出`);
  }
  if (body.includes('"jet-hub-usage"')) {
    throw new Error(`${srcPath}: 徽标注册未被摘净，拒绝产出`);
  }
  // ⚠️⚠️ 导出接线必须在场（见 BODY_START 的长注释）—— 这是「切错起点」的守门断言：
  //    少了它，IIFE 返回空对象，补丁 G 会在**设置页渲染时**才炸，最难发现。
  if (!body.includes('module.exports = __toCommonJS(client_exports)')) {
    throw new Error(
      `${srcPath}: 抽取结果里没有导出接线（module.exports = __toCommonJS(...)）——\n`
      + '  BODY_START 起点切错了位置，IIFE 会返回空对象、补丁 G 将完全无效。拒绝产出。',
    );
  }
  // 老的 `function apply(ctx)` 必须恰好一个（IIFE 里只应暴露它一个 apply）。
  const applyCount = body.split('function apply(ctx)').length - 1;
  if (applyCount !== 1) throw new Error(`${srcPath}: factory 体里有 ${applyCount} 个 function apply(ctx)（应为 1）`);

  return `    // ── 补丁 G：老 Jet Hub 的完整设置页 ───────────────────────────────────
    // 源码来自设备上仍在的 dsh-providers-hub/lib/client/jet-hub.js（整体复用，
    // 不逐功能重写；理由与边界见 patch-jet-hub-ui.mjs 的模块头）。
    // 包在 IIFE 里：内部符号不外泄，与 OFM 自己的同名变量互不干扰。
    // ⚠️ 已摘除它自带的用量徽标注册（避免与 OFM 那枚并排显示两枚胶囊）。
    const ${MARK} = (() => {
${body}
      return module.exports
    })()
    // ─────────────────────────────────────────────────────────────────────

`;
}

const stateOf = (src) => (src.includes(MARK) ? 'patched' : 'clean');

if (mode === '--check') {
  console.log(`老客户端来源：${JET_HUB_CLIENT[0] ?? '✗ 缺失'}`);
  if (JET_HUB_CLIENT.length === 0) process.exit(1);
  const size = fs.statSync(JET_HUB_CLIENT[0]).size;
  console.log(`  产物大小：${(size / 1024).toFixed(0)} KB`);
  let bad = 0;
  for (const f of targets()) {
    if (!fs.existsSync(f)) { console.log(`  ✗ 缺失  ${f}`); bad += 1; continue; }
    const src = fs.readFileSync(f, 'utf8');
    console.log(`  ${stateOf(src) === 'patched' ? '已打补丁 G' : '未打补丁  '}  ${f}`);
    if (!src.includes(APPLY_ANCHOR)) { console.log(`    ✗ 找不到 apply 锚点（补丁 F 没打？）`); bad += 1; }
  }
  // 预演一次抽取：锚点坏了要在这里就报出来，而不是装到一半。
  const merged = mergedSource();
  console.log(`\n抽取结果：${(merged.length / 1024).toFixed(0)} KB（可直接插入）`);
  process.exit(bad > 0 ? 1 : 0);
}

if (mode === '--revert') {
  for (const f of targets()) {
    const bak = `${f}.pre-patch-g`;
    if (!fs.existsSync(bak)) { console.log(`无备份，跳过  ${f}`); continue; }
    fs.copyFileSync(bak, f);
    console.log(`已还原  ${f}`);
  }
  process.exit(0);
}

const merged = mergedSource();
let changed = 0;
for (const f of targets()) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
  let src = fs.readFileSync(f, 'utf8');
  if (stateOf(src) === 'patched') { console.log(`补丁 G 已在，跳过  ${f}`); continue; }

  const n = src.split(APPLY_ANCHOR).length - 1;
  if (n !== 1) throw new Error(`${f}: apply 锚点命中 ${n} 次（应为 1）`);
  if (!fs.existsSync(`${f}.pre-patch-g`)) fs.copyFileSync(f, `${f}.pre-patch-g`);

  // G1: 插入 IIFE（放在 apply 之前，模块级）
  src = src.replace(APPLY_ANCHOR, `${merged}${APPLY_ANCHOR}`);
  // G2: 在 apply 内部调用它（紧跟首行；helper 定义在其后，互不干扰）
  const callLine = `${APPLY_ANCHOR}\n      // 补丁 G：挂载老 Jet Hub 的设置页（17 渠道面板 / 聚合 / 备份 / Token 用量 …）。\n      ${MARK}.apply(ctx)\n`;
  const n2 = src.split(APPLY_ANCHOR).length - 1;
  if (n2 !== 1) throw new Error(`${f}: 插入后 apply 锚点变为 ${n2} 次，中止`);
  src = src.replace(APPLY_ANCHOR, callLine);

  fs.writeFileSync(f, src);
  changed += 1;
  console.log(`已打补丁 G（IIFE + apply 调用）  ${f}`);
}
console.log(`\n完成：改动 ${changed} 个文件。回滚：node patch-jet-hub-ui.mjs --revert`);
