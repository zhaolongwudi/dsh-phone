#!/usr/bin/env node
/**
 * 直接渲染 **AggregatePanel**（绕开 `renderToString` 不跑 effect 的限制）。
 *
 * ## 为什么需要单独一个脚本
 *
 * `render-check.mjs` 渲染的是 `JetHubPage` 外壳，而它靠 `useEffect` 里的
 * `provider.status` 响应来挑第一个可用渠道（`selected` 初值是 `null`）。
 * **`renderToString` 不执行 effect** ⇒ `selected` 恒为 `null` ⇒
 * 子面板（含 `AggregatePanel`）**从不被渲染**。
 *
 * 实测证据：加了 `--rpc-data` 喂真数据后，HTML 仍是 **55913 字符**（与无数据时逐字相同）
 * ⇒ 那句话只证明了「外壳能渲染」，**没有**证明补丁 H 改过的聚合面板能渲染。
 *
 * ⇒ 本脚本从 `client.js` 里**抽出** `AggregatePanel` 及其依赖的纯函数，
 * 单独用真实 `react-dom/server` 渲染它，并**注入 `useState` 初值**让候选行真的渲染
 * （否则只渲染「读取中…」那半张壳，见下）。
 *
 * 用法：
 *   node render-aggregate.mjs <client.js>                    # 自己抓真实目录（默认）
 *   node render-aggregate.mjs <client.js> --catalog <json>   # 用给定目录（离线可复跑）
 *   node render-aggregate.mjs <client.js> --no-catalog       # 不注入（只验外壳能渲染）
 *
 * ⚠️ 默认路径会**自己去运行中的实例抓目录**（`aggregate.catalog`）—— 因为夹具文件
 *    （`rpcdata.json`）里含**真实账号信息**（昵称、credentialRef），不该留在盘上，
 *    故已删除；本脚本改为自带采集，保证「删掉夹具后仍可复跑」。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire('/data/data/com.dshphone/files/tree/node_modules/');
const React = require('react');
const ReactDOMServer = require('react-dom/server');

const file = process.argv[2];
const catIdx = process.argv.indexOf('--catalog');
const catFile = catIdx > 0 ? process.argv[catIdx + 1] : undefined;
const noCatalog = process.argv.includes('--no-catalog');
if (file === undefined || !fs.existsSync(file)) {
  console.error('用法: node render-aggregate.mjs <client.js> [--catalog <json>] [--no-catalog]');
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

/**
 * 取真实聚合目录。
 *
 * ⚠️ 缺省**自己抓**：含账号信息的夹具（rpcdata.json）已按要求删除，而本验证必须
 *    能随时复跑 ⇒ 内置采集，不依赖盘上残留。
 */
function fetchCatalog() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const out = execFileSync(process.execPath, [path.join(here, 'hub-rpc.mjs'), 'aggregate.catalog', '{}'], {
    cwd: here, encoding: 'utf8', timeout: 60_000,
  });
  const j = JSON.parse(out);
  if (j?.ok !== true) throw new Error(`aggregate.catalog 未成功：${JSON.stringify(j).slice(0, 200)}`);
  return j.value;
}


/**
 * 抽取「面板 + 它真正需要的纯函数」。
 *
 * ⚠️⚠️ **不能用写死的函数名清单**（真实教训）：初版列了 12 个名字，补丁 I 把面板换成
 * gitee 排序版后，它多调 `rotationRosterOf` / `rotationBlockerOf` / `candidateKeyOf` /
 * `moveCandidateTo` / `pendingOrderFromRoster` / `startExpiryReprobe` … ⇒
 * 抽取结果报 `rotationRosterOf is not defined`。
 * 而**产品本身是对的**（那 21 个函数在 client.js 里都有定义，已逐一核对）
 * ⇒ 那是**验证器的缺陷**，会被误读成「补丁坏了」。
 *
 * ⚠️⚠️ **判据也不能用「括号深度」**（第三次返工）：面板在 G 的 IIFE 里（depth 4），
 * 而辅助纯函数在 esbuild 包装的另一层（depth 3）—— **不在同一层**，
 * 用「与面板同 depth」匹配会一个辅助函数都抽不到（实测闭包只有 1 个）。
 *
 * ⇒ 最终判据：**行首缩进为 0**。本文件里真正的顶层定义（面板 + 全部纯函数）都**顶格**写；
 *   而嵌套函数（`startCarrierContribution` 内的 `schedule()` / `tick()` / `ensureGuest()`
 *   / `detailOf()`）都带 2 空格以上缩进 —— 实测区分得很干净。
 */
const TOP_LEVEL_INDENT = 0;

/** 该名字是否有「顶格定义」（行首无缩进）。 */
function findTopFn(source, name) {
  const needle = `function ${name}(`;
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    const lineStart = source.lastIndexOf('\n', at - 1) + 1;
    if (at - lineStart === TOP_LEVEL_INDENT) return at;
  }
  return -1;
}

/** 抽出一个顶格函数的源码（到下一个顶格定义为止）。 */
function extractFn(source, name) {
  const i = findTopFn(source, name);
  if (i < 0) throw new Error(`找不到顶格 function ${name}(`);
  const re = /\n(?:function |const [A-Za-z_$][\w$]* = )/g;
  re.lastIndex = i + 8;
  let m;
  let end = source.length;
  while ((m = re.exec(source)) !== null) {
    const at = m.index + 1; // 指向 'function '/'const ' 的起点
    if (at - (source.lastIndexOf('\n', at - 1) + 1) === TOP_LEVEL_INDENT) { end = at; break; }
  }
  return source.slice(i, end);
}

/** 依赖闭包：从 root 出发把**顶格**辅助函数逐个收进来，直到不再增长。 */
function extractClosure(source, rootName) {
  const have = new Map();
  const queue = [rootName];
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
  console.error('✗ 抽不到 AggregatePanel —— 合并可能没成功');
  process.exit(1);
}
console.log(`  依赖闭包：${closure.size} 个函数（${[...closure.keys()].slice(0, 6).join(', ')} …）`);

// ⚠️ 面板用的是 `React2.createElement`（esbuild 对第二份 react 的别名）。
const code = `
const React2 = React;
${parts.join('\n')}
return AggregatePanel;
`;

// ⚠️⚠️ `useState` 的 shim **必须在编译这一步注入**（真实教训）：
//    面板是在下面 `new Function('React', code)` 里**一次性求值**的，它闭包捕获的
//    就是这里传进去的那个 `React`。若先编译、事后再换一个 React 去 renderToString，
//    面板用的仍是**原来那个** `React2.useState` ⇒ shim 完全不起作用
//    （实测：仍然只渲染「读取中…」）。
//    ⇒ 把 shim 作为 `React` 传进编译，让面板从一开始就用它。
/**
 * 真实聚合目录（用于注入 `models` 初值）。
 *
 * 三种来源，按优先级：
 *   ① `--catalog <file>`：读文件（离线可复跑）。文件可能是**两种形状**，都要认
 *      （真实教训：只认裸 `{models}` 时，喂按端点分键的表会静默取到 `null`
 *      ⇒ shim 不生效 ⇒ 输出与不注入逐字相同，**却仍打印「✓ 通过」**）：
 *        a. 裸目录：`{ models: [...], orderMode }`
 *        b. 端点表：`{ 'aggregate.catalog': { models, orderMode }, … }`
 *   ② `--no-catalog`：不注入（只验外壳能渲染）。
 *   ③ 缺省：**自己抓**（见 `fetchCatalog()`）—— 夹具已删，保证随时可复跑。
 */
let catalog;
if (noCatalog) {
  catalog = undefined;
} else if (catFile !== undefined) {
  if (!fs.existsSync(catFile)) { console.error(`✗ --catalog 文件不存在：${catFile}`); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  catalog = Array.isArray(raw?.models) ? raw : raw['aggregate.catalog'];
} else {
  try {
    catalog = fetchCatalog();
  } catch (error) {
    console.error(`✗ 抓取 aggregate.catalog 失败：${error?.message}`);
    console.error('  （用 --catalog <json> 或 --no-catalog 可离线运行）');
    process.exit(1);
  }
}
const seedModels = Array.isArray(catalog?.models) ? catalog.models : null;
if (catFile !== undefined && seedModels === null) {
  console.error(`✗ --catalog 给了 ${catFile}，但里面找不到 models 数组（形状不认）。`);
  console.error('  支持：裸 {models:[...]} 或 {"aggregate.catalog":{models:[...]}}');
  process.exit(1);
}

/**
 * 让 `models`（与 `expanded`）的 `useState` **初值就是我们要验的东西**。
 *
 * ## ⚠️⚠️ 为什么必须这么做（本验证脚本存在的理由）
 *
 * `renderToString` **不执行 `useEffect`**，而面板的 `load()` 在 effect 里 ⇒
 * `models` 恒为 `null` ⇒ 组件只渲染「读取中…」那半张壳，
 * **`renderCandidate` 一次都不跑** —— 而那正是补丁 H 改动的地方。
 *
 * 实测证据：不注入时该面板只渲染 **844 字符**、RPC 一个都没发。
 *
 * ## 注入两处（缺一不可）
 *
 * 1. **`models`**（第 1 次 `useState`）＝ 真实目录 ⇒ 92 个模型行真的渲染（实测 25128 字符）；
 * 2. **`expanded`**（第 4 次 `useState`）＝ `{ [首个模型]: true }`
 *    ⇒ **候选行展开** ⇒ `renderCandidate` 才会跑。
 *    ⚠️ 只注入 `models` 时面板渲染到「模型头」就停了（25128 字符里
 *    **一个候选按钮都没有**）⇒ 「三态文案」断言必然**假红** ——
 *    那是**验证脚本的缺陷**，不是产品的。故两层都要注入。
 *
 * ⚠️ 只影响本验证脚本，不改产品代码。
 */
function shimReact(seed, expandKey) {
  // ⚠️⚠️ 计数必须**hoist 到 `get` 之外**（真实教训）：若写在 `get` 里，
  //    每次读 `React2.useState` 都会新建一个计数器 ⇒ 每次调用都被当成「第 1 次」
  //    ⇒ 面板的 models/rejections/busy… **全部**拿到目录数组 ⇒ 仍渲染「读取中…」。
  //    ⚠️⚠️ **序号必须按调用出现顺序核对**（又一次真实教训）：面板的 7 个
  //    `useState` 依次是 models(1) / rejections(2) / busy(3) / **notice(4)** /
  //    **expanded(5)** / expiryOrder(6) / expiryBusy(7)。
  //    我最初按「expanded 是第 4 个」注入 ⇒ 把 `{modelKey:true}` 塞给了 **notice**
  //    （一个对象当 React child）⇒ 渲染当场抛
  //    `Objects are not valid as a React child (found: object with keys {glm-5-3-flash})`。
  //    ⇒ 序号改动前，务必回源码重新数一遍。
  const I_MODELS = 1;
  const I_EXPANDED = 5;
  let n = 0;
  return new Proxy(React, {
    get(target, prop) {
      if (prop === 'useState') {
        return (init) => {
          n += 1;
          if (n === I_MODELS && seed !== null) return [seed, () => {}];
          if (n === I_EXPANDED && expandKey !== null) return [{ [expandKey]: true }, () => {}];
          return [typeof init === 'function' ? init() : init, () => {}];
        };
      }
      return target[prop];
    },
  });
}
// 展开首个模型，好让候选行（renderCandidate / 三态按钮）真的被渲染。
const firstModelKey = seedModels?.[0]?.canonicalId ?? null;
const reactForPanel = seedModels === null ? React : shimReact(seedModels, firstModelKey);

let Panel;
try {
  // eslint-disable-next-line no-new-func
  Panel = new Function('React', code)(reactForPanel);
} catch (error) {
  console.error(`✗ 抽出后求值失败：${error?.message}`);
  process.exit(1);
}
console.log(`✓ 抽出 ${parts.length} 段（含 AggregatePanel）${seedModels === null ? '' : `，已注入 ${seedModels.length} 个模型的初值`}`);

// ── 渲染 ─────────────────────────────────────────────────────────────────────
const calls = [];
// `catalog` 已在上面解析（含两种形状）—— 这里不再重复声明。
const rpcCall = async (endpoint) => {
  calls.push(endpoint);
  if (endpoint === 'aggregate.catalog' && catalog !== undefined) return catalog;
  return {};
};

let html;
try {
  html = ReactDOMServer.renderToString(React.createElement(Panel, { rpcCall }));
} catch (error) {
  console.error(`✗ AggregatePanel 渲染抛错：${error?.message}`);
  if (error?.stack) console.error(String(error.stack).split('\n').slice(1, 6).join('\n'));
  process.exit(1);
}
const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
console.log(`✓ AggregatePanel 渲染成功  HTML ${html.length} 字符`);
console.log(`  可见文本：${text.slice(0, 400)}`);
console.log(`  渲染期发出的 RPC：${[...new Set(calls)].join(', ') || '（无 —— 首次渲染在 state 初值）'}`);

// ── 断言 ─────────────────────────────────────────────────────────────────────
if (seedModels !== null) {
  const hasAllowed = text.includes('参与轮换');
  const hasDefault = text.includes('默认不参与');
  /**
   * 「注入是否生效」的判据。
   *
   * ⚠️⚠️ 必须**同时**接受两代面板的形态（真实教训）：npm 面板每个模型显示
   * 「N 个渠道 · 按渠道名」，而补丁 I 换成 gitee 排序版后改成**候选直接平铺**
   * （不再有「N 个渠道」这段文字）⇒ 只数 `个渠道` 会对新面板恒为 0，
   * 于是断言报「一个模型都没渲染出来 —— 初值注入没生效」**假红**，
   * 而实际 HTML 有 24760 字符、候选都在。
   * ⇒ 判据改为「三态文案里至少出现一种」**或**「出现了已知的候选形似文本」。
   */
  const modelCount = (text.match(/个渠道/g) || []).length;
  const hasCandidateRows = hasAllowed || hasDefault;
  console.log(`\n三态文案：参与轮换=${hasAllowed}  默认不参与=${hasDefault}`
    + `  模型行=${modelCount}  候选行=${hasCandidateRows}`);
  if (!hasCandidateRows) {
    console.error('✗ 没有任何候选行 —— 初值注入没生效（验证本身不可信）。');
    process.exit(1);
  }
  if (!hasDefault) {
    console.error('✗ 真实目录里有 default-rejected 候选，但面板没渲染出「默认不参与」——');
    console.error('  说明三态判定没生效（被当成「已拒绝」或「参与轮换」了）。');
    process.exit(1);
  }
}
if (text.length < 5) { console.error('\n✗ 渲染内容过少'); process.exit(1); }
console.log('\n✓ 通过');
