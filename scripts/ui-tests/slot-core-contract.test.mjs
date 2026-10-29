// 用**真实 SlotCore**（引擎树的 @deepseek-ai/dsh-client-ui-slots）验证槽位注册契约。
//
// ## 为什么这层不可替代
//
// 前面几层验证的都是「我们写的代码是否自洽」：锚点登记齐不齐、标记有没有消费、
// 配方能不能跑。但三期真正的未知是**上游槽位 API 的契约**：
// 注册到「host 没声明的槽」会怎样？我先前据 dsh-client-modules 的注释推断
// 「inject 只影响到达顺序、未声明不会硬失败」—— 那是**猜的**。
//
// 本测试直接加载上游真实实现来验：
//   register() 第一步就 records.get(name)，未声明则 throw
//     slot "X" is not declared (a parent entry's children table must declare it)
// ⇒ 「host 未声明该槽」是**硬失败**，不是时序竞态。结论因此被推翻并修正。
//
// ## 无引擎树时
// 显式跳过并说明（CI 无引擎树），不把「没测」说成「通过」。
//
// 运行：node scripts/ui-tests/slot-core-contract.test.mjs
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveEngineTree } from './paths.mjs'

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

const TREE = resolveEngineTree()
const SLOTS = TREE ? join(TREE, 'node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js') : null

if (!SLOTS || !existsSync(SLOTS)) {
  console.log('真实 SlotCore 契约：跳过（本环境无引擎树，CI 属预期）')
  console.log('  说明：本层只在维护期可跑；无引擎树时不假装通过。')
  console.log('\n结果：0 passed / 0 failed（跳过）')
  process.exit(0)
}

const { SlotCore } = await import(SLOTS)
check('加载到真实 SlotCore', typeof SlotCore === 'function')

console.log('契约 1：未声明的槽位注册必须硬失败')
{
  const sc = new SlotCore()
  let err = null
  try { sc.register({ name: 'shell.overlay', id: 'probe', order: 1 }, () => null) } catch (e) { err = e }
  check('未声明槽位注册抛错（证实是硬失败而非竞态）', err !== null, String(err?.message).slice(0, 80))
  check('错误信息含 "not declared"（可据此定位）',
    /not declared/.test(String(err?.message ?? '')), String(err?.message).slice(0, 100))
}

console.log('契约 2：声明后注册成功，且能被查出')
{
  const sc = new SlotCore()
  let err = null, ok = false
  try {
    const rec = sc.record('probe-slot')
    rec.spec = { kind: 'single', scope: 'root' }
    sc.register({ name: 'probe-slot', id: 'probe', order: 1 }, () => null)
    ok = true
  } catch (e) { err = e }
  check('声明后注册成功', ok, String(err?.message).slice(0, 80))
  check('entriesOfSlot 能查到条目', sc.entriesOfSlot('probe-slot').length > 0)
}

console.log('契约 3b：槽位 kind 决定注册参数（list 必带 id / single 不带也行）')
{
  // 用真实实现查明：register 按 rec.spec.kind 分派，list 与 single 校验不同。
  // 实测各迁移目标槽：shell.overlay=list、input.left=list、settings.section=list；
  // header.leading=single、input.plan=single。配方必须按 kind 给参数。
  const mk = (key, kind) => { const s = new SlotCore(); const r = s.record(key); r.spec = { kind, scope: "root" }; return s }
  let e1 = null
  try { mk("ov", "list").register({ name: "ov", order: 1 }, () => null) } catch (e) { e1 = e }
  check('list 槽缺 id 直接报错（配方必须带 id）', e1 !== null, String(e1?.message ?? '').slice(0, 70))
  check('错误信息含 requires options.id', /requires options\.id/.test(String(e1?.message ?? '')))
  let e2 = null
  try { mk("hd", "single").register({ name: "hd", id: "with-id", order: 1 }, () => null) } catch (e) { e2 = e }
  check('single 槽带 id 无害（被忽略，不报错）', e2 === null, String(e2?.message ?? '').slice(0, 70))
}

console.log('契约 3：同 id 重复注册的行为（三期迁移的真实风险点）')
{
  const sc = new SlotCore()
  const rec = sc.record('probe-slot')
  rec.spec = { kind: 'single', scope: 'root' }
  sc.register({ name: 'probe-slot', id: 'same-id', order: 1 }, () => null)
  let err = null
  try { sc.register({ name: 'probe-slot', id: 'same-id', order: 2 }, () => null) } catch (e) { err = e }
  // 不断言「必然抛错」——上游可能允许后到者覆盖；如实记录实际行为即可。
  console.log('    同 id 二次注册：' + (err ? '抛错 → ' + String(err.message).slice(0, 70) : '未抛错（后者覆盖/并存）'))
  check('该行为被观测并记录（不假设）', true)
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
