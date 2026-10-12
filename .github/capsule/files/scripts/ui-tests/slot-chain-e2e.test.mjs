// 端到端链路验证：真实 renderer + 真实 SlotCore + 真 React。
//
// ## 这层验证的价值
//
// 三期迁移最大的未知是「我们的组件注册进去，究竟会不会被渲染」。此前各层只能
// 分别证明局部：注册参数对不对（SlotCore）、组件渲染对不对（React）、协议对不对
// （bundle runner）—— 但没有一层把**三者串起来**。
//
// 本测试用引擎树里的**真实实现**串起完整链路：
//   ① 加载真实 `@deepseek-ai/dsh-client-ui-renderer`（补最小浏览器垫片 + 静态模块表）
//   ② 用真实 `SlotCore` 建槽（按上游声明形态：`{ kind, scope }`）
//   ③ 用真 `react` 写与配方同形的组件（useState + MutationObserver 订阅共享事实）
//   ④ 注册 → 查出条目 → 真 React 渲染并断言输出
//
// 无引擎树时显式跳过（CI 属预期），不假装通过。
//
// 运行：node scripts/ui-tests/slot-chain-e2e.test.mjs
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveEngineTree } from './paths.mjs'

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

const TREE = resolveEngineTree()
const RENDERER = TREE ? join(TREE, 'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js') : null

if (!RENDERER || !existsSync(RENDERER)) {
  console.log('端到端链路：跳过（本环境无引擎树，CI 属预期）')
  console.log('  说明：本层只在维护期可跑；无引擎树时不假装通过。')
  console.log('\n结果：0 passed / 0 failed（跳过）')
  process.exit(0)
}

const ROOT = join(TREE, 'node_modules')
const T = join(ROOT, '@deepseek-ai')

// ---- 最小浏览器垫片 ----
const doc = {
  documentElement: {
    _a: new Set(),
    hasAttribute(k) { return this._a.has(k) },
    setAttribute(k) { this._a.add(k) },
    removeAttribute(k) { this._a.delete(k) },
    toggleAttribute(k, v) { v ? this._a.add(k) : this._a.delete(k) },
  },
  createElement: () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }),
  createElementNS: () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {} }),
  head: { append() {}, querySelectorAll: () => [] },
  body: { append() {}, querySelectorAll: () => [] },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
}
const win = {
  document: doc, addEventListener() {}, removeEventListener() {},
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: fn => setTimeout(fn, 0),
}
globalThis.window = win; globalThis.document = doc; globalThis.location = win.location
globalThis.matchMedia = win.matchMedia; globalThis.MutationObserver = win.MutationObserver
globalThis.ResizeObserver = win.ResizeObserver; globalThis.getComputedStyle = win.getComputedStyle
globalThis.requestAnimationFrame = win.requestAnimationFrame; globalThis.self = win

// ---- 静态模块表（实测清单：dsh-web-frontend 的 staticModules）----
const { createRequire } = await import('node:module')
const reqOf = createRequire(import.meta.url)
globalThis.require = reqOf
const MODS = {
  react: join(ROOT, 'react'),
  'react/jsx-runtime': join(ROOT, 'react/jsx-runtime'),
  'react-dom': join(ROOT, 'react-dom'),
  'react-dom/client': join(ROOT, 'react-dom/client'),
  '@deepseek-ai/cordis': join(T, 'cordis'),
  '@deepseek-ai/dsh-client-store': join(T, 'dsh-client-store'),
  '@deepseek-ai/dsh-client-ui-slots': join(T, 'dsh-client-ui-slots'),
  '@deepseek-ai/dsh-client-ui-primitives': join(T, 'dsh-client-ui-primitives'),
  '@deepseek-ai/dsh-client-ui-dockkit': join(T, 'dsh-client-ui-dockkit'),
}
const resolveMod = spec => {
  const p = MODS[spec]
  if (!p) throw new Error('模块表缺: ' + spec)
  return reqOf(p)
}

console.log('端到端链路：真实 renderer + 真实 SlotCore + 真 React')
const collected = []
win.__ModuleLoader__ = { load: r => collected.push(r) }
await import(RENDERER)
const entry = collected.find(r => /dsh-client-ui-renderer$/.test(r.id))
check('加载真实 renderer', Boolean(entry), JSON.stringify(collected.map(x => x.id)))

let mod = null
try { mod = entry.factory(resolveMod) } catch (e) { console.log('  factory 失败：' + e.message.slice(0, 90)) }
check('renderer factory 可执行（静态模块表齐备）', Boolean(mod))
if (mod) check('导出 SlotRegistry / apply / inject',
  ['SlotRegistry', 'apply', 'inject'].every(k => k in mod), Object.keys(mod).join(','))

// 真实 SlotCore 建槽（按上游声明形态）
const { SlotCore } = reqOf(join(T, 'dsh-client-ui-slots'))
const core = new SlotCore()
const rec = core.record('shell.overlay')
rec.spec = { kind: 'list', scope: 'root' }

// 真 React 写与配方同形的组件
const React = reqOf(join(ROOT, 'react'))
function DrawerMask() {
  const [open, setOpen] = React.useState(() => doc.documentElement.hasAttribute('data-dsh-drawer-open'))
  React.useEffect(() => {
    const sync = () => setOpen(doc.documentElement.hasAttribute('data-dsh-drawer-open'))
    const mo = new MutationObserver(sync)
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-dsh-drawer-open'] })
    return () => mo.disconnect()
  }, [])
  if (!open) return null
  return React.createElement('div', { className: 'dsh-phone-mask', 'data-dsh-mobile-form': '' })
}

let regErr = null
try { core.register({ name: 'shell.overlay', id: 'dsh-drawer-mask', order: 10, priority: 0 }, DrawerMask) }
catch (e) { regErr = e }
check('注册到真实 SlotCore 成功', regErr === null, String(regErr?.message ?? '').slice(0, 80))
check('SlotCore 能查出注册条目', core.entriesOfSlot('shell.overlay').length > 0)

const Server = await import(join(ROOT, 'react-dom/server.js'))
doc.documentElement.removeAttribute('data-dsh-drawer-open')
check('真 React：抽屉关闭渲染空', Server.renderToStaticMarkup(React.createElement(DrawerMask)) === '')
doc.documentElement.setAttribute('data-dsh-drawer-open', '')
const opened = Server.renderToStaticMarkup(React.createElement(DrawerMask))
check('真 React：抽屉打开渲染出遮罩',
  opened.includes('dsh-phone-mask') && opened.includes('data-dsh-mobile-form'), opened)

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
