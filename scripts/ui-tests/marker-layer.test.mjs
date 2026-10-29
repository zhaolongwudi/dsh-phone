// 形态标记层行为验证：加载**真实交付产物** dsh-phone.js，在最小 DOM 垫片上断言
// 5 个 data-dsh-* 事实的发布、翻转与清理。
//
// 为什么用垫片而不是只 grep 源码：标记层的全部价值在「什么时候打、什么时候撤」，
// 字符串在场证明不了判据正确（例如把 data-shell-overlay 内的模态误判成页面模态）。
//
// 运行：node tests/marker-layer.test.mjs（或仓库内 scripts/ui-tests/marker-layer.test.mjs）
import { readFileSync } from 'node:fs'
import { resolvePhoneJs, resolveAssets } from './paths.mjs'

// ---------- 最小 DOM 垫片（只实现 dsh-phone.js 实际用到的面） ----------
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.children = []
    this.parentElement = null; this.style = new Style(); this.dataset = {}
    this._classes = new Set()
    this.classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !this._classes.has(c) : !!on; v ? this._classes.add(c) : this._classes.delete(c); return v },
      contains: c => this._classes.has(c),
    }
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get className() { return [...this._classes].join(' ') }
  setAttribute(k, v) { this.attrs.set(k, v === undefined ? '' : String(v)); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v) }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null }
  hasAttribute(k) { return this.attrs.has(k) }
  removeAttribute(k) { this.attrs.delete(k) }
  toggleAttribute(k, on) { const v = on === undefined ? !this.attrs.has(k) : !!on; v ? this.setAttribute(k, '') : this.removeAttribute(k); return v }
  append(...n) { for (const x of n) { x.parentElement = this; this.children.push(x) } }
  insertBefore(n) { this.append(n) }
  replaceChildren() { this.children = [] }
  addEventListener() {} removeEventListener() {}
  get id() { return this.getAttribute('id') ?? '' } set id(v) { this.setAttribute('id', v) }
  get hidden() { return this.hasAttribute('hidden') } set hidden(v) { v ? this.setAttribute('hidden', '') : this.removeAttribute('hidden') }
  get inert() { return this.hasAttribute('inert') } set inert(v) { v ? this.setAttribute('inert', '') : this.removeAttribute('inert') }
  // 选择器：只支持本文件用到的形态，够用即止
  matches(sel) { return matchesSel(this, sel) }
  closest(sel) { let n = this; while (n) { if (matchesSel(n, sel)) return n; n = n.parentElement } return null }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
  querySelectorAll(sel) {
    const parts = sel.split(',').map(s => s.trim())
    const out = []
    const walk = n => { for (const c of n.children) { if (parts.some(p => matchesSel(c, p))) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 } }
}
class Style { constructor() { this.m = new Map() } setProperty(k, v) { this.m.set(k, v) } getPropertyValue(k) { return this.m.get(k) ?? '' } removeProperty(k) { this.m.delete(k) } }

/** 支持：tag、.class、[attr]、[attr="v"]、:scope > child，以及它们的空格组合（只取末段）。 */
function matchesSel(el, sel) {
  let s = sel.trim()
  if (s.includes(' ')) s = s.split(/\s+/).pop()          // 后代组合只判末段
  if (s.startsWith(':scope > ')) s = s.slice(9).trim()
  const tokens = s.match(/(^[a-zA-Z]+)|(\.[\w-]+)|(\[[^\]]+\])/g) ?? []
  for (const t of tokens) {
    if (t.startsWith('.')) { if (!el._classes.has(t.slice(1))) return false }
    else if (t.startsWith('[')) {
      const m = t.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/)
      if (!m) return false
      if (m[2] === undefined) { if (!el.hasAttribute(m[1])) return false }
      else if (el.getAttribute(m[1]) !== m[2]) return false
    } else if (el.tagName !== t.toUpperCase()) return false
  }
  return true
}

// ---------- 搭出被测场景 ----------
const html = new El('html')
const body = new El('body')
html.append(body)

// 框架：右栏带 data-rightbar-col，框架根是它的父元素
const frame = new El('div'); frame.className = 'pI_x6G_frame'
const sidebarCol = new El('div'); sidebarCol.className = 'pI_x6G_sidebarCol'
const rightbarCol = new El('div'); rightbarCol.setAttribute('data-rightbar-col', '')
const overlayLayer = new El('div'); overlayLayer.setAttribute('data-shell-overlay', '')
// 壳内浮层里的对话框：**不是**页面模态，不得触发 modal-open
const innerDialog = new El('div'); innerDialog.setAttribute('role', 'dialog'); innerDialog.setAttribute('aria-modal', 'true')
overlayLayer.append(innerDialog)
frame.append(sidebarCol, rightbarCol, overlayLayer)
body.append(frame)

// 设置面板：带 data-shortcut-modal + nav
const settingsPanel = new El('div'); settingsPanel.setAttribute('role', 'dialog'); settingsPanel.setAttribute('aria-modal', 'true')
settingsPanel.setAttribute('data-shortcut-modal', 'settings')
const nav = new El('nav'); settingsPanel.append(nav)
const settingsHost = new El('div')   // 模拟 portal 挂在 body（documentElement 之下）

// ---------- 装载真实产物 ----------
const src = readFileSync(resolvePhoneJs(), 'utf8')
const ASSETS = resolveAssets()

let mediaMatches = true
const doc = {
  documentElement: html, body,
  querySelector: s => html.querySelector(s),
  querySelectorAll: s => html.querySelectorAll(s),
  createElement: t => new El(t),
  addEventListener() {}, removeEventListener() {},
  createRange: () => ({ selectNodeContents() {}, collapse() {} }),
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
}
const win = {
  innerWidth: 400, innerHeight: 800,
  // matches 必须是**活值**（getter）：真实 MediaQueryList.matches 随视口变化，
  // 快照式实现会让「宽窄屏切换」这一核心场景假绿。
  matchMedia: () => ({ get matches() { return mediaMatches }, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  visualViewport: null, getSelection: doc.getSelection,
}
/** 记录 MutationObserver 回调，使测试能主动触发重算（不改产品代码加测试钩子）。 */
const observers = []
class TObserver { constructor(cb) { this.cb = cb; observers.push(this) } observe() {} disconnect() {} }
const sandbox = {
  window: win, document: doc, navigator: { userAgent: 'test' },
  MutationObserver: TObserver,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: fn => fn(),
  DataTransfer: class { constructor() { this.items = { add() {} } } setData() {} getData() { return '' } },
  ClipboardEvent: class {}, KeyboardEvent: class {}, Event: class {},
  HTMLTextAreaElement: class {}, crypto: { randomUUID: () => 'x' },
  console,
}
win.window = win
Object.assign(win, { document: doc })
const vm = await import('node:vm')
vm.runInNewContext(src, sandbox, { filename: 'dsh-phone.js' })

// ---------- 断言 ----------
let pass = 0, fail = 0
const check = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)) }
/** 触发重算：产品的 MutationObserver 回调即 queue()，rAF 在垫片里同步执行。 */
const flush = () => { for (const o of observers) o.cb() }

console.log('不变量：每个发布的标记都必须有消费方（CSS 或 JS）')
{
  // 真实踩到过：一期发布了 5 个标记，其中 3 个当时没有任何 CSS 规则消费 ——
  // 也就是说标记发布了却没人用，等于白做，而且不报错。更糟的是其中一条本可
  // 修掉一个真实交互缺陷（设置面板打开时自绘菜单按钮「可见但点不动」）。
  // 故把「发布 ↔ 消费」的配对视作不变量：新增标记必须同时给出消费方。
  const PUBLISHED = ['data-dsh-mobile-form', 'data-dsh-frame', 'data-dsh-modal-open',
    'data-dsh-settings-dialog', 'data-dsh-settings-open',
    // 三期的共享状态通道：抽屉开合由它承载，槽位组件与 dsh-phone.js 都读这一份
    'data-dsh-drawer-open',
    // 侧栏实体标签（上游只给哈希类名，本层补语义事实）
    'data-dsh-rail']
  // 消费面有两个：CSS 用 [attr] 选择器锚样式，JS 用 hasAttribute/closest/querySelector
  // 读状态做逻辑判断。任一方用到即算有消费者——只查 CSS 会误判（settings-open
  // 的消费者正是 JS：抽屉是否钉住由它决定）。
  const css = readFileSync(ASSETS.css, 'utf8')
  const js = readFileSync(resolvePhoneJs(), 'utf8')
  const consumedByCss = m => css.includes('[' + m)
  const consumedByJs = m => new RegExp('(hasAttribute|closest|querySelector|matches)\\([^)]*' + m).test(js)
  const unconsumed = PUBLISHED.filter(m => !consumedByCss(m) && !consumedByJs(m))
  check('无「已发布但无人消费」的标记', unconsumed.length === 0, unconsumed.join(', '))
  check('每个标记至少被一方消费', PUBLISHED.every(m => consumedByCss(m) || consumedByJs(m)))
}

console.log('不变量：根属性 vs 元素属性必须与 CSS 选择器前缀一致')
{
  // 实测踩过同类问题：发布在 html 的标记必须用 `html[attr]` 选，发布在元素上的
  // 用 `[attr]` 选。写反了选择器照样合法、不报错，只是永不命中（静默失效）。
  const js = readFileSync(resolvePhoneJs(), 'utf8')
  const css = readFileSync(ASSETS.css, 'utf8')
  const marks = [
    ['data-dsh-mobile-form', true],   // true = 发布在 documentElement
    ['data-dsh-drawer-open', true],
    ['data-dsh-modal-open', true],
    ['data-dsh-settings-open', true],
    ['data-dsh-frame', false],        // false = 发布在元素上
    ['data-dsh-rail', false],
    ['data-dsh-settings-dialog', false],
  ]
  for (const [attr, onRoot] of marks) {
    // 根属性经 syncFlag 发布（容错版，兼容极简垫片）；元素属性经 setAttribute。
    const pub = onRoot
      ? js.includes("syncFlag(document.documentElement, '" + attr)
      : js.includes(attr) && /setAttribute\((FRAME_TAG|RAIL_TAG|SETTINGS_TAG)/.test(js)
    const usesHtml = css.includes('html[' + attr + ']')
    const usesBare = css.includes('[' + attr + ']') && !usesHtml
    check(attr + '：发布处与选择器前缀一致', pub && (onRoot ? usesHtml : usesBare),
      'root=' + onRoot + ' html=' + usesHtml + ' bare=' + usesBare)
  }
}

console.log('场景 1：窄屏 + 无模态')
check('html[data-dsh-mobile-form] 发布', html.hasAttribute('data-dsh-mobile-form'))
check('框架根打上 data-dsh-frame', frame.hasAttribute('data-dsh-frame'))
check('无设置面板时 settings-open 不发布', !html.hasAttribute('data-dsh-settings-open'))
check('壳内浮层对话框不算页面模态（modal-open 不发布）', !html.hasAttribute('data-dsh-modal-open'))

console.log('场景 1.5：侧栏实体标签必须发布（本层有 4 条规则优先用它）')
{
  // 上游只给侧栏哈希类名（.pI_x6G_sidebarCol），没有语义属性。本层补 [data-dsh-rail]，
  // 使 4 条规则（抽屉定位/可见性/遮罩层级）不再硬依赖哈希。
  check('侧栏打上 data-dsh-rail', sidebarCol.hasAttribute('data-dsh-rail'))
  check('侧栏在框架子树内', sidebarCol === frame.querySelector('[data-dsh-rail]'))
}

console.log('场景 2：设置面板打开（portal 挂在 body）')
settingsHost.append(settingsPanel); html.append(settingsHost)
flush()
check('设置面板打上 data-dsh-settings-dialog', settingsPanel.hasAttribute('data-dsh-settings-dialog'))
check('页面模态 modal-open 发布', html.hasAttribute('data-dsh-modal-open'))
check('settings-open 发布', html.hasAttribute('data-dsh-settings-open'))

console.log('场景 3：设置面板关闭')
settingsHost.children = []; settingsPanel.parentElement = null
flush()
check('data-dsh-settings-dialog 已撤', !settingsPanel.hasAttribute('data-dsh-settings-dialog'))
check('modal-open 已撤', !html.hasAttribute('data-dsh-modal-open'))
check('settings-open 已撤', !html.hasAttribute('data-dsh-settings-open'))

console.log('场景 3.5：设置面板渲染在框架覆盖层之内（实现细节变化）')
{
  // 真实边界：设置面板当前 portal 到 body，但上游可改成渲染进 [data-shell-overlay]。
  // 若「设置面板识别」被覆盖层过滤掉，data-dsh-settings-open 会**静默永不发布**
  // （无报错，只有窄屏下抽屉不被钉住）。故 settings-open 必须与覆盖层位置无关。
  // 注：modal-open 在覆盖层内按设计仍不发布（那不是盖住侧栏的页面模态）。
  settingsHost.children = []; settingsPanel.parentElement = null
  flush()
  overlayLayer.append(settingsPanel)
  flush()
  check('覆盖层内的设置面板仍发布 data-dsh-settings-dialog', settingsPanel.hasAttribute('data-dsh-settings-dialog'))
  check('覆盖层内的设置面板仍发布 settings-open', html.hasAttribute('data-dsh-settings-open'))
  check('覆盖层内的对话框不算页面模态（modal-open 仍不发布）', !html.hasAttribute('data-dsh-modal-open'))
  overlayLayer.children = overlayLayer.children.filter(c => c !== settingsPanel)
  settingsPanel.parentElement = null
  flush()
  check('移出后两项均已撤', !settingsPanel.hasAttribute('data-dsh-settings-dialog') && !html.hasAttribute('data-dsh-settings-open'))
}

console.log('场景 3.6：抽屉开合状态的唯一真源（三期共享通道）')
{
  // 三期要把遮罩/开关迁进槽位组件，而组件与 dsh-phone.js 分属不同模块、无共享
  // 作用域。故开合状态必须在 DOM 上有一条明确契约：html[data-dsh-drawer-open]。
  // 本场景断言它确实被写入、且窄屏切换时正确切换。
  check('初始未展开时不带 data-dsh-drawer-open', !html.hasAttribute('data-dsh-drawer-open'))
  // 真正触发开关：产品代码把 onclick 绑在自建按钮上（由 body.append 落到 DOM）。
  // 这里模拟用户点击「☰ 菜单」，断言状态经 DOM 事实翻转 —— 只测初始值证明不了
  // 契约可用（通道的价值在于「两个模块都能读写同一份状态」）。
  const menuBtn = body.querySelector('.dsh-phone-menu')
  check('自绘菜单按钮已在 DOM 中', menuBtn !== null)
  if (menuBtn) {
    menuBtn.onclick()
    check('点击后 html 带上 data-dsh-drawer-open', html.hasAttribute('data-dsh-drawer-open'))
    // 遮罩的点击同样应把它收起（遮罩与开关共享同一状态机）
    const maskBtn = body.querySelector('.dsh-phone-sidebar-mask')
    check('自绘遮罩已在 DOM 中', maskBtn !== null)
    if (maskBtn) {
      maskBtn.onclick()
      check('点遮罩后状态收起', !html.hasAttribute('data-dsh-drawer-open'))
    }
    // 复位，避免影响后续场景
    flush()
  }
}

console.log('场景 4：宽屏')
mediaMatches = false; flush()
check('宽屏 mobile-form 已撤', !html.hasAttribute('data-dsh-mobile-form'))
check('框架标记仍在（与宽度无关）', frame.hasAttribute('data-dsh-frame'))

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
