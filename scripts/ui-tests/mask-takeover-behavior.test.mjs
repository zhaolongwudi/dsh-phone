// 接管行为（不只看代码形态）：接管事实在场 / 不在场时，本地遮罩的去留。
//
// 与 mask-takeover.test.mjs 的分工：那是**静态断言**（源码里该有什么）；
// 本测试**真的执行 dsh-phone.js**，检查它创建/隐藏了哪个元素 ——
// 「代码里有 localMask.hidden = maskTakenOver」不等于「运行时真的隐藏了」。
//
// 运行：node scripts/ui-tests/mask-takeover-behavior.test.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { resolvePhoneJs } from './paths.mjs'

const phoneJs = resolvePhoneJs()
if (!phoneJs) {
  console.log('接管行为：跳过（本布局下未找到 dsh-phone.js）')
  console.log('\n结果：0 passed / 0 failed（跳过）')
  process.exit(0)
}
const src = readFileSync(phoneJs, 'utf8')

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

/** 造一个够用的 DOM 垫片：让 querySelector 能返回 frame/rail/mask/menu。 */
function makeDom({ maskMounted }) {
  const htmlAttrs = new Set()
  if (maskMounted) htmlAttrs.add('data-dsh-mask-mounted')
  const created = {}
  class El {
    constructor(cls = '') {
      this.className = cls; this.dataset = {}; this.hidden = false
      this._attrs = new Map(); this.children = []
      this.style = { setProperty() {}, removeProperty() {} }
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }
    }
    setAttribute(k, v) { this._attrs.set(k, v) }
    getAttribute(k) { return this._attrs.get(k) ?? null }
    hasAttribute(k) { return this._attrs.has(k) }
    removeAttribute(k) { this._attrs.delete(k) }
    toggleAttribute(k, v) { v ? this._attrs.set(k, '') : this._attrs.delete(k) }
    addEventListener() {} removeEventListener() {}
    append(...n) { this.children.push(...n) }
    querySelector(sel) {
      if (this._byClass) return this._byClass(sel)
      return queryMap[sel] ?? null
    }
    querySelectorAll() { return [] }
    closest() { return null }
    matches() { return false }
    click() {}
  }
  const frame = new El('pI_x6G_frame'); frame._attrs.set('data-dsh-frame', '')
  const rail = new El('pI_x6G_sidebarCol'); rail._attrs.set('data-dsh-rail', '')
  frame.querySelector = sel => (String(sel).includes('rail') || String(sel).includes('sidebarCol')) ? rail : null
  const queryMap = { '[data-dsh-frame], .pI_x6G_frame': frame }
  const doc = {
    _all: [],
    documentElement: {
      style: { setProperty() {}, removeProperty() {} },
      hasAttribute: k => htmlAttrs.has(k),
      setAttribute: k => htmlAttrs.add(k),
      removeAttribute: k => htmlAttrs.delete(k),
      toggleAttribute(k, v) { v ? htmlAttrs.add(k) : htmlAttrs.delete(k) },
    },
    body: new El('body'),
    createElement: tag => {
      const e = new El(); created[tag] = (created[tag] || 0) + 1
      doc._all.push(e)
      return e
    },
    querySelector(sel) {
      if (queryMap[sel]) return queryMap[sel]
      // 按 class 选择器在已创建元素里查（够本测试用）
      const cls = String(sel).replace(/^\./, '')
      return doc._all.find(e => String(e.className).split(/\s+/).includes(cls)) ?? null
    },
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    head: { append() {} },
  }
  return { doc, created, frame, rail, getMask: () => doc.querySelector('.dsh-phone-sidebar-mask') }
}

function run({ maskMounted }) {
  const { doc, getMask, created } = makeDom({ maskMounted })
  const values = new Map()
  doc.documentElement.style.setProperty = (k, v) => values.set(k, v)
  const media = { matches: true, addEventListener() {} }
  const window = { innerHeight: 800, visualViewport: { height: 800, scale: 1, addEventListener() {} },
    matchMedia: () => media, addEventListener() {} }
  const events = new Map()
  doc.addEventListener = (n, f) => events.set(n, f)
  window.addEventListener = (n, f) => events.set(n, f)
  // 第一次 adapt 会创建本地遮罩
  vm.runInNewContext(src, { window, document: doc, MutationObserver: class { observe() {} }, requestAnimationFrame: f => f() })
  return { doc, created, getMask, events }
}

console.log('接管行为：事实在场 vs 不在场，本地遮罩的去留')

// 分支 1：未接管（组件没渲染）→ 本地遮罩必须保留
{
  const r = run({ maskMounted: false })
  const mask = r.getMask()
  check('未接管：本地遮罩被创建', Boolean(mask), 'createElement button 次数=' + (r.created.button ?? 0))
  check('未接管：本地遮罩未被隐藏', mask ? mask.hidden === false : false)
}

// 分支 2：已接管（组件挂载了）→ 本地遮罩必须让位
{
  const r = run({ maskMounted: true })
  const mask = r.getMask()
  check('已接管：本地遮罩仍被创建（不破坏 DOM 结构）', Boolean(mask))
  check('已接管：本地遮罩被隐藏（让位给组件）', mask ? mask.hidden === true : false,
    'hidden=' + String(mask?.hidden))
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
