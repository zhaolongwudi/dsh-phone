#!/usr/bin/env node
/**
 * 交互接线验证：**真的调用**聚合面板里那个「参与轮换」开关的 onClick。
 *
 * ## 为什么需要它（补丁 H 的验证缺口）
 *
 * 到这一步为止，补丁 H 只验到了两件事：
 *   ① **纯函数**对不对（`candidateToggleAction` 等，11 项单测）；
 *   ② 面板**渲染**出来的文案对不对（`render-aggregate.mjs`：显示「默认不参与」）。
 *
 * 但**没有**验过第三件 —— 那两件之间**有没有接上**：
 * 按钮的 `onClick` 是否真的调到了 `onToggleRejected(canonicalId, candidate)`，
 * 而它是否真的发出 `aggregate.setAllowed {allowed:true}`。
 *
 * 这正是本仓库反复记录的那类缺陷 ——「代码写了但走不到」：
 * 纯函数绿、渲染绿、CI 绿，真机一点却没反应。
 *
 * ## 做法
 *
 * `renderToString` 不给元素树，但**直接调用函数组件**可以得到：
 * `AggregatePanel(props)` 返回的是 `React.createElement` 的**普通对象树**
 * （`{type, props, children}`）。于是：
 *
 *   1. 调组件拿到树；2. 深度遍历找出所有 `<button>`；
 *   3. 按可见文字定位「默认不参与」那个；
 *   4. **真的调它的 `onClick()`**，用桩 `rpcCall` 记录发出去的端点与载荷。
 *
 * ⚠️ 这不是浏览器（不测真实拖拽的 `dataTransfer`），但足以证明
 *    **「点这个按钮 ⇒ 发这条 RPC」这条接线是通的**。
 *
 * 用法：
 *   node check-aggregate-wiring.mjs <client.js> [--catalog <json>]
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire('/data/data/com.dshphone/files/tree/node_modules/');
const React = require('react');

const file = process.argv[2];
const catIdx = process.argv.indexOf('--catalog');
const catFile = catIdx > 0 ? process.argv[catIdx + 1] : undefined;
if (file === undefined || !fs.existsSync(file)) {
  console.error('用法: node check-aggregate-wiring.mjs <client.js> [--catalog <json>]');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

/**
 * 抽取面板 + 它依赖的**顶格**辅助函数（依赖闭包，不写死名字）。
 *
 * ⚠️⚠️ 两条判据都是踩坑换来的（与 `render-aggregate.mjs` 同源，那边有更长的说明）：
 *   1. **不能写死函数名清单** —— 补丁 I 把面板换成 gitee 排序版后多调
 *      `rotationRosterOf` 等，写死的清单抽不到 ⇒ 报 `rotationRosterOf is not defined`，
 *      而**产品本身是好的**（那 21 个函数在 client.js 里都有定义）。
 *   2. **不能按括号深度判「同级」** —— 面板在 G 的 IIFE 里（depth 4），
 *      纯函数在 esbuild 包装的另一层（depth 3），不在一层。
 *   ⇒ 用**行首缩进为 0** 判顶层定义（本文件里顶层定义都顶格写，嵌套函数都带缩进）。
 */
const TOP_LEVEL_INDENT = 0;
function findTopFn(source, name) {
  const needle = `function ${name}(`;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (at - (source.lastIndexOf('\n', at - 1) + 1) === TOP_LEVEL_INDENT) return at;
  }
  return -1;
}
function extractFn(source, name) {
  const i = findTopFn(source, name);
  if (i < 0) throw new Error(`找不到顶格 function ${name}(`);
  const re = /\n(?:function |const [A-Za-z_$][\w$]* = )/g;
  re.lastIndex = i + 8;
  let m;
  let end = source.length;
  while ((m = re.exec(source)) !== null) {
    const at = m.index + 1;
    if (at - (source.lastIndexOf('\n', at - 1) + 1) === TOP_LEVEL_INDENT) { end = at; break; }
  }
  return source.slice(i, end);
}
function extractClosure(source, root) {
  const have = new Map();
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift();
    if (have.has(name)) continue;
    let body;
    try { body = extractFn(source, name); } catch { continue; }
    have.set(name, body);
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const id = m[1];
      if (have.has(id) || queue.includes(id)) continue;
      if (findTopFn(source, id) >= 0) queue.push(id);
    }
  }
  return have;
}
const closure = extractClosure(src, 'AggregatePanel');
const parts = [...closure.values()];
if (!closure.has('AggregatePanel')) {
  console.error('✗ 抽不到 AggregatePanel');
  process.exit(1);
}
console.log(`✓ 依赖闭包 ${closure.size} 个函数`);

// ── 目录 ─────────────────────────────────────────────────────────────────────
function fetchCatalog() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const out = execFileSync(process.execPath, [path.join(here, 'hub-rpc.mjs'), 'aggregate.catalog', '{}'], {
    cwd: here, encoding: 'utf8', timeout: 60_000,
  });
  const j = JSON.parse(out);
  if (j?.ok !== true) throw new Error(`aggregate.catalog 未成功`);
  return j.value;
}
let catalog;
if (catFile !== undefined) {
  const raw = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  catalog = Array.isArray(raw?.models) ? raw : raw['aggregate.catalog'];
} else {
  catalog = fetchCatalog();
}
const models = catalog.models;

// ── 桩 React ─────────────────────────────────────────────────────────────────
/**
 * 面板编译时传入的 `React`。
 *
 * ⚠️⚠️ **这里刻意**只**注入 `useEffect`（让它不执行），`useState` 交给下面那个
 *    dispatcher 统一处理 —— 不能在这一层再包一个 `useState` 代理**（真实教训）：
 *    那样会有**两个**地方各自数 hook 序号，而编译器捕获的是这一层的代理，
 *    于是 dispatcher 里的 `--manual` 注入（orderMode）**永远到不了面板**，
 *    表现为「`--manual` 传了但按钮还是『按临期』」，很难查。
 *    ⇒ hook 值的注入**只有一处**：`dispatcher`。
 */
function reactForPanel() {
  return new Proxy(React, {
    get(target, prop) {
      // ⚠️ `useEffect` 必须**不执行**（真机上它跑 load()；这里要的是**初值那棵树**）。
      if (prop === 'useEffect' || prop === 'useLayoutEffect') return () => {};
      return target[prop];
    },
  });
}

const code = `
const React2 = React;
${parts.join('\n')}
return AggregatePanel;
`;

// 找出「未参与但可手工打开」的候选（第一个 default-rejected）。
const targetCandidate = (() => {
  for (const m of models) {
    for (const c of m.candidates ?? []) {
      if (c.state === 'default-rejected') return { model: m, cand: c };
    }
  }
  return null;
})();
if (targetCandidate === null) {
  console.error('✗ 真实目录里没有 default-rejected 候选 —— 本用例失去意义（换个目录再跑）');
  process.exit(1);
}
// 展开**含该候选的那个模型**（而不是第 1 个）。
const expandKey = targetCandidate.model.canonicalId;
const Panel = new Function('React', code)(reactForPanel());

// ── 调组件拿到元素树 ─────────────────────────────────────────────────────────
/**
 * ⚠️⚠️ 直接调函数组件**必须先装一个 hook dispatcher**（真实教训）：
 * React 的 `useState`/`useCallback` 都是**转调 `ReactCurrentDispatcher.current`**，
 * 而那个槽在渲染之外是 `null` ⇒ 直接 `Panel(props)` 抛
 * `Cannot read properties of null (reading 'useCallback')`（并伴随 "Invalid hook call"）。
 *
 * ⇒ 装一个**最小可用**的 dispatcher：`useState` 走注入逻辑、`useCallback` 原样返回、
 *   其余给安全空实现。这样拿到的就是组件**真实返回的那棵元素树**（含所有 `onClick`）。
 *   ⚠️ 用完必须还原，避免污染后续调用。
 */
const INTERNALS = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const I_MODELS = 1;
const I_EXPANDED = 5;
/**
 * `orderMode` 是面板的第几个 `useState`？—— **每次都要回源码数**（踩过坑）：
 * gitee 排序版的真实顺序是
 *   models(1) / rejections(2) / busy(3) / notice(4) / expanded(5) / **orderMode(6)**
 *   / pendingOrder(7) / orderBusy(8) / rejectBusy(9) / lastProbeAt(10) / …
 * ⚠️ 序号写错会把值塞给别的 state（例如给 `notice` 塞对象 ⇒
 *    `Objects are not valid as a React child`）。
 * ⚠️ 而且**换面板版本就会变**（npm 版没有 orderMode，序号完全不同）⇒
 *    改面板后必须重新核对本常量。
 */
const I_ORDER_MODE = 6;
/** `--manual`：把 orderMode 初值设成 'manual' ⇒ 候选可拖（拖拽只在手工模式下存在）。 */
const wantManual = process.argv.includes('--manual');
let hookIndex = 0;
const dispatcher = {
  useState: (init) => {
    hookIndex += 1;
    if (hookIndex === I_MODELS) return [models, () => {}];
    if (hookIndex === I_EXPANDED) return [{ [expandKey]: true }, () => {}];
    if (hookIndex === I_ORDER_MODE && wantManual) return ['manual', () => {}];
    return [typeof init === 'function' ? init() : init, () => {}];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (init) => ({ current: init }),
  useContext: () => undefined,
  useReducer: (_r, init) => [typeof init === 'function' ? init() : init, () => {}],
  useDebugValue: () => {},
  useImperativeHandle: () => {},
  useTransition: () => [false, (fn) => (typeof fn === 'function' ? fn() : undefined)],
  useDeferredValue: (v) => v,
  useId: () => 'stub-id',
  useSyncExternalStore: (_sub, getSnapshot) => (typeof getSnapshot === 'function' ? getSnapshot() : undefined),
  useInsertionEffect: () => {},
};

const sent = [];
const rpcCall = async (endpoint, payload) => {
  sent.push({ endpoint, payload });
  if (endpoint === 'aggregate.catalog') return catalog;
  return {};
};
let tree;
const prevDispatcher = INTERNALS.ReactCurrentDispatcher.current;
hookIndex = 0;
INTERNALS.ReactCurrentDispatcher.current = dispatcher;
try {
  tree = Panel({ rpcCall });
} catch (error) {
  console.error(`✗ 直接调用 AggregatePanel 抛错：${error?.message}`);
  if (error?.stack) console.error(String(error.stack).split('\n').slice(1, 5).join('\n'));
  process.exit(1);
} finally {
  INTERNALS.ReactCurrentDispatcher.current = prevDispatcher;
}

// ── 深度遍历找按钮 ───────────────────────────────────────────────────────────
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props !== undefined) {
    return textOf(node.props.children);
  }
  return '';
}
const buttons = [];
(function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node.type === 'button' && node.props !== undefined) buttons.push(node);
  if (node.props !== undefined) walk(node.props.children);
})(tree);

console.log(`✓ 组件树构建成功，找到 ${buttons.length} 个按钮`);
/**
 * 定位「未参与但可手工打开」那个开关。
 *
 * ⚠️⚠️ **必须同时认两代文案**（真实教训）：`default-rejected` 的按钮文字在两版面板里不同 ——
 *   · npm 版（补丁 H）：`默认不参与`
 *   · gitee 排序版（补丁 I）：`无临期积分 · 未参与`
 * （见各自 `describeCandidateState` 的 `default-rejected` 分支。）
 * 只认前者会让本检查器对补丁 I 之后的面板**假红**，而产品其实是对的。
 */
const UNJOINED_LABELS = ['默认不参与', '无临期积分 · 未参与'];
const target = buttons.find((b) => UNJOINED_LABELS.some((s) => textOf(b).includes(s)));
if (target === undefined) {
  console.error(`✗ 没找到「未参与」开关（认这些文案：${UNJOINED_LABELS.join(' / ')}）——`);
  console.error('  三态判定未生效，或该模型没被展开。');
  console.error(`  找到的按钮文案：${[...new Set(buttons.map((b) => textOf(b)))].slice(0, 12).join(' / ')}`);
  process.exit(1);
}
console.log(`✓ 找到目标按钮：「${textOf(target)}」  title=${JSON.stringify(target.props.title).slice(0, 60)}`);

// ── 真的点它 ─────────────────────────────────────────────────────────────────
sent.length = 0;
try {
  target.props.onClick();
} catch (error) {
  console.error(`✗ onClick 抛错：${error?.message}`);
  process.exit(1);
}
// onClick 内部是 `void onToggleRejected(...)` —— 它 async，等一个微任务让 RPC 发出去。
await new Promise((r) => setTimeout(r, 50));

const call = sent.find((c) => c.endpoint !== 'aggregate.catalog');
console.log(`\n点击后发出的 RPC：${sent.map((c) => c.endpoint).join(', ') || '（无）'}`);
if (call === undefined) {
  console.error('✗ 点击没有发出任何 RPC —— 接线是断的（正是「代码写了但走不到」）。');
  process.exit(1);
}
console.log(`  端点：${call.endpoint}`);
console.log(`  载荷：${JSON.stringify(call.payload)}`);

// ── 断言：必须是 setAllowed(true)（而不是 setRejected）───────────────────────
let bad = 0;
if (call.endpoint !== 'aggregate.setAllowed') {
  console.error(`✗ 端点应为 aggregate.setAllowed，实际 ${call.endpoint}`);
  bad += 1;
}
if (call.payload?.allowed !== true) {
  console.error(`✗ 载荷应含 allowed:true，实际 ${JSON.stringify(call.payload)}`);
  bad += 1;
}
if (call.payload?.provider !== targetCandidate.cand.provider
  || call.payload?.realId !== targetCandidate.cand.realId) {
  console.error('✗ 载荷里的 provider/realId 与被点的候选不符');
  bad += 1;
}
if (bad > 0) process.exit(1);
console.log('\n✓ 接线正确：点「未参与」开关 ⇒ aggregate.setAllowed { allowed: true }');

// ── 排序相关接线（补丁 I 才有；没有就跳过，不算失败）────────────────────────
/**
 * 验「切排序模式」与「拒绝非临期」两个按钮，以及**拖动**的 `setData`。
 *
 * ⚠️ 拖动为什么能这样验：本仓库历史上那个真实缺陷正是
 * `onDragStart` **漏了 `dataTransfer.setData`** ⇒ 浏览器不触发拖拽。
 * 传一个桩 event 直接调 `onDragStart`，断言 `setData` 被调用，就能钉住它。
 * （「落点算得对不对」仍需真机，这里验不了，如实标注。）
 */
const buttonsByLabel = (label) => buttons.find((b) => textOf(b).includes(label));

const orderModeBtn = buttonsByLabel('排序：');
const rejectBtn = buttonsByLabel('拒绝非临期');
if (orderModeBtn === undefined && rejectBtn === undefined) {
  console.log('\n· 未发现排序模式 / 拒绝非临期按钮 —— 当前面板是 npm 版（未打补丁 I），跳过。');
} else {
  console.log('\n=== 排序相关接线（补丁 I）===');
  let bad2 = 0;

  // ① 切排序模式 → aggregate.setOrderMode
  if (orderModeBtn === undefined) {
    console.error('✗ 找不到「排序：」按钮');
    bad2 += 1;
  } else {
    sent.length = 0;
    try { orderModeBtn.props.onClick(); } catch (e) { console.error(`✗ 排序按钮 onClick 抛错：${e?.message}`); bad2 += 1; }
    await new Promise((r) => setTimeout(r, 50));
    const c = sent.find((x) => x.endpoint === 'aggregate.setOrderMode');
    console.log(`  排序按钮「${textOf(orderModeBtn)}」→ ${c?.endpoint ?? '（未发出）'} ${JSON.stringify(c?.payload ?? {})}`);
    if (c === undefined) { console.error('  ✗ 没有发出 aggregate.setOrderMode'); bad2 += 1; }
    else if (c.payload?.mode !== 'manual' && c.payload?.mode !== 'expiry') {
      console.error(`  ✗ mode 应为 manual/expiry，实际 ${JSON.stringify(c.payload?.mode)}`); bad2 += 1;
    }
  }

  // ② 一键拒绝非临期 → aggregate.rejectNonExpiring
  if (rejectBtn === undefined) {
    console.error('✗ 找不到「拒绝非临期」按钮');
    bad2 += 1;
  } else {
    sent.length = 0;
    try { rejectBtn.props.onClick(); } catch (e) { console.error(`✗ 拒绝非临期 onClick 抛错：${e?.message}`); bad2 += 1; }
    await new Promise((r) => setTimeout(r, 50));
    const c = sent.find((x) => x.endpoint === 'aggregate.rejectNonExpiring');
    console.log(`  拒绝非临期 → ${c?.endpoint ?? '（未发出）'}`);
    if (c === undefined) { console.error('  ✗ 没有发出 aggregate.rejectNonExpiring'); bad2 += 1; }
  }

  // ③ 拖动：onDragStart 必须调 dataTransfer.setData（历史缺陷就出在这）
  const draggables = [];
  (function walk2(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk2); return; }
    if (node.props?.draggable !== undefined && typeof node.props.onDragStart === 'function') draggables.push(node);
    if (node.props !== undefined) walk2(node.props.children);
  })(tree);
  if (draggables.length === 0) {
    // 只有「按手工」模式下的参与候选才可拖 —— 首次渲染是 expiry 模式，属正常。
    console.log('  · 当前没有可拖元素（按临期模式下不可拖，属正常；切到「按手工」后才有）。');
  } else {
    const setDataCalls = [];
    const stubEvent = {
      dataTransfer: { setData: (t, v) => setDataCalls.push({ t, v }), effectAllowed: '' },
      preventDefault: () => {}, stopPropagation: () => {},
    };
    try { draggables[0].props.onDragStart(stubEvent); } catch (e) { console.error(`✗ onDragStart 抛错：${e?.message}`); bad2 += 1; }
    console.log(`  拖动 onDragStart → dataTransfer.setData 调用 ${setDataCalls.length} 次`);
    if (setDataCalls.length === 0) {
      console.error('  ✗ onDragStart 没有调用 dataTransfer.setData —— 正是本仓库历史上那个缺陷');
      console.error('    （拖拽在真实浏览器里将**完全不触发**，只有箭头能用）。');
      bad2 += 1;
    }
  }

  if (bad2 > 0) process.exit(1);
  console.log('✓ 排序接线正确');
}
