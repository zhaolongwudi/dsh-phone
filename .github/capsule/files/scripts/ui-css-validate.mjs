// CSS 结构校验：补足「花括号配平」之外的检查。
//
// ## 为什么需要
//
// 本轮对 dsh-phone.css 做了多轮**机械替换**（正则批量改选择器）。花括号配平只说明
// 括号成对，**证明不了结构合法** —— 例如：
//   - 声明块里混入非声明文本（替换时把注释片段带进规则体）
//   - 属性名/值被截断（替换边界切错）
//   - 注释未闭合，吞掉后续规则
//   - 选择器为空（`{...}` 或 `,{...}`）
// 这些都会让浏览器**静默丢弃该规则**，与本方案一路在防的失效形态同族。
//
// ## 用法
//   node scripts/ui-css-validate.mjs            校验（有问题非零退出）
//   node scripts/ui-css-validate.mjs --json
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** CSS 自定义属性与常规属性都允许的形态。 */
const DECL_RE = /^[-a-zA-Z_][-\w]*\s*:\s*.+$/s

/**
 * 校验 CSS 文本的结构。
 * @param css CSS 全文
 * @returns {{unclosedComment:boolean, unbalanced:object, badDeclarations:Array, emptySelectors:Array}}
 */
export function validateCss(css) {
  // 1) 注释闭合
  const opens = (css.match(/\/\*/g) || []).length
  const closes = (css.match(/\*\//g) || []).length
  const unclosedComment = opens !== closes

  // 去注释后再做结构检查（注释里的花括号不应参与）
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')

  // 2) 三类括号配平
  const count = (s, ch) => (s.match(new RegExp('\\' + ch, 'g')) || []).length
  const unbalanced = {
    brace: count(body, '{') !== count(body, '}'),
    paren: count(body, '(') !== count(body, ')'),
    bracket: count(body, '[') !== count(body, ']'),
  }

  // 3) 逐块检查声明与选择器
  const badDeclarations = []
  const emptySelectors = []
  // 用简单扫描：因为 CSS 无嵌套（本文件确实没有 @nest），按 { } 切分足够
  const re = /([^{}]*)\{([^{}]*)\}/g
  for (const m of body.matchAll(re)) {
    const sel = m[1].trim()
    const decls = m[2]
    if (!sel) { emptySelectors.push('(空选择器)'); continue }
    if (!decls.trim()) { emptySelectors.push('(空规则体) ' + sel.slice(0, 60)); continue }
    // 空选择器项：以逗号结尾/开头、含连续逗号，都说明某项为空
    // （实测补：最初只查「结尾」与「连续」，漏了「开头」与「整块为空」）
    if (/^\s*,/.test(sel) || /,\s*$/.test(sel) || /,\s*,/.test(sel)) emptySelectors.push(sel.slice(0, 80))
    // 声明体：按 ; 切，逐条必须是 prop:value
    for (const d of decls.split(';')) {
      const t = d.trim()
      if (!t) continue
      if (!DECL_RE.test(t)) badDeclarations.push({ sel: sel.slice(0, 60), decl: t.slice(0, 80) })
    }
  }
  return { unclosedComment, unbalanced, badDeclarations, emptySelectors, lostFallback: lostHashFallback(css) }
}

/** 人可读报告。 */
export function formatReport(r, path) {
  const L = [`CSS 结构校验 · ${path}`, '']
  const ok = s => (s ? '✗' : '✓')
  L.push(`${ok(r.unclosedComment)} 注释闭合`)
  L.push(`${ok(r.unbalanced.brace || r.unbalanced.paren || r.unbalanced.bracket)} 括号配平（花/圆/方）`)
  L.push(`${ok(r.badDeclarations.length)} 声明形态合法（${r.badDeclarations.length} 条异常）`)
  for (const b of r.badDeclarations.slice(0, 8)) L.push(`    [${b.sel}] ${b.decl}`)
  L.push(`${ok(r.emptySelectors.length)} 无空选择器（${r.emptySelectors.length} 处）`)
  for (const s of r.emptySelectors.slice(0, 5)) L.push(`    ${s}`)
  L.push(`${ok((r.lostFallback ?? []).length)} 属性优先替换保留 hash 兜底（${(r.lostFallback ?? []).length} 处丢失）`)
  for (const x of (r.lostFallback ?? []).slice(0, 5)) L.push(`    ${x.attr}`)
  const bad = r.unclosedComment || r.unbalanced.brace || r.unbalanced.paren || r.unbalanced.bracket
    || r.badDeclarations.length > 0 || r.emptySelectors.length > 0 || (r.lostFallback ?? []).length > 0
  L.push('')
  L.push(bad ? '✗ 未通过' : '✓ 通过')
  return L.join('\n')
}

/**
 * 检查「属性优先替换」是否都保留了原 hash 兜底。
 *
 * 依据：本方案对 CSS 的替换一律采用「属性优先 + 保留 hash」的超集形态
 * （9 处，均已人工核对）。若某处把 hash 删了，语义就从超集变成替换 —— 风险反转。
 *
 * @param css CSS 全文
 * @returns {Array<{attr:string, decl:string}>} 疑似丢了兜底的项
 */
export function lostHashFallback(css) {
  const out = []
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map(s => s.trim()).filter(Boolean)
    const decl = m[2].trim()
    // 只看含自有/上游语义属性的选择器组
    const hasAttr = sels.some(s => /\[data-[a-z-]+/.test(s))
    if (!hasAttr) continue
    // 该组里是否还有 CSS Module 哈希选择器作兜底
    const hasHash = sels.some(s => /\.[A-Za-z0-9_-]{5,10}_[a-zA-Z]/.test(s))
    // 例外：整组都指向**本层自建元素**（.dsh-phone-*，由本层 createElement 产生）
    // 时无需 hash 兜底 —— 那些元素与上游无关。
    // ⚠️ 注意不能把 `data-dsh-*` 也算作自有：它是本层发布的**事实**，但标在**上游元素**
    // 上（如 [data-dsh-frame] 标在框架根 div），仍需 hash 兜底。早先误豁免过，导致漏报。
    // 只看**末段**（被样式化的那个元素）：前面几段多半是条件（如 html[data-x] 作前提）。
    const selfBuilt = s => {
      const last = s.trim().split(/\s+/).pop()
      // 本层自建元素（.dsh-phone-*）与**外部插件契约**（.dim-jh-* = Jet Hub、
      // .dsh-phone-noema* = Noema）都不需要上游 hash 兜底 —— 它们与本层/上游
      // 的 CSS Module 无关。EXTERNAL 的口径须与 ui-layer-audit 保持一致。
      return /\.(dsh-phone-[a-z-]+|dim-jh-[a-z-]+)/.test(last)
    }
    const allSelfBuilt = sels.every(selfBuilt)
    if (!hasHash && !allSelfBuilt) out.push({ attr: sels.find(s => /\[data-/.test(s)), decl: decl.slice(0, 60) })
  }
  return out
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
  if (!cssPath) { console.log('CSS 结构校验 · 跳过（本布局下未找到 dsh-phone.css）'); process.exit(0) }
  const css = readFileSync(cssPath, 'utf8')
  const r = validateCss(css)
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else console.log(formatReport(r, cssPath))
  const bad = r.unclosedComment || r.unbalanced.brace || r.unbalanced.paren || r.unbalanced.bracket
    || r.badDeclarations.length > 0 || r.emptySelectors.length > 0 || (r.lostFallback ?? []).length > 0
  process.exit(bad ? 1 : 0)
}
