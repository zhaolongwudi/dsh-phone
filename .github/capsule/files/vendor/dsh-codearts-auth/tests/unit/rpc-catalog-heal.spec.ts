/**
 * `fullCatalogIds` 三态 + 按需自愈接线的**行为**守卫 —— 真跑 `jet-hub-rpc` 端点，
 * 不做源码文本断言。
 *
 * ## 为什么需要本文件
 *
 * 2026-10-12 移植 Gitee `d14636e6` 系列（11 个提交）时改动了本端点的两处核心逻辑，
 * 而**两处都只有上游的行为用例、capsule 里一条都没有**：
 *
 * 1. `fullCatalogIds` 由「优先 `listAllModels()`、缺失才用 `listModels()`」改为
 *    **两来源取并集**，并新增 `complete` / `remoteError` 两个字段（Issue IKJW33 相邻）。
 *    旧实现的缺陷：冷缓存下 `listAllModels()` 返回**编译期兜底表（子集）**，
 *    它「存在」即短路 ⇒ 「关闭全部」只写子集黑名单却返回成功，用户以为关了整家、
 *    而几百个远端模型仍可选；`provider.status` 更会据此把整家**误显示为已关闭**。
 * 2. 积分端点（`credits.balances` / `credits.claimAll`）新增**按需自愈续期**
 *    （Issue IKKHL5）：睡眠恢复后池内 `expiresAt` 已过期，而端点原先只 resolve
 *    凭据直连上游 ⇒ 卡片红着「已过期」、积分行报 HTTP 401，且无自救手段。
 *
 * ⚠️ 这两处都属于「抽出的纯函数正确 ≠ 它被正确调用」那一类：`fullCatalogIds`
 * 写对了，但调用点若仍判 `ids.length === 0` 而不是 `complete`，缺陷原样复现；
 * 自愈函数写对了，但端点入口漏了一行 `await healExpiredAccounts(...)`，
 * 用户看到的 401 一模一样。⇒ 本文件**只驱动真实端点**，不看源码文本。
 *
 * ## 锁住的不变式
 *
 * 1. 远端成功 ⇒ 黑名单是**并集**（兜底子集 ∪ 远端），不是任一单边；
 * 2. 远端读失败 ⇒ 写黑名单类操作**拒绝且不落盘**（不得只关兜底子集）；
 * 3. 远端读到但为空 ⇒ 同样拒绝，但文案与「读失败」**不同**（不得打印字面量
 *    `undefined`）；⚠️ 它与「全部已关闭」是同形但**语义相反**的两种状态；
 * 4. `account.test` 对目录是**尽力而为**：远端失败但有适配器目录时仍照常测；
 * 5. `provider.status` 的 `closed` 只走**安全方向**：子集判据说「已关闭」时
 *    必须核实，核实不了就报未关闭；未关闭时不核实（零网络）；
 * 6. 已过期账号在 `credits.balances` / `credits.claimAll` 入口触发续期，
 *    且打到**正确的 provider**；未过期不触发；
 * 7. 设计上无续期能力的渠道（loomy）**静默跳过**（不发请求、不报错）；
 * 8. 续期失败**不上抛**（端点照常返回，由上游给出真原因）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import type { ProviderAccountEntry } from '../../src/types.js'

class FakeCredentials {
  private store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: string) { return { configured: this.store.has(ref), writable: true, source: 'fake' } }
  async set(ref: string, value: string) { this.store.set(ref, value) }
  async unset(ref: string) { this.store.delete(ref) }
}

interface HarnessOptions {
  modelAdapters?: Record<string, unknown> | undefined
  listModels?: () => Promise<Array<{ id: string }>>
  /** 各 auth 桩的续期实现；`label` 是该桩在形参表里的 provider 名。 */
  onRefresh?: (label: string, entry: ProviderAccountEntry) => Promise<void> | void
}

/**
 * 装配真实 `AccountPool` + `registerJetHubRpc`，返回 `call(method, payload)`。
 *
 * ⚠️ 13 个 auth 桩**按位置**逐个传入（手机版是位置传参，Phase 6 的命名对象
 * 重构未做）：顺序与 `src/jet-hub-rpc.ts` 的形参表一致 ——
 * codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline,
 * loomy, raccoon, minimax, zcode, gemini。桩带 label 是为了断言
 * 「自愈分派打到了正确的 provider」（错位的表现是刷了别家的凭据）。
 */
function makeRpc(options: HarnessOptions = {}) {
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: options.listModels ?? (async () => []),
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  } as never)

  let handler: ((req: Request) => Promise<Response>) | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)

  const refreshCalls: Array<{ label: string; entry: ProviderAccountEntry }> = []
  const LABELS = [
    'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qoderCn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
  ]
  const authStubs = LABELS.map((label) => ({
    refreshAccountCredential: async (_ref: string, _pool: unknown, id: string) => {
      const entry = { id, provider: label } as ProviderAccountEntry
      refreshCalls.push({ label, entry })
      await options.onRefresh?.(label, entry)
    },
  }))

  const pool = new AccountPool(ctx)
  // ⚠️ 逐个**位置**传入（不展开数组）：手机版的 13 个 auth 形参是**位置参数**，
  // 展开会让 tsc 报「spread argument must have a tuple type」，也会在将来
  // 形参表变动时把「少传/错位」这类故障藏进类型断言里。
  /* ⚠️ 调用形态随 rc.11 更新（2026-10-15）：`registerJetHubRpc` 的第 3 参从
     「13 个位置形参」改成 **`auths` 命名对象**（键是 provider id）。
     理由（rc.11 的注释）：位置形参错位已复发多次，命名对象从类型上消除该风险。
     ⚠️ rc.11 多了 `officeace` 键（第 14 家），本 spec 的桩一并补上。 */
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: authStubs[0] as never, buddy: authStubs[1] as never, workbuddy: authStubs[2] as never,
      lobsterai: authStubs[3] as never, qoder: authStubs[4] as never, qodercn: authStubs[5] as never,
      trae: authStubs[6] as never, cline: authStubs[7] as never, loomy: authStubs[8] as never,
      raccoon: authStubs[9] as never, minimax: authStubs[10] as never, zcode: authStubs[11] as never,
      gemini: authStubs[12] as never,
      officeace: authStubs[12] as never,
    },
    options.modelAdapters as never,
  )
  const h = handler
  if (h === undefined) throw new Error('endpoint handler 未注册')

  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'jet-hub', payload: { method, payload } }),
    }))
    const body = await res.json() as {
      result: { ok: boolean; value?: any; error?: { code: string; message: string } }
    }
    return body.result
  }
  return { call, pool, refreshCalls }
}

const account = (id: string, provider: string, expiresAt: number): ProviderAccountEntry => ({
  id, provider, nickname: id, enabled: true, credentialRef: `REF_${id}`,
  createdAt: 1, expiresAt, refreshable: true,
})

describe('fullCatalogIds：两来源取并集（Issue IKJW33 相邻）', () => {
  it('远端成功 ⇒ 黑名单是并集，而不是只写兜底子集', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'fallback-only' }] } },
      listModels: async () => [{ id: 'remote-a' }, { id: 'remote-b' }],
    })
    const res = await r.call('model.setAllDisabled', { provider: 'codearts', disabled: true })
    expect(res.ok).toBe(true)
    expect(Object.keys(r.pool.listDisabledModels('codearts') ?? {}).sort())
      .toEqual(['fallback-only', 'remote-a', 'remote-b'])
  })

  it('远端读失败 ⇒ 拒绝且不落盘（不得只关兜底子集）', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'fallback-only' }] } },
      listModels: async () => { throw new Error('boom') },
    })
    const res = await r.call('model.setAllDisabled', { provider: 'codearts', disabled: true })
    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain('boom')
    expect(Object.keys(r.pool.listDisabledModels('codearts') ?? {})).toEqual([])
  })

  it('远端读到但为空 ⇒ 拒绝且不落盘，文案不得打印字面量 undefined', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'fallback-only' }] } },
      listModels: async () => [],
    })
    const res = await r.call('model.setAllDisabled', { provider: 'codearts', disabled: true })
    expect(res.ok).toBe(false)
    expect(res.error?.message).toBe('该供应商没有可关闭的模型，未做任何变更')
    expect(res.error?.message ?? '').not.toContain('undefined')
    expect(Object.keys(r.pool.listDisabledModels('codearts') ?? {})).toEqual([])
  })

  it('关闭供应商：远端读失败时拒绝（不得只关兜底子集）', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'fallback-only' }] } },
      listModels: async () => { throw new Error('boom') },
    })
    const res = await r.call('provider.setEnabled', { provider: 'codearts', enabled: false })
    expect(res.ok).toBe(false)
    expect(Object.keys(r.pool.listDisabledModels('codearts') ?? {})).toEqual([])
  })

  it('account.test 对目录尽力而为：适配器有目录 + 远端读失败 ⇒ 不因目录退化成 bad-request', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'only-fallback' }] } },
      listModels: async () => { throw new Error('boom') },
    })
    // 无该账号 ⇒ 应在「账号不存在」处结束，而不是目录错误
    const res = await r.call('account.test', { accountId: 'nope' })
    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain('不存在')
  })
})

describe('provider.status：closed 只走安全方向', () => {
  it('兜底子集判据说「已关闭」时必须核实 —— 不得误报', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'hy3' }] } },
      listModels: async () => [{ id: 'glm-5.2' }, { id: 'deepseek-v4-flash' }],
    })
    await r.pool.setModelsDisabled('codearts', ['hy3'])
    const res = await r.call('provider.status', { providers: ['codearts'] })
    expect(res.value.statuses.codearts.closed).toBe(false)
    expect(res.value.statuses.codearts.models.total).toBe(3)
  })

  it('真的全关时仍报已关闭（核实判据不得用「远端非空」）', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'hy3' }] } },
      listModels: async () => [],
    })
    await r.pool.setModelsDisabled('codearts', ['hy3'])
    const res = await r.call('provider.status', { providers: ['codearts'] })
    expect(res.value.statuses.codearts.closed).toBe(true)
  })

  it('核实不了（远端读失败）⇒ 保守报未关闭', async () => {
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'hy3' }] } },
      listModels: async () => { throw new Error('boom') },
    })
    await r.pool.setModelsDisabled('codearts', ['hy3'])
    const res = await r.call('provider.status', { providers: ['codearts'] })
    expect(res.value.statuses.codearts.closed).toBe(false)
  })

  it('未关闭时不核实目录（零网络）', async () => {
    let listCalls = 0
    const r = makeRpc({
      modelAdapters: { codearts: { listAllModels: () => [{ id: 'hy3' }, { id: 'x' }] } },
      listModels: async () => { listCalls++; return [{ id: 'a' }] },
    })
    const res = await r.call('provider.status', { providers: ['codearts'] })
    expect(res.value.statuses.codearts.closed).toBe(false)
    expect(listCalls).toBe(0)
  })
})

describe('积分端点按需自愈（Issue IKKHL5）', () => {
  const PAST = Date.now() - 60_000
  const FUTURE = Date.now() + 3_600_000

  it('credits.balances：已过期账号在其入口触发续期，且打到正确的 provider', async () => {
    const r = makeRpc()
    await r.pool.addAccount(account('buddy-a1', 'buddy', PAST))
    await r.call('credits.balances', { provider: 'buddy' })
    expect(r.refreshCalls.map((c) => c.label)).toEqual(['buddy'])
    expect(r.refreshCalls[0]?.entry.id).toBe('buddy-a1')
  })

  it('credits.claimAll：领取入口同样自愈（否则「刷新能看到余额、领取仍 401」）', async () => {
    const r = makeRpc()
    await r.pool.addAccount(account('buddy-a3', 'buddy', PAST))
    await r.call('credits.claimAll', { provider: 'buddy' })
    expect(r.refreshCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('未过期账号不发续期请求', async () => {
    const r = makeRpc()
    await r.pool.addAccount(account('buddy-a2', 'buddy', FUTURE))
    await r.call('credits.balances', { provider: 'buddy' })
    expect(r.refreshCalls).toEqual([])
  })

  it('设计上无续期能力的渠道（loomy）静默跳过', async () => {
    const r = makeRpc()
    await r.pool.addAccount(account('loomy-a1', 'loomy', PAST))
    await r.call('credits.balances', { provider: 'loomy' })
    expect(r.refreshCalls).toEqual([])
  })

  it('续期失败不上抛：端点照常返回，由上游给出真原因', async () => {
    const r = makeRpc({ onRefresh: async () => { throw new Error('refresh boom') } })
    await r.pool.addAccount(account('buddy-a4', 'buddy', PAST))
    const res = await r.call('credits.balances', { provider: 'buddy' })
    expect(res.ok).toBe(true)
    expect(r.refreshCalls.length).toBe(1)
  })

  it('expiresAt 为数字字符串（用户可编辑备份导入）⇒ 与客户端判据一致，不续期', async () => {
    const r = makeRpc()
    await r.pool.addAccount({ ...account('buddy-a5', 'buddy', PAST), expiresAt: String(PAST) as never })
    await r.call('credits.balances', { provider: 'buddy' })
    expect(r.refreshCalls).toEqual([])
  })

  it('逐账号顺序执行：两个过期账号都被续期', async () => {
    const r = makeRpc()
    await r.pool.addAccount(account('buddy-b1', 'buddy', PAST))
    await r.pool.addAccount(account('buddy-b2', 'buddy', PAST - 1000))
    await r.call('credits.balances', { provider: 'buddy' })
    expect(r.refreshCalls.length).toBe(2)
  })
})
