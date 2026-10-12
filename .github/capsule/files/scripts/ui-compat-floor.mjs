// WebView 兼容下限核查：本层新增的 CSS/JS 特性是否低于目标内核支持面。
//
// ## 为什么需要
//
// 本项目的 `dsh-phone.compat.js` 在**运行时补** Chrome 97–119 区间的新 API
// （`Array.prototype.toSorted` / `Promise.withResolvers` / `AbortSignal.any` 等），
// 说明目标 WebView 内核**相当老**。本层若引入更新的特性（如 CSS `:has()` 需
// Chrome 105、`@container` 需 105），在目标设备上会**静默失效**（选择器不命中）
// 或直接抛错 —— 与本方案一路在防的形态同族。
//
// 本脚本对照一张**特性 → 内核要求**表，检查本层新增资产是否越界；越界即报红，
// 由维护者决定「改用等价老特性」还是「加进 compat.js 运行时补」。
//
// ## 用法
//   node scripts/ui-compat-floor.mjs           核查（越界非零退出）
//   node scripts/ui-compat-floor.mjs --json
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 特性 → { 要求, 说明, 风险 }。
 * 数值取自各特性首次可用的 Chrome 版本（Android WebView 与 Chrome 同源）。
 */
export const FEATURES = {
  // CSS
  ':has(': { since: 105, kind: 'CSS', note: '父选择器' },
  ':is(': { since: 88, kind: 'CSS', note: '匹配列表' },
  ':where(': { since: 88, kind: 'CSS', note: '零特异性匹配列表' },
  '@container': { since: 105, kind: 'CSS', note: '容器查询' },
  ':focus-visible': { since: 86, kind: 'CSS', note: '焦点可见' },
  'aspect-ratio': { since: 88, kind: 'CSS', note: '宽高比' },
  'inset:': { since: 87, kind: 'CSS', note: 'inset 简写' },
  // JS
  'toSorted(': { since: 110, kind: 'JS', note: '数组复制排序' },
  'withResolvers(': { since: 119, kind: 'JS', note: 'Promise.withResolvers' },
  'AbortSignal.any': { since: 116, kind: 'JS', note: '信号组合' },
  'structuredClone(': { since: 98, kind: 'JS', note: '深拷贝' },
  '??=': { since: 85, kind: 'JS', note: '空值赋值' },
  '?.': { since: 80, kind: 'JS', note: '可选链' },
  '??': { since: 80, kind: 'JS', note: '空值合并' },
  'at(-': { since: 92, kind: 'JS', note: 'Array.at' },
  'Object.hasOwn(': { since: 93, kind: 'JS', note: 'hasOwn' },
  'replaceAll(': { since: 85, kind: 'JS', note: 'replaceAll' },
}

/**
 * 目标内核下界（Chrome 版本）—— **保守估计值**。
 *
 * 依据：本项目 `dsh-phone.compat.js` 运行时补这些 API（实测读其源码）：
 *   findLast (97) / structuredClone (98) / AbortSignal.timeout (103)
 *   toSorted (110) / AbortSignal.any (116) / Promise.withResolvers (119)
 *
 * **语义要说清**：compat 补到 119 并不代表「下界 = 119」——补丁是防御性的，
 * 真实内核可能更低。真实下界不可知时，正确做法是取**保守侧**（把支持面想得最窄），
 * 即 compat 覆盖到的**最老**那个 API 的版本：**97**。
 *
 * 取保守值的含义：凡 ≥97 的特性都会被列出来，由维护者核对「基线是否确实在用」。
 * 这样宁可多问一次，也不会漏掉一个真会在老内核上失效的特性。
 *
 * ⚠️ compat.js 是**上游文件**，不在本层胶囊里，故不能靠本层文件推断；
 * 该常量来自对本项目基线的实测读取，上游 compat.js 变动时应复核。
 */
export const COMPAT_FLOOR = 97

/**
 * 从 compat.js 推断下限（可选；本层通常拿不到该文件，故仅作参考）。
 * @param compatText compat.js 全文
 * @returns {{floor:number, patched:string[]}}
 */
/** 特性 → compat.js 里用于探测它的全限定名（实测形态）。 */
const COMPAT_PROBES = {
  'toSorted(': ['Array.prototype.toSorted'],
  'withResolvers(': ['Promise.withResolvers'],
  'AbortSignal.any': ['AbortSignal.any'],
  'structuredClone(': ['structuredClone'],
  'replaceAll(': ['String.prototype.replaceAll'],
  'at(-': ['Array.prototype.at'],
  'Object.hasOwn(': ['Object.hasOwn'],
}

export function inferFloor(compatText) {
  const patched = []
  let floor = 0
  for (const [feat, probes] of Object.entries(COMPAT_PROBES)) {
    const info = FEATURES[feat]
    if (!info) continue
    // 实测形态：`if (typeof Array.prototype.toSorted !== 'function')`
    if (probes.some(p => new RegExp('typeof\\s+' + p.replace(/\./g, '\\.') + '\\s*!==').test(compatText))) {
      patched.push(feat)
      floor = Math.max(floor, info.since)
    }
  }
  return { floor, patched }
}

/**
 * 核查一段文本是否用了超出下界的特性。
 * @param text 文本
 * @param floor 下界（Chrome 版本）
 * @returns {Array<{feat:string, since:number, kind:string, note:string}>}
 */
export function violations(text, floor) {
  const out = []
  for (const [feat, info] of Object.entries(FEATURES)) {
    if (info.since <= floor) continue          // 不低于下界即安全
    if (text.includes(feat)) out.push({ feat, ...info })
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
  const jsPath = locate('app/src/main/assets/dsh-phone.js')
  const cssPath = locate('app/src/main/assets/dsh-phone.css')
  const compatPath = locate('app/src/main/assets/dsh-phone.compat.js')
  if (!jsPath || !cssPath) { console.log('兼容下限核查 · 跳过（本布局下未找到 UI 资产）'); process.exit(0) }

  const compat = compatPath ? readFileSync(compatPath, 'utf8') : ''
  const inferred = compat ? inferFloor(compat) : { floor: 0, patched: [] }
  // 下界用实测常量（上方 COMPAT_FLOOR 的注释说明了它怎么来的）；
  // 若恰好能读到 compat.js，则把推断值一并打印作交叉验证。
  const floor = COMPAT_FLOOR
  const patched = inferred.patched
  const js = readFileSync(jsPath, 'utf8')
  const css = readFileSync(cssPath, 'utf8')

  const vJs = violations(js, floor)
  const vCss = violations(css, floor)
  const result = { floor, patched, js: vJs, css: vCss }

  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`WebView 兼容下限核查（由 compat.js 推断下界 ≈ Chrome ${floor}）`)
    console.log('  目标内核下界：Chrome ' + floor + '（实测常量；源自上游 compat.js 补的最保守 API）')
    if (compat) console.log('  本次读到 compat.js，推断值：' + (inferred.floor || '（未识别）') + (inferred.patched.length ? '（' + inferred.patched.join(', ') + '）' : ''))
    else console.log('  未读到 compat.js（它是上游文件，不在本层胶囊内）—— 下界取实测常量')
    const show = (name, vs) => {
      if (!vs.length) { console.log(`  ✓ ${name}：无越界特性`); return }
      console.log(`  ✗ ${name}：${vs.length} 项超出下界（目标内核上会静默失效或抛错）`)
      for (const v of vs) console.log(`      ${v.feat}  需 Chrome ${v.since}+（${v.note}）`)
    }
    show('dsh-phone.js', vJs)
    show('dsh-phone.css', vCss)
    const bad = vJs.length + vCss.length
    console.log('')
    console.log(bad === 0 ? '✓ 通过' : `✗ ${bad} 项需处理（改用等价老特性，或加进 compat.js 运行时补）`)
    process.exit(bad === 0 ? 0 : 1)
  }
}
