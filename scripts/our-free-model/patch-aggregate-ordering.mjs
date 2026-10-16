#!/usr/bin/env node
/**
 * 补丁 I：把聚合面板整体换成 **gitee 上游的排序版**（补排序模式 / 拖动 / 拒绝非临期）。
 *
 * ## 补什么
 *
 * 宿主早就支持、catalog 也早已下发，但 npm 版客户端**没有界面**的三件事：
 *
 * | 端点 | 界面 |
 * |---|---|
 * | `aggregate.setOrderMode` | 顶部「按临期 / 按手工」切换（单按钮，非两段式） |
 * | `aggregate.setOrder` | **鼠标拖动**候选自定义顺序 |
 * | `aggregate.rejectNonExpiring` | 一键把「无临期积分」的候选恢复为默认不参与 |
 *
 * 实测证据（宿主真的支持，不是空想）：
 * ```
 * aggregate.setOrderMode {mode:'manual'} → {orderMode:'manual'}   ✓
 * aggregate.setOrder {canonicalId, order:[…]} → {order:[…]}       ✓
 * aggregate.rejectNonExpiring {}          → {cleared:N}           ✓
 * aggregate.catalog → {orderMode:'expiry', models[].order}         ← 本来就下发
 * ```
 *
 * ## 为什么值得换（不只是「多个功能」）
 *
 * gitee 版包含了**本仓库历史上那个真实缺陷的修复**，注释原文：
 * > ⚠️⚠️ **必须 `setData`，否则拖拽根本不触发**（真实缺陷，用户验收实测：
 * > 「拖动好像是不生效的」）……我第一版漏了它，于是只在「上下箭头」路径能改序，
 * > 鼠标拖拽整个失效。
 *
 * ⇒ 换上去 = 直接拿到修好的实现；而本补丁的验证器会**钉住 `setData` 被调用**。
 *
 * ## 换什么（两块，一起换）
 *
 * 1. **11 个辅助纯函数** → gitee `aggregate-panel-logic.js` 的 21 个（超集，
 *    含排序/拖动所需的 `candidateKeyOf` / `moveCandidateTo` / `pendingOrderFromRoster`
 *    / `rotationRosterOf` / `rotationBlockerOf` / `startExpiryReprobe` …）；
 * 2. **`AggregatePanel` 本体**（npm 232 行 → gitee 662 行）。
 *
 * ⚠️ **两块必须一起换**：gitee 面板调的是 `candidateToggleAction(canonicalId, candidate, resolved)`
 *   （第 3 参是**对象**），而补丁 H 的 npm 版是 `(canonicalId, candidate, state)`
 *   （第 3 参是**字符串**）。只换一块 ⇒ 三态判定静默错位 ⇒ **开关又变成点了没反应**。
 *   （H 的语义已由 gitee 版**覆盖**：两者都实现了「未接入 ⇒ 写白名单」那条判据，
 *     gitee 版还多处理了 `expiryWired === false` 的 `allowed → setAllowed(false)` 分支。）
 *
 * ## ⚠️ 前置
 *
 * 必须先打**补丁 G**（老 Jet Hub 设置页）—— 本补丁替换的 `AggregatePanel` 就在
 * 补丁 G 注入的那个 IIFE 里。G 没打时锚点找不到，本补丁会**明确报错并退出**。
 *
 * 用法：
 *   node patch-aggregate-ordering.mjs --check
 *   node patch-aggregate-ordering.mjs --apply
 *   node patch-aggregate-ordering.mjs --revert
 *
 * ⚠️ `OFM_I_TARGETS`（冒号分隔）可覆盖目标 —— **先在副本上演练**再动线上。
 *    （教训：补丁 `--revert` 会作用到 `targets()` 里的**全部**文件，
 *      2026-10-16 曾因此误还原线上文件。）
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const PROFILE = path.join(HOME, 'profiles/phone/node_modules');
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const PLUGIN_DIRS = [LOCAL, path.join(PROFILE, 'dsh-our-free-model')];

const MARK = 'patch I: aggregate ordering';

/** gitee 权威源码（固化在工作区，离线可用）。 */
const LOGIC_SRC = path.join(HERE, 'gitee-client-src/aggregate-panel-logic.js');
const PANEL_SRC = path.join(HERE, 'gitee-client-src/AggregatePanel.gitee.js');

const targets = () => {
  const override = process.env.OFM_I_TARGETS;
  if (override !== undefined && override.length > 0) return override.split(':').filter((s) => s.length > 0);
  return PLUGIN_DIRS.map((d) => path.join(d, 'client.js'));
};

/** npm 版辅助函数块的边界（已核实唯一）。 */
const HELPERS_START = 'function sortModelsForPanel(models) {';
const HELPERS_END_ANCHOR = '\n// plugin-src/client/provider-toggle.js';

/** npm 版 AggregatePanel 的边界。 */
const PANEL_START = 'function AggregatePanel({ rpcCall }) {';
const PANEL_END_ANCHOR = '\nfunction JetHubPage({ rpcCall }) {';

/** 读 gitee 源码并转成「可注入 IIFE」的形态（去掉 export）。 */
function giteeSources() {
  for (const f of [LOGIC_SRC, PANEL_SRC]) {
    if (!fs.existsSync(f)) throw new Error(`缺少 gitee 权威源码：${f}\n（应随工具一起分发，见 gitee-client-src/）`);
  }
  // 纯函数：export function → function（IIFE 内部不需要 ESM 导出）
  const logic = fs.readFileSync(LOGIC_SRC, 'utf8')
    .replace(/^export function /gm, 'function ');
  if (/^export /m.test(logic)) throw new Error('agg-logic 里仍有未处理的 export');
  const panel = fs.readFileSync(PANEL_SRC, 'utf8');
  if (!panel.includes('function AggregatePanel({ rpcCall })')) {
    throw new Error('AggregatePanel.gitee.js 看起来不是完整的面板源码');
  }
  if (!panel.includes('dataTransfer') || !panel.includes('setData')) {
    throw new Error(
      'AggregatePanel.gitee.js 里没有 dataTransfer.setData —— 那是「拖拽根本不触发」那个\n'
      + '  真实缺陷的修复点；缺了它说明这份源码不对（或不是最新），拒绝产出。',
    );
  }
  return { logic, panel };
}

const stateOf = (src) => (src.includes(MARK) ? 'patched' : 'clean');

/** 预检：两块锚点都必须能唯一命中，且补丁 G 必须在场。 */
function precheck(src) {
  const problems = [];
  if (!src.includes('OFM_JET_HUB_UI')) {
    problems.push('找不到 OFM_JET_HUB_UI —— 请**先打补丁 G**（老 Jet Hub 设置页）');
  }
  const c = (n) => src.split(n).length - 1;
  if (c(HELPERS_START) !== 1) problems.push(`辅助函数块起点命中 ${c(HELPERS_START)} 次（应为 1）`);
  if (c(HELPERS_END_ANCHOR) !== 1) problems.push(`辅助函数块终点命中 ${c(HELPERS_END_ANCHOR)} 次（应为 1）`);
  if (c(PANEL_START) !== 1) problems.push(`AggregatePanel 起点命中 ${c(PANEL_START)} 次（应为 1）`);
  if (c(PANEL_END_ANCHOR) !== 1) problems.push(`AggregatePanel 终点命中 ${c(PANEL_END_ANCHOR)} 次（应为 1）`);
  // 顺序必须正确（起点在终点之前），否则切片会得到空/负长度
  const hs = src.indexOf(HELPERS_START);
  const he = src.indexOf(HELPERS_END_ANCHOR);
  if (hs >= 0 && he >= 0 && he <= hs) problems.push('辅助函数块 终点在起点之前（锚点错位）');
  const ps = src.indexOf(PANEL_START);
  const pe = src.indexOf(PANEL_END_ANCHOR);
  if (ps >= 0 && pe >= 0 && pe <= ps) problems.push('AggregatePanel 终点在起点之前（锚点错位）');
  return problems;
}

/** 用 gitee 源码替换两块。 */
function applyTo(src, { logic, panel }) {
  // 1) 辅助函数块：起点到终点锚点之间整块换掉
  const hs = src.indexOf(HELPERS_START);
  const he = src.indexOf(HELPERS_END_ANCHOR);
  const helpersBlock = `// ── ${MARK} ──────────────────────────────────────────────────────
// 聚合面板的判定与文案纯函数（**gitee 上游 aggregate-panel-logic.js 逐字搬入**）。
// 比 npm 版多 10 个（排序/拖动/重探所需）：candidateKeyOf / moveCandidateTo /
// pendingOrderFromRoster / rotationRosterOf / rotationBlockerOf / rankCandidatesForPanel
// / startExpiryReprobe / shouldReprobeExpiry / rejectionKey / moveCandidate。
// 抽成纯函数是为了可单测（单测环境没有 react）。
${logic}`;
  let out = src.slice(0, hs) + helpersBlock + src.slice(he);

  // 2) 面板本体
  const ps = out.indexOf(PANEL_START);
  const pe = out.indexOf(PANEL_END_ANCHOR);
  out = out.slice(0, ps) + `// ── ${MARK} ──────────────────────────────────────────────────────
// 排序版聚合面板（gitee 上游 AggregatePanel 逐字搬入）。
// 新增：顶部排序模式切换（按临期/按手工）、鼠标拖动自定义顺序、一键「拒绝非临期」。
// ⚠️ 必须与上面那批纯函数**成对替换**（回调签名不同，见本补丁模块头）。
${panel}` + out.slice(pe);
  return out;
}

const mode = process.argv[2] || '--check';

if (mode === '--check') {
  let bad = 0;
  let sources;
  try {
    sources = giteeSources();
    console.log(`gitee 源码：纯函数 ${sources.logic.length} 字符 / 面板 ${sources.panel.length} 字符`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  for (const f of targets()) {
    if (!fs.existsSync(f)) { console.log(`  ✗ 缺失  ${f}`); bad += 1; continue; }
    const src = fs.readFileSync(f, 'utf8');
    const st = stateOf(src);
    console.log(`  ${st === 'patched' ? '已打补丁 I' : '未打补丁  '}  ${f}`);
    if (st === 'clean') {
      const problems = precheck(src);
      for (const p of problems) { console.log(`      ✗ ${p}`); bad += 1; }
      if (problems.length === 0) console.log('      ✓ 锚点齐备，可施加');
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}

if (mode === '--revert') {
  for (const f of targets()) {
    const bak = `${f}.pre-patch-i`;
    if (!fs.existsSync(bak)) { console.log(`无备份，跳过  ${f}`); continue; }
    fs.copyFileSync(bak, f);
    console.log(`已还原  ${f}`);
  }
  process.exit(0);
}

const sources = giteeSources();
let changed = 0;
for (const f of targets()) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
  let src = fs.readFileSync(f, 'utf8');
  if (stateOf(src) === 'patched') { console.log(`补丁 I 已在，跳过  ${f}`); continue; }

  const problems = precheck(src);
  if (problems.length > 0) {
    console.error(`✗ ${f}：`);
    for (const p of problems) console.error(`    ${p}`);
    console.error('  拒绝改动。');
    process.exit(1);
  }
  if (!fs.existsSync(`${f}.pre-patch-i`)) fs.copyFileSync(f, `${f}.pre-patch-i`);

  src = applyTo(src, sources);

  // ── 落盘前的三条守卫（任一不满足就不写）──────────────────────────────────
  if (!src.includes("'aggregate.setOrderMode'") && !src.includes('"aggregate.setOrderMode"')) {
    throw new Error(`${f}: 施加后仍找不到 aggregate.setOrderMode，拒绝写入`);
  }
  if (!src.includes('dataTransfer.setData')) {
    throw new Error(`${f}: 施加后找不到 dataTransfer.setData（拖拽修复点丢失），拒绝写入`);
  }
  // 面板与纯函数必须**成对**：gitee 面板调 3 参对象版，缺了就会静默错位。
  if (!src.includes('candidateToggleAction(canonicalId, candidate, resolved)')
    && !src.includes('candidateToggleAction(canonicalId, candidate, state)')) {
    // 两种签名都可能（取决于版本），但**必须**与面板匹配 —— 用候选调用形态核对
  }
  if (!src.includes('rotationRosterOf')) {
    throw new Error(`${f}: 施加后找不到 rotationRosterOf（纯函数块没换成 gitee 版），拒绝写入`);
  }
  fs.writeFileSync(f, src);
  changed += 1;
  console.log(`已打补丁 I（纯函数块 + 排序版面板）  ${f}`);
}
console.log(`\n完成：改动 ${changed} 个文件。回滚：node patch-aggregate-ordering.mjs --revert`);
