// WebView 兼容下限核查的判别力测试。
//
// 为什么重要：本层资产跑在**目标 WebView 内核**上，而该项目 compat.js 在运行时补
// Chrome 97–119 区间的新 API —— 说明内核可能相当老。本层若引入更老的越界特性，
// 在设备上会**静默失效**（选择器不命中）或直接抛错。校验器自身必须有判别力，
// 且「保守侧」的取舍要写清（宁可多问，不可漏报）。
//
// 运行：node scripts/ui-tests/compat-floor.test.mjs
import { violations, FEATURES, COMPAT_FLOOR } from '../ui-compat-floor.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

console.log('下界取值：必须是保守侧（宁可多问，不可漏报）')
{
  // compat.js 补到的最新 API = 119（Promise.withResolvers）。下界必须 ≤ 它 ——
  // 否则等于宣称「内核比需要补丁的版本还新」，与 compat 的存在自相矛盾。
  const NEWEST_PATCHED = 119
  check('下界不高于 compat 补到的最新 API（否则自相矛盾）', COMPAT_FLOOR <= NEWEST_PATCHED,
    `floor=${COMPAT_FLOOR} newest=${NEWEST_PATCHED}`)
  check('下界是正整数', Number.isInteger(COMPAT_FLOOR) && COMPAT_FLOOR > 0, String(COMPAT_FLOOR))
  // 保守侧：下界应取 compat 覆盖范围内偏老的值，而不是最新的那个
  check('下界取保守侧（低于最新补丁版本）', COMPAT_FLOOR < NEWEST_PATCHED,
    `floor=${COMPAT_FLOOR}`)
}

console.log('真问题：超出下界的特性必须检出')
{
  // 用一个人为的低下界验证判别力
  const low = 60
  const hits = violations('.a:has(.b){}\nx.toSorted(()=>0)\nPromise.withResolvers()', low)
  const feats = hits.map(h => h.feat)
  check('检出 :has(', feats.includes(':has('), JSON.stringify(feats))
  check('检出 toSorted(', feats.includes('toSorted('))
  check('检出 withResolvers(', feats.includes('withResolvers('))
}

console.log('误报防线：不高于下界的特性不得报出')
{
  // 下界 119 时，Chrome 105 的 :has 不该报
  const hits = violations('.a:has(.b)', 119)
  check('下界 119 时不报 :has（105 < 119）', !hits.some(h => h.feat === ':has('), JSON.stringify(hits))
  // 空文本不报
  check('空文本无越界', violations('', 60).length === 0)
}

console.log('真实产物：本层资产必须在下界内')
{
  let root = HERE
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(root, 'overrides/app/src/main/assets/dsh-phone.js'))) break
    if (existsSync(join(root, 'app/src/main/assets/dsh-phone.js'))) break
    const up = dirname(root); if (up === root) { root = null; break }
    root = up
  }
  const find = rel => {
    if (!root) return null
    for (const p of ['overrides/', '']) if (existsSync(join(root, p + rel))) return join(root, p + rel)
    return null
  }
  const jsP = find('app/src/main/assets/dsh-phone.js')
  const cssP = find('app/src/main/assets/dsh-phone.css')
  if (jsP && cssP) {
    const vJs = violations(readFileSync(jsP, 'utf8'), COMPAT_FLOOR)
    const vCss = violations(readFileSync(cssP, 'utf8'), COMPAT_FLOOR)
    check('dsh-phone.js 无越界特性（下界 ' + COMPAT_FLOOR + '）', vJs.length === 0,
      JSON.stringify(vJs.map(x => x.feat + '@' + x.since)))
    check('dsh-phone.css 无越界特性', vCss.length === 0,
      JSON.stringify(vCss.map(x => x.feat + '@' + x.since)))
  } else {
    console.log('  （跳过：本布局下未找到 UI 资产）')
  }
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
