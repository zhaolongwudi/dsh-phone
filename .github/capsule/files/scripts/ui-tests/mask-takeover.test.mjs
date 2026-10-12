// 三期首个真实迁移的行为测试：抽屉遮罩的「挂载即接管 + 失败降级」。
//
// ## 为什么这两件事必须同时验证
//
// 这是本方案第一个**落地到槽位**的控件。它的安全性完全建立在「两种结果都安全」上：
//   · 槽位组件没渲染（通道不可用）⇒ 本地实现照常工作（零回归）
//   · 槽位组件渲染成功          ⇒ 本地实现让位（无重叠）
// 只验其中一种，就等于放另一半裸奔。故测试对**两个分支**都建场景。
//
// 状态契约：html[data-dsh-drawer-open]（一期发布，dsh-phone.js 写）
// 接管事实：html[data-dsh-mask-mounted]（组件挂载时发布）
//
// 运行：node scripts/ui-tests/mask-takeover.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePhoneJs, resolveAssets, resolvePlugin } from './paths.mjs'

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

const js = readFileSync(resolvePhoneJs(), 'utf8')
const { css } = resolveAssets()
const cssText = readFileSync(css, 'utf8')

console.log('接管机制：JS 侧必须读事实并让位')
check('读取接管事实 data-dsh-mask-mounted', js.includes("hasAttribute('data-dsh-mask-mounted')"))
check('有让位变量 maskTakenOver', /maskTakenOver/.test(js))
check('本地遮罩按接管状态隐藏', /localMask\.hidden\s*=\s*maskTakenOver/.test(js))
check('新建遮罩时也遵循接管状态', /if \(maskTakenOver\) mask\.hidden = true/.test(js))

console.log('收口规则：CSS 必须能压过原显示规则（否则两遮罩重叠）')
{
  // 原显示规则的形态
  const showRe = /html\[data-dsh-drawer-open\]\s+\.dsh-phone-sidebar-mask\s*\{[^}]*display:block/
  const hideRe = /html\[data-dsh-mask-mounted\]\s+\.dsh-phone-sidebar-mask\s*\{[^}]*display:none!important/
  check('存在原「打开时显示」规则', showRe.test(cssText))
  check('存在接管后「强制隐藏」规则', hideRe.test(cssText))
  // 关键：隐藏规则必须带 !important —— 仅靠 hidden 属性会被 (0,2,1) 的原规则覆盖
  check('隐藏规则带 !important（否则被原规则覆盖）', /data-dsh-mask-mounted\][^{]*\{[^}]*!important/.test(cssText))
}

console.log('组件遮罩样式：必须存在，且与本地遮罩同规格（否则接管后外观漂移）')
{
  // 实测踩过：组件用 className 'dsh-phone-mask'，但本层 CSS 里**没有**这条类 ——
  // 于是接管后渲染出一个无定位的裸 div（比原状更糟）。
  const compRe = /\.dsh-phone-mask\{([^}]*)\}/
  const comp = cssText.match(compRe)
  check('存在 .dsh-phone-mask 样式', Boolean(comp), '缺失 ⇒ 接管后是布局错乱的裸 div')
  if (comp) {
    // 与本地遮罩那条（去掉 display:block 开关）逐项对齐
    let local = null
    for (const m of cssText.matchAll(/html\[data-dsh-drawer-open\]\s+\.dsh-phone-sidebar-mask\{([^}]*)\}/g)) {
      if (/display:block/.test(m[1])) local = m[1]
    }
    // 剔除 display：它是显隐开关，两边机制不同（组件靠 CSS 事实驱动、本地靠原规则），
    // 不属于「视觉规格」。其余项（定位/层级/尺寸/颜色）必须逐项一致。
    const norm = s => (s || '').split(';').map(x => x.trim()).filter(Boolean)
      .filter(x => !/^display\s*:/.test(x)).sort().join(';')
    check('与本地遮罩规格逐项一致（无外观漂移）', Boolean(local) && norm(comp[1]) === norm(local),
      '组件=' + norm(comp[1]) + ' | 本地=' + norm(local))
    check('组件遮罩为 fixed 定位（否则不覆盖视口）', /position:fixed/.test(comp[1]))
    check('组件遮罩有 z-index', /z-index:\s*\d+/.test(comp[1]))
  }
}

console.log('显隐由 CSS 承担（不依赖 React 重渲染）')
{
  // layout 用 useMemo(..., [renderSlot]) 渲染本槽，DOM 属性变化不会触发重算。
  // 故组件始终渲染，显隐必须由 CSS 按同一事实驱动。
  check('组件遮罩默认隐藏', /\.dsh-phone-mask\{[^}]*display:none/.test(cssText))
  check('抽屉打开时显示组件遮罩', /html\[data-dsh-drawer-open\]\s+\.dsh-phone-mask\{[^}]*display:block/.test(cssText))
}

console.log('降级路径：事实缺失时必须保留本地实现')
check('本地遮罩仍会被创建（未接管时）', /createElement\('button'\);\s*mask\.className = 'dsh-phone-sidebar-mask'/.test(js)
  || js.includes("mask.className = 'dsh-phone-sidebar-mask'"))
check('本地遮罩点击仍收起抽屉', /mask\.onclick\s*=\s*\(\)\s*=>\s*show\(false\)/.test(js))
check('本地菜单按钮仍存在', js.includes("menu.className = 'dsh-phone-menu'"))

console.log('状态契约：两个实现共用同一事实（无双状态源）')
{
  // JS 写 drawer-open
  check('JS 写入 data-dsh-drawer-open', /syncFlag\(document\.documentElement, 'data-dsh-drawer-open'/.test(js))
  // 组件读/清同一事实。核查**三层**：生成器输入（源）与两个生成产物 ——
  // 源改了但产物没重新生成，是这条链上最容易出现的「改了不生效」。
  const srcPath = resolvePlugin('source')
  let src = null
  try { if (srcPath) src = readFileSync(srcPath, 'utf8') } catch {}
  if (src) {
    // 组件**不读**该属性决定渲染（读了就会踩「DOM 变化不触发重渲染」的坑，实测推出）。
    check('组件不按属性条件渲染（防回归）', !/hasAttribute\('data-dsh-drawer-open'\)\)\s*return null/.test(src))
    check('组件经 ref 回调在真正挂载时发布事实',
      /ref:\s*publishMaskMounted/.test(src) && src.includes("setAttribute('data-dsh-mask-mounted'"))
    // 引用稳定：内联箭头每次渲染都是新引用 ⇒ React 会 detach/attach 抖动，
    // 一旦顺序反转就会误删事实（本地遮罩意外复活）。
    check('ref 是模块级常量（引用稳定，无抖动）', /function publishMaskMounted/.test(src))
    check('卸载时收回事实（让回本地实现）', src.includes("removeAttribute('data-dsh-mask-mounted'"))
    check('槽位组件点击时清同一事实', src.includes("removeAttribute('data-dsh-drawer-open')"))
    check('槽位组件发布接管事实', src.includes("setAttribute('data-dsh-mask-mounted'"))
    check('组件注册到 shell.overlay', src.includes("inject('shell.overlay'"))
    check('组件 id 唯一（dsh-drawer-mask）', src.includes("id: 'dsh-drawer-mask'"))
  } else {
    console.log('  （跳过组件侧核查：本布局下未找到 client-source.js）')
  }

  // 产物必须同步：源改了而产物没重新生成 ⇒ 设备上跑的还是旧代码（静默失效）。
  for (const [key, label] of [['qqBundle', 'phone-qq/cards-client.js'], ['peerBundle', 'peer/agent-cards/client.js']]) {
    const p = resolvePlugin(key)
    if (!p) { console.log('  （跳过 ' + label + '：本布局下未找到）'); continue }
    const b = readFileSync(p, 'utf8')
    check(label + ' 含注册（已重新生成）', b.includes('dsh-drawer-mask'),
      '需跑 node scripts/build-agent-cards-client.mjs 重新生成')
    check(label + ' 含接管事实发布', b.includes('dsh-mask-mounted'))
  }
}

console.log('状态同步：组件写事实后 adapt 必须重跑（否则 a11y 状态错位）')
{
  // 实测分析得出：三期之后**槽位组件**也会写 data-dsh-drawer-open（点遮罩关闭）。
  // 若 MutationObserver 的 attributeFilter 不含它，adapt() 不重跑 ⇒
  // rail.inert / aria-hidden / menu[aria-expanded] 与视觉状态错位。
  const m = js.match(/attributeFilter:\s*\[([^\]]*)\]/)
  check('attributeFilter 含 data-dsh-drawer-open',
    Boolean(m) && m[1].includes('data-dsh-drawer-open'), m ? m[1] : '未找到 filter')
  // 同时确认不会造成观察循环：adapt 主流程不得调用 show(（show 会写该属性）。
  const L = js.split('\n')
  let adaptStart = -1, adaptEnd = -1, depth = 0
  for (let i = 0; i < L.length; i++) {
    if (/const adapt = \(\) => \{|function adapt\(/.test(L[i])) { adaptStart = i; depth = 0 }
    if (adaptStart >= 0) {
      depth += (L[i].match(/\{/g) || []).length - (L[i].match(/\}/g) || []).length
      if (depth === 0 && i > adaptStart) { adaptEnd = i; break }
    }
  }
  let loop = false
  for (let i = adaptStart; i <= adaptEnd; i++) {
    const l = L[i] || ''
    if (/\bshow\s*\(/.test(l) && !/const show =/.test(l) && !/(onclick|addEventListener|=>)/.test(l)) loop = true
  }
  check('adapt 主流程不调用 show(（无观察循环）', !loop)
}

console.log('符号契约：手写 element 的 $typeof 必须是双美元符')
{
  // 实测踩过：DrawerMask 里写成 $typeof（单美元符）。React 靠该符号识别 element，
  // 写错则整个对象被当成普通 child ⇒ 报 "Objects are not valid as a React child"，
  // 组件**完全渲染不出来**；而当时所有静态断言（class/属性/ref）都是绿的。
  const srcPath = resolvePlugin('source')
  if (srcPath) {
    const s = readFileSync(srcPath, 'utf8')
    const single = s.split('\n').filter(l => /[^$]\$typeof/.test(l))
    check('无单美元符的 $typeof 写法（否则 React 不认该 element）', single.length === 0,
      single.map(x => x.trim().slice(0, 60)).join(' | '))
    const doubles = (s.match(/\$\$typeof/g) || []).length
    check('$$typeof 出现次数 ≥ 组件数（写作规范）', doubles >= 3, String(doubles))
  }
  // 产物同样要核（源对了而产物是旧的，设备上仍是坏的）
  for (const [key, label] of [['qqBundle', 'phone-qq/cards-client.js'], ['peerBundle', 'peer/agent-cards/client.js']]) {
    const p = resolvePlugin(key)
    if (!p) continue
    const b = readFileSync(p, 'utf8')
    const single = b.split('\n').filter(l => /[^$]\$typeof/.test(l))
    check(label + ' 无单美元符的 $typeof', single.length === 0, single.map(x => x.trim().slice(0, 50)).join(' | '))
  }
}

console.log('真实 React 渲染组件（手写 element 形状是否被接受）')
{
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const { resolveEngineTree } = await import('./paths.mjs')
  const tree = resolveEngineTree()
  const reactPath = tree ? join(tree, 'node_modules/react') : null
  if (!reactPath || !existsSync(reactPath)) {
    console.log('  （跳过：本环境无引擎树，CI 属预期）')
  } else {
    const vm = await import('node:vm')
    const React = req(reactPath)
    const Server = req(join(tree, 'node_modules/react-dom/server'))
    const attrs = new Set()
    const doc = {
      documentElement: { hasAttribute: k => attrs.has(k), setAttribute: k => attrs.add(k), removeAttribute: k => attrs.delete(k) },
      createElement: () => ({}), head: { append() {} },
    }
    const regs = []
    const sandbox = { document: doc, Symbol, Object, Array, JSON, Error, console }
    const srcPath = resolvePlugin('source')
    if (!srcPath) { console.log('  （跳过：未找到 client-source.js）') }
    const pluginSrc = srcPath ? readFileSync(srcPath, 'utf8') : ''
    vm.runInNewContext(pluginSrc + ';globalThis.__apply = apply;', sandbox, { filename: 'client-source.js' })
    sandbox.__apply({ slots: { inject: (n, cb) => cb(), register: (o, c) => regs.push({ o, c }) } })
    const mask = regs.find(r => r.o.id === 'dsh-drawer-mask')
    check('取到 DrawerMask 组件', Boolean(mask))
    if (mask) {
      let html = null, err = null
      try { html = Server.renderToStaticMarkup(React.createElement(mask.c)) } catch (e) { err = e }
      check('真实 React 接受手写 element 形状', err === null, String(err?.message ?? '').slice(0, 90))
      check('渲染出 .dsh-phone-mask', String(html).includes('dsh-phone-mask'), String(html).slice(0, 90))
      check('渲染出 data-dsh-mobile-form', String(html).includes('data-dsh-mobile-form'))
      const el = mask.c()
      check('element 带 ref 回调（挂载时机发布事实）', typeof el.ref === 'function')
      el.ref({ nodeType: 1 })
      check('ref(node) 发布接管事实', attrs.has('data-dsh-mask-mounted'))
      el.ref(null)
      check('ref(null) 收回接管事实', !attrs.has('data-dsh-mask-mounted'))
    }
  }
}

console.log('顺序加固：无先例的槽必须放在最后注册')
{
  // 源码依据：renderer 的 slots.inject(key, cb) 在 reconcile() 抛错时**同步重抛**
  //   try { reconcile() } catch (error) { stop(); throw error }
  // ⇒ 若把 shell.overlay（本层唯一无先例的槽）放在前面，一旦它失败，
  //   后面 8 个 settings.section 注册全都不会执行 —— 一个失败拖垮所有兄弟。
  const srcPath = resolvePlugin('source')
  if (srcPath) {
    const s = readFileSync(srcPath, 'utf8')
    const iShell = s.indexOf("inject('shell.overlay'")
    const iSet = s.indexOf("inject('settings.section'")
    check('shell.overlay 注入在 settings.section 之后',
      iShell > 0 && iSet > 0 && iShell > iSet, `shell@${iShell} settings@${iSet}`)
    check('源码里说明了顺序意图（防后人误改回）', /顺序意图/.test(s) || /放在\*\*最后\*\*/.test(s))
  }
  // 产物同样要保持该顺序 —— 源对了而产物是旧的，设备上仍是旧顺序。
  for (const [key, label] of [['qqBundle', 'phone-qq/cards-client.js'], ['peerBundle', 'peer/agent-cards/client.js']]) {
    const p = resolvePlugin(key)
    if (!p) continue
    const b = readFileSync(p, 'utf8')
    const iS = b.indexOf("inject('shell.overlay'")
    const iT = b.indexOf("inject('settings.section'")
    check(label + ' 保持顺序（shell 在后）', iS > 0 && iT > 0 && iS > iT, `shell@${iS} settings@${iT}`)
  }
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
