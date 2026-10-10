import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { ActiveRouteRegistry, activeRoutes } from '../../src/active-route.js'

/**
 * 「本次实际发往的真实目标」登记表 + 两处写入点 + RPC 端点的回归。
 *
 * ## 为什么需要它
 *
 * 路由型 provider（`aggregate` / `jet-hub-auto`）在模型选择器里只显示**虚拟**名字，
 * 用户看不到「这次到底发给了谁、哪个模型」。本功能在**转发一开始**记下真实目标，
 * 由客户端按 5 秒轮询渲染。
 *
 * ## ⚠️ 两条最容易写错的语义（都有用例钉住）
 *
 * 1. **写入时机是「转发一开始」，不是「成功之后」** —— 与同仓的
 *    `activeProviderByModel`（余额徽标用，**必须成功才写**）**判据相反**。
 *    若有人「为统一」把它改成同一提交点，用户在整个长回答期间都看不到读数
 *    （而那正是「实时」唯一有价值的时间窗）。
 * 2. **RPC 是纯内存读**：客户端 5 秒一轮，端点里绝不能出现余额探测。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * 去掉注释后的源码。
 *
 * ⚠️ 反面断言必须基于它：本仓库注释里**大量引用**被禁止/被讨论的写法
 * （例如本文件里就写出了「成功之后」这种对照说法），直接对全文断言会把注释
 * 本身判成违规 —— `usage-badge-client.spec.ts` 首次踩过这个坑。
 */
const codeOf = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

describe('active-route：登记表语义', () => {
  it('无历史 → null（调用方据此不渲染，不编造）', () => {
    const registry = new ActiveRouteRegistry()
    expect(registry.read('aggregate')).toBeNull()
  })

  it('记录后可读回 provider + model + at', () => {
    const registry = new ActiveRouteRegistry()
    registry.record('aggregate', 'loomy', 'glm-4.6', 1000)
    expect(registry.read('aggregate')).toEqual({ provider: 'loomy', model: 'glm-4.6', at: 1000 })
  })

  it('⚠️ 覆盖写：当前在用只关心最后一次', () => {
    const registry = new ActiveRouteRegistry()
    registry.record('aggregate', 'loomy', 'glm-4.6', 1000)
    registry.record('aggregate', 'zcode', 'glm-5', 2000)
    expect(registry.read('aggregate')).toEqual({ provider: 'zcode', model: 'glm-5', at: 2000 })
  })

  it('按路由分别记录，互不串台', () => {
    const registry = new ActiveRouteRegistry()
    registry.record('aggregate', 'loomy', 'glm-4.6', 1)
    expect(registry.read('jet-hub-auto')).toBeNull()
    registry.record('jet-hub-auto', 'codearts', 'deepseek-v4.1', 2)
    expect(registry.read('aggregate')).toEqual({ provider: 'loomy', model: 'glm-4.6', at: 1 })
    expect(registry.read('jet-hub-auto')).toEqual({ provider: 'codearts', model: 'deepseek-v4.1', at: 2 })
  })

  it('clear 清空', () => {
    activeRoutes.record('aggregate', 'loomy', 'glm-4.6', 1)
    activeRoutes.clear()
    expect(activeRoutes.read('aggregate')).toBeNull()
  })
})

describe('active-route：两处写入点', () => {
  it('⚠️⚠️ 聚合适配器在**转发一开始**写（不是成功之后）', () => {
    // 反向验证：把这一行移到 `if (pendingProvider !== undefined)` 那个提交点内，
    // 本用例即失败 —— 而那正是「长回答期间看不到读数」的缺陷形态。
    const source = codeOf(read('src/aggregate-adapter.ts'))
    expect(source).toMatch(/activeRoutes\.record\(\s*AGGREGATE_PROVIDER,\s*target\.provider,\s*target\.realId\s*\)/)
    // ⚠️ 必须用 target.realId（该渠道下的真实模型），不是虚拟键 modelKey：
    //    写 modelKey 会让读数恒显示 `auto` 这类虚拟名，等于没做。
    expect(source).not.toMatch(/activeRoutes\.record\(\s*AGGREGATE_PROVIDER,\s*target\.provider,\s*modelKey\s*\)/)
    // 且必须在候选循环体内（每次尝试都覆盖写 ⇒ 失败切换后读数跟着变）。
    const loopIndex = source.indexOf('for (let index = 0; index < targets.length; index += 1)')
    const recordIndex = source.indexOf('activeRoutes.record(AGGREGATE_PROVIDER')
    expect(loopIndex).toBeGreaterThan(-1)
    expect(recordIndex).toBeGreaterThan(loopIndex)
  })

  it('自动适配器在 dispatch 内写（转发前，且用真实 model）', () => {
    const source = codeOf(read('src/auto-adapter.ts'))
    expect(source).toMatch(/activeRoutes\.record\(\s*AUTO_PROVIDER,\s*target\.provider,\s*target\.model\s*\)/)
    // Phase 3 后 dispatch 是 async generator（零输出改道），锚点随之更新；
    // 断言语义不变：record 仍写在 dispatch 方法体内、先于转发。
    const dispatchIndex = source.indexOf('private async *dispatch(')
    const recordIndex = source.indexOf('activeRoutes.record(AUTO_PROVIDER')
    expect(dispatchIndex).toBeGreaterThan(-1)
    expect(recordIndex).toBeGreaterThan(dispatchIndex)
  })

  it('⚠️ auto 有失败切换语义时不能只写一次（本实现只有一个目标，故写在 dispatch 开头）', () => {
    // auto 不在 provider 之间重试 ⇒ dispatch 就是权威点。这条断言守住
    // 「别把写入挪到 prepareCall」—— 那里只是**决策**，请求可能根本没发出去。
    const source = codeOf(read('src/auto-adapter.ts'))
    const prepareIndex = source.indexOf('async prepareCall(')
    const recordIndex = source.indexOf('activeRoutes.record(AUTO_PROVIDER')
    expect(prepareIndex).toBeGreaterThan(-1)
    expect(recordIndex).toBeGreaterThan(prepareIndex)
  })
})

describe('active-route：RPC 端点', () => {
  const rpc = codeOf(read('src/jet-hub-rpc.ts'))

  it('注册 router.activeRoute', () => {
    expect(rpc).toContain("case 'router.activeRoute'")
  })

  it('⚠️ 纯内存读：端点内不得出现余额/网络调用', () => {
    const start = rpc.indexOf("case 'router.activeRoute'")
    const end = rpc.indexOf("case 'aggregate.expiryOrder'")
    expect(start).toBeGreaterThan(-1)
    const body = rpc.slice(start, end === -1 ? start + 1200 : end)
    for (const forbidden of ['expiryProbe', 'getAvailableAccount', 'fetch', 'readBadge']) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('⚠️ 未注册/未知 router 回 null 而不是报错（可选装饰，安静降级）', () => {
    const start = rpc.indexOf("case 'router.activeRoute'")
    const body = rpc.slice(start, start + 1200)
    expect(body).toMatch(/typeof router === 'string' && router\.length > 0/)
    expect(body).toContain('provider: route?.provider ?? null')
    expect(body).toContain('model: route?.model ?? null')
    expect(body).toContain('at: route?.at ?? null')
  })

  it('响应类型已声明并导出', () => {
    const types = read('src/types.ts')
    expect(types).toContain('export interface RpcActiveRouteResponse')
    expect(types).toContain('model: string | null')
    expect(rpc).toContain('RpcActiveRouteResponse')
  })
})
