// 槽位清单与三期迁移表的判别力测试。
//
// 为什么需要：三期的迁移目标是「把硬塞 DOM 的控件改注册到槽位」。若槽位名写错
// 或上游删掉了该槽，注册代码**不会报错**——slots.inject 永远等服务，控件静默
// 不出现（本项目实测：settings.dev.item 在 0.2.1-alpha.1 已不存在，而参考项目
// 正是按它写的）。本测试对各类错法各注入一个反例，断言必须报红。
//
// 运行：node scripts/ui-tests/slot-inventory.test.mjs
import { MIGRATION, SLOT_RE, SLOT_KIND, SNAPSHOT_0_2_1, checkMigration, scanSlots, scanSlotOccupants, precedentSlots } from '../ui-slot-inventory.mjs'
import { resolveEngineTree } from './paths.mjs'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

const TREE = resolveEngineTree()

console.log('基线：登记快照与迁移表应当自洽')
{
  check('迁移表非空', MIGRATION.length > 0, String(MIGRATION.length))
  check('快照含全部迁移目标', MIGRATION.every(m => m.target in SNAPSHOT_0_2_1),
    MIGRATION.filter(m => !(m.target in SNAPSHOT_0_2_1)).map(m => m.target).join(', '))
  check('每条候选带当前实现/理由/风险（可据此决策）',
    MIGRATION.every(m => m.current && m.why && m.risk))
  const r = checkMigration(null, SNAPSHOT_0_2_1)
  check('快照模式下全部迁移目标可用', r.missing.length === 0, JSON.stringify(r.missing.map(m => m.target)))
}

console.log('recipe 完整性：每个候选都必须带可执行配方')
{
  // recipe 是「下一步能直接动手」的依据；缺了它，三期就只剩一张风险表。
  check('每个候选都有 recipe', MIGRATION.every(m => m.recipe && typeof m.recipe === 'object'),
    MIGRATION.filter(m => !m.recipe).map(m => m.id).join(', '))
  check('每个 recipe 有改动文件', MIGRATION.every(m => m.recipe?.file))
  check('每个 recipe 有注册代码片段', MIGRATION.every(m => Array.isArray(m.recipe?.code) && m.recipe.code.length > 0))
  check('每个 recipe 有接线点清单', MIGRATION.every(m => Array.isArray(m.recipe?.wiring) && m.recipe.wiring.length > 0))
  check('每个 recipe 有验证方法', MIGRATION.every(m => Array.isArray(m.recipe?.verify) && m.recipe.verify.length > 0))
  // 这条原先断言 composer-upload 的代码里含「放弃迁移」字样 —— 那是「配方里写个
  // 提醒」的形态。2026-10-13 该配方**真的被否决**（实测收益不成立 + 会丢指令入口），
  // 故断言升级为更本质的东西：**已否决的候选必须写明理由**，且其 recipe 必须
  // 明确标注「不要照抄」（否则后人照抄会得到坏结果或假红）。
  {
    const rejected = MIGRATION.filter(m => typeof m.status === 'string' && /否决|暂不做/.test(m.status))
    check('已否决的候选都写明了理由', rejected.every(m => Array.isArray(m.rejectReason) && m.rejectReason.length > 0),
      rejected.filter(m => !Array.isArray(m.rejectReason) || m.rejectReason.length === 0).map(m => m.id).join(', '))
    const cu = MIGRATION.find(m => m.id === 'composer-upload')
    check('composer-upload 已标注否决（含理由与「不要照抄」）',
      typeof cu?.status === 'string' && /否决/.test(cu.status) &&
      Array.isArray(cu.rejectReason) && cu.rejectReason.length >= 3 &&
      cu.recipe.code.some(l => l.includes('不要照抄')),
      'status=' + String(cu?.status) + ' reasons=' + (cu?.rejectReason?.length ?? 0))
  }
}

console.log('通道验证度：从实际在跑的 bundle 反推哪些槽被验证过')
{
  // 这条判断此前靠人肉记忆（「settings.section 有先例、别的没有」）。写成可机检
  // 事实后，bundle 一变就自动反映。风险 = 组件复杂度 × 通道验证度，缺了后者
  // 会把「组件简单但通道没验证过」的项误评为低风险。
  const fs = await import('node:fs')
  const os = await import('node:os')
  const d = fs.mkdtempSync(os.tmpdir() + '/prec-')
  fs.mkdirSync(d + '/phone-qq', { recursive: true })
  fs.writeFileSync(d + '/phone-qq/cards-client.js',
    "ctx.slots.register({ name: 'settings.section', id: 'a' }, C)")
  const prec = precedentSlots(d)
  check('从 bundle 提取到已注册槽位', prec.has('settings.section'), JSON.stringify([...prec]))
  check('未注册的槽不在集合里', !prec.has('shell.overlay'))
  check('根目录为 null 时返回空集（不抛错）', precedentSlots(null).size === 0)
  check('目录不存在时返回空集', precedentSlots('/nonexistent-xyz').size === 0)
  fs.rmSync(d, { recursive: true, force: true })
}

console.log('上游占用：single 槽被占用时我方必须换 priority')
{
  // 用真实 SlotCore 印证扫描器的意义：single 槽的冲突判据是 priority（默认 0），
  // 与 id 无关。实测 conversation.input.plan 已被 dsh-client-ui-plan 以 pri 0 占用
  // ⇒ 我方若用默认 priority 会直接 throw（这不是理论风险，是已验证的失败路径）。
  const TREE = process.env.DSH_TREE ?? resolveEngineTree()
  // 判据用「扫描结果是否为空」而非「TREE 是否非空」：DSH_TREE 可能指向一个
  // 不存在的路径（CI 兼容性测试就是这么做的），此时 TREE 非空但扫不到东西 ——
  // 那属「无输入可验」，应跳过。实测这个差别造成过 2 例假红。
  if (TREE && scanSlotOccupants(TREE).size > 0) {
    const occ = scanSlotOccupants(TREE)
    const items = MIGRATION.map(m => ({ m, o: occ.get(m.target) ?? [] }))
    // 用**必然被占用的 single 槽**验证扫描器能力，不依赖 MIGRATION 内容 ——
    // 修掉 model-picker-notice 后，迁移表里已无「single 且被占用」的项。
    const probe = 'conversation.input.plan'          // 实测被 dsh-client-ui-plan 以 priority 0 占用
    const probeOcc = occ.get(probe) ?? []
    check('扫描器能发现 single 槽的上游占用', probeOcc.length > 0, JSON.stringify(probeOcc))
    check('扫描器不误报未被占用的槽（conversation.header.leading）',
      (occ.get('conversation.header.leading') ?? []).length === 0)
    const planOcc = occ.get('conversation.input.plan') ?? []
    check('input.plan 确被上游占用（印证配方改 priority 的必要性）', planOcc.length > 0,
      JSON.stringify(planOcc))
    check('占用信息含 priority（决定我方取值）', planOcc.every(x => typeof x.priority === 'number'))
  } else {
    console.log('  （跳过：本环境无可用引擎树）')
  }
}

console.log('反例 1：迁移目标写成不存在的槽 → 必须判缺')
{
  const r = checkMigration(null, { 'shell.overlay': 'x' })  // 只给一个槽
  check('检出不可用目标', r.missing.length > 0, String(r.missing.length))
  check('可用的仍记为可用', r.ok.some(o => o.target === 'shell.overlay'))
}

console.log('反例 2：槽位名正则必须认得出真实形态')
{
  const samples = [
    ["'conversation.header.leading'", 'conversation.header.leading'],
    ["'shell.overlay'", 'shell.overlay'],
    ["'settings.section'", 'settings.section'],
    ["'sidebar.right.pane.tab.title'", 'sidebar.right.pane.tab.title'],
  ]
  for (const [src, want] of samples) {
    const got = [...src.matchAll(SLOT_RE)].map(m => m[0].slice(1, -1))
    check('识别 ' + want, got.includes(want), JSON.stringify(got))
  }
  // 干扰项不应被当成槽位
  const noise = ["'some.other.thing'", "'settingsX.section'"]
  for (const s of noise) {
    const got = [...s.matchAll(SLOT_RE)].map(m => m[0].slice(1, -1))
    check('不误认 ' + s, got.length === 0, JSON.stringify(got))
  }
}

if (TREE) {
  console.log('在线：对真实引擎树校验')
  const slots = scanSlots(TREE)
  check('从引擎树提取到槽位', slots.size > 20, String(slots.size))
  const r = checkMigration(TREE, SNAPSHOT_0_2_1)
  check('全部迁移目标在真实引擎上存在', r.missing.length === 0, JSON.stringify(r.missing.map(m => m.target)))
  // 登记快照必须与真实引擎一致（否则快照会误导离线判据）
  const snapshotStale = Object.keys(SNAPSHOT_0_2_1).filter(s => !slots.has(s))
  check('登记快照未过期（无引擎已删的槽）', snapshotStale.length === 0, snapshotStale.join(', '))
} else {
  console.log('在线：跳过（本机无引擎树，已由离线层覆盖）')
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
