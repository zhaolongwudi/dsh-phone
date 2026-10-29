// 槽位注册审计的判别力测试：证明它抓得住「同 id / 同 order / 槽名失效」三类静默失效。
//
// 这是本项目真实踩过的形态：dsh-phone-qq 与 dsh-peer 由同一份 client-source.js
// 产出，天然同 id —— 只要两者都进 profile bundles，keyed 槽就会「先到者赢、
// 后者静默消失」（用户只看到面板没了，没有任何报错）。审计器必须在改动把
// 第二个包加进 bundles 时立刻报红，而不是等用户反馈。
//
// 运行：node scripts/ui-tests/slot-register-audit.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync as wf, cpSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditRegisters, extractRegisters, readBundles } from '../ui-slot-register-audit.mjs'
import { resolveEngineTree } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

const TREE = resolveEngineTree()
/** 定位真实仓库根（含 phone-qq 与 peer）。 */
function repoRoot() {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const p of ['', '../../', '../']) {
      const c = join(d, p)
      if (existsSync(join(c, 'phone-qq/cards-client.js')) && existsSync(join(c, 'peer/agent-cards/client.js'))) return c
    }
    const up = dirname(d); if (up === d) break; d = up
  }
  return null
}
const ROOT = repoRoot()

console.log('基线：真实仓库现状')
if (!ROOT) { console.log('  （跳过：本布局下找不到 phone-qq/peer，属预期——它们是上游文件而非胶囊内）') }
else {
  const r = auditRegisters(ROOT, TREE)
  check('读到真实 bundles', typeof r === 'object')
  check('现有在装包之间无真实冲突', r.dupIds.filter(d => d.live).length === 0,
    JSON.stringify(r.dupIds.filter(d => d.live).map(d => d.id)))
  check('槽名全部有效', r.unknownSlot.length === 0, JSON.stringify(r.unknownSlot))
  check('潜在冲突已识别（生成关系）', r.dupIds.some(d => d.generated))
}

console.log('反例 1：两个包都进 bundles → 同 id 必须判为真实冲突')
{
  const d = mkdtempSync(join(tmpdir(), 'reg-'))
  mkdirSync(join(d, 'phone-qq'), { recursive: true })
  mkdirSync(join(d, 'peer/agent-cards'), { recursive: true })
  mkdirSync(join(d, 'home-template/profiles/phone'), { recursive: true })
  const REG = "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dup-x', order: 10 }, C))\n"
  wf(join(d, 'phone-qq/cards-client.js'), REG)
  wf(join(d, 'peer/agent-cards/client.js'), REG)
  // 两包都在 bundles
  wf(join(d, 'home-template/profiles/phone/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['dsh-phone-qq', 'dsh-peer'] } } }))
  const r = auditRegisters(d, TREE)
  check('检出真实同 id 冲突', r.dupIds.some(x => x.id === 'dup-x' && x.live), JSON.stringify(r.dupIds))
  check('bundles 读取正确', readBundles(d).has('dsh-peer') && readBundles(d).has('dsh-phone-qq'))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 2：只有一个包进 bundles → 同 id 应只算潜在，不阻断')
{
  const d = mkdtempSync(join(tmpdir(), 'reg-'))
  mkdirSync(join(d, 'phone-qq'), { recursive: true })
  mkdirSync(join(d, 'peer/agent-cards'), { recursive: true })
  mkdirSync(join(d, 'home-template/profiles/phone'), { recursive: true })
  const REG = "ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dup-y', order: 10 }, C))\n"
  wf(join(d, 'phone-qq/cards-client.js'), REG)
  wf(join(d, 'peer/agent-cards/client.js'), REG)
  wf(join(d, 'home-template/profiles/phone/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['dsh-phone-qq'] } } }))
  const r = auditRegisters(d, TREE)
  check('同 id 被识别但不算真实冲突', r.dupIds.some(x => x.id === 'dup-y') && !r.dupIds.find(x => x.id === 'dup-y').live)
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 3：槽名不在引擎 → 必须报「永不生效」')
{
  const d = mkdtempSync(join(tmpdir(), 'reg-'))
  mkdirSync(join(d, 'phone-qq'), { recursive: true })
  mkdirSync(join(d, 'peer/agent-cards'), { recursive: true })
  wf(join(d, 'phone-qq/cards-client.js'),
    "ctx.slots.inject('settings.dev.item', () => ctx.slots.register({ name: 'settings.dev.item', id: 'z', order: 1 }, C))\n")
  wf(join(d, 'peer/agent-cards/client.js'), '')
  const r = auditRegisters(d, TREE)
  check('检出无效槽名', r.unknownSlot.some(u => u.slot === 'settings.dev.item'), JSON.stringify(r.unknownSlot))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 4：提取器必须认出循环注册的 id')
{
  const src = [
    "for (const [id, label] of [['chat-history','x'],['memory-isolation','y']]) {",
    "  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id, order: 27, label }, C))",
    "}",
  ].join('\n')
  const regs = extractRegisters(src)
  const ids = new Set(regs.map(r => r.id))
  check('认出循环里的 chat-history', ids.has('chat-history'), JSON.stringify([...ids]))
  check('认出循环里的 memory-isolation', ids.has('memory-isolation'))
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
