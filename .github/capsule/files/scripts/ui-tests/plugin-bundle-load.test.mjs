// 产物装载验证：用**真实模块系统协议**装载本层生成的客户端 bundle。
//
// ## 与其他层的分工
//
//   · mask-takeover.test.mjs：静态断言（源码/产物/样式里该有什么）
//   · slot-chain-e2e.test.mjs：真实 renderer + SlotCore + React 的链路
//   · **本测试**：把**实际生成的产物**按 \`window.__ModuleLoader__.load({id, factory})\`
//     协议注册进一个模仿上游模块系统的宿主，并**调用它的 factory** —— 验证产物
//     真的能被装载、inject 声明正确、apply 能跑完且注册落到预期槽位。
//
// 为什么这层有价值：产物是生成器的输出，格式由生成器决定；一旦生成器或产物形态
// 变化（例如 injection 声明丢失、factory 抛错），只有「真的装载一次」才能发现。
//
// 运行：node scripts/ui-tests/plugin-bundle-load.test.mjs
import { readFileSync } from 'node:fs'
import { resolvePlugin } from './paths.mjs'

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

const p = resolvePlugin('qqBundle')
if (!p) {
  console.log('产物装载：跳过（本布局下未找到 phone-qq/cards-client.js）')
  console.log('\n结果：0 passed / 0 failed（跳过）')
  process.exit(0)
}
const code = readFileSync(p, 'utf8')

console.log('产物装载：按真实 __ModuleLoader__ 协议装载本层产物')

// 模仿上游客户端模块系统的装载面
const loaded = []
const win = {
  __ModuleLoader__: { load: entry => { loaded.push(entry) } },
}
// 产物里用到 document（主题脚本插入 + 接管事实发布）
const attrs = new Set()
const doc = {
  documentElement: {
    hasAttribute: k => attrs.has(k),
    setAttribute: k => attrs.add(k),
    removeAttribute: k => attrs.delete(k),
  },
  createElement: () => ({}),
  head: { append() {} },
}
// 用 vm 执行产物（它引用 window/document）
const vm = await import('node:vm')
let err = null
try {
  vm.runInNewContext(code, { window: win, document: doc, Symbol, Object, Array, JSON, console })
} catch (e) { err = e }
check('产物可执行（无语法/引用错误）', err === null, String(err?.message ?? '').slice(0, 100))
check('调用了 __ModuleLoader__.load', loaded.length === 1, String(loaded.length))

const entry = loaded[0]
if (entry) {
  check('条目含 id', typeof entry.id === 'string' && entry.id.length > 0, String(entry.id))
  check('条目含 factory 函数', typeof entry.factory === 'function')

  // 调用 factory：产物形态是 factory: () => ({ inject, apply })
  let mod = null
  try { mod = entry.factory() } catch (e) { err = e }
  check('factory() 可执行', mod !== null, String(err?.message ?? '').slice(0, 100))
  if (mod) {
    check('factory 返回 inject 声明', Array.isArray(mod.inject) || typeof mod.inject === 'object', JSON.stringify(mod.inject))
    check('inject 含 slots', JSON.stringify(mod.inject ?? '').includes('slots'))
    check('factory 返回 apply 函数', typeof mod.apply === 'function')

    // 跑 apply：用一个记录型 ctx，验证注册落到预期槽位
    const regs = []
    const ctx = { slots: {
      inject: (name, cb) => cb(),
      register: (opts, comp) => { regs.push({ slot: opts.name, id: opts.id, comp }) },
    } }
    let applyErr = null
    try { mod.apply(ctx) } catch (e) { applyErr = e }
    check('apply(ctx) 可执行', applyErr === null, String(applyErr?.message ?? '').slice(0, 110))
    check('注册数 ≥ 9（8 个 settings.section + 1 个 shell.overlay）', regs.length >= 9, String(regs.length))
    check('含 shell.overlay 的抽屉遮罩', regs.some(r => r.slot === 'shell.overlay' && r.id === 'dsh-drawer-mask'))
    check('含 settings.section 的既有入口', regs.filter(r => r.slot === 'settings.section').length >= 8)
    // 顺序（见 mask-takeover 的顺序加固说明）：shell.overlay 必须写在**基础
    // settings.section 之后**。这样它若在 reconcile 时同步抛错，设置页入口已注册完。
    // ⚠️ 不能断言「运行时的最后一条」：inject 是「订阅 + reconcile」，
    //    执行时机取决于各槽**何时被声明**，且 phone-qq 变体会在其后再追加注册。
    //    故按**源码书写位置**判定。
    const iShell = code.indexOf("inject('shell.overlay'")
    const iThirdSet = code.indexOf("inject('settings.section'", code.indexOf("inject('settings.section'", code.indexOf("inject('settings.section'") + 1) + 1)
    check('shell.overlay 写在基础 settings.section 之后（顺序加固）',
      iShell > 0 && iThirdSet > 0 && iShell > iThirdSet, `shell@${iShell} thirdSettings@${iThirdSet}`)
    // 每条注册都必须带 id（list 槽契约：缺 id 会 throw）
    const noId = regs.filter(r => r.slot !== 'conversation.header.leading' && (r.id === undefined || r.id === null))
    check('所有注册都带 id（list 槽契约）', noId.length === 0, JSON.stringify(noId.map(r => r.slot)))

  console.log('factory 签名：必须接收 require（否则 react 类组件拿不到 React）')
{
  // 实测对照上游得出：上游插件的 factory 是 `(require) => {…}`，模块系统会传入它
  // （如 dsh-client-ui-shortcuts 的产物体内大量 require("react")）。
  // 而生成器原先产出 `() => {…}` —— 不接收该参数 ⇒ 任何需要 react 的组件都拿不到
  // React。当前 DrawerMask 手工构造 element 掩盖了这个问题，一旦按配方用
  // require('react') 就会在设备上抛错。
  check('factory 接收 require 参数', entry.factory.length >= 1,
    'length=' + entry.factory.length + '（0 = 不接收，react 不可用）')
  // 传入一个记录型 require，确认 factory 不再因缺少该参数而抛错
  const asked = []
  let ferr = null
  try { entry.factory(spec => { asked.push(spec); throw new Error('未提供: ' + spec) }) }
  catch (e) { ferr = e }
  check('传入 require 后 factory 仍可执行（不因缺参抛错）',
    ferr === null || !/is not a function|require is not defined/.test(String(ferr?.message)),
    String(ferr?.message ?? '').slice(0, 90))
}

console.log('真实 host 接受：产物注册喂给上游 SlotCore（有引擎树时）')
  {
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { resolveEngineTree } = await import('./paths.mjs')
    const tree = resolveEngineTree()
    const slotsLib = tree ? join(tree, 'node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js') : null
    if (!slotsLib || !existsSync(slotsLib)) {
      console.log('  （跳过：本环境无引擎树，CI 属预期）')
    } else {
      const { createRequire } = await import('node:module')
      const req = createRequire(import.meta.url)
      const { SlotCore } = req(slotsLib)
      const core = new SlotCore()
      // 按上游 layout 的声明形态建槽（实测：'shell.overlay': { kind: 'list', scope: 'root' }）
      for (const k of ['shell.overlay', 'settings.section']) {
        const r = core.record(k); r.spec = { kind: 'list', scope: 'root' }
      }
      const errs = []
      if (mod) {
        mod.apply({ slots: {
          inject: (name, cb) => cb(),
          register: (opts, comp) => { try { core.register(opts, comp) } catch (e) { errs.push(String(opts?.id) + ': ' + e.message.slice(0, 60)) } },
        } })
      }
      check('全部注册被真实 SlotCore 接受（0 拒绝）', errs.length === 0, errs.join(' | '))
      check('shell.overlay 有 1 条（抽屉遮罩）', core.entriesOfSlot('shell.overlay').length === 1,
        String(core.entriesOfSlot('shell.overlay').length))
      check('settings.section 有 ≥8 条（既有入口未丢）', core.entriesOfSlot('settings.section').length >= 8,
        String(core.entriesOfSlot('settings.section').length))
    }
  }
  }
}


console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
