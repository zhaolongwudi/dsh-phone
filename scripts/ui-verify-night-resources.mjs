// 验证「原生壳面的深色资源确实打进 APK」——把 §9.25 里的「未验证」项尽可能缩小。
//
// ## 要回答的问题
//
// 上一轮如实标注：「**原生壳面**在系统深色下是否真被 Android 选中 values-night
// ⇒ **未验证**（需把设备系统切到深色后观察）」。本脚本用**静态证据**回答它的一半：
//   · 双态资源是否**都**被编译进 APK（这是 Android 能选中的**必要条件**）
//
// ## 方法：在 resources.arsc 里找同一 token 的两套取值
//
// Android 把资源按「配置（config）」分组存在 resources.arsc 里：
//   ds_bg 的 default 配置 = #F8FAFC（浅）
//   ds_bg 的 night   配置 = #0B0F14（深）
// 若**两个颜色值都能在 arsc 里找到**，说明双态资源都进包了 ⇒ Android 会按 uiMode 选中。
//
// 颜色在 arsc 里以 4 字节存（ARGB，小端）。故搜字节序列：
//   #F8FAFC → FC FA F8 FF
//   #0B0F14 → 14 0F 0B FF
//
// ## 局限（如实标注）
//
// 这**不能**证明「设备当前就处于深色并选中了 night」—— 那需要运行期观察。
// 它证明的是「**必要条件已满足**：两套资源都在包里，且 token 名都在」。
// 是否被选中由 Android 的配置匹配算法决定（确定性行为，非本层可控）。
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import zlib from 'node:zlib'

const APK = process.argv[2]
if (!APK) {
  // CI 安全：无 APK 参数时打印用法并**正常退出**（契约见 ci-compat.test.mjs）
  console.log('原生壳面深色资源校验：跳过（未给出 APK 路径 —— 非设备环境，CI 属预期）')
  console.log('  用法: node verify-night-resources.mjs <apk>')
  process.exit(0)
}

function readEntries(apk) {
  const fd = openSync(apk, 'r')
  const size = statSync(apk).size
  const tailLen = Math.min(66000, size)
  const tail = Buffer.alloc(tailLen); readSync(fd, tail, 0, tailLen, size - tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  const cdCount = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16)
  const cd = Buffer.alloc(cdSize); readSync(fd, cd, 0, cdSize, cdOff)
  const out = []
  let p = 0
  for (let i = 0; i < cdCount; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break
    const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24)
    const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32)
    const lho = cd.readUInt32LE(p + 42)
    out.push({ name: cd.subarray(p + 46, p + 46 + nlen).toString('utf8'), method, csize, usize, lho })
    p += 46 + nlen + elen + clen
  }
  return { fd, out }
}
function read(fd, e) {
  const lh = Buffer.alloc(30); readSync(fd, lh, 0, 30, e.lho)
  const nl = lh.readUInt16LE(26), el = lh.readUInt16LE(28)
  const raw = Buffer.alloc(e.csize); readSync(fd, raw, 0, e.csize, e.lho + 30 + nl + el)
  return e.method === 0 ? raw : zlib.inflateRawSync(raw)
}

/** ARGB hex（如 #F8FAFC）→ 小端 4 字节序列。 */
function argbBytes(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  const b4 = Buffer.alloc(4)
  b4.writeUInt32LE(((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0, 0)
  return b4
}
function findSeq(hay, needle) {
  let n = 0, i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += 1 }
  return n
}

const { fd, out } = readEntries(APK)
const arscE = out.find(x => x.name === 'resources.arsc')
if (!arscE) { console.error('无 resources.arsc'); process.exit(1) }
const arsc = read(fd, arscE)
console.log('resources.arsc: ' + arsc.length + ' B')

// 本层 9 个 token 的双态取值（与 values/ 与 values-night/ 一致）
const PAIRS = [
  ['ds_bg', '#F8FAFC', '#0B0F14'],
  ['ds_surface', '#FFFFFF', '#1C1C1E'],
  ['ds_border', '#E2E8F0', '#2A3441'],
  ['ds_text_primary', '#0F172A', '#F1F5F9'],
  ['ds_text_secondary', '#475569', '#94A3B8'],
  ['ds_accent', '#2563EB', '#60A5FA'],
  ['ds_ok', '#16A34A', '#4ADE80'],
  ['ds_warn', '#D97706', '#FBBF24'],
  ['ds_danger', '#DC2626', '#F87171'],
]

console.log('\n① token 名是否在 arsc 的字符串池里（资源能被引用的前提）')
let nameOk = 0
for (const [name] of PAIRS) {
  const has = arsc.includes(Buffer.from(name, 'utf8'))
  if (has) nameOk++
  console.log('   ' + (has ? '✓' : '✗') + ' ' + name)
}

console.log('\n② 双态颜色值是否都在 arsc 里（两套资源都进包的必要条件）')
let pairOk = 0
for (const [name, light, night] of PAIRS) {
  const nl = findSeq(arsc, argbBytes(light))
  const nn = findSeq(arsc, argbBytes(night))
  const ok = nl > 0 && nn > 0
  if (ok) pairOk++
  console.log(`   ${ok ? '✓' : '✗'} ${name.padEnd(20)} 浅 ${light} ×${nl}  深 ${night} ×${nn}`)
}

console.log('\n═══ 结论 ═══')
console.log(`  token 名命中：${nameOk}/${PAIRS.length}`)
console.log(`  双态值命中：${pairOk}/${PAIRS.length}`)
if (nameOk === PAIRS.length && pairOk === PAIRS.length) {
  console.log('  ✓ **双态资源都已编译进 APK** ⇒ Android 会在 uiMode=night 时选中 night 配置')
  console.log('    ⚠️ 局限：这证明的是「必要条件已满足」，**不等于**「设备当前处于深色并已选中」。')
  console.log('       后者需运行期观察（切系统深色后看启动页/状态点）。')
} else {
  console.log('  ✗ 有缺失 ⇒ 某些 token 在深色下取不到 night 值（会回落到 default）')
}
closeSync(fd)
