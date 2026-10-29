// 客户端 bundle 装载器（壳侧真实协议的测试替身）。
//
// 单独成模块的原因：`slot-register-runtime.test.mjs` 与 `recipe-executable.test.mjs`
// 都要用它，而从前者导入会**执行整个测试文件**（顶层跑断言并 process.exit），
// 后者就永远跑不到自己的逻辑。抽出后两边共用同一实现。
//
// 协议（实测自 phone-qq/cards-client.js 产物形态）：
//   window.__ModuleLoader__.load({ id, factory })；factory(require) 返回 { inject, apply }。
import vm from 'node:vm'

/**
 * 按壳侧真实协议执行一份 client bundle，收集注册行为。
 *
 * 协议（实测自 phone-qq/cards-client.js 的产物形态）：
 *   window.__ModuleLoader__.load({ id, factory })；factory() 返回 { inject, apply }。
 * 壳侧拿到 inject 后等这些服务就绪，再调 apply(ctx)。
 *
 * @param source bundle 全文
 * @param injects 可选注入（{ require, document, MutationObserver }），供配方测试提供
 *    react 垫片与 DOM 事实；不传时用最小默认实现
 * @returns {{id:string, inject:string[], registrations:Array, errors:string[]}}
 */
export function runBundle(source, injects = {}) {
  const registrations = []
  const errors = []
  let loaded = null

  const ctx = {
    slots: {
      // 上游 inject(name, cb)：等该槽就绪后执行 cb。记录型实现立即执行。
      inject(name, cb) {
        try { cb() } catch (e) { errors.push('inject(' + name + ') 抛错: ' + e.message) }
      },
      // 上游 register(options, component)：登记到指定槽。
      register(options, component) {
        registrations.push({
          name: options?.name ?? null,
          id: options?.id ?? null,
          order: options?.order ?? null,
          label: options?.label ?? null,
          hasComponent: typeof component === 'function',
          // 组件本体：供配方「渲染行为」断言直接实例化（不必重跑配方体——
          // 那会因缺 ctx 报 ReferenceError）。
          component: typeof component === 'function' ? component : null,
        })
        return () => {}
      },
    },
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          if (!entry || typeof entry.factory !== 'function') {
            errors.push('load() 收到的条目缺 factory')
            return
          }
          // factory 在真实协议里收到 require（解析静态模块表）；此处透传注入的实现，
          // 未注入时给一个「一律拒绝」的替身 —— 静默返回 undefined 会让配方里的
          // require('react') 拿到空值，反而掩盖错误。
          const req = injects.require ?? ((spec) => { throw new Error('未注入模块表，无法解析: ' + spec) })
          loaded = { id: entry.id, ...entry.factory(req) }
        },
      },
    },
    document: injects.document ?? {
      createElement: () => ({ set src(_v) {}, set textContent(_v) {} }),
      head: { append() {} },
      querySelectorAll: () => [],
    },
    MutationObserver: injects.MutationObserver ?? class { observe() {} disconnect() {} },
    Symbol, Object, Array, JSON, console, String, Number, Boolean, Error, TypeError,
  }
  sandbox.window.document = sandbox.document
  sandbox.globalThis = sandbox

  try {
    vm.runInNewContext(source, sandbox, { filename: 'client-bundle.js' })
  } catch (e) {
    errors.push('执行抛错: ' + e.message)
    return { id: null, inject: [], registrations, errors }
  }

  if (!loaded) return { id: null, inject: [], registrations, errors: errors.concat('未调用 __ModuleLoader__.load') }
  const inject = Array.isArray(loaded.inject) ? loaded.inject : []
  if (typeof loaded.apply !== 'function') {
    errors.push('factory 未返回 apply 函数')
    return { id: loaded.id ?? null, inject, registrations, errors }
  }
  try { loaded.apply(ctx) } catch (e) { errors.push('apply() 抛错: ' + e.message) }

  return { id: loaded.id ?? null, inject, registrations, errors }
}

