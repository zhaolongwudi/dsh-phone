// UI 锚点失效门禁：检查 dsh-phone.css 依赖的上游哈希类名在当前引擎树上是否仍存在。
//
// ## 为什么需要它
//
// dsh-phone.css 用上游 CSS Module 的**构建期哈希类名**锚定元素（.pI_x6G_frame 之类）。
// 上游升级时这些哈希会重新生成，命中失败是**完全静默**的：页面照常渲染、构建通过、
// 类型检查通过、单测通过——只有人眼可能发现「某个按钮变大了」。此前多轮上游跟进中
// 已经真实发生过这类失效（本次首次运行时即查出 4 条）。
//
// 本门禁把这种静默失效搬到构建期：失效即报红，并点名「哪个语义元素、属于哪个上游包」，
// 让维护者拿得到可执行的修复线索，而不是面对一个「界面乱了」的模糊现象。
//
// ## 用法
//   node scripts/check-ui-anchors.mjs                          离线一致性检查（CI 默认）
//   node scripts/check-ui-anchors.mjs --tree <dsh树根>           加做「锚点在真实引擎树上存在」检查
//   node scripts/check-ui-anchors.mjs --tree <dsh树根> --report  只报告，恒零退出
//   node scripts/check-ui-anchors.mjs --json                    机读输出
//
// ## 判据（分两层——CI 的 vendor 依赖不含 UI 包，拿不到引擎树）
// 第一层 · 离线（任何环境都能跑）：
//   - CSS 引用的每个哈希都必须在映射表有登记（防新写规则绕过资产化）
//   - 已登记且非 knownDead 的哈希必须真的出现在 CSS 里（防表里留死条目）
// 第二层 · 需要引擎树（本地/维护期）：
//   - 每个声明锚点必须在某上游包里找得到（找不到 = 上游已改名，CSS 静默失效）
//   - 声明写的上游包要与实际归属一致（防映射表自身漂移）
//   - knownDead 里的项若「复活」则提示清理
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAnchors, referencedHashes } from './ui-anchor-scan.mjs'
import { scanSlots } from './ui-slot-inventory.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// 路径解析复用测试侧的同一实现：CSS 与映射表在胶囊工作区里**不在同一前缀**
// （CSS 属上游文件走 overrides/，映射表是全新增走 files/），写死单一路径会在
// 其中一种布局下报「文件不存在」，或被陈旧副本骗过去。
const CSS_PATH = resolveCss()
const JS_PATH = resolveJs()
const MAP_PATH = resolveMap()

/** 自本文件向上探测 dsh-phone.js。 */
function resolveJs() {
  const rel = 'app/src/main/assets/dsh-phone.js'
  for (const p of probe(rel)) return p
  throw new Error('找不到 ' + rel)
}

/** 自本文件向上探测 CSS（兼容 overrides/ 与仓库根两种位置）。 */
function resolveCss() {
  const rel = 'app/src/main/assets/dsh-phone.css'
  for (const p of probe(rel)) return p
  throw new Error('找不到 ' + rel)
}

/** 自本文件向上探测映射表（兼容 files/ 与仓库根两种位置）。 */
function resolveMap() {
  const rel = 'app/src/main/assets/ui-anchors.json'
  for (const p of probe(rel)) return p
  throw new Error('找不到 ' + rel)
}

/** 生成候选路径序列：逐级向上 × 每个前缀，返回实际存在的那些。 */
function* probe(rel) {
  const prefixes = ['overrides/', 'files/', '']
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const prefix of prefixes) {
      const p = join(d, prefix + rel)
      if (existsSync(p)) yield p
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
}

/**
 * 执行门禁检查。tree 为空时只做第一层（离线）检查。
 *
 * 扫描面 = CSS + JS **并集**：两者都靠上游哈希锚元素，且失效都是静默的
 * （CSS 是不命中、JS 是 querySelector 返回 null 后被 ?. / if(!x) 跳过）。
 * 只查 CSS 会漏掉 5 个只有 JS 用的锚点。
 *
 * @param tree dsh 引擎树根（含 node_modules/@deepseek-ai），可为 null
 * @param cssPath CSS 路径（测试可注入）
 * @param mapPath 映射表路径（测试可注入）
 * @param jsPath JS 路径（测试可注入；传空串则跳过）
 * @returns 结构化结果
 */
export function checkAnchors(tree, cssPath = CSS_PATH, mapPath = MAP_PATH, jsPath = JS_PATH) {
  const online = Boolean(tree) && existsSync(tree ?? '')
  const engine = online ? scanAnchors(tree) : new Map()
  const css = readFileSync(cssPath, 'utf8')
  const js = jsPath && existsSync(jsPath) ? readFileSync(jsPath, 'utf8') : ''
  const map = JSON.parse(readFileSync(mapPath, 'utf8'))
  // 并集：任一消费面用到即需纳管；随后再分别记下「谁在用」，便于报错时定位。
  const referenced = new Set([...referencedHashes(css), ...referencedHashes(js)])
  const inCss = referencedHashes(css)
  const inJs = referencedHashes(js)

  /** 标注某锚点的消费面，报错时能直接说「改哪里」。 */
  const usedBy = (h) => [inCss.has(h) ? 'CSS' : null, inJs.has(h) ? 'JS' : null].filter(Boolean).join('+') || '-'

  const declared = map.anchors ?? {}
  const knownDead = Object.fromEntries(
    Object.entries(map.knownDead ?? {}).filter(([k]) => k !== '$comment'))

  const missing = []      // 已登记、但当前引擎树里找不到 → 上游改了，CSS 失效
  const deadRevived = []  // 登记为已失效、但引擎树里又有了 → 该从 knownDead 移除
  const undeclared = []   // CSS 用了但映射表没登记 → 漏登记
  const pkgMismatch = []  // 映射表写的包与实际不符 → 表本身漂移
  const stale = []        // 映射表里登记了、但 CSS 已不再引用 → 表里的死条目
  const badSlots = []     // CSS 用了 [data-slot="X"] 但引擎树里没有该槽

  // 第一层：离线一致性（不需要引擎树）
  for (const hash of referenced) {
    if (!(hash in declared) && !(hash in knownDead)) undeclared.push({ hash, usedBy: usedBy(hash) })
  }
  for (const hash of Object.keys(declared)) {
    if (!referenced.has(hash)) stale.push(hash)
  }

  // data-slot 校验（需要引擎树才能判存在性；离线只登记）
  const slotRefs = new Set()
  for (const m of readFileSync(cssPath, 'utf8').matchAll(/\[data-slot="([^"]+)"\]/g)) slotRefs.add(m[1])

  // 第二层：需要引擎树的在线校验
  if (online) for (const slot of slotRefs) {
    // 槽位存在性：引擎树里能扫到该槽的声明（scanSlots 覆盖 children 表）
    const knownSlots = scanSlots(tree)
    if (!knownSlots.has(slot)) badSlots.push(slot)
  }
  if (online) for (const [hash, info] of Object.entries(declared)) {
    const pkgs = engine.get(hash)
    if (!pkgs || pkgs.size === 0) missing.push({ hash, usedBy: usedBy(hash), ...info })
    else if (info.pkg && !pkgs.has(info.pkg)) pkgMismatch.push({ hash, usedBy: usedBy(hash), declared: info.pkg, actual: [...pkgs] })
  }
  if (online) for (const hash of Object.keys(knownDead)) {
    const pkgs = engine.get(hash)
    if (pkgs && pkgs.size > 0) deadRevived.push({ hash, actual: [...pkgs] })
  }

  return {
    online, engineVersion: map.engine, tree: online ? tree : null, totalEngineHashes: engine.size,
    referencedCount: referenced.size, declaredCount: Object.keys(declared).length,
    missing, deadRevived, undeclared, pkgMismatch, stale, badSlots, slotRefs: [...slotRefs],
  }
}

/** 把结果渲染成人可读报告。 */
export function formatReport(r) {
  const L = []
  L.push(r.online
    ? `UI 锚点门禁 · 在线校验（引擎树 ${r.tree}）`
    : 'UI 锚点门禁 · 离线一致性检查（未给 --tree，跳过「锚点在上游是否存在」）')
  L.push(`  映射表声明 ${r.declaredCount} 项 · CSS+JS 实际引用 ${r.referencedCount} 项` +
    (r.online ? ` · 引擎树共 ${r.totalEngineHashes} 个哈希` : ''))
  L.push('')
  if (r.missing.length) {
    L.push(`✗ 失效 ${r.missing.length} 项（上游已改，对应 CSS 规则当前不生效）：`)
    for (const m of r.missing) L.push(`    [${String(m.usedBy ?? '-').padEnd(7)}] ${m.hash.padEnd(24)} ${String(m.semantic ?? '-').padEnd(34)} 上游包 ${m.pkg ?? '-'}`)
  }
  if (r.undeclared.length) {
    L.push(`✗ 未登记 ${r.undeclared.length} 项（CSS 用了哈希但没进映射表）：`)
    for (const u of r.undeclared) L.push(`    [${String(u.usedBy ?? '-').padEnd(7)}] ${u.hash}`)
  }
  if (r.badSlots?.length) {
    L.push(`✗ data-slot 引用了不存在的槽 ${r.badSlots.length} 项（选择器静默不命中）：`)
    for (const s of r.badSlots) L.push('    ' + s)
  }
  if (r.stale.length) {
    L.push(`✗ 死条目 ${r.stale.length} 项（映射表登记了但 CSS 已不用，应清理）：`)
    for (const s of r.stale) L.push(`    ${s}`)
  }
  if (r.pkgMismatch.length) {
    L.push(`✗ 归属漂移 ${r.pkgMismatch.length} 项（映射表写的包与实际不符）：`)
    for (const m of r.pkgMismatch) L.push(`    [${String(m.usedBy ?? '-').padEnd(7)}] ${m.hash}  表=${m.declared}  实际=${m.actual.join('/')}`)
  }
  if (r.deadRevived.length) {
    L.push(`! 已登记失效项复活 ${r.deadRevived.length} 项（应从 knownDead 移除）：`)
    for (const d of r.deadRevived) L.push(`    ${d.hash}  现在存在于 ${d.actual.join('/')}`)
  }
  const bad = r.missing.length + r.undeclared.length + r.pkgMismatch.length + r.stale.length + (r.badSlots?.length ?? 0)
  L.push('')
  L.push(bad === 0
    ? (r.online ? '✓ 通过：全部已声明锚点在当前引擎树上有效' : '✓ 通过：CSS/JS 与映射表一致（未做上游存在性校验）')
    : `✗ 未通过：${bad} 项需处理`)
  if (!r.online) L.push('  提示：维护期加 --tree <dsh树根> 做完整校验，可发现上游改名导致的静默失效。')
  return L.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const treeArg = process.argv.indexOf('--tree')
  // 未传 --tree = 有意走离线模式（CI 的 vendor 依赖不含 UI 包）；传了但路径不存在 = 用法错误。
  const tree = treeArg >= 0 ? process.argv[treeArg + 1] : null
  if (treeArg >= 0 && (!tree || !existsSync(tree))) {
    console.error(`--tree 指向的路径不存在：${tree ?? '(缺参数)'}`)
    process.exit(2)
  }
  const r = checkAnchors(tree)
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else console.log(formatReport(r))
  const bad = r.missing.length + r.undeclared.length + r.pkgMismatch.length + r.stale.length + (r.badSlots?.length ?? 0)
  process.exit(process.argv.includes('--report') ? 0 : (bad === 0 ? 0 : 1))
}
