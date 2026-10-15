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
 * 特性 → { 要求, 说明, 风险, allow? }。
 * 数值取自各特性首次可用的 Chrome 版本（Android WebView 与 Chrome 同源）。
 *
 * `allow`（可选）= **已登记的、有等价兜底或仅降级的写法**（Issue F-66）：命中这些
 * 正则的片段先从待检文本里剔除，剩下的命中才算越界。逐条都必须在注释里写明依据，
 * 且**形状要尽可能窄** —— 宽正则等于换个地方继续假绿。
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
  // ⚠️ 下面两条是 Issue F-66 补的：它们都**高于下界 97**，而原先整表缺项 ⇒ 门禁对
  //    本层真实用到的这两个特性一无所知，报「✓ 无越界」属**假绿**（与 F-57 同族的
  //    「判据漏项」）。补上后，凡是**未登记**的新用法都会被报出来。
  dvh: {
    since: 108, kind: 'CSS', note: '动态视口高度单位',
    allow: [
      // 本层把高度/最大高度交给**自定义属性**，值由 JS 以 px 写入
      //（`dsh-phone.js:150-157` 写 `--dsh-phone-viewport-height`，其余
      //  `--dsh-phone-*-height` 由同一处 adapt 逻辑写入）⇒ `…dvh` 只是「拿不到变量」
      //  时的兜底；内核 <108 时兜底失效、整条声明被丢弃，主路径仍由 px 变量驱动。
      /var\(--dsh-phone-[a-z-]+,[^)]*dvh[^)]*\)/g,
      // 全层**唯一**无兜底的一处：`dsh-phone.css:90` 的 `.dim-jh-modal` max-height。
      // 内核 <108 时该 `!important` 声明被丢弃 ⇒ 回落到插件自身的
      // `max-height:min(640px, calc(100vh - 48px))`（`jet-hub-styles.js:251`）
      // ⇒ 只是少 24px 内缩、不溢出，属可接受的降级（审查报告亦判「影响面很小」）。
      /max-height:calc\(100dvh - 24px\)/g,
    ],
  },
  inert: {
    since: 102, kind: 'JS', note: '惰性化（inert 属性）',
    allow: [
      // 本层只在 `rail` 上用它，且两处赋值都**同一条语句**里伴随 aria-hidden 兜底
      //（`dsh-phone.js:186` / `:200`）；抽屉关闭时侧栏已被 CSS 移出视口 ⇒ 内核 <102 时
      //  只少一层惰性化，无功能损失。※ 同一事实的**注释**（`:483`）也一并豁免，
      //  否则门禁会被自己的注释打红（本仓库记过「锚裸字符串」的同型问题）。
      /rail\.inert/g,
    ],
  },
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
 *
 * ⚠️ 先剔除该特性**已登记的等价兜底写法**（`info.allow`，见 `FEATURES` 的说明），
 * 只对剩下的命中报越界 —— 否则「补了一条本来就安全用法的特性」会把门禁打成假红。
 *
 * @param text 文本
 * @param floor 下界（Chrome 版本）
 * @returns {Array<{feat:string, since:number, kind:string, note:string}>}
 */
export function violations(text, floor) {
  const out = []
  for (const [feat, info] of Object.entries(FEATURES)) {
    if (info.since <= floor) continue          // 不低于下界即安全
    if (unregisteredUsage(text, info).includes(feat)) out.push({ feat, ...info })
  }
  return out
}

/**
 * 去掉该特性**已登记放行**的片段，返回仍需核查的文本（Issue F-66）。
 * @param text 文本
 * @param info FEATURES 的表项
 * @returns {string} 待核查文本（无 `allow` 时原样返回）
 */
function unregisteredUsage(text, info) {
  const allow = info.allow
  if (allow === undefined || allow.length === 0) return text
  let out = text
  for (const pattern of allow) out = out.replace(pattern, '')
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
