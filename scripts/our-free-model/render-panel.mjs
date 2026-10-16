#!/usr/bin/env node
/**
 * 通用「单面板渲染」验证器：抽出任意具名组件 + 依赖闭包，真渲染它。
 *
 * ## 为什么需要（补丁盲区）
 *
 * `render-check.mjs` 渲染的是 `JetHubPage` **外壳**，而外壳靠 state 选面板：
 *   - `selected`（初值 = 第一个渠道）决定 `ProviderPanel` / `AggregatePanel`；
 *   - `showGateway` / `showTokenLedger` 等**布尔覆盖层**决定弹窗面板。
 * ⇒ 外壳渲染成功**只能证明外壳没白屏**，证明不了那些面板自己能不能渲染。
 * 这正是本仓库记过的那类缺陷（「构建绿、单测绿，只有点开才白屏」）。
 *
 * ## 做法
 *
 * 复用 `render-aggregate.mjs` 的**依赖闭包抽取**（行首缩进判顶层，
 * 不写死函数名 —— 那两个坑都踩过），把目标组件和它需要的辅助函数抽出来，
 * 装一个最小 hook dispatcher，用真 `react-dom/server` 渲染。
 *
 * 用法：
 *   node render-panel.mjs <client.js> <组件名> [--expect <必须出现的文本>]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/data/data/com.dshphone/files/tree/node_modules/');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const file = process.argv[2];
const want = process.argv[3];
const exIdx = process.argv.indexOf('--expect');
const expectText = exIdx > 0 ? process.argv[exIdx + 1] : undefined;
if (file === undefined || want === undefined || !fs.existsSync(file)) {
  console.error('用法: node render-panel.mjs <client.js> <组件名> [--expect <文本>]');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

/**
 * 行首缩进为 0 判「顶层定义」。
 *
 * ⚠️ 不能用写死的函数名清单（换面板版本就不够用）；
 *    也不能用「括号深度 === 0」（面板在 esbuild 包装 + 补丁 G 的 IIFE 里，深度 4）。
 *    实测行首缩进判得最干净：顶层定义都顶格，嵌套函数都带缩进。
 */
const TOP_LEVEL_INDENT = 0;
function findTop(source, name) {
  const needle = `function ${name}(`;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (at - (source.lastIndexOf('\n', at - 1) + 1) === TOP_LEVEL_INDENT) return at;
  }
  return -1;
}
function extractFn(source, name) {
  const i = findTop(source, name);
  if (i < 0) throw new Error(`找不到顶格 function ${name}(`);
  const re = /\n(?:function |var [A-Za-z_$][\w$]* = |const [A-Za-z_$][\w$]* = )/g;
  re.lastIndex = i + 8;
  let m;
  let end = source.length;
  while ((m = re.exec(source)) !== null) {
    const at = m.index + 1;
    if (at - (source.lastIndexOf('\n', at - 1) + 1) === TOP_LEVEL_INDENT) { end = at; break; }
  }
  return source.slice(i, end);
}

/**
 * 抽一个顶格**常量**（`var X = …` / `const X = …`）。
 *
 * ⚠️⚠️ 必须支持常量，不能只抽函数（真实教训）：`GatewayPanel` 用到
 * `MODEL_STATUS_FILTERS` —— 只抽函数会让渲染报 `MODEL_STATUS_FILTERS is not defined`，
 * 看起来像**产品坏了**，实际是**验证器抽取不全**。
 * bundles 里这些模块级常量都是顶格的 `var X = …`。
 */
function extractConst(source, name) {
  for (const kw of ['var ', 'const ', 'let ']) {
    const needle = `${kw}${name} =`;
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      if (at - (source.lastIndexOf('\n', at - 1) + 1) !== TOP_LEVEL_INDENT) continue;
      const re = /\n(?:function |var [A-Za-z_$][\w$]* = |const [A-Za-z_$][\w$]* = )/g;
      re.lastIndex = at + needle.length;
      let m;
      let end = source.length;
      while ((m = re.exec(source)) !== null) {
        const nextAt = m.index + 1;
        if (nextAt - (source.lastIndexOf('\n', nextAt - 1) + 1) === TOP_LEVEL_INDENT) { end = nextAt; break; }
      }
      return source.slice(at, end);
    }
  }
  return null;
}

function extractClosure(source, root) {
  const have = new Map();
  const queue = [root];
  /**
   * ⚠️⚠️ 常量扫描必须**排除 bundle 自身的基础设施**（真实教训）：
   * bundles 顶部有 \`var React2 = __toESM(require("react"), 1)\` 这类定义，
   * 扫进来会让 \`new Function\` 报 \`SyntaxError: Identifier \React2 has already been declared\`
   * —— 因为我们自己的包装就声明了 \`const React2 = React\`。
   */
  const SKIP = new Set([
    "React2", "React", "require", "module", "exports", "__toESM", "__toCommonJS",
    "__commonJS", "__defProp", "__export", "__reExport", "__copyProps",
    "import_react", "import_react_dom", "import_jsx_runtime",
  ]);
  /** 取一个顶格定义的源码：先当函数，再当常量。找不到返回 null。 */
  const take = (name) => {
    try { return extractFn(source, name); } catch { /* 不是函数 */ }
    return extractConst(source, name);
  };
  /** 把源码里引用到的**顶格定义**入队（函数与常量统一处理）。 */
  const enqueueRefs = (body) => {
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const id = m[1];
      if (have.has(id) || queue.includes(id) || SKIP.has(id)) continue;
      // ⚠️ 只收**顶格**定义。常量之间会互相依赖（GatewayPanel → MODEL_STATUS_FILTERS
      //    → PROVIDER_REGISTRY），故常量的引用也要再入队 —— 统一走队列即可。
      if (extractConst(source, id) !== null || findTop(source, id) >= 0) queue.push(id);
    }
  };
  while (queue.length > 0) {
    const name = queue.shift();
    if (have.has(name)) continue;
    const body = take(name);
    if (body === null) continue;
    have.set(name, body);
    enqueueRefs(body);
  }
  return have;
}

const closure = extractClosure(src, want);
if (!closure.has(want)) {
  console.error(`✗ 抽不到 ${want} —— 它可能不是顶格定义，或名字不对`);
  process.exit(1);
}
console.log(`✓ 抽到 ${want}（闭包 ${closure.size} 个函数）`);

/** 最小 hook dispatcher：state 用初值，effect 不跑（要的是初值那棵树）。 */
const INTERNALS = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const calls = [];
const rpcCall = async (endpoint) => { calls.push(endpoint); return {}; };
const dispatcher = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useInsertionEffect: () => {},
  useRef: (init) => ({ current: init }),
  useContext: () => undefined,
  useReducer: (_r, init) => [typeof init === 'function' ? init() : init, () => {}],
  useDebugValue: () => {},
  useImperativeHandle: () => {},
  useTransition: () => [false, (fn) => (typeof fn === 'function' ? fn() : undefined)],
  useDeferredValue: (v) => v,
  useId: () => 'stub-id',
  useSyncExternalStore: (_s, g) => (typeof g === 'function' ? g() : undefined),
};

/**
 * ⚠️⚠️ **必须按源码顺序输出**（真实教训，本验证器第三次返工）：
 * 闭包是 BFS 收集的（`queue.shift()` 逐层展开），而 bundle 里的
 * `var PROVIDER_REGISTRY = …` 与 `const RATE_LIMIT_CAPABILITIES = …` 是
 * **按源序求值**的 —— 后者 `Object.fromEntries(PROVIDER_REGISTRY.filter(…))`
 * 直接引用前者。按 BFS 顺序拼接会让 `PROVIDER_REGISTRY` 排在未初始化处 ⇒
 * 报 `TypeError: Cannot read properties of undefined (reading 'map')`，
 * 看起来像**产品坏了**，其实是**验证器把定义顺序打乱了**。
 * ⇒ 按各段在源文件中的位置排序后再拼接。
 */
const ordered = [...closure.entries()]
  .map(([name, body]) => ({ body, at: src.indexOf(body) }))
  .sort((a, b) => a.at - b.at)
  .map((x) => x.body);
const code = `const React2 = React;\n${ordered.join('\n')}\nreturn ${want};`;
const Comp = new Function('React', code)(React);
const props = { rpcCall, ctx: { slots: { register: () => {}, inject: () => {} } } };

let html;
const prev = INTERNALS.ReactCurrentDispatcher.current;
INTERNALS.ReactCurrentDispatcher.current = dispatcher;
try {
  html = ReactDOMServer.renderToString(React.createElement(Comp, props));
} catch (error) {
  console.error(`✗ ${want} 渲染抛错：${error?.message}`);
  if (error?.stack) console.error(String(error.stack).split('\n').slice(1, 5).join('\n'));
  process.exit(1);
} finally {
  INTERNALS.ReactCurrentDispatcher.current = prev;
}
const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`✓ ${want} 渲染成功  HTML ${html.length} 字符`);
console.log(`  可见文本：${text.slice(0, 240)}`);
if (expectText !== undefined) {
  if (!text.includes(expectText) && !html.includes(expectText)) {
    console.error(`\n✗ 渲染结果里找不到期望文本「${expectText}」`);
    process.exit(1);
  }
  console.log(`  ✓ 含期望文本「${expectText}」`);
}
if (text.length < 5) { console.error('\n✗ 渲染内容过少（疑似白屏）'); process.exit(1); }
console.log('\n✓ 通过');
