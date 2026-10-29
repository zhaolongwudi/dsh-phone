// 插件 peer 门禁的**判别力反证**测试。
//
// ## 为什么必须有这个文件
//
// 该门禁的失效形态恰恰是「静默变恒真」：如果判定逻辑写错（例如把精确旧版也判成
// 兼容、或取不到 semver 就一律放行），门禁会**永远绿**，而设备上插件照样整块消失
// —— 与它要防的事故一模一样。故必须双向断言：
//   · 能检出：精确旧版 / 不存在的版本 / 空范围 必须被判不兼容；
//   · 不误报：caret/tilde 范围、workspace: 协议、非 dsh 的 peer 必须放行。
//
// ## 一个真实教训（本文件正是为它而写）
//
// 首版判定在取不到 semver 时**退化为精确串比对**，于是 noema 的 `^0.2.1-alpha.1`
// 被误判成失配 ⇒ 构建期**假红**。修正后判据来源改为「仓库自带 pnpm 里的 semver」
// （`runtime/tools/pnpm/dist/node_modules/semver`，随仓库提交、无需 install），
// 并在判据缺失时**显式 exit 2**，而不是退化成一个会说谎的判定。
//
// 运行：node scripts/ui-tests/plugin-peers.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

// 定位仓库根（与其它 ui-tests 同一套向上查找手法）
let root = HERE
for (let i = 0; i < 10; i++) {
  if (existsSync(join(root, 'runtime/package.json'))) break
  const up = dirname(root); if (up === root) { root = null; break }
  root = up
}
// ⚠️ 循环跑满仍未命中时必须**显式置 null**：否则 root 停在某个上层目录，
//    后面按它取 semver/清单会失败 ⇒ 本层在「没铺 runtime/ 的布局」下**假红**。
if (root !== null && !existsSync(join(root, 'runtime/package.json'))) root = null
if (!root) {
  console.log('  （跳过：本布局下找不到 runtime/package.json —— 例如胶囊源目录）')
  console.log('\n结果：0 passed / 0 failed')
  process.exit(0)
}

// 判据来源必须与 check-plugin-peers.mjs 保持一致
const req = createRequire(join(root, 'package.json'))
const semver = (() => {
  for (const c of [
    join(root, 'runtime/tools/pnpm/dist/node_modules/semver'),
    join(root, 'runtime/node_modules/semver'),
    join(root, 'node_modules/semver'),
    'semver',
  ]) {
    try { const m = req(c); if (typeof m?.satisfies === 'function') return m } catch {}
  }
  return null
})()

const RUNTIME = (() => {
  try { return JSON.parse(readFileSync(join(root, 'runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'] }
  catch { return null }
})()

console.log('判据来源：必须是「真 semver」，不能退化成会说谎的串比对')
{
  check('仓库自带 pnpm 的 semver 可用（无需 pnpm install）', semver !== null)
  check('runtime 引擎版本可读', typeof RUNTIME === 'string' && RUNTIME.length > 0, String(RUNTIME))
}

if (semver === null) {
  console.log(`\n结果：${pass} passed / ${fail} failed（判据缺失，后续断言无法进行）`)
  process.exit(1)
}

// 与 app-boot 的 evaluatePluginCompatibility 同逻辑的判定（用于断言）
const DSH_PREFIX = '@deepseek-ai/dsh'
function judge(manifest, runtimeVersion) {
  const peers = {}
  for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
    if (name !== DSH_PREFIX && !name.startsWith(DSH_PREFIX + '-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    let ok = false
    try { ok = requirement.trim() !== '' && semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }) } catch { ok = false }
    if (!ok) peers[name] = range
  }
  return Object.keys(peers).length ? { peers } : undefined
}

console.log('能检出：这些必须被判不兼容（否则门禁是恒真的假绿）')
{
  const V = RUNTIME
  // 精确旧版 —— 正是 2026-10-14 Jet Hub 事故的形态
  check('精确旧版（0.2.1-alpha.1）被检出', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.1' } }, V) !== undefined)
  check('精确未来版（9.9.9）被检出', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': '9.9.9' } }, V) !== undefined)
  check('不存在的预发布（0.0.0-nope）被检出', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': '0.0.0-nope' } }, V) !== undefined)
  check('空范围被检出', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': '   ' } }, V) !== undefined)
  check('非法范围被检出', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': 'not-a-range' } }, V) !== undefined)
  // 多个 peer 里只要有一个不合就整体不合
  const multi = judge({ peerDependencies: { '@deepseek-ai/dsh-llm': V, '@deepseek-ai/dsh-commands': '0.2.1-alpha.1' } }, V)
  check('多 peer 中单个不合即整体不合', multi !== undefined && '@deepseek-ai/dsh-commands' in multi.peers)
}

console.log('不误报：这些必须放行（否则构建期假红）')
{
  const V = RUNTIME
  check('精确当前版放行', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': V } }, V) === undefined)
  // noema 的真实写法 —— 首版正是把它误报成红
  check('caret 旧版范围放行（noema 的真实写法）',
    judge({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.1-alpha.1' } }, V) === undefined)
  check('tilde 范围放行', judge({ peerDependencies: { '@deepseek-ai/dsh-tools': '~0.2.1-alpha.1' } }, V) === undefined)
  check('>= 范围放行', judge({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.2.0' } }, V) === undefined)
  check('workspace:^ 协议放行', judge({ peerDependencies: { '@deepseek-ai/dsh-tools': 'workspace:^' } }, V) === undefined)
  check('通配 * 放行', judge({ peerDependencies: { '@deepseek-ai/dsh-llm': '*' } }, V) === undefined)
  // 非 dsh 的 peer 不参与判定（cordis/schemastery/react 等再旧也不该报）
  check('非 dsh 的 peer 被忽略（cordis *）', judge({ peerDependencies: { '@deepseek-ai/cordis': '*', '@deepseek-ai/schemastery': '^3.18.4' } }, V) === undefined)
  check('非 dsh 的 peer 即使不匹配也不报', judge({ peerDependencies: { '@deepseek-ai/cordis': '^99.0.0' } }, V) === undefined)
  check('无 peerDependencies 字段放行', judge({}, V) === undefined)
  check('peerDependencies 为空对象放行', judge({ peerDependencies: {} }, V) === undefined)
}

console.log('真实清单：仓库里每个插件都不能被判不兼容')
{
  let rt
  try { rt = JSON.parse(readFileSync(join(root, 'runtime/package.json'), 'utf8')) } catch { rt = null }
  const dirs = rt
    ? Object.entries(rt.dependencies || {}).filter(([, v]) => String(v).startsWith('file:'))
        .map(([name, v]) => ({ name, dir: join(root, 'runtime', String(v).replace(/^file:/, '')) }))
    : []
  check('找到至少一个 file: 插件依赖', dirs.length > 0, String(dirs.length))
  let bad = 0
  for (const { name, dir } of dirs) {
    const mf = join(dir, 'package.json')
    if (!existsSync(mf)) continue
    let m; try { m = JSON.parse(readFileSync(mf, 'utf8')) } catch { continue }
    const issue = judge(m, RUNTIME)
    if (issue !== undefined) { bad++; console.log(`    不兼容：${name} → ${JSON.stringify(issue.peers)}`) }
  }
  check('全部插件清单与引擎兼容（0 个会被跳过）', bad === 0, `bad=${bad}`)
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
