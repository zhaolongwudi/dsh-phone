// 三期配方「可执行性」验证：把配方里的注册代码真正跑一遍，证明它成立。
//
// ## 为什么值得单独测
//
// 配方（ui-slot-inventory.mjs 的 MIGRATION[].recipe）是给人照着改的代码片段。
// 但「看起来对」与「跑得起来」是两回事：写错 require 的服务名、用错 ctx API、
// 组件返回非法结构 —— 这些在设备上才暴露，而那时已经改完一堆文件。
//
// 本测试用壳侧真实装载协议（window.__ModuleLoader__.load）+ 记录型 ctx.slots，
// 把配方代码**当作 source 执行**，断言：
//   1. 能按协议装载（factory 返回 { inject, apply }）；
//   2. 注册到正确的槽位、带 id/order；
//   3. 组件是函数且能被「渲染」出合法结构（用最小 React 垫片）；
//   4. 组件确实读共享状态事实（data-dsh-drawer-open 翻转时输出跟着变）。
//
// 这层验证不替代设备验收（渲染几何/遮挡只有 CDP+ADB 能证），但能挡住
// 「配方本身写错」这类低级且高代价的错误。
//
// 运行：node scripts/ui-tests/recipe-executable.test.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATION } from '../ui-slot-inventory.mjs'
import { runBundle } from './ui-bundle-runner.mjs'

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

/** 最小 React 垫片：够跑函数组件与 hooks。 */
export function makeReactStub() {
  const state = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ $$typeof: 'el', type, props: props ?? {}, children }),
    useState: (init) => {
      const i = cursor++
      if (state[i] === undefined) state[i] = typeof init === 'function' ? init() : init
      return [state[i], v => { state[i] = v }]
    },
    useEffect: (fn) => { cursor++; try { fn() } catch { /* 垫片下副作用失败不致命 */ } },
    useRef: (init) => ({ current: init }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  // reset() 必须**连 state 一起清**：它代表「重新挂载」，而真实 React 在挂载时
  // 会重算 useState 的初始值。只清游标会读到上一次的缓存值 → 假红（实测踩到）。
  return { React, reset: () => { cursor = 0; state.length = 0 } }
}

console.log('配方可执行性：逐条把 recipe.code 当源码跑')
const executable = MIGRATION.filter(m => Array.isArray(m.recipe?.code) && m.recipe.code.length > 0)
check('存在带代码的配方', executable.length > 0, String(executable.length))

for (const m of executable) {
  console.log(`\n  [${m.id}] → ${m.target}`)
  // 配方的 code 是「函数体片段」，包成完整 bundle 执行
  const body = m.recipe.code.join('\n')
  const src = [
    "window.__ModuleLoader__.load({ id: 'probe-recipe', factory: (require) => {",
    '  const React = require("react")',
    '  const h = React.createElement',
    '  const inject = ["slots"]',
    '  const apply = (ctx) => {',
    body.split('\n').map(l => '    ' + l).join('\n'),
    '  }',
    '  return { inject, apply }',
    '} })',
  ].join('\n')

  // runBundle 只注入最小沙箱；这里为配方额外提供 react 与 DOM 事实
  const q = new Map()
  const documentStub = {
    documentElement: {
      _attrs: new Set(),
      hasAttribute(a) { return this._attrs.has(a) },
      setAttribute(a) { this._attrs.add(a) },
      removeAttribute(a) { this._attrs.delete(a) },
      toggleAttribute(a, on) { on ? this._attrs.add(a) : this._attrs.delete(a) },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, append() {} }),
    head: { append() {} },
  }
  const r = runBundle(src, {
    require: (spec) => {
      if (spec === 'react') return makeReactStub().React
      throw new Error('未在模块表内: ' + spec)
    },
    document: documentStub,
    MutationObserver: class { observe() {} disconnect() {} },
  })

  check('按协议装载无错', r.errors.length === 0, r.errors.join(' | '))
  check('注册到目标槽', r.registrations.some(x => x.name === m.target), JSON.stringify(r.registrations.map(x => x.name)))
  check('注册带 id 与 order', r.registrations.every(x => x.id && x.order !== null))
  check('注册带组件工厂', r.registrations.every(x => x.hasComponent))
}

console.log('配方可用 require(react)：修好 factory 签名后的关键能力')
{
  // 实测背景：生成器原先产出 `factory: () => {…}`，不接收 require ——
  // 于是配方里 `require('react')` 会拿到 undefined。上游插件的 factory 是
  // `(require) => {…}`（对照 dsh-client-ui-shortcuts 实测）。已修生成器。
  // 本步用**真实 React** 验证：配方里的 react 组件定义能执行并渲染出元素。
  const { createRequire } = await import('node:module')
  const { resolveEngineTree } = await import('./paths.mjs')
  const vm = await import('node:vm')
  const req = createRequire(import.meta.url)
  const tree = resolveEngineTree()
  const reactPath = tree ? join(tree, 'node_modules/react') : null
  if (!reactPath || !existsSync(reactPath)) {
    console.log('  （跳过：本环境无引擎树，CI 属预期）')
  } else {
    const React = req(reactPath)
    const Server = req(join(tree, 'node_modules/react-dom/server'))
    // 取一条用 require('react') 的配方验证
    const target = MIGRATION.find(x => /require\(.react.\)/.test(x.recipe.code.join('\n')))
    check('存在使用 require(react) 的配方', Boolean(target), '（若都改为手工 element 也会通过）')
    if (target) {
      const body = target.recipe.code.join('\n')
      const cut = body.indexOf('ctx.slots.inject(')
      const defs = cut >= 0 ? body.slice(0, cut) : body
      // 动态提取组件函数名（不硬编码）：配方里形如 `function Xxx(` 的第一个名字。
      const fnName = (defs.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/) || [])[1] ?? null
      check('[' + target.id + '] 能提取组件函数名', Boolean(fnName), String(fnName))
      let comp = null, err = null
      if (fnName) {
        try {
          comp = vm.runInNewContext(
            '(function(require){\n' + defs + '\nreturn ' + fnName + ';\n})',
            { Symbol, Object, Array, JSON, console, document: { documentElement: { hasAttribute: () => false } } })(
            spec => { if (spec === 'react') return React; throw new Error('模块表缺: ' + spec) })
        } catch (e) { err = e }
      }
      check('[' + target.id + '] 配方组件定义可用 require(react) 执行',
        comp !== null && err === null, String(err?.message ?? '').slice(0, 90))
      if (comp) {
        let html = null
        try { html = Server.renderToStaticMarkup(React.createElement(comp)) } catch (e) { err = e }
        check('[' + target.id + '] 真实 React 渲染出元素', typeof html === 'string', String(err?.message ?? '').slice(0, 80))
      }
    }
  }
}

console.log('真实 SlotCore 注册：每条配方的参数必须匹配目标槽的 kind')
{
  // 比自写桩强：用上游真实 SlotCore，按其 children 声明表建好目标槽，再跑配方的
  // 注册语句。若参数与 kind 契约不符（如 list 槽缺 id），上游实现会直接 throw。
  const TREE = process.env.DSH_TREE ?? '/data/user/0/com.dshphone/files/tree'
  const SLOTS = TREE + '/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js'
  const { SLOT_KIND } = await import('../ui-slot-inventory.mjs')
  let SlotCore = null
  try { ({ SlotCore } = await import(SLOTS)) } catch { /* 无引擎树则跳过 */ }

  if (!SlotCore) {
    console.log('  （跳过：本环境无引擎树，无法载入真实 SlotCore）')
  } else {
    for (const m of MIGRATION) {
      const kind = SLOT_KIND[m.target]
      const sc = new SlotCore()
      // 按上游声明形态建槽（`"槽名": { kind, scope }`）
      const rec = sc.record(m.target)
      rec.spec = { kind: kind ?? 'single', scope: 'root' }
      // 执行**完整配方体**（组件定义 + 注册语句）：只跑注册那段的话，组件定义
      // 不在作用域里，所有引用组件的配方都会 ReferenceError（实测踩到）。
      const body = m.recipe.code.join('\n')
      let err = null
      try {
        const makeRequire = () => (spec) => {
          if (spec === 'react') return makeReactStub().React
          throw new Error('未在模块表内: ' + spec)
        }
        // eslint-disable-next-line no-new-func
        new Function('ctx', 'require', 'document', 'MutationObserver', body)(
          { slots: { inject: (name, cb) => cb(), register: (opts, comp) => sc.register(opts, comp) } },
          makeRequire(), { documentElement: { hasAttribute: () => false, removeAttribute() {} } },
          class { observe() {} disconnect() {} })
      } catch (e) { err = e }
      check(`[${m.id}] 注册参数匹配 ${kind ?? '?'} 槽契约`, err === null, String(err?.message ?? '').slice(0, 90))
    }
  }
}

console.log('真实 React 渲染（引擎树可用时）：配方组件在真 hooks 语义下必须正确')
{
  // 引擎树路径：本地/维护期可用；CI 无引擎树时整段跳过（不假装通过）。
  const TREE = process.env.DSH_TREE ?? '/data/user/0/com.dshphone/files/tree'
  const nodeModules = TREE + '/node_modules'
  let React = null, Server = null
  try {
    React = (await import(nodeModules + '/react/index.js')).default
    Server = await import(nodeModules + '/react-dom/server.js')
  } catch { /* 无引擎树 → 下面的在线分支跳过 */ }

  if (!React || !Server) {
    console.log('  （跳过：本环境无引擎树，无法载入真实 React；上方的垫片验证已覆盖基本行为）')
  } else {
    console.log('  使用引擎树里的 React ' + (React.version ?? '?') + ' 渲染')
    const mask = MIGRATION.find(m => m.id === 'drawer-mask')
    const body = mask.recipe.code.join('\n')

    // 用真实 DOM 事实 + 真 React 执行配方里的组件
    const dom = {
      documentElement: { _a: new Set(),
        hasAttribute(k) { return this._a.has(k) },
        setAttribute(k) { this._a.add(k) },
        removeAttribute(k) { this._a.delete(k) } },
    }
    const mod = { exports: {} }
    const vm2 = await import('node:vm')
    // 注意：配方 code 自带 `const React = require('react')`，不要再包一层（会重复声明）。
    // 只取组件定义部分：配方末尾的 ctx.slots.inject(...) 是注册语句，
    // 在没有 ctx 的沙箱里会 ReferenceError（注册行为已由上方的协议测试覆盖）。
    const cutAt = body.indexOf('ctx.slots.inject(')
    const defOnly = cutAt >= 0 ? body.slice(0, cutAt) : body
    vm2.runInNewContext(
      defOnly + '\nmodule.exports = (typeof DrawerMask !== "undefined") ? DrawerMask : null',
      { module: mod, exports: mod.exports,
        require: s => { if (s === 'react') return React; throw new Error(s) },
        document: dom, MutationObserver: class { observe() {} disconnect() {} }, console },
      { filename: 'recipe-real.js' })

    const Comp = mod.exports
    check('配方组件在真 React 下可导出', typeof Comp === 'function')

    dom.documentElement.removeAttribute('data-dsh-drawer-open')
    const closed = Server.renderToStaticMarkup(React.createElement(Comp))
    check('真 React：抽屉关闭渲染空字符串', closed === '', JSON.stringify(closed))

    dom.documentElement.setAttribute('data-dsh-drawer-open', '')
    const opened = Server.renderToStaticMarkup(React.createElement(Comp))
    check('真 React：抽屉打开渲染出遮罩元素',
      opened.includes('dsh-phone-mask') && opened.includes('data-dsh-mobile-form'), opened)
    check('真 React：遮罩是 div', /^<div /.test(opened), opened.slice(0, 40))
  }
}

console.log('渲染行为：drawer-mask 必须真正响应共享状态')
{
  const maskRecipe = MIGRATION.find(m => m.id === 'drawer-mask')
  check('找到 drawer-mask 配方', Boolean(maskRecipe))
  if (maskRecipe) {
    const body = maskRecipe.recipe.code.join('\n')
    const src = [
      "window.__ModuleLoader__.load({ id: 'probe-render', factory: (require) => {",
      '  const React = require("react")',
      '  const inject = ["slots"]',
      '  const apply = (ctx) => {',
      body.split('\n').map(l => '    ' + l).join('\n'),
      '  }',
      '  return { inject, apply }',
      '} })',
    ].join('\n')

    const dom = {
      documentElement: {
        _attrs: new Set(),
        hasAttribute(a) { return this._attrs.has(a) },
        setAttribute(a) { this._attrs.add(a) },
        removeAttribute(a) { this._attrs.delete(a) },
        toggleAttribute(a, on) { on ? this._attrs.add(a) : this._attrs.delete(a) },
      },
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, setAttribute() {}, append() {} }),
      head: { append() {} },
    }
    const stub = makeReactStub()
    const r = runBundle(src, {
      require: (spec) => {
        if (spec === 'react') return stub.React
        throw new Error('未在模块表内: ' + spec)
      },
      document: dom,
      MutationObserver: class { observe() {} disconnect() {} },
    })
    check('装载无错', r.errors.length === 0, r.errors.join(' | '))
    const reg = r.registrations[0]
    check('注册到 shell.overlay', reg?.name === 'shell.overlay', String(reg?.name))
    // runner 现在也记录组件本体，可直接渲染（不必重跑配方体，那会因缺 ctx 报错）
    const comp = reg?.component
    check('runner 记录了组件本体', typeof comp === 'function')
    if (typeof comp === 'function') {
      stub.reset()
      check('抽屉关闭时渲染 null（不误显遮罩）', comp() === null, JSON.stringify(comp()))
      dom.documentElement.setAttribute('data-dsh-drawer-open', '')
      stub.reset()
      const opened = comp()
      check('抽屉打开时渲染出元素', opened !== null && typeof opened === 'object')
      check('遮罩带 dsh-phone-mask 类', opened?.props?.className === 'dsh-phone-mask', String(opened?.props?.className))
      check('遮罩带 data-dsh-mobile-form 标记', opened?.props?.['data-dsh-mobile-form'] === '')
      check('遮罩带 onClick 处理器', typeof opened?.props?.onClick === 'function')
      opened?.props?.onClick?.()
      check('点击遮罩后状态事实被清除（两模块同一份状态）', !dom.documentElement.hasAttribute('data-dsh-drawer-open'))
    }
  }
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
