// Android 资源校验：本层新增的 XML 资源必须能被 aapt2 接受。
//
// ## 为什么需要
//
// 本层新增了 3 个 res 资源（语义色双态 + 尺寸）。它们若格式不对，**gradle 资源
// 编译会直接失败** —— 那不是「静默失效」，而是硬阻断构建。但本机没有 gradle/java，
// 无法真的跑 aapt2，故用等价的结构与格式检查提前拦住常见错法：
//   - XML 声明缺失/根元素不是 <resources>
//   - 标签未闭合、裸 & 未转义
//   - 色值不是 #RRGGBB / #AARRGGBB
//   - dimen 值缺单位（dp/sp/px）
//   - 同名资源在 values 与 values-night 里不成对（会导致深色态取不到值）
//
// ## 用法
//   node scripts/ui-res-validate.mjs            校验（有问题非零退出）
//   node scripts/ui-res-validate.mjs --json
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本层新增的资源文件（相对仓库根）。 */
const RES_FILES = [
  ['app/src/main/res/values/ds_colors.xml', 'color'],
  ['app/src/main/res/values-night/ds_colors.xml', 'color'],
  ['app/src/main/res/values/dimens.xml', 'dimen'],
]

/**
 * 校验单个资源文件。
 * @param text XML 全文
 * @param kind 'color' | 'dimen'
 * @returns {{ok:boolean, entries:Array<{name:string,value:string,ok:boolean,why:string}>, problems:string[]}}
 */
export function validateRes(text, kind) {
  const problems = []
  const t = text.trim()
  if (!/^<\?xml version="1\.0" encoding="utf-8"\?>/.test(t)) problems.push('缺 XML 声明头')
  if (!/<resources>/.test(t) || !/<\/resources>/.test(t)) problems.push('根元素不是 <resources>')

  // 标签配平（只数同层，够用；本类文件无嵌套元素）
  const opens = [...t.matchAll(/<(\w+)(?:\s[^>]*)?>/g)].filter(m => !m[0].endsWith('/>')).length
  const closes = [...t.matchAll(/<\/(\w+)>/g)].length
  if (opens !== closes) problems.push(`标签不配平（${opens} 开 / ${closes} 闭）`)

  // 裸 & 未转义
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t)) problems.push('存在未转义的 & 字符')

  const entries = []
  const re = kind === 'color'
    ? /<color name="([^"]+)">([^<]+)<\/color>/g
    : /<dimen name="([^"]+)">([^<]+)<\/dimen>/g
  for (const m of t.matchAll(re)) {
    const [_, name, raw] = m
    const value = raw.trim()
    let ok = true, why = ''
    if (kind === 'color') {
      ok = /^#[0-9A-Fa-f]{6}$/.test(value) || /^#[0-9A-Fa-f]{8}$/.test(value)
      if (!ok) why = '色值须为 #RRGGBB 或 #AARRGGBB'
    } else {
      ok = /^\d+(\.\d+)?(dp|sp|px)$/.test(value)
      if (!ok) why = '须带 dp/sp/px 单位'
    }
    entries.push({ name, value, ok, why })
  }
  if (entries.length === 0) problems.push('没有任何资源条目')

  return { ok: problems.length === 0 && entries.every(e => e.ok), entries, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 向上探测仓库根（兼容胶囊工作区与 apply 后仓库）
  const findFile = rel => {
    let d = HERE
    for (let i = 0; i < 10; i++) {
      for (const p of ['files/', '']) {
        const f = join(d, p + rel)
        if (existsSync(f)) return f
      }
      const up = dirname(d); if (up === d) break; d = up
    }
    return null
  }

  const results = []
  for (const [rel, kind] of RES_FILES) {
    const path = findFile(rel)
    if (!path) { results.push({ rel, missing: true }); continue }
    results.push({ rel, path, kind, ...validateRes(readFileSync(path, 'utf8'), kind) })
  }

  if (process.argv.includes('--json')) { console.log(JSON.stringify(results, null, 2)) }
  else {
    const found = results.filter(r => !r.missing)
    if (found.length === 0) { console.log('Android 资源校验 · 跳过（本布局下未找到新增资源）'); process.exit(0) }
    console.log('Android 资源校验（结构 + 格式，等价于 aapt2 的常见拒绝面）')
    let bad = 0
    for (const r of found) {
      const tag = r.ok ? '✓' : '✗'
      if (!r.ok) bad++
      console.log(`  ${tag} ${r.rel}  （${r.entries.length} 条）`)
      for (const p of r.problems) console.log('      ' + p)
      for (const e of r.entries.filter(x => !x.ok)) console.log(`      ${e.name} = ${e.value}  ${e.why}`)
    }
    // 双态成对性：values 与 values-night 的同名资源应一致
    const day = found.find(r => r.rel.includes('values/') && r.kind === 'color')
    const night = found.find(r => r.rel.includes('values-night/') && r.kind === 'color')
    if (day && night) {
      const dn = new Set(day.entries.map(e => e.name))
      const nn = new Set(night.entries.map(e => e.name))
      const onlyDay = [...dn].filter(x => !nn.has(x))
      const onlyNight = [...nn].filter(x => !dn.has(x))
      const paired = onlyDay.length === 0 && onlyNight.length === 0
      if (!paired) bad++
      console.log(`  ${paired ? '✓' : '✗'} 深浅色资源成对（day-only: ${onlyDay.join(',') || '无'}；night-only: ${onlyNight.join(',') || '无'}）`)
    }
    console.log('')
    console.log(bad === 0 ? '✓ 通过' : `✗ ${bad} 项需处理`)
    process.exit(bad === 0 ? 0 : 1)
  }
}
