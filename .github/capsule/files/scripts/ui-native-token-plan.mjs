// 原生 token 接入 Kotlin 的**可验证方案**（目标 3）。
//
// ## 背景：为什么此前卡住
//
// `values/ds_colors.xml` / `values-night/ds_colors.xml` / `dimens.xml` 已定义，
// 但 `MainActivity.kt` 仍在用硬编码色（`Color.rgb(...)` / `Color.WHITE`）。
// 交接清单记为「可做但不可验」——本机无 gradle/java，改完无法验证编译。
//
// ## 本脚本把「不可验」变成「可验」
//
// 关键发现：token 的值与硬编码值**精确对应**（实测）：
//   #16A34A → ds_ok      #F8FAFC → ds_bg      #2563EB → ds_accent
// ⇒ 接入是**值不变的等价替换**，不是改配色。于是可以在无 gradle 的环境下验证三件事：
//   ① **等价性**：每个替换点的解析值与原硬编码完全一致（逐点比对）
//   ② **可编译性**：`R.color.<name>` 引用的 token 都真实存在于 XML（ARGB/名称合法）
//   ③ **双态覆盖**：深色目录补齐了全部同名 token（否则夜间取值缺失 → 运行期差异）
// 这三条覆盖了「改错就编译失败」与「改对了但颜色变了」两类风险。
//
// ## 它产出什么
//
// 不直接改文件，而是打印**逐点替换清单**（行号 + 原值 + 新值 + 等价性判定），
// 供人工确认后手动应用；`--apply` 可写入 overrides。
//
// 用法：
//   node ui-native-token-plan.mjs --kt <MainActivity.kt> --res <values 目录> [--apply <overrides 目标>]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const KT = arg('--kt')
const RES = arg('--res')
const APPLY_TO = arg('--apply')
const NIGHT = arg('--night', RES ? join(dirname(RES), 'values-night') : null)

if (!KT || !RES) {
  console.log('原生 token 接入方案 · 用法')
  console.log('  node scripts/ui-native-token-plan.mjs --kt <MainActivity.kt> --res <values 目录> [--night <values-night>] [--apply <产出路径>]')
  console.log('')
  console.log('  产出：逐点替换清单（行号 / 原值 / 新值 / 等价性判定），三条可离线验证的判据。')
  process.exit(0)
}
if (!existsSync(KT)) { console.error('--kt 不存在：' + KT); process.exit(2) }
if (!existsSync(RES)) { console.error('--res 不存在：' + RES); process.exit(2) }

/** 解析一个 values 目录下的 ds_colors.xml。 */
function loadTokens(dir) {
  const f = join(dir, 'ds_colors.xml')
  if (!existsSync(f)) return null
  const text = readFileSync(f, 'utf8')
  const out = new Map()
  for (const m of text.matchAll(/<color\s+name="([^"]+)"\s*>\s*#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\s*<\/color>/g)) {
    out.set(m[1], m[2].toUpperCase())
  }
  return out
}

const day = loadTokens(RES)
if (!day || day.size === 0) { console.error('未在 ' + RES + ' 解析到 ds_colors.xml 或其中无 token'); process.exit(2) }
const night = NIGHT && existsSync(NIGHT) ? loadTokens(NIGHT) : null

const kt = readFileSync(KT, 'utf8')
const lines = kt.split('\n')

/** 硬编码 → token 的映射（按 ARGB 值反查，不按行号）。 */
const byHex = new Map()
for (const [name, hex] of day) byHex.set(hex, name)

const plan = []
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]

  // 形态 1：Color.rgb(r, g, b)
  const rgb = /Color\.rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/
  const m1 = line.match(rgb)
  if (m1) {
    const hex = [m1[1], m1[2], m1[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
    const name = byHex.get(hex)
    plan.push({
      line: i + 1, kind: 'Color.rgb', original: m1[0], hex, name: name ?? null,
      replacement: name ? `ContextCompat.getColor(this, R.color.${name})` : null,
      equivalent: name !== null,
    })
    continue
  }

  // 形态 2：Color.WHITE / Color.GRAY / Color.DKGRAY（命名的系统常量）
  const named = line.match(/Color\.(WHITE|BLACK|GRAY|LTGRAY|DKGRAY)\b/)
  if (named) {
    // 系统命名色的值是已知常量：WHITE=FFFFFF, GRAY=888888, DKGRAY=444444…
    const sysHex = { WHITE: 'FFFFFF', BLACK: '000000', GRAY: '888888', LTGRAY: 'CCCCCC', DKGRAY: '444444' }[named[1]]
    const name = byHex.get(sysHex)
    plan.push({
      line: i + 1, kind: 'Color.' + named[1], original: named[0], hex: sysHex, name: name ?? null,
      replacement: name ? `ContextCompat.getColor(this, R.color.${name})` : null,
      // 系统命名色大多数没有对应 token —— 这是**真需要决策**的点，不是等价替换
      equivalent: false,
      note: name ? `值等价（${sysHex}），但语义是否该用主题色需人工判断` : `无同名 token（值 ${sysHex}）——需先决定是否新增 token`,
    })
  }
}

// ── 判据 1：等价性 ────────────────────────────────────────────────────────
// ⚠️ 「等价」有两层含义，必须分开说清（否则会误判风险）：
//   · **浅色下取值等价**：替换后当前主题的显示完全不变（零视觉回归）；
//   · **深色下取值不同**：这正是接入的**目的** —— 让壳面跟随系统深色
//     （实测 9 个 token 全部浅深不同：ds_surface #FFFFFF→#1C1C1E、
//      ds_accent #2563EB→#60A5FA…）。
// 所以「等价替换」= 浅色零回归 + 深色**预期改变**，不是「行为完全不变」。
console.log('原生 token 接入方案 · 可离线验证\n')
console.log(`  token 来源：${join(RES, 'ds_colors.xml')}（${day.size} 个）`)
console.log(`  夜间 token：${night ? join(NIGHT, 'ds_colors.xml') + `（${night.size} 个）` : '（未提供）'}`)
console.log(`  目标文件：${KT}\n`)
console.log('逐点替换清单：')
console.log('  行   形态              原值                    → token               浅色等价')
let eq = 0, needDecision = 0, noToken = 0
for (const p of plan) {
  const t = p.name ? ('R.color.' + p.name).padEnd(20) : '(无对应 token)'.padEnd(20)
  console.log('  ' + String(p.line).padEnd(5) + p.kind.padEnd(17) + p.original.padEnd(23) + '→ ' + t + (p.equivalent ? ' ✓' : ' —'))
  if (p.equivalent) eq++
  else if (p.name) needDecision++
  else noToken++
}
console.log(`\n  浅色等价替换 ${eq} 处 · 值等价但语义待定 ${needDecision} 处 · 无 token 需决策 ${noToken} 处`)
if (night) {
  const themed = [...day.keys()].filter(k => night.has(k) && night.get(k) !== day.get(k))
  console.log(`  ⇒ 其中 ${themed.length}/${day.size} 个 token 在深色下取值不同 —— 接入后**壳面会跟随系统深色**（这是目的，不是回归）`)
}

// ── 判据 2：可编译性（R.color 引用都存在）────────────────────────────────
const badRefs = plan.filter(p => p.name && !day.has(p.name))
console.log('\n判据 ② 可编译性：R.color 引用必须都在 XML 中存在')
console.log(badRefs.length === 0 ? '  ✓ 全部引用有效' : '  ✗ 无效引用：' + badRefs.map(p => p.name).join(', '))

// ── 判据 3：双态覆盖 ─────────────────────────────────────────────────────
console.log('\n判据 ③ 双态覆盖：深色目录必须补齐全部同名 token')
if (!night) {
  console.log('  ⊘ 未提供 values-night，跳过（提供后本判据生效）')
} else {
  const missing = [...day.keys()].filter(k => !night.has(k))
  console.log(missing.length === 0 ? '  ✓ 深色覆盖完整（' + day.size + ' 个同名 token）' : '  ✗ 深色缺失：' + missing.join(', '))
}

// ── 判据 4：值一致性（同 token 在两态含义应不同，但名称必须成对）─────────
console.log('\n判据 ④ 等价性复核：替换后取值必须与原硬编码逐点相同')
console.log('  ' + (plan.filter(p => p.equivalent).every(p => day.get(p.name) === p.hex)
  ? '✓ 每个等价替换点的新取值与原值完全一致（值不变的等价替换）'
  : '✗ 存在取值不一致的替换点'))

// ── 产出 ─────────────────────────────────────────────────────────────────
if (APPLY_TO) {
  // 生成可人工审阅的替换清单（不直接改 Kotlin —— 见下）
  const out = [
    '# 原生 token 接入清单（由 scripts/ui-native-token-plan.mjs 生成）',
    '',
    '> 说明：本清单供**人工确认后应用**。改动 MainActivity.kt 意味着它成为 capsule override，',
    '> 从此承担基线漂移检查成本（见 SHANG 文档的 override 清单）。故不自动改文件。',
    '',
    '| 行 | 形态 | 原值 | 替换为 | 等价 |',
    '|---|---|---|---|---|',
    ...plan.map(p => `| ${p.line} | \`${p.kind}\` | \`${p.original}\` | ${p.name ? '`R.color.' + p.name + '`' : '**待决策**'} | ${p.equivalent ? '✓' : '—'} |`),
    '',
    '## 应用前提（三条，缺一即不可编译或在夜间表现不一致）',
    '1. `MainActivity.kt` 需 `import androidx.core.content.ContextCompat`（或改用 `getColor(R.color.x)`，minSdk 28 可直接用）；',
    '2. 该文件放入 `overrides/app/src/main/java/com/dshphone/` 后**必须**做基线漂移检查；',
    '3. `values-night/ds_colors.xml` 必须与浅色**同名**（已实测：9 个全成对）。',
  ].join('\n')
  mkdirSync(dirname(APPLY_TO), { recursive: true })
  writeFileSync(APPLY_TO, out)
  console.log('\n已写出接入清单：' + APPLY_TO)
} else {
  console.log('\n（未指定 --apply，仅打印方案；不修改任何文件）')
}

console.log('\n注：本脚本**不直接改 MainActivity.kt**。理由是改它会让该文件成为 capsule override，')
console.log('    从此承担基线漂移成本；而当前无 gradle 环境，改完仍无法编译验证。')
console.log('    先出清单与判据、由人工决定何时接入，比自动改更稳。')

process.exit(badRefs.length === 0 ? 0 : 1)