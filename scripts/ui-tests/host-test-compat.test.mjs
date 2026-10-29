// 上游既有测试的兼容性：本层改动不得打红**上游自己的测试**。
//
// ## 为什么必须测（实测踩过）
//
// 本层改动的是 `app/src/main/assets/dsh-phone.js`，而 build-assets.py 会把它
// **复制**成 `phone-qq/presentation.js`；上游自带 `phone-qq/presentation.test.js`
// 会在 `vm.runInNewContext` 里执行它，用的 document 垫片**极简**：
//
//   document = { documentElement: { style }, body: {...}, querySelector: () => null, ... }
//
// 本层标记层最初用 `documentElement.toggleAttribute(...)` 发布事实 —— Chrome 69+
// 的 API，本层兼容面没问题，但那个垫片**没有该方法** ⇒ 上游测试直接抛错
// （`toggleAttribute is not a function`）。这是「本层把上游测试打红」的跨包回归，
// 而且它不在本层测试套件的视野里，只能靠专门检查发现。
//
// 本测试用与上游**同样的垫片形态**跑本层产物：垫片里若缺某个 DOM 方法，
// 本层也必须能容错（事实发布失败不应影响主流程）。
//
// 运行：node scripts/ui-tests/host-test-compat.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { resolvePhoneJs } from './paths.mjs'

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

/** 复刻 phone-qq/presentation.test.js 的垫片（故意极简，缺 toggleAttribute 等）。 */
function minimalShim() {
  const values = new Map(), events = new Map()
  const style = { setProperty: (k, v) => values.set(k, v), removeProperty: k => values.delete(k) }
  const media = { matches: true, addEventListener() {} }
  const viewport = { height: 800, scale: 1, addEventListener: (n, f) => events.set(n, f) }
  const window = {
    innerHeight: 800, visualViewport: viewport, matchMedia: () => media,
    addEventListener(name, fn) { if (name === 'resize') window.__probeResize = fn },
  }
  const document = {
    documentElement: { style },                 // ← 只有 style：没有 toggleAttribute/hasAttribute
    body: { classList: { toggle() {} } },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (n, f) => events.set(n, f),
  }
  // values/media/viewport 一并返回：供下面「复刻上游断言」读取具体数值行为。
  return { window, document, values, media, viewport, MutationObserver: class { observe() {} }, requestAnimationFrame: fn => fn() }
}

const src = resolvePhoneJs()

console.log('上游垫片兼容性：本层产物必须在极简 document 垫片下可执行')
check('找到本层产物', Boolean(src && existsSync(src)), String(src))
if (src) {
  const code = readFileSync(src, 'utf8')
  let err = null
  try { vm.runInNewContext(code, minimalShim()) } catch (e) { err = e }
  check('极简垫片下无抛错（上游 presentation.test.js 不会红）', err === null,
    String(err?.message ?? '').slice(0, 120))

  // 只查**垫片对象上缺失的方法**：垫片给了 document / documentElement / body / window，
  // 但 documentElement **只有 style**。故凡 `document.documentElement.X(` 形态而 X 不在
  // 垫片里，就会一调即抛（实测 toggleAttribute 就是这种）。
  // 元素方法（closest/matches）不在此列 —— 垫片里没有那些元素，调用点都在条件分支后。
  // 静态列举会误报：documentElement.hasAttribute 等出现在**运行时路径**
  // （adapt/show 内），而垫片只用于初始化那一跑。故改为**实测**：跑一遍（上面已测），
  // 再触发一次 resize 让 adapt 重跑，确认运行时路径同样安全。
  let resizeErr = null
  try {
    const shim = minimalShim()
    vm.runInNewContext(code, shim)
    // 触发 resize（adapt 会重跑标记层 + 抽屉逻辑）
    const handler = shim.window.__probeResize
    if (typeof handler === 'function') handler()
  } catch (e) { resizeErr = e }
  check('触发 resize / 运行时路径不抛错', resizeErr === null, String(resizeErr?.message ?? '').slice(0, 110))
}

console.log('复刻上游三条断言（不只「不抛错」，行为也要对）')
{
  // 上游 phone-qq/presentation.test.js 断言的是**具体数值行为**，不是「能跑」。
  // 只测「不抛错」会漏掉「能跑但算错了」——那同样会让上游 CI 变红。
  const page = () => {
    const shim = minimalShim()
    vm.runInNewContext(readFileSync(src, 'utf8'), shim)
    return { ...shim, update: () => shim.window.__probeResize?.() }
  }
  {
    const p = page()
    p.viewport.height = 365; p.update()
    check('键盘弹起 → 高度 365px', p.values.get('--dsh-phone-viewport-height') === '365px',
      String(p.values.get('--dsh-phone-viewport-height')))
    p.viewport.height = 800; p.update()
    check('键盘收起 → 恢复 800px', p.values.get('--dsh-phone-viewport-height') === '800px')
  }
  {
    const p = page()
    p.window.innerHeight = 350; p.viewport.height = 350; p.update()
    check('原生缩放不重复扣减', p.values.get('--dsh-phone-viewport-height') === '350px')
  }
  {
    const p = page()
    p.viewport.scale = 2; p.viewport.height = 400; p.update()
    check('捏合缩放不塌陷框架', p.values.get('--dsh-phone-viewport-height') === '800px')
    p.media.matches = false; p.update()
    check('桌面布局撤掉该变量', p.values.has('--dsh-phone-viewport-height') === false)
  }
}

console.log('自证：坏产物必须被检出')
{
  let err = null
  try { vm.runInNewContext('document.documentElement.toggleAttribute("x", true)', minimalShim()) }
  catch (e) { err = e }
  check('直接调 toggleAttribute 会被判为抛错（判据有效）', err !== null)
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
