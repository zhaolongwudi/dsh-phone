// UI override 的**基线分叉搬运工具**（目标 4）。
//
// ## 要解决的问题
//
// 本层的 `dsh-phone.js` / `dsh-phone.css` 是**上游文件的覆盖版**。但它有三个来源，
// 且互相分叉，直接覆盖必然丢东西：
//
//   A. jwoo 上游（`jwoo1982217-eng/dsh-phone`）—— 别人的新版本
//   B. 本仓库基线（`zhaolongwudi/dsh-phone` 的 app/src/main/assets/）—— 含**自有增强**
//   C. 本层 capsule 覆盖版 —— B + 三层 UI 改造（标记层 / 门禁 / 三期槽位化）
//
// 上游更新时若拿 A 直接覆盖 C，会**静默丢掉两样**：
//   · B 相对 A 的自有增强（实测：大文件上传 `uploadChatDocuments` /
//     `/phone-chat-files/upload` / 防误发 `dshFileUploadPending`）
//   · C 相对 B 的三层改造（`MOBILE_FORM_MAX_WIDTH=767`、`syncFlag` 标记层、
//     `data-dsh-toggle-mounted` 接管规则…）
// 两者都不会报错，只表现为「功能悄悄没了」。
//
// ## 本工具做什么
//
// 把「谁改了什么」算清楚，输出**可执行的搬运方案**，而不是让维护者肉眼比对：
//   1. 三方两两 diff，按**语义块**归类（不是裸行号）
//   2. 标出「C 相对 B 的改造」（即本层成果，**必须保留**）
//   3. 标出「B 相对 A 的自有增强」（**必须保留**）
//   4. 给出把 A 的新版本搬进 C 的**分步手法**与校验清单
//
// 用法：
//   node ui-baseline-merge.mjs --upstream <A> --baseline <B> --capsule <C>
//   node ui-baseline-merge.mjs --upstream <A> --baseline <B> --capsule <C> --json
import { readFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const A = arg('--upstream')
const B = arg('--baseline')
const C = arg('--capsule')
const AS_JSON = args.includes('--json')

// 缺少参数时打印**完整用法**并正常退出（CI 会无参跑本脚本，见 ui-tests/ci-compat.test.mjs）。
// 用 exit 0：这是「信息性工具未获输入」，不是失败 —— 与 apply.sh 里其它维护期工具一致。
if (!A || !B || !C) {
  console.log('UI override 基线分叉搬运分析 · 用法')
  console.log('  node scripts/ui-baseline-merge.mjs --upstream <A> --baseline <B> --capsule <C> [--json]')
  console.log('')
  console.log('  三方角色（都由脚本按**内容指纹**判定，不靠文件名猜）：')
  console.log('    A --upstream  上游版本（如 jwoo1982217-eng/dsh-phone 的 app/src/main/assets/dsh-phone.js）')
  console.log('    B --baseline  本仓库基线（zhaolongwudi/dsh-phone 同路径）')
  console.log('    C --capsule   本层覆盖版（.github/capsule/overrides/app/src/main/assets/dsh-phone.js）')
  console.log('')
  console.log('  输出：本层改造清单（不可丢）、上游独有能力清单（可搬入）、以及三步搬运手法与门禁自检命令。')
  process.exit(0)
}
for (const [name, p] of [['--upstream', A], ['--baseline', B], ['--capsule', C]]) {
  if (!existsSync(p)) { console.error(name + ' 文件不存在：' + p); process.exit(2) }
}

const read = (p) => readFileSync(p, 'utf8').split('\n')

/**
 * 本层改造的**语义指纹**（不是行号）。
 * 为什么用指纹而不是 diff 行号：上游一改，行号全变；指纹锚的是**能力**。
 * 每条 = [标识, 正则, 说明]。命中即认为该改造在场；缺失则说明搬运时丢了。
 */
const CAPSULE_MARKS = [
  ['断点 767', /MOBILE_FORM_MAX_WIDTH\s*=\s*767/, '手机形态断点对齐上游（原为 700，会在 701-767px 出现半态）'],
  ['窄屏匹配', /matchMedia\(`\(max-width: \$\{MOBILE_FORM_MAX_WIDTH\}px\)`\)/, '断点常量真正被使用'],
  ['标记层 mobile-form', /syncFlag\(document\.documentElement,\s*'data-dsh-mobile-form'/, '一期：形态事实'],
  ['标记层 frame', /FRAME_TAG\s*=\s*'data-dsh-frame'/, '一期：框架根事实（用于替代哈希）'],
  ['标记层 rail', /RAIL_TAG\s*=\s*'data-dsh-rail'/, '一期：侧栏事实'],
  ['标记层 modal-open', /syncFlag\(document\.documentElement,\s*'data-dsh-modal-open'/, '一期：页面级模态事实'],
  ['标记层 settings-open', /syncFlag\(document\.documentElement,\s*'data-dsh-settings-open'/, '一期：设置面板在场事实'],
  ['标记层 settings-dialog', /SETTINGS_TAG\s*=\s*'data-dsh-settings-dialog'/, '一期：设置面板本体'],
  ['抽屉共享通道', /syncFlag\(document\.documentElement,\s*'data-dsh-drawer-open'/, '三期：开合唯一真源（槽位组件与形态层共用）'],
  ['槽位开关 aria 同步', /slotToggle\.setAttribute\('aria-expanded'/, '三期：状态唯一写入者契约'],
  ['接管事实读取（遮罩）', /hasAttribute\('data-dsh-mask-mounted'\)/, '三期：槽位组件接管后本地让位'],
  ['设置面板识别解耦', /querySelector\('\[data-shortcut-modal="settings"\]'\)/, '一期：识别刻意不受覆盖层过滤影响'],
  ['观察器纳入 drawer-open', /attributeFilter:\s*\[[^\]]*'data-dsh-drawer-open'/, '三期：槽位组件写事实后 adapt 必须重跑'],
]

/**
 * 上游有、而**本仓基线没有**的能力指纹。
 *
 * ## ⚠️ 本表的存在本身就是一次事实订正（2026-10-13）
 *
 * 交接清单原写：本层 `dsh-phone.js` 的基线是「你仓库里的版本（25521 B）」，
 * 相对 jwoo 上游（27066 B）差 4 行，「是你自己加的上传增强」。
 *
 * **实测方向是反的**，三方身份经哈希钉死：
 *   · jwoo 上游      = 27066 B，**含** `uploadChatDocuments` / `/phone-chat-files/upload`
 *                      / `dshFileUploadPending`（整文件上传 + 防误发）
 *   · 你仓库基线     = 25521 B，**不含**这些
 *   · 设备 APK 里的  = 25521 B（md5 `f2b03aee96bde6ad6903f193599e1ea7`，与仓库基线一致）
 *   · 仓库侧官方确认：jwoo1982217-eng/dsh-phone = 27066 B (sha bf910a79d7)
 *                     zhaolongwudi/dsh-phone  = 25521 B (sha 4e81913e6f)
 *
 * ⇒ 正确理解：**上游比你仓库多一个「整文件上传」能力**，
 *   而非「你仓库比上游多 4 行增强」。这直接影响搬运方向 ——
 *   将来合并上游时应把这些能力**搬进来**，而不是「保护它们不被覆盖」。
 */
const UPSTREAM_ONLY_MARKS = [
  ['大文件上传', /uploadChatDocuments/, '上游独有：整文件上传到 /phone-chat-files/upload'],
  ['上传端点', /\/phone-chat-files\/upload/, '上游独有：服务端上传路由'],
  ['防误发标记', /dshFileUploadPending/, '上游独有：上传中禁止提交既有草稿'],
  ['完整文件态文案', /完整文件已上传并加入草稿/, '上游独有：上传成功后的提示'],
  ['上传中提示', /正在上传 \$\{file\.name\}/, '上游独有：逐个文件的上传进度文案'],
]

/** 兼容别名（早期版本叫 BASELINE_MARKS，语义已订正）。 */
const BASELINE_MARKS = UPSTREAM_ONLY_MARKS

const mark = (lines, res) => lines.some(l => res.test(l))
const textOf = (lines) => lines.join('\n')

const a = read(A), b = read(B), c = read(C)
const A_ = textOf(a), B_ = textOf(b), C_ = textOf(c)

console.log('UI override 基线分叉分析')
console.log(`  A 上游      ${A}  (${a.length} 行)`)
console.log(`  B 本仓基线  ${B}  (${b.length} 行)`)
console.log(`  C 本层覆盖  ${C}  (${c.length} 行)`)

// ── 1. 三方指纹矩阵 ───────────────────────────────────────────────────────
console.log('\n── 本层改造（C 相对 B）在三方中的在场情况 ──')
console.log('  标识'.padEnd(26) + 'A上游  B基线  C本层')
const capsuleReport = []
for (const [name, re, why] of CAPSULE_MARKS) {
  const inA = mark(a, re), inB = mark(b, re), inC = mark(c, re)
  capsuleReport.push({ name, why, inA, inB, inC })
  const f = (v) => (v ? ' ✓  ' : ' —  ')
  console.log('  ' + name.padEnd(24) + f(inA) + f(inB) + f(inC))
}
const lostIfOverwrite = capsuleReport.filter(r => r.inC && !r.inB)
console.log(`\n  ⇒ C 独有（相对 B）的改造 ${lostIfOverwrite.length} 项；若用 B 或 A 覆盖 C 会全部丢失。`)

// ── 2. 上游独有能力矩阵（方向已订正，见 UPSTREAM_ONLY_MARKS 注释）─────────
console.log('\n── 上游有、本仓基线没有的能力（A 有 B 无）──')
console.log('  标识'.padEnd(26) + 'A上游  B基线  C本层')
const baseReport = []
for (const [name, re, why] of UPSTREAM_ONLY_MARKS) {
  const inA = mark(a, re), inB = mark(b, re), inC = mark(c, re)
  baseReport.push({ name, why, inA, inB, inC })
  const f = (v) => (v ? ' ✓  ' : ' —  ')
  console.log('  ' + name.padEnd(24) + f(inA) + f(inB) + f(inC))
}
const upstreamOnly = baseReport.filter(r => r.inA && !r.inB)
const missingInC = baseReport.filter(r => r.inA && !r.inC)
console.log(`\n  ⇒ 上游独有（A 有 B 无）的能力 ${upstreamOnly.length} 项。`)
console.log(missingInC.length === 0
  ? '  ✓ 这些能力在本层 C 中**全部在场**（说明 C 的覆盖是基于含该能力的那一版做的）'
  : `  ⚠️ 有 ${missingInC.length} 项在 C 中缺失：` + missingInC.map(r => r.name).join(', ') +
    '\n     ⇒ 若这些能力是你想要的，本轮搬运应把它们**搬进来**（而不是"防止被覆盖"）')

// ── 2.5 上游相对基线的**新增行**（通用信号，不依赖预定义指纹）─────────────
//   ⚠️ 为什么必须补：上面的指纹表只能发现**已知**能力。上游若新增一个表里没有的
//      功能，工具会说「需要搬运」却不告诉你新增了什么，维护者仍要肉眼 diff。
//      实测：构造上游新增一行 `UPSTREAM_NEW_FEATURE`，工具完全没提它。
//   本段给出「线索」而非「判定」—— 是否该搬由人决定。
console.log('\n── 上游相对基线的新增行（通用线索，非判定）──')
{
  const setB = new Set(b.map(l => l.trim()).filter(Boolean))
  // 只取「有实质内容」的行：非空白、非纯注释
  const isSubstantive = (s) => {
    const x = s.trim()
    if (!x) return false
    if (x.startsWith('//') || x.startsWith('/*') || x.startsWith('*') || x.startsWith('*/')) return false
    return true
  }
  const blocks = []
  let cur = null
  for (let i = 0; i < a.length; i++) {
    const line = a[i]
    const fresh = isSubstantive(line) && !setB.has(line.trim())
    if (fresh) {
      if (!cur) { cur = { from: i + 1, to: i + 1, lines: [line.trim()] } }
      else { cur.to = i + 1; if (cur.lines.length < 3) cur.lines.push(line.trim()) }
    } else if (cur) { blocks.push(cur); cur = null }
  }
  if (cur) blocks.push(cur)

  if (blocks.length === 0) {
    console.log('  （无：上游相对基线没有实质新增行）')
  } else {
    const total = blocks.reduce((n, blk) => n + (blk.to - blk.from + 1), 0)
    console.log(`  共 ${blocks.length} 个新增块（约 ${total} 行）：`)
    for (const blk of blocks.slice(0, 12)) {
      const span = blk.from === blk.to ? `L${blk.from}` : `L${blk.from}-${blk.to}`
      console.log(`    ${span.padEnd(12)} ${blk.lines[0].slice(0, 88)}`)
      for (const extra of blk.lines.slice(1)) console.log(`    ${''.padEnd(12)} ${extra.slice(0, 88)}`)
    }
    if (blocks.length > 12) console.log(`    … 另有 ${blocks.length - 12} 块`)
    console.log('  ⇒ 这些是**线索**：逐块判断是否属于你要的上游能力；要就搬进来，')
    console.log('    不要就显式记录「有意不搬」（否则下次还会被重新提出）。')
  }
}

// ── 3. 可搬运性判定 ──────────────────────────────────────────────────────
console.log('\n── 结论 ──')
const aDiffersFromB = A_ !== B_
const aDiffersFromC = A_ !== C_
console.log(`  A(上游) vs B(仓库基线)：${aDiffersFromB ? '**不同**' : '相同'}`)
console.log(`  A(上游) vs C(本层覆盖)：${aDiffersFromC ? '**不同**' : '相同'}`)
if (!aDiffersFromB && !aDiffersFromC) {
  console.log('  三方内容一致 ⇒ 本次无需搬运。')
} else {
  console.log('  ⇒ 需要搬运。**不可整文件覆盖**（会丢 C 的本层改造，实测 ' + capsuleReport.length + ' 项）。')
}
console.log('\n  正确手法（三步，任一步缺一即静默丢功能）：')
console.log('    ① 以「含你想要能力的那一版」为新基底')
console.log('       · 要上游的整文件上传 ⇒ 以 A 为基底')
console.log('       · 不要           ⇒ 以 B 为基底')
console.log('    ② 把 C 的本层改造叠加上去（按上面「本层改造」逐项核对，共 ' + capsuleReport.length + ' 项）')
console.log('    ③ 跑门禁自检（缺任一条都会静默失效）：')
console.log('       node scripts/ui-layer-audit.mjs && node scripts/check-ui-anchors.mjs')
console.log('       && node scripts/ui-css-validate.mjs && node scripts/ui-tests/marker-layer.test.mjs')
console.log('       && node scripts/ui-tests/mask-takeover.test.mjs')
console.log('       && node scripts/ui-tests/plugin-bundle-load.test.mjs')
console.log('\n  本工具可复跑（把新下载的上游放到 --upstream 即可）：')
console.log('    node scripts/ui-baseline-merge.mjs --upstream <新上游> --baseline <仓库基线> --capsule <本层覆盖>')

if (AS_JSON) {
  console.log('\n' + JSON.stringify({
    files: { A, B, C }, lines: { a: a.length, b: b.length, c: c.length },
    capsuleMarks: capsuleReport, upstreamOnlyMarks: baseReport,
    lostIfOverwrite: lostIfOverwrite.map(r => r.name),
    upstreamOnly: upstreamOnly.map(r => r.name),
    upstreamOnlyMissingInCapsule: missingInC.map(r => r.name),
    upstreamDiffersFromBaseline: aDiffersFromB,
    upstreamDiffersFromCapsule: aDiffersFromC,
  }, null, 2))
}

// 退出码：本层改造一项都没落地 = 真问题（非 0）；否则 0
process.exit(lostIfOverwrite.length > 0 ? 0 : 1)