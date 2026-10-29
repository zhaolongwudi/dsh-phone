// 槽位注册的**运行时**验证：模拟壳侧客户端模块装载器与 cordis 槽位 API，
// 真实执行本项目的 client bundle，断言注册行为。
//
// ## 为什么需要它（与 ui-slot-register-audit.mjs 的分工）
//
//   - `ui-slot-register-audit.mjs` 是**静态**检查：正则扫源码，查同 id / 同 order /
//     槽名是否存在。它能发现「表里的冲突」，但发现不了「代码根本跑不起来」——
//     例如 factory 抛异常、`inject` 漏声明导致服务永远等待、register 的参数形态
//     不符合上游契约。
//   - 本测试是**动态**验证：按壳侧真实装载协议（window.__ModuleLoader__.load）
//     执行产物，喂一个记录型的 ctx.slots，断言「谁注册到了哪个槽、带的什么参数」。
//
// 这层验证对三期的意义：迁移配方（SHELL-UI-PORT-PLAN §9.6）把控件从 DOM 硬塞
// 改成槽位注册时，最大的风险是「注册了但永不生效」——静态检查看不出来，只有真跑
// 一遍才知道。本测试就是那层保险。
//
// 运行：node scripts/ui-tests/slot-register-runtime.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBundle } from './ui-bundle-runner.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

/** 向上探测仓库根（兼容胶囊工作区与 apply 后仓库两种布局）。 */
function findRoot() {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const p of ['', '../../', '../']) {
      const c = join(d, p)
      if (existsSync(join(c, 'phone-qq/cards-client.js')) || existsSync(join(c, 'peer/agent-cards/client.js'))) return c
    }
    const up = dirname(d); if (up === d) break; d = up
  }
  return null
}

const ROOT = findRoot()

console.log('运行时装载：真实 client bundle 必须能被壳侧协议加载')
if (!ROOT) {
  console.log('  （跳过：本布局下无 phone-qq/peer 产物，属预期——它们是上游文件，只在 apply 后的仓库根存在）')
} else {
  const targets = [
    ['phone-qq/cards-client.js', 'dsh-phone-qq'],
    ['peer/agent-cards/client.js', 'dsh-peer'],
  ]
  for (const [rel, expectId] of targets) {
    const p = join(ROOT, rel)
    if (!existsSync(p)) { console.log(`  （跳过 ${rel}：不存在）`); continue }
    console.log(`\n  ${rel}`)
    const r = runBundle(readFileSync(p, 'utf8'))
    check('无执行错误', r.errors.length === 0, r.errors.join(' | '))
    check('module id 正确（壳侧按包名装载，错则整个 bundle 不生效）', r.id === expectId, `实际 ${r.id}`)
    check('声明了 inject（漏则永远等服务、界面无反应）', r.inject.length > 0, JSON.stringify(r.inject))
    check('inject 含 slots 服务', r.inject.includes('slots'), JSON.stringify(r.inject))
    check('有实际注册行为', r.registrations.length > 0, String(r.registrations.length))
    check('每次注册都带 name 与 id（缺一则上游登记不完整）',
      r.registrations.every(x => x.name && x.id),
      JSON.stringify(r.registrations.filter(x => !x.name || !x.id)))
    check('每次注册都带组件工厂', r.registrations.every(x => x.hasComponent))
    const slots = [...new Set(r.registrations.map(x => x.name))]
    console.log(`    注册 ${r.registrations.length} 处，分布在 ${slots.length} 个槽：${slots.join(', ')}`)
  }
}

console.log('\n自证：装载器必须能抓出坏 bundle（否则本测试是假绿）')
{
  // 反例 1：factory 抛错
  const bad1 = "window.__ModuleLoader__.load({ id: 'x', factory: () => { throw new Error('boom') } })"
  const r1 = runBundle(bad1)
  check('抓出 factory 抛错', r1.errors.some(e => e.includes('执行抛错')), JSON.stringify(r1.errors))

  // 反例 2：忘了 load
  const r2 = runBundle("const inject = ['slots'];")
  check('抓出未调用 load', r2.errors.some(e => e.includes('未调用')), JSON.stringify(r2.errors))

  // 反例 3：load 了但没返回 apply
  const bad3 = "window.__ModuleLoader__.load({ id: 'y', factory: () => ({ inject: ['slots'] }) })"
  const r3 = runBundle(bad3)
  check('抓出缺 apply', r3.errors.some(e => e.includes('apply')), JSON.stringify(r3.errors))

  // 反例 4：正常 bundle 应无错
  const good = [
    "window.__ModuleLoader__.load({ id: 'z', factory: () => {",
    "  const inject = ['slots']",
    "  const apply = ctx => { ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'a', order: 1 }, () => null)) }",
    "  return { inject, apply }",
    "} })",
  ].join('\n')
  const r4 = runBundle(good)
  check('正常 bundle 无错且有注册', r4.errors.length === 0 && r4.registrations.length === 1, JSON.stringify(r4))
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
