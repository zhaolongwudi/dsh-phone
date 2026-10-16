#!/usr/bin/env node
/**
 * 无头加载验证：把 `client.js` 真的跑一遍，确认它能注册、apply 不抛错。
 *
 * ## 为什么需要它（这台设备上唯一的可行验证）
 *
 * 客户端 bundle 是 `window.__ModuleLoader__.load({id, factory})` 形式，正常只在
 * 浏览器里执行。而这台设备上**没有可用的原生 esbuild/vitest**（Android 的 W^X
 * 禁止从应用数据目录执行二进制），所以上游那套 `pnpm test` 跑不了。
 *
 * 但验证「bundle 能不能加载、apply 会不会抛」并不需要真浏览器：bundle 只依赖
 * `react` / `react-dom` 两个宿主模块，其余全是纯 JS。故本脚本：
 *
 *   1. 造一个最小 `window.__ModuleLoader__` 接住 `load({id, factory})`；
 *   2. 用**桩 React**（只实现 bundle 真正用到的 API）满足 `require`；
 *   3. 调 `factory(require)` ⇒ 拿到 `{ apply, inject, name }`；
 *   4. 用**假 ctx**（记录所有槽位注册）调 `apply(ctx)`；
 *   5. 断言：apply 不抛、注册了期望的槽位、且**没有重复注册**。
 *
 * ⚠️ 这不是端到端渲染测试（桩 React 不渲染）。它守的是**加载期与注册期**的
 * 失败 —— 而这两类恰恰是「改 client.js」最危险的部分：一个语法错误或一个
 * 缺符号会让**整个 Web 界面白屏**，而不只是某个功能不显示。
 *
 * 用法：
 *   node headless-client-check.mjs <client.js 路径> [--expect id1,id2,...]
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const expectArg = process.argv.indexOf('--expect');
const expect = expectArg > 0 && process.argv[expectArg + 1] !== undefined
  ? process.argv[expectArg + 1].split(',').filter((s) => s.length > 0)
  : [];
if (file === undefined) {
  console.error('用法: node headless-client-check.mjs <client.js> [--expect id1,id2]');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error(`文件不存在：${file}`); process.exit(1); }

// ── 桩 React：只实现被测 bundle 真正用到的 API ────────────────────────────────
let hooks = 0;
const React = {
  createElement: (type, props, ...children) => ({ $$typeof: 'el', type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => { hooks += 1; }],
  useEffect: () => { hooks += 1; },
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useLayoutEffect: () => { hooks += 1; },
  useContext: () => undefined,
  createContext: (v) => ({ Provider: null, Consumer: null, _v: v }),
  memo: (c) => c,
  forwardRef: (c) => c,
  Children: { map: (c, f) => (Array.isArray(c) ? c.map(f) : []), toArray: (c) => (Array.isArray(c) ? c : []) },
};
const ReactDOM = { createPortal: (node) => node, render: () => {}, createRoot: () => ({ render: () => {}, unmount: () => {} }) };

// ── 接住 bundle 注册 ─────────────────────────────────────────────────────────
let registered = null;
const win = {
  __ModuleLoader__: {
    load: (entry) => { registered = entry; },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
  navigator: { userAgent: 'node' },
  document: undefined,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
};
globalThis.window = win;
// ⚠️ 最小 DOM 桩：两个 bundle 都在 `ctx.effect` 里注入 `<style>`（真机上是必须的，
//    无头环境只需让它别抛）。只实现它们真正碰到的 API，不假装是完整 DOM。
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attributes: {},
    textContent: '', innerHTML: '', className: '',
    setAttribute: (k, v) => { el.attributes[k] = v; },
    getAttribute: (k) => el.attributes[k] ?? null,
    removeAttribute: (k) => { delete el.attributes[k]; },
    appendChild: (c) => { el.children.push(c); return c; },
    append: (...c) => { el.children.push(...c); },
    removeChild: (c) => { el.children = el.children.filter((x) => x !== c); return c; },
    remove: () => {},
    insertBefore: (c) => { el.children.unshift(c); return c; },
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    contains: () => false, focus: () => {}, click: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}
const documentStub = {
  head: makeElement('head'), body: makeElement('body'), documentElement: makeElement('html'),
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ textContent: text }),
  createDocumentFragment: () => makeElement('fragment'),
  querySelector: () => null, querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener: () => {}, removeEventListener: () => {},
  cookie: '',
};
globalThis.document = documentStub;
win.document = documentStub;
// ⚠️ Node 26 的 globalThis.navigator 是**只读 getter**，直接赋值抛 TypeError；
//    用 defineProperty 覆盖（bundle 只读 userAgent，给个普通对象即可）。
try {
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
} catch { /* 某些运行时不支持覆盖，忽略：bundle 不依赖它也能跑 */ }

const requireShim = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return ReactDOM;
  throw new Error(`未知依赖：${spec}（bundle 只应依赖 react / react-dom）`);
};

// ── 1. 加载 ──────────────────────────────────────────────────────────────────
const code = fs.readFileSync(file, 'utf8');
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', code)(win, globalThis);
} catch (error) {
  console.error(`✗ 加载失败（语法或顶层执行）：${error?.message ?? error}`);
  process.exit(1);
}
if (registered === null) { console.error('✗ bundle 没有调用 __ModuleLoader__.load'); process.exit(1); }
console.log(`✓ 加载成功  id=${registered.id}`);

let mod;
try {
  mod = registered.factory(requireShim);
} catch (error) {
  console.error(`✗ factory 执行失败：${error?.message ?? error}`);
  process.exit(1);
}
if (typeof mod?.apply !== 'function') { console.error('✗ factory 没有导出 apply'); process.exit(1); }
console.log(`✓ factory 执行成功  导出=${Object.keys(mod).join(',')}`);

// ── 2. 假 ctx：记录所有槽位注册 ──────────────────────────────────────────────
const registeredSlots = [];
const fakeSlotService = {
  inject: (name, cb) => {
    // 槽位是「注册器」：inject 拿到一个 register 函数，cb 里调它。
    const register = (def, component) => {
      registeredSlots.push({ slot: name, id: def?.id, order: def?.order, hasComponent: component !== undefined });
      return () => {};
    };
    try { cb(register); } catch (error) { throw new Error(`槽位 ${name} 的 inject 回调抛错：${error?.message ?? error}`); }
    return () => {};
  },
  register: (def) => { registeredSlots.push({ slot: def?.name, id: def?.id, order: def?.order, hasComponent: true }); return () => {}; },
};
const ctx = {
  slots: fakeSlotService,
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch (error) { throw new Error(`ctx.effect 回调抛错：${error?.message ?? error}`); } },
  inject: (deps, cb) => { if (typeof cb === 'function') { try { cb(); } catch { /* 依赖缺失在无头环境正常 */ } } return () => {}; },
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} }, load: async () => {} }) },
  sessions: {}, remote: { session: {} },
  // ⚠️ locale 服务的**真实形状**（读 OFM client.js 得来）：`ctx.locale.bind(NS)` 返回
  //    一个带 `.locale` 的取词函数，`ctx.locale.register(ns, dict)` 注册词典。
  //    桩少了 bind 会在 apply 第一步就抛错（实测撞过，故照实补上）。
  locale: Object.assign(
    (key) => key,
    {
      bind: () => Object.assign((key) => key, { locale: 'stub', ns: 'stub' }),
      register: () => {},
      t: (key) => key,
    },
  ),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => {}, off: () => {}, emit: () => {},
};

// ── 3. apply ─────────────────────────────────────────────────────────────────
try {
  mod.apply(ctx);
} catch (error) {
  console.error(`✗ apply 抛错：${error?.message ?? error}`);
  if (error?.stack) console.error(String(error.stack).split('\n').slice(1, 5).join('\n'));
  process.exit(1);
}
console.log(`✓ apply 执行成功  注册槽位 ${registeredSlots.length} 个`);
for (const s of registeredSlots) {
  console.log(`    ${String(s.slot).padEnd(28)} id=${String(s.id).padEnd(24)} order=${s.order} 组件=${s.hasComponent}`);
}

// ── 4. 断言 ──────────────────────────────────────────────────────────────────
let bad = 0;
for (const want of expect) {
  if (!registeredSlots.some((s) => s.id === want)) { console.error(`✗ 期望的槽位 id 未注册：${want}`); bad += 1; }
}
// 同一槽位 + 同一 id 注册两次 = 界面会出现两份（本次合并最容易踩的坑）。
const seen = new Map();
for (const s of registeredSlots) {
  const key = `${s.slot}::${s.id}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
for (const [key, n] of seen) {
  if (n > 1) { console.error(`✗ 重复注册 ${n} 次：${key}`); bad += 1; }
}
// 用量徽标槽位必须**恰好一个**（老 Jet Hub 那枚已摘除；两个会并排显示两枚胶囊）。
const badgeSlots = registeredSlots.filter((s) => s.slot === 'conversation.input.right');
if (badgeSlots.length > 1) {
  console.error(`✗ conversation.input.right 注册了 ${badgeSlots.length} 个（应为 1，否则输入框出现多枚胶囊）`);
  bad += 1;
}
if (bad > 0) process.exit(1);
console.log('\n✓ 全部断言通过');
