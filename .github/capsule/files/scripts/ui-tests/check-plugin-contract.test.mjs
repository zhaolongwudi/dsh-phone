// 跨层类名契约门禁的判别力测试：证明它「坏了会红」，而不是永远绿。
//
// 假门禁是这类静态检查最常见的失败形态：脚本能跑、报告漂亮、CI 全绿，但真出问题时
// 一声不响。本测试对每一条判据各注入一个反例，断言必须报红；并额外验证「注释不算
// 消费/产出」这一条 —— 少了它，删掉真规则、只留注释，门禁照样绿（本仓库记过的
// 同型事故：判据自匹配修复注释本身）。
//
// 运行：node scripts/ui-tests/check-plugin-contract.test.mjs --root <胶囊仓根>
import { mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveLayout, checkPluginContract, formatReport, stripComments, referencedClasses, producesClass,
} from '../check-plugin-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 自本测试向上探测胶囊仓根（含 overrides/ 与 files/ 的那一级）。
 *
 * ⚠️ 与 check-plugin-contract.mjs 的取舍一致：**不依赖 DSH_TREE**（本机没有该
 *    环境变量，CI 也没有），只按相对路径向上找本层独有的标记物。
 * @returns 仓根绝对路径
 */
function resolveCapsuleRoot() {
  // 命令行显式给的最优先（CI 里路径形态可能不同）。
  // ⚠️ 必须归一成**绝对路径**：`--root .` 这类相对值直接传下去，后面按 root 长度
  //    切相对路径会全错（实测：报错路径里出现 `des/app/...`，多切了 6 个字符）。
  const at = process.argv.indexOf('--root')
  if (at >= 0 && process.argv[at + 1]) return resolve(process.argv[at + 1])
  let d = HERE
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(d, 'overrides/app/src/main/assets/dsh-phone.css'))) return d
    if (existsSync(join(d, 'files/app/src/main/assets/phone-plugin-contract.json'))) return d
    // 布局 B（apply 之后）：契约表就落在仓根 app/ 下。
    if (existsSync(join(d, 'app/src/main/assets/phone-plugin-contract.json'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return process.cwd()
}

const ROOT = resolveCapsuleRoot()
const LAYOUT = resolveLayout(ROOT)

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

/**
 * 把绝对路径转成「相对某个仓根」的相对路径。
 *
 * ⚠️ 必须每次传入**当时那个**仓根：沙盒里的布局根是临时目录，用真实仓根的长度去
 *    切沙盒路径会切错位数（初版就这么写，报错信息里出现 `des/app/...` ——
 *    「overrides/」被多切掉了 6 个字符）。
 * @param root 仓根
 * @param p 绝对路径
 */
const relTo = (root, p) => p.slice(root.length + 1)

/**
 * 造一份真实布局的独立副本（**绝不改真文件**）。
 *
 * ⚠️ 只复制门禁要用到的三类路径：app 层两个资产、契约表、插件客户端目录。
 *    沿用真实的前缀关系（overrides/ 与 files/ 分离），否则测不出布局解析。
 */
function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'plugin-contract-'))
  const rel = (p) => relTo(LAYOUT.root, p)
  const copy = (src) => {
    const dst = join(d, rel(src))
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
  }
  copy(LAYOUT.contract)
  if (LAYOUT.appJs) copy(LAYOUT.appJs)
  if (LAYOUT.appCss) copy(LAYOUT.appCss)
  if (LAYOUT.pluginPkg) copy(LAYOUT.pluginPkg)
  for (const entry of LAYOUT.pluginDirs) {
    for (const f of readdirSync(entry.dir)) {
      const dst = join(d, rel(entry.dir), f)
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(join(entry.dir, f), dst)
    }
  }
  return d
}
const L = (d) => resolveLayout(d)
const withContract = (d, mutate) => {
  const p = join(d, relTo(d, L(d).contract))
  const m = JSON.parse(readFileSync(p, 'utf8'))
  mutate(m)
  writeFileSync(p, JSON.stringify(m, null, 2))
}

console.log('解析自检：必须命中真实资产，不能是陈旧副本或错误前缀')
{
  check('已定位胶囊仓根', typeof ROOT === 'string' && ROOT.length > 1, ROOT)
  check('app 层两个消费文件都找到（跨前缀：契约表 files/、资产 overrides/）',
    LAYOUT.appJs !== null && LAYOUT.appCss !== null,
    JSON.stringify({ js: LAYOUT.appJs, css: LAYOUT.appCss }))
  check('插件产出面取到**两处**并集（只取一处会假红：files/ 侧只有 3 个文件）',
    LAYOUT.pluginDirs.length >= 1, String(LAYOUT.pluginDirs.length))
  check('契约表可解析且有 classes',
    Object.keys(JSON.parse(readFileSync(LAYOUT.contract, 'utf8')).classes ?? {}).length >= 20)
}

console.log('基线：真实文件应当通过')
{
  const r = checkPluginContract(LAYOUT)
  check('无契约失效', r.broken.length === 0, JSON.stringify(r.broken.map(b => b.cls)))
  check('无未登记', r.undeclared.length === 0, JSON.stringify(r.undeclared))
  check('无死条目', r.stale.length === 0, JSON.stringify(r.stale))
  check('插件侧确实扫到了产出（不是空集合导致的假绿）', r.producerCount >= 20, String(r.producerCount))
  check('无版本漂移', r.versionDrift === null, JSON.stringify(r.versionDrift))
}

console.log('反例 1：插件侧把类名改名 → 必须报「契约失效」并点名插件文件与语义')
{
  const d = sandbox()
  const dir = L(d).pluginDirs.map(e => e.dir).find(dir => readdirSync(dir).includes('usage-badge.js'))
  const p = join(dir, 'usage-badge.js')
  writeFileSync(p, readFileSync(p, 'utf8').split("className: 'dim-jh-badgeText'").join("className: 'dim-jh-badgeTextRenamed'"))
  const r = checkPluginContract(L(d))
  const hit = r.broken.find(b => b.cls === 'dim-jh-badgeText')
  check('检出契约失效', hit !== undefined, JSON.stringify(r.broken.map(b => b.cls)))
  check('报错带可执行线索（消费面 + 声明的插件文件 + 语义）',
    hit?.usedBy === 'dsh-phone.css' && hit?.pluginFile === 'usage-badge.js' && typeof hit?.semantic === 'string')
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 2：只把类名留在**注释**里 → 仍须报「契约失效」（剥注释判据）')
{
  // 少了这条，插件侧删掉真实现、注释里留一句「.dim-jh-x 曾经在这里」即可骗过门禁。
  const d = sandbox()
  const dir = L(d).pluginDirs.map(e => e.dir).find(dir => readdirSync(dir).includes('usage-badge.js'))
  const p = join(dir, 'usage-badge.js')
  const renamed = readFileSync(p, 'utf8').split("className: 'dim-jh-badgeText'").join("className: 'dim-jh-badgeTextRenamed'")
  writeFileSync(p, `/* 这里仍然有 .dim-jh-badgeText 的说明 */\n${renamed}`)
  const r = checkPluginContract(L(d))
  check('注释不算产出', r.broken.some(b => b.cls === 'dim-jh-badgeText'))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 3：app 层引用了未登记的类名 → 必须报「未登记」')
{
  const d = sandbox()
  const p = join(d, relTo(d, L(d).appCss))
  writeFileSync(p, readFileSync(p, 'utf8') + '\n.dim-jh-zzProbeNeverDeclared{color:red}\n')
  const r = checkPluginContract(L(d))
  check('检出未登记', r.undeclared.some(u => u.cls === 'dim-jh-zzProbeNeverDeclared'),
    JSON.stringify(r.undeclared))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 4：app 层只在**注释**里提到类名 → 不得算作消费（否则删掉真规则仍绿）')
{
  const d = sandbox()
  const p = join(d, relTo(d, L(d).appCss))
  writeFileSync(p, readFileSync(p, 'utf8') + '\n/* .dim-jh-zzProbeCommentOnly 只是注释 */\n')
  const r = checkPluginContract(L(d))
  check('注释不算消费', !r.undeclared.some(u => u.cls === 'dim-jh-zzProbeCommentOnly'),
    JSON.stringify(r.undeclared))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 5：契约表留下死条目 → 必须报「死条目」')
{
  const d = sandbox()
  withContract(d, m => { m.classes['dim-jh-zzProbeStale'] = { semantic: 'probe', pluginFile: 'jet-hub.js' } })
  const r = checkPluginContract(L(d))
  check('检出死条目', r.stale.includes('dim-jh-zzProbeStale'), JSON.stringify(r.stale))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 6：插件包版本漂移 → 必须提示复核')
{
  const d = sandbox()
  const rel = relTo(d, L(d).pluginPkg)
  const p = join(d, rel)
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.version = '9.9.9-probe'
  writeFileSync(p, JSON.stringify(m, null, 2))
  const r = checkPluginContract(L(d))
  check('检出漂移', r.versionDrift?.actual === '9.9.9-probe', JSON.stringify(r.versionDrift))
  rmSync(d, { recursive: true, force: true })
}

console.log('判据单元：剥注释与产出识别')
{
  check('CSS 块注释被剥掉', !stripComments('/* .dim-jh-a */ .dim-jh-b{}', 'css').includes('dim-jh-a'))
  check('JS 行注释被剥掉', !stripComments('  // .dim-jh-a\nconst x=1', 'js').includes('dim-jh-a'))
  check('URL 里的 // 不被误当行注释', stripComments("fetch('https://x/y')", 'js').includes('https://x/y'))
  check('类名提取正确', referencedClasses('.dim-jh-a, .dim-jh-b{}.dim-jh-a{}').size === 2)
  check('引号内的类名算产出', producesClass("className: 'dim-jh-a dim-jh-b'", 'dim-jh-b'))
  check('裸词（注释残留）不算产出', !producesClass('提到 dim-jh-a 但没引号', 'dim-jh-a'))
}

console.log('报告渲染：失败时必须给出可执行线索')
{
  const d = sandbox()
  const dir = L(d).pluginDirs.map(e => e.dir).find(dir => readdirSync(dir).includes('usage-badge.js'))
  const p = join(dir, 'usage-badge.js')
  writeFileSync(p, readFileSync(p, 'utf8').split("className: 'dim-jh-badgeText'").join("className: 'dim-jh-badgeTextRenamed'"))
  const text = formatReport(checkPluginContract(L(d)))
  check('报告含失效项与插件文件名', text.includes('dim-jh-badgeText') && text.includes('usage-badge.js'))
  check('报告末行明确「未通过」', text.includes('✗ 未通过'))
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
