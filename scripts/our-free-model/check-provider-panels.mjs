#!/usr/bin/env node
/**
 * 逐个渲染 **17 个渠道面板**（`JetHubPage` 的 `selected` 分别设成每个渠道 id）。
 *
 * ## 为什么需要（真实的验证盲区）
 *
 * `render-check.mjs` 只渲染外壳，`selected` 是 `useState` 初值 = **第一个渠道**
 * ⇒ 只证明了**那一个**渠道的面板不白屏。而 17 个渠道的**能力不同**
 * （`credits` / `creditPackages` / `permanentLock` / `usesExpiryWindow` /
 * `rateLimit` / `accountTest` …），面板会走**不同分支** ⇒
 * 「1 个能渲染」推不出「17 个都能渲染」。
 *
 * ## 做法
 *
 * 装一个 hook dispatcher：**第 1 个 `useState`**（= `JetHubPage` 的 `selected`）
 * 按参数注入成目标渠道 id（`JetHubPage` 的 hooks 先于子组件执行，故序号 1 稳定）。
 * 然后对每个渠道渲染一次，任一抛错即失败。
 *
 * 用法：
 *   node check-provider-panels.mjs <client.js>
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/data/data/com.dshphone/files/tree/node_modules/');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const file = process.argv[2];
if (file === undefined || !fs.existsSync(file)) {
  console.error('用法: node check-provider-panels.mjs <client.js>');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

// ── 依赖闭包（行首缩进判顶层；函数与常量统一；按源码顺序输出）──────────────
const TOP = 0;
function findTop(source, name) {
  const needle = `function ${name}(`;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (at - (source.lastIndexOf('\n', at - 1) + 1) === TOP) return at;
  }
  return -1;
}
function sliceTop(source, at) {
  const re = /\n(?:function |var [A-Za-z_$][\w$]* = |const [A-Za-z_$][\w$]* = )/g;
  re.lastIndex = at + 8;
  let m;
  let end = source.length;
  while ((m = re.exec(source)) !== null) {
    const n = m.index + 1;
    if (n - (source.lastIndexOf('\n', n - 1) + 1) === TOP) { end = n; break; }
  }
  return source.slice(at, end);
}
function extractConst(source, name) {
  for (const kw of ['var ', 'const ', 'let ']) {
    const needle = `${kw}${name} =`;
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      if (at - (source.lastIndexOf('\n', at - 1) + 1) !== TOP) continue;
      return sliceTop(source, at);
    }
  }
  return null;
}
const SKIP = new Set([
  'React2', 'React', 'require', 'module', 'exports', '__toESM', '__toCommonJS',
  '__commonJS', '__defProp', '__export', '__reExport', '__copyProps',
  'import_react', 'import_react_dom', 'import_jsx_runtime',
]);
function extractClosure(source, root) {
  const have = new Map();
  const queue = [root];
  /**
   * ⚠️⚠️ 必须**先判 `findTop` 是否命中**（真实教训）：
   * `findTop` 对常量返回 **-1**，而 `sliceTop(source, -1)` **不会抛错** ——
   * 它会从文件末尾附近切出一段垃圾当「定义」返回 ⇒ 常量永远抽不到，
   * 表现为 `PROVIDER_REGISTRY is not defined` / 渠道列表为空。
   * （早先那版用 `throw` 表示未命中，所以没踩到；这版改成显式判定。）
   */
  const take = (n) => {
    const at = findTop(source, n);
    if (at >= 0) return sliceTop(source, at);
    return extractConst(source, n);
  };
  while (queue.length > 0) {
    const name = queue.shift();
    if (have.has(name)) continue;
    const body = take(name);
    if (body === null) continue;
    have.set(name, body);
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const id = m[1];
      if (have.has(id) || queue.includes(id) || SKIP.has(id)) continue;
      if (extractConst(source, id) !== null || findTop(source, id) >= 0) queue.push(id);
    }
  }
  return have;
}

const closure = extractClosure(src, 'JetHubPage');
if (!closure.has('JetHubPage')) { console.error('✗ 抽不到 JetHubPage'); process.exit(1); }

// 渠道 id 列表（从 PROVIDER_REGISTRY 里取，避免写死）
const registry = closure.get('PROVIDER_REGISTRY') ?? src.slice(src.indexOf('var PROVIDER_REGISTRY ='), src.indexOf('var PROVIDER_REGISTRY =') + 20000);
const ids = [...new Set([...registry.matchAll(/id:\s*"([a-z0-9]+)"/g)].map((m) => m[1]))];
if (ids.length === 0) { console.error('✗ 从 PROVIDER_REGISTRY 抽不到渠道 id'); process.exit(1); }

const ordered = [...closure.entries()]
  .map(([, body]) => ({ body, at: src.indexOf(body) }))
  .sort((a, b) => a.at - b.at)
  .map((x) => x.body);
const code = `const React2 = React;\n${ordered.join('\n')}\nreturn JetHubPage;`;

/**
 * ⚠️⚠️ **注入必须在编译期**（真实教训）：我第一版装的是
 * `ReactCurrentDispatcher.current`，结果 **18 个渠道渲染出逐字节相同的 HTML**
 * （55913 字符，全都是默认渠道）—— 因为 `renderToString` 会**自己安装 dispatcher**，
 * 把我在外面装的那份**覆盖掉**，注入等于没发生。
 * ⇒ 改为「把代理过的 `React` 传给 `new Function`」：组件闭包捕获的就是这个 `React`，
 *    `renderToString` 换 dispatcher 也换不掉它（与 `render-aggregate.mjs` 同款手法）。
 */
function makeReact(pick) {
  let n = 0;
  return new Proxy(React, {
    get(target, prop) {
      // ⚠️ `useEffect` 不执行：要的是**初值那棵树**（renderToString 本来也不跑 effect）。
      if (prop === 'useEffect' || prop === 'useLayoutEffect') return () => {};
      if (prop === 'useState') {
        return (init) => {
          n += 1;
          // 第 1 个 useState 就是 JetHubPage 的 `selected`（父组件先于子组件执行）。
          if (n === 1) return [pick, () => {}];
          return [typeof init === 'function' ? init() : init, () => {}];
        };
      }
      return target[prop];
    },
  });
}

/** 渲染一次，`selected` 注入成 `pick`。 */
function render(pick) {
  const Page = new Function('React', code)(makeReact(pick));
  return ReactDOMServer.renderToString(React.createElement(Page, { rpcCall: async () => ({}) }));
}

console.log(`渠道数：${ids.length}（${ids.join(', ')}）\n`);
let bad = 0;
/**
 * ⚠️⚠️ **必须有「注入真的生效了」的判据**（真实教训）：
 * 我第一版注入无效（被 `renderToString` 自装的 dispatcher 覆盖），
 * 18 个渠道渲染出**逐字节相同**的 HTML，而脚本**照样报「全部通过」** ——
 * 一个「全绿却什么也没验」的假绿。
 * ⇒ 这里比对：不同渠道的 HTML 必须**互不相同**；若全部相同，说明 `selected`
 *    根本没被注入 ⇒ 验证不可信，直接失败。
 */
const seen = new Map();
for (const id of ids) {
  let html;
  try {
    html = render(id);
  } catch (error) {
    console.error(`  ✗ ${id.padEnd(12)} 渲染抛错：${error?.message}`);
    bad += 1;
    continue;
  }
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 40) { console.error(`  ✗ ${id.padEnd(12)} 内容过少（${text.length} 字符，疑似白屏）`); bad += 1; continue; }
  if (seen.has(html)) {
    console.error(`  ✗ ${id.padEnd(12)} 与「${seen.get(html)}」的 HTML 逐字节相同`
      + ' ⇒ selected 注入没生效（假绿），本次验证不可信');
    bad += 1;
    continue;
  }
  seen.set(html, id);
  console.log(`  ✓ ${id.padEnd(12)} HTML ${String(html.length).padStart(6)} 字符  「${text.slice(0, 60)}」`);
}
console.log();
if (bad > 0) { console.error(`✗ ${bad} / ${ids.length} 个渠道面板有问题`); process.exit(1); }
console.log(`✓ ${ids.length} 个渠道面板全部渲染通过（且互不相同 ⇒ 注入确实生效）`);
