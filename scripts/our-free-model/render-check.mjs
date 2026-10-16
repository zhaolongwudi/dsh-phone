#!/usr/bin/env node
/**
 * 真渲染验证：用**真实 react + react-dom/server** 把老 Jet Hub 设置页渲染成 HTML。
 *
 * ## 与 headless-client-check.mjs 的分工
 *
 * | 脚本 | 桩 React | 守什么 |
 * |---|---|---|
 * | `headless-client-check.mjs` | 是 | **加载期 + 注册期**的失败（语法错、缺符号、槽位重复） |
 * | 本脚本 | **否**（用真的） | **渲染期**的失败（组件一跑就抛、hooks 用错、缺 props） |
 *
 * 后者是「改了 client.js 但只在打开设置页时才炸」那类缺陷的唯一拦截点 ——
 * 而这类缺陷在真机上表现为**整个设置页白屏**，用户看不出原因。
 *
 * ## 做法
 *
 * 从合并后的 `client.js` 里取到 `settings.section` 的注册回调，拿到 id 为
 * `jet-hub` 的组件，备齐它 inject 的 props（全是桩 RPC），用
 * `ReactDOMServer.renderToString` 真渲染一次。
 *
 * ⚠️ 这不是端到端（不点按钮、不发真 RPC），但能证明**组件树真的能构建**。
 *
 * 用法：
 *   node render-check.mjs <client.js> [--id jet-hub]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/data/data/com.dshphone/files/tree/node_modules/');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const file = process.argv[2];
const idIdx = process.argv.indexOf('--id');
const wantId = idIdx > 0 ? process.argv[idIdx + 1] : 'jet-hub';
if (file === undefined || !fs.existsSync(file)) { console.error(`用法: node render-check.mjs <client.js> [--id <槽位id>]`); process.exit(1); }

// ── 浏览器全局（bundle 顶层会碰 window / document）────────────────────────────
const styleEls = [];
const makeElement = (tag) => {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attributes: {},
    textContent: '', innerHTML: '', className: '', id: '',
    setAttribute: (k, v) => { el.attributes[k] = v; },
    getAttribute: (k) => el.attributes[k] ?? null,
    removeAttribute: (k) => { delete el.attributes[k]; },
    appendChild: (c) => { el.children.push(c); return c; },
    append: (...c) => { el.children.push(...c); },
    removeChild: (c) => { el.children = el.children.filter((x) => x !== c); return c; },
    remove: () => { styleEls.splice(styleEls.indexOf(el), 1); },
    insertBefore: (c) => { el.children.unshift(c); return c; },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    contains: () => false, focus: () => {}, click: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
};
const documentStub = {
  head: makeElement('head'), body: makeElement('body'), documentElement: makeElement('html'),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  createDocumentFragment: () => makeElement('fragment'),
  querySelector: () => null, querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener: () => {}, removeEventListener: () => {}, cookie: '',
};
let registered = null;
const win = {
  __ModuleLoader__: { load: (e) => { registered = e; } },
  addEventListener: () => {}, removeEventListener: () => {},
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
  navigator: { userAgent: 'node' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  EventSource: undefined,
  dshDesktop: undefined,
};
win.window = win;
globalThis.window = win;
globalThis.document = documentStub;
win.document = documentStub;
try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true }); } catch {}
globalThis.localStorage = win.localStorage;
globalThis.matchMedia = win.matchMedia;

const requireShim = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return require('react-dom');
  throw new Error(`未知依赖：${spec}`);
};

// ── 1. 加载 + factory ────────────────────────────────────────────────────────
const code = fs.readFileSync(file, 'utf8');
try { new Function('window', 'globalThis', code)(win, globalThis); }
catch (e) { console.error(`✗ 加载失败：${e?.message}`); process.exit(1); }
const mod = registered.factory(requireShim);
console.log(`✓ 加载 ${registered.id}`);

// ── 2. 抓住目标槽位的组件 ────────────────────────────────────────────────────
/** 渲染期组件真的发过的 RPC 端点（诊断用）。 */
const awaitingRpc = [];
const captured = [];
const slots = {
  inject: (name, cb) => {
    const register = (def, component) => { captured.push({ slot: name, def, component }); return () => {}; };
    try { cb(register); } catch (e) { throw new Error(`槽位 ${name} inject 抛错：${e?.message}`); }
    return () => {};
  },
  // ⚠️ 外层 `register` **必须**也记进 captured：两个 bundle 都写成
  //    `ctx.slots.inject(名, () => ctx.slots.register(定义, 组件))` ——
  //    真正被调用的是 **ctx.slots.register（外层这个）**，不是 inject 回调收到的
  //    那个 `register` 形参。初版把它写成丢弃的 `() => () => {}`，于是**一个槽位
  //    都抓不到**，被误读成「补丁 G 没生效」（实测撞过，故照实记下）。
  register: (def, component) => { captured.push({ slot: def?.name, def, component }); return () => {}; },
};
awaitingRpc.length = 0;
const ctx = {
  slots,
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch (e) { throw new Error(`effect 抛错：${e?.message}`); } },
  inject: (deps, cb) => { if (typeof cb === 'function') { try { cb(); } catch {} } return () => {}; },
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} }, load: async () => {} }) },
  sessions: {}, remote: { session: {} },
  locale: Object.assign((k) => k, { bind: () => Object.assign((k) => k, { locale: 'stub' }), register: () => {}, t: (k) => k }),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => {}, off: () => {}, emit: () => {},
};
mod.apply(ctx);
console.log(`✓ apply 注册 ${captured.length} 个槽位`);

const target = captured.find((c) => c.slot === 'settings.section' && c.def?.id === wantId);
if (target === undefined) {
  console.error(`✗ 找不到 settings.section 里 id=${wantId} 的组件`);
  console.error(`  实有：${captured.filter((c) => c.slot === 'settings.section').map((c) => c.def?.id).join(', ')}`);
  process.exit(1);
}
console.log(`✓ 找到目标组件 槽位=${target.slot} id=${target.def.id}`);

// ── 3. 备齐 props（组件 inject 的全给桩）─────────────────────────────────────
/**
 * RPC 桩。
 *
 * ⚠️⚠️ **必须能按端点返回**真数据，否则很多面板根本渲染不出来（真实教训）：
 * 起初它恒回 `{}`，而 `JetHubPage` 的 `selected` 初值是 `null` 且靠
 * `provider.status` 的响应来挑第一个可用渠道 ⇒ 桩回空对象 ⇒ `selected` 永远是
 * `null` ⇒ **`AggregatePanel` 根本没被渲染**，于是「渲染成功 55913 字符」这句话
 * 只证明了外壳能渲染，**没证明补丁 H 改过的那个面板能渲染**。
 *
 * ⇒ 加 `--rpc-data <json 文件>`：按 method 提供响应；缺省仍回 `{}`。
 */
const rpcDataIdx = process.argv.indexOf('--rpc-data');
const rpcDataFile = rpcDataIdx > 0 ? process.argv[rpcDataIdx + 1] : undefined;
const rpcData = rpcDataFile !== undefined && fs.existsSync(rpcDataFile)
  ? JSON.parse(fs.readFileSync(rpcDataFile, 'utf8'))
  : {};
const rpcCall = async (endpoint, payload) => {
  awaitingRpc.push(endpoint);
  const hit = rpcData[endpoint];
  if (hit !== undefined) {
    // 少数端点（provider.status）按 payload 里的 providers 列表裁剪，照实模拟。
    if (endpoint === 'provider.status' && hit.statuses !== undefined) {
      const asked = payload?.providers;
      if (Array.isArray(asked)) {
        const statuses = {};
        for (const id of asked) if (hit.statuses[id] !== undefined) statuses[id] = hit.statuses[id];
        return { statuses };
      }
    }
    return hit;
  }
  return {};
};
const props = {
  ...(typeof target.def.inject === 'function' ? (target.def.inject('session-stub') ?? {}) : {}),
  ctx,
  rpcCall,
  t: (k) => k,
  locale: undefined,
  ns: 'stub',
  sessionId: 'session-stub',
  close: () => {},
  open: () => {},
};

// ── 4. 真渲染 ───────────────────────────────────────────────────────────────
let html;
try {
  html = ReactDOMServer.renderToString(React.createElement(target.component, props));
} catch (error) {
  console.error(`✗ 渲染抛错：${error?.message}`);
  if (error?.stack) console.error(String(error.stack).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
console.log(`✓ 渲染成功  HTML ${html.length} 字符`);
const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`\n渲染出的可见文本（前 600 字）：\n${text.slice(0, 600)}`);
if (awaitingRpc.length > 0) {
  console.log(`\n渲染期发出的 RPC：${[...new Set(awaitingRpc)].join(', ')}`);
}
// 白屏判据：渲染成功但几乎没内容，等于用户看到空白页。
if (text.length < 20) { console.error('\n✗ 渲染出的内容过少（疑似白屏）'); process.exit(1); }
console.log('\n✓ 渲染内容非空');
