// UI 层健康检查：把本方案建立的不变量集中到一处，自动拦「代码与样式对不上」类问题。
//
// ## 为什么需要它
//
// 一路改下来踩到的这类问题有个共同特征：**不报错**。构建通过、类型检查通过、
// 单测通过，但界面少一块或位置不对。具体三种：
//   1. JS 用 classList 切换了状态类，但 CSS 里没有对应规则 ⇒ 状态切换是死代码
//      （用户点了没反应）。实测：body.dsh-phone-mobile 的规则被改成属性选择器后，
//      JS 里那行 toggle 就成了这种死代码，还会误导后来者。
//   2. CSS 选了 .dsh-phone-* 但没人写它 ⇒ 死规则。
//   3. CSS 用了 var(--dsh-phone-*) 但既无定义也无人设置 ⇒ 静默取空值。
//
// ## 判据（经实测校正，避免误报）
//   A. **状态类**（由 classList 切换）必须有 CSS 消费。
//      ⚠️ 必须与「创建标记」区分：className 赋值只是元素身份标签（供 JS 查询或
//      纯语义标注，如上传用的隐藏 input），不要求样式规则。早先把两者混为一谈，
//      一次性误报了 5 个 class —— 判据立错就会一直误报，故此处按语义分开。
//   B. CSS 里的 .dsh-phone-* 选择器必须有人写它；**外部契约豁免** —— dim-jh-*
//      （Jet Hub）与 dsh-phone-noema*（Noema）的 DOM 由别的插件产生。
//   C. 变量必须有来源；JS 的「常量前缀 + 拼接」形态（setProperty(prefix + 'left')）
//      也要认，否则又会误报。
//
// ## 用法
//   node scripts/ui-layer-audit.mjs           检查（有问题非零退出）
//   node scripts/ui-layer-audit.mjs --json
//   node scripts/ui-layer-audit.mjs --report  只报告
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 自有命名空间（本层注入的 class 一定带这些前缀）。 */
const OWN_PREFIX = /^(dsh-phone-|dsh-peer-|dsh-drawer-)/

/** 外部插件契约：DOM 由别的插件产生，本层只做适配，看不到产生方。 */
const EXTERNAL_PREFIX = /^(dim-jh-|dsh-phone-noema)/

/** 把空白分隔的 class 收进集合。 */
function collect(out, s) {
  for (const c of String(s).split(/\s+/)) if (c) out.add(c)
}

/**
 * 提取 JS 用 classList 切换的**状态类**（承载开/关语义）。
 * @param js JS 全文
 * @returns {Set<string>}
 */
export function stateClassesToggledByJs(js) {
  const out = new Set()
  for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*['"]([^'"]+)['"]/g)) collect(out, m[1])
  return out
}

/**
 * 提取 JS 赋值的**创建标记**（className，元素身份标签，不要求 CSS 规则）。
 * @param js JS 全文
 * @returns {Set<string>}
 */
export function markerClassesAssignedByJs(js) {
  const out = new Set()
  for (const m of js.matchAll(/className\s*[:=]\s*['"]([^'"]+)['"]/g)) collect(out, m[1])
  return out
}

/**
 * 提取 JS 里被 querySelector/closest/matches 引用的 class（选择器锚点）。
 * @param js JS 全文
 * @returns {Set<string>}
 */
export function classesUsedAsSelectors(js) {
  const out = new Set()
  const re = /(?:querySelector(?:All)?|closest|matches)\(\s*['"]([^'"]+)['"]/g
  for (const m of js.matchAll(re)) {
    for (const c of m[1].matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) out.add(c[1])
  }
  // 经变量的选择器：常量数组 ['.dsh-x',…] 配 querySelector(selector)
  if (/(?:querySelector(?:All)?|closest|matches)\(\s*\w+\s*\)/.test(js)) {
    for (const m of js.matchAll(/['"]\.([A-Za-z_][A-Za-z0-9_-]*)[ '"]/g)) out.add(m[1])
  }
  return out
}

/**
 * 提取 CSS 选择器引用的 class（去注释，避免示例类名被当规则）。
 * @param css CSS 全文
 * @returns {Set<string>}
 */
export function classesUsedByCss(css) {
  const out = new Set()
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of body.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) out.add(m[1])
  return out
}

/** CSS 使用的 --dsh-phone-* 变量。 */
export function phoneVarsUsed(css) {
  const out = new Set()
  for (const m of css.matchAll(/var\(\s*(--dsh-phone-[A-Za-z0-9_-]+)/g)) out.add(m[1])
  return out
}

/** CSS 定义的 --dsh-phone-* 变量。 */
export function phoneVarsDefined(css) {
  const out = new Set()
  for (const m of css.matchAll(/(--dsh-phone-[A-Za-z0-9_-]+)\s*:/g)) out.add(m[1])
  return out
}

/** JS 里 setProperty 的字面量变量名。 */
export function phoneVarsSetByJs(js) {
  const out = new Set()
  for (const m of js.matchAll(/setProperty\(\s*['"](--dsh-phone-[A-Za-z0-9_-]+)['"]/g)) out.add(m[1])
  return out
}

/**
 * JS 里「常量前缀 + 拼接」设置的变量（如 setProperty(prefix + 'left', …)）。
 * @param js JS 全文
 * @returns {Set<string>}
 */
export function phoneVarsSetByConcat(js) {
  const out = new Set()
  const prefixes = [...js.matchAll(/(?:const|let|var)\s+\w+\s*=\s*['"](--dsh-phone-[A-Za-z0-9_-]*)['"]/g)].map(m => m[1])
  if (prefixes.length === 0) return out
  for (const m of js.matchAll(/setProperty\(\s*\w+\s*\+\s*['"]([A-Za-z0-9_-]+)['"]/g)) {
    for (const p of prefixes) out.add(p + m[1])
  }
  for (const m of js.matchAll(/\[\s*((?:'[A-Za-z0-9_-]+'\s*,?\s*)+)\](?=[^\n]*\bprefix\b)/g)) {
    for (const k of m[1].matchAll(/'([A-Za-z0-9_-]+)'/g)) {
      for (const p of prefixes) out.add(p + k[1])
    }
  }
  return out
}

/**
 * 执行图层健康检查。
 * @param cssPath CSS 路径
 * @param jsPath JS 路径
 * @returns {{deadState:string[], deadCss:string[], undefinedVars:string[]}}
 */
/**
 * @param cssPath CSS 文件
 * @param jsPath 主 JS（app/src/main/assets/dsh-phone.js）
 * @param extraJs 额外 JS 文本（可选）：客户端插件源与生成产物同样会产出
 *   `.dsh-phone-*` 类名的 DOM。不纳入会把这些类的 CSS 规则误判为「死 CSS」
 *   —— 实测踩过：三期遮罩的 .dsh-phone-mask 就因此被误报。
 */
export function auditLayer(cssPath, jsPath, extraJs = []) {
  const css = readFileSync(cssPath, 'utf8')
  const js = readFileSync(jsPath, 'utf8')
  const pluginJs = extraJs.join('\n')

  const state = stateClassesToggledByJs(js)
  const marker = markerClassesAssignedByJs(js)
  // 插件侧只参与「谁写了这个类」，不参与状态类判定（它没有本层的 classList 逻辑）。
  const asSelector = classesUsedAsSelectors(js)
  const pluginMarkers = markerClassesAssignedByJs(pluginJs)
  const pluginSelectors = classesUsedAsSelectors(pluginJs)
  const used = classesUsedByCss(css)
  const varsKnown = new Set([...phoneVarsDefined(css), ...phoneVarsSetByJs(js), ...phoneVarsSetByConcat(js)])

  const writtenAny = new Set([...state, ...marker, ...asSelector, ...pluginMarkers, ...pluginSelectors])


  return {
    // A：状态类必须有 CSS 消费（否则切换是死代码）
    deadState: [...state].filter(c => OWN_PREFIX.test(c) && !used.has(c)).sort(),
    // B：CSS 选了但无人写（排除外部契约）
    deadCss: [...used]
      .filter(c => /^dsh-phone-/.test(c) && !EXTERNAL_PREFIX.test(c) && !writtenAny.has(c))
      .sort(),
    // C：用了但无来源
    undefinedVars: [...phoneVarsUsed(css)].filter(v => !varsKnown.has(v)).sort(),
  }
}

/** 生成人可读报告。 */
export function formatReport(r) {
  const L = ['UI 图层健康检查（代码 ↔ 样式 一致性）', '']
  const sec = (title, items, hint) => {
    if (items.length) {
      L.push(`✗ ${title} ${items.length} 项：`)
      for (const i of items) L.push('    ' + i)
      L.push(`    → ${hint}`)
    } else L.push(`✓ ${title}：无`)
  }
  sec('状态类无 CSS 消费者（classList 切换了但样式无规则 → 切换是死代码）', r.deadState,
    '补 CSS 规则，或确认该状态确实不需要样式（那 JS 那行该删）')
  sec('死 CSS（选了 .dsh-phone-* 但无人写它，且非外部契约）', r.deadCss,
    '确认是否还有动态拼接产生该类；否则删除该规则')
  sec('未定义变量（用了 --dsh-phone-* 但无定义也无 JS 设置）', r.undefinedVars,
    '在 CSS 里定义，或确认 JS 会设置它')
  const bad = r.deadState.length + r.deadCss.length + r.undefinedVars.length
  L.push('')
  L.push(bad === 0 ? '✓ 通过' : `✗ ${bad} 项需处理`)
  return L.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const locate = rel => {
    let d = HERE
    for (let i = 0; i < 10; i++) {
      for (const p of ['overrides/', 'files/', '']) {
        const f = join(d, p + rel)
        if (existsSync(f)) return f
      }
      const up = dirname(d); if (up === d) break; d = up
    }
    return null
  }
  const cssPath = locate('app/src/main/assets/dsh-phone.css')
  const jsPath = locate('app/src/main/assets/dsh-phone.js')
  if (!cssPath || !jsPath) {
    console.log('UI 图层健康检查 · 跳过（本布局下未找到 dsh-phone.css/js）')
    process.exit(0)
  }
  // 三期之后，客户端插件（源与产物）也会产出 `.dsh-phone-*` 类名的 DOM，
  // 故一并交给审计 —— 否则插件的类会被误判成死 CSS（实测踩过 .dsh-phone-mask）。
  const pluginCandidates = [
    'peer/agent-cards/client-source.js',
    'phone-qq/cards-client.js',
    'peer/agent-cards/client.js',
  ]
  const extraJs = []
  for (const rel of pluginCandidates) {
    const p = locate(rel)          // 与 cssPath/jsPath 同一套定位逻辑
    if (p) extraJs.push(readFileSync(p, 'utf8'))
  }
  const r = auditLayer(cssPath, jsPath, extraJs)
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else console.log(formatReport(r))
  const bad = r.deadState.length + r.deadCss.length + r.undefinedVars.length
  process.exit(process.argv.includes('--report') ? 0 : (bad === 0 ? 0 : 1))
}
