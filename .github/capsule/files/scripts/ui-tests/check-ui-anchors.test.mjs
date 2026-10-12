// UI 锚点门禁的判别力测试：证明它「坏了会红」而不是永远绿。
//
// 假门禁是这类静态检查最常见的失败形态：脚本能跑、报告漂亮、CI 全绿，
// 但真出问题时一声不响。本测试对各类判据各注入一个反例，断言必须报红。
//
// 运行：node tests/check-ui-anchors.test.mjs
import { mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAnchors } from '../check-ui-anchors.mjs'
import { referencedHashes, HASH_RE } from '../ui-anchor-scan.mjs'
import { resolveAssets, resolveEngineTree, resolvePhoneJs, HERE } from './paths.mjs'

const ASSETS = resolveAssets()
const REAL_CSS = ASSETS.css
const REAL_MAP = ASSETS.map
const TREE = resolveEngineTree()

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}
/** 造一份真实文件的独立副本，供注入反例用（绝不改真文件）。 */
const sandbox = () => {
  const d = mkdtempSync(join(tmpdir(), 'anchors-'))
  const css = join(d, 'css'), map = join(d, 'map.json')
  cpSync(REAL_CSS, css); cpSync(REAL_MAP, map)
  return { dir: d, css, map }
}
const withMap = (s, mutate) => {
  const m = JSON.parse(readFileSync(s.map, 'utf8'))
  mutate(m)
  writeFileSync(s.map, JSON.stringify(m, null, 2))
}

console.log('解析自检：必须命中真实产物，不能是陈旧副本')
{
  // 背景：曾出现「工作区里残留一份手工铺开的 app/ 副本」的情况，测试优先命中
  // 副本 → 对着旧文件全绿。故此处断言解析结果落在胶囊资产目录内，且文件非空。
  const layout = ASSETS.layout
  // 防「假绿」的真正判据：解析到的 CSS 与映射表必须同属一个项目树，
  // 且该树是**本测试所在树**（不能是缓存、别处检出或散落副本）。
  // 早期版本写死了前缀白名单，反而把我自己的模拟仓库误判成异常——判据要落在
  // 语义上（同一棵树），不是落在路径字面上。
  // 防「假绿的真正判据：CSS、映射表、本测试三者必须同属一棵项目树。
  // 只看 CSS 与映射表不够（布局B下它们的公共祖先是 assets/，而测试在 scripts/）；
  // 三者取共同祖先才是「这是同一份检出」的可证事实。若解析命中缓存或别处
  // 的散落副本，共同祖先会退化成 / 或某个无关目录，此处即报红。
  const isAncestor = (a, b) => b === a || b.startsWith(a + '/')
  const chain = (p) => { const out = []; let d = p; while (true) { out.push(d); const up = dirname(d); if (up === d) break; d = up } return out }
  const shared = chain(ASSETS.css).find(d => isAncestor(d, ASSETS.map) && isAncestor(d, HERE))
  check('CSS、映射表与本测试同属一棵项目树', shared !== undefined && shared !== '/',
    'css=' + ASSETS.css + ' map=' + ASSETS.map + ' test=' + HERE)
  check('共同祖先含本层标记（不是缓存或无关目录）',
    shared !== undefined && (existsSync(join(shared, 'app/src/main/assets/dsh-phone.css'))
      || existsSync(join(shared, 'overrides/app/src/main/assets/dsh-phone.css'))),
    String(shared))
  check('CSS 非空（防命中截断/空文件）', readFileSync(ASSETS.css, 'utf8').length > 1000)
  check('映射表可解析且有 anchors', Object.keys(JSON.parse(readFileSync(ASSETS.map, 'utf8')).anchors ?? {}).length >= 40)
  console.log('    布局：' + layout)
}

console.log('基线：真实文件应当通过')
{
  const r = checkAnchors(TREE, REAL_CSS, REAL_MAP, resolvePhoneJs())
  check('无失效锚点', r.missing.length === 0, JSON.stringify(r.missing))
  check('无未登记哈希', r.undeclared.length === 0, JSON.stringify(r.undeclared))
  check('无死条目', r.stale.length === 0, JSON.stringify(r.stale))
  check('在线模式已启用（提供了引擎树）', r.online === true)
}

console.log('覆盖自检：CSS 与 JS 两个消费面都必须纳管')
{
  // 只查 CSS 会漏掉仅 JS 使用的锚点（如 .hHd-Xa_toggle 用来展开抽屉）：
  // 那类失效同样静默（querySelector 返回 null 后被 ?. / if(!x) 跳过）。
  const jsAnchors = [...referencedHashes(readFileSync(resolvePhoneJs(), 'utf8'))]
  const onlyJs = jsAnchors.filter(h => !referencedHashes(readFileSync(REAL_CSS, 'utf8')).has(h))
  check('存在仅 JS 使用的锚点（证明并集扫描有必要）', onlyJs.length > 0, String(onlyJs.length))
  const probeRun = checkAnchors(TREE, REAL_CSS, REAL_MAP, resolvePhoneJs())
  check('门禁报告同时统计两个消费面',
    probeRun.referencedCount > referencedHashes(readFileSync(REAL_CSS, 'utf8')).size,
    'referenced=' + probeRun.referencedCount)
}

console.log('反例 1：CSS 用了未登记的哈希 → 必须报「未登记」')
{
  const s = sandbox()
  writeFileSync(s.css, readFileSync(s.css, 'utf8') + '\n.zzAb1Cd_widget{color:red}\n')
  const r = checkAnchors(TREE, s.css, s.map, '')
  check('检出未登记项', r.undeclared.some(u => u.hash === '.zzAb1Cd_widget'), JSON.stringify(r.undeclared))
  rmSync(s.dir, { recursive: true, force: true })
}

console.log('反例 2：声明了引擎树不存在的锚点 → 必须报「失效」')
{
  const s = sandbox()
  withMap(s, m => { m.anchors['.zzNotReal_classY'] = { semantic: 'probe.missing', pkg: 'dsh-client-ui-layout' } })
  const r = checkAnchors(TREE, s.css, s.map, '')
  check('检出失效项', r.missing.some(x => x.hash === '.zzNotReal_classY'), JSON.stringify(r.missing))
  check('失效项带语义与所属包（可执行的修复线索）',
    r.missing[0]?.semantic === 'probe.missing' && r.missing[0]?.pkg === 'dsh-client-ui-layout')
  rmSync(s.dir, { recursive: true, force: true })
}

console.log('反例 3：映射表留下 CSS 已不用的死条目 → 必须报「死条目」')
{
  const s = sandbox()
  const TARGET = '.uV2eYG_card'
  writeFileSync(s.css, readFileSync(s.css, 'utf8').split(TARGET).join('.renamedX'))
  const r = checkAnchors(TREE, s.css, s.map, '')
  check('检出死条目', r.stale.includes(TARGET), JSON.stringify(r.stale))
  rmSync(s.dir, { recursive: true, force: true })
}

console.log('反例 4：把锚点归错上游包 → 必须报「归属漂移」')
{
  const s = sandbox()
  withMap(s, m => { m.anchors['.pI_x6G_frame'] = { semantic: 'layout.frame', pkg: 'dsh-client-ui-wrong-package' } })
  const r = checkAnchors(TREE, s.css, s.map, '')
  check('检出归属漂移', r.pkgMismatch.some(x => x.hash === '.pI_x6G_frame'), JSON.stringify(r.pkgMismatch))
  rmSync(s.dir, { recursive: true, force: true })
}

console.log('正则边界：不得把 JS 常量误认成上游哈希')
{
  // 实测踩到：早期 HASH_RE 只要求类名首字母为字母，于是 Number.MAX_SAFE_INTEGER
  // 被匹配成「前缀 MAX_SAFE + 类名 INTEGER」，compat.js 因此虚假报错。引擎树里
  // 这类全大写常量有 1306 个。修正为「类名段必须含小写」后零误伤（57 锚点全留）。
  const noise = ['.MAX_SAFE_INTEGER', '.CORDIS_SHARED', '.DEFAULT_BASELINE', '.__DSH_REMOTE']
  for (const s of noise) {
    check('不误认 ' + s, !HASH_RE.test(s))
    HASH_RE.lastIndex = 0   // 全局正则带 lastIndex，逐次使用要复位
  }
  const real = ['.pI_x6G_frame', '.uV2eYG_card', '.VOzbGW_panel', '.wSkVaW_header', '._7KE1Ra_menu']
  for (const s of real) {
    check('仍识别 ' + s, HASH_RE.test(s))
    HASH_RE.lastIndex = 0
  }
}

console.log('data-slot 存在性：槽名写错必须报红（与哈希失效同类）')
{
  // 上游 dsh-client-ui-renderer 给每个槽位自动注入 [data-slot="<slotKey>"]，
  // 故它是稳定语义钩子、本层 CSS 已在用。但槽名写错**不报错** —— 选择器静默不命中。
  const s = sandbox()
  const css = readFileSync(s.css, 'utf8') + '\n[data-slot="fake.slot.probe"]{}\n[data-slot="settings.general.item"]{}\n'
  writeFileSync(s.css, css)
  const r = checkAnchors(TREE, s.css, s.map, '')
  check('检出不存在的槽名', r.badSlots.includes('fake.slot.probe'), JSON.stringify(r.badSlots))
  check('真实槽名不误报', !r.badSlots.includes('settings.general.item'))
  check('扫描到 data-slot 引用', r.slotRefs.includes('settings.general.item'), JSON.stringify(r.slotRefs))
  rmSync(s.dir, { recursive: true, force: true })
}

console.log('反例 5：离线模式（CI 无引擎树）仍能查一致性')
{
  const s = sandbox()
  writeFileSync(s.css, readFileSync(s.css, 'utf8') + '\n.zzAb1Cd_widget{color:red}\n')
  const r = checkAnchors(null, s.css, s.map, '')
  check('离线模式标记正确', r.online === false)
  check('离线模式仍检出未登记', r.undeclared.some(u => u.hash === '.zzAb1Cd_widget'))
  check('离线模式不做存在性判断（无判据可用）', r.missing.length === 0)
  rmSync(s.dir, { recursive: true, force: true })
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
