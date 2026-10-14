/**
 * `login.poll` 的**终态失败通道**（Gitee issue IKLI7J，2026-10-14 自上游移植）。
 *
 * ## 被守住的缺陷（真实报障）
 *
 * 「登录失败对用户完全不可见：任何 provider 登录失败都只剩 5 分钟静默转圈」。
 *
 * 两条根因：
 * 1. 后端失败侧回 `{done:false, error}` 或走「删掉占位条目」，而前端
 *    `if (!pollRes?.done) return;` **只判 `done`** ⇒ 那句唯一指路的原因被整体丢掉；
 * 2. 其余 provider 失败后**删掉占位条目**，`login.poll` 命中
 *    `if (!entry) return {done:false}` —— 与「用户还没授权完」**同形**，
 *    没有任何终态表示。
 *
 * 5 分钟不是服务端超时，是**客户端自己的轮询上限**（`plugin-src/client/jet-hub.js`）。
 *
 * ## 三条契约（改任何一处都要同时看这三条）
 *
 * | 形态 | 含义 |
 * |---|---|
 * | `{done:false}` | 进行中（正常中间态，**不得**误报成失败） |
 * | `{done:true, success:true}` | 成功 |
 * | `{done:true, success:false, error}` | 终态失败，`error` 可直接展示 |
 *
 * ## ⚠️ 与上游 spec 的**有意差异**（手机版形态适配）
 *
 * 上游在本轮把 `registerJetHubRpc` 改成了**具名对象** `auths`（`JetHubAuths`），
 * 且新增了 `officeace` / `accio` 两个 provider。手机版：
 * - `registerJetHubRpc` 仍是**位置参数**（本仓库 14 个调用点全是位置传参，
 *   历史上已因少传/插队错位复发 6 次，改造属独立议题）；
 * - **不引入** officeace / accio（第七轮决议：用户不用华为、属新增 provider）。
 * ⇒ 上游用 OfficeAce 作「失败可控」的替身那些用例，这里改用 **codearts / gemini /
 * lobsterai**（都是回调式或 persistLogin 式、都能精确控制失败时机）。
 * 三条契约与全部守卫判据与上游**同源**，只有进入方式与 provider 选择不同。
 *
 * ⚠️ 本文件**不发真实网络、不开浏览器窗口**，全部走替身。
 */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

type Handler = (request: Request) => Promise<Response>

interface RpcResult {
  ok: boolean
  value?: { done?: boolean; success?: boolean; error?: string; accountId?: string; [k: string]: unknown }
  error?: { code?: string; message?: string }
}

interface Harness {
  call(method: string, payload: unknown): Promise<RpcResult>
  /** 当前账号池里的条目（只读快照）。 */
  accounts(): Array<Record<string, unknown>>
}

/**
 * 去掉整行注释与块注释内容（**只为计数**）。
 *
 * ⚠️ 红队实测：块注释里插一行**裸文本** `failLogin(id, error)` 就能把计数守卫配平
 *（行锚定正则分不清「注释里的调用」与「真调用」）⇒ 计数前必须先剥注释。
 * 这里只剥「整行 `//`」与「`/* … *\/` 区间」，够用且不误伤 URL 里的 `//`。
 */
function stripComments(source: string): string {
  const out: string[] = []
  let inBlock = false
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      out.push('')
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      out.push('')
      continue
    }
    out.push(trimmed.startsWith('//') ? '' : line)
  }
  return out.join('\n')
}

/**
 * `registerJetHubRpc` 的**位置参数**替身（手机版形态）。
 *
 * ⚠️ 顺序必须与 `src/jet-hub-rpc.ts` 的形参表逐一对齐：
 * `ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline,
 * loomy, raccoon, minimax, zcode, gemini`。
 * 少传/插队错位在本仓库复发过 6 次（每加一个 provider 一次），故这里**逐个命名**，
 * 不用 `...args`。
 *
 * `overrides` 的键是 provider id，值为该 provider 的 auth 替身；未提供的用空对象。
 */
function registerWithAuths(
  ctx: unknown,
  pool: unknown,
  overrides: Record<string, unknown>,
  modelAdapters?: unknown,
): void {
  const stub = {} as never
  registerJetHubRpc(
    ctx as never,
    pool as never,
    (overrides.codearts ?? stub) as never,
    (overrides.buddy ?? stub) as never,
    (overrides.workbuddy ?? stub) as never,
    (overrides.lobsterai ?? stub) as never,
    (overrides.qoder ?? stub) as never,
    (overrides.qodercn ?? stub) as never,
    (overrides.trae ?? stub) as never,
    (overrides.cline ?? stub) as never,
    (overrides.loomy ?? stub) as never,
    (overrides.raccoon ?? stub) as never,
    (overrides.minimax ?? stub) as never,
    (overrides.zcode ?? stub) as never,
    (overrides.gemini ?? stub) as never,
    modelAdapters as never,
  )
}

/**
 * 搭一个能注册 Jet Hub RPC 的最小 ctx + 内存账号池。
 *
 * ⚠️ 用**普通对象**而不是 `new Context()` + 真 `AccountPool`：本文件要精确控制
 * 「占位条目在不在」「凭据写没写」，真 `AccountPool` 会把这些藏在磁盘/缓存后面。
 */
function makeHarness(overrides: Record<string, unknown>): Harness {
  let handler: Handler | undefined
  const entries = new Map<string, Record<string, unknown>>()
  const store = new Map<string, string>()

  const ctx = {
    get: (key: string) => key === 'connection'
      ? {
        fetch: {
          register: (config: { path: string; fetch: Handler }) => {
            if (config.path === JET_HUB_API_PATH) handler = config.fetch
          },
        },
      }
      : undefined,
    inject: (_deps: string[], callback: (c: unknown) => void) => { callback(ctx) },
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      resolve: async (ref: string) => {
        const value = store.get(ref)
        return value === undefined ? undefined : { value, source: 'test' }
      },
      set: async (ref: string, value: string) => { store.set(ref, value) },
      unset: async (ref: string) => { store.delete(ref) },
    },
  }

  const pool = {
    addAccount: async (entry: Record<string, unknown>) => { entries.set(String(entry.id), entry) },
    updateAccount: async (id: string, patch: Record<string, unknown>) => {
      const current = entries.get(id)
      if (current !== undefined) entries.set(id, { ...current, ...patch })
    },
    removeAccount: async (id: string) => { entries.delete(id) },
    // ⚠️ 真 `AccountPool` 有这个方法，`failLogin` 用它判「登录是否其实已成功」。
    // 替身缺了它会被判成「读不到池」⇒ 终态腿静默失效（上游 spec 实测踩过一次）。
    findAccount: (id: string) => entries.get(id),
    listAccounts: async () => [...entries.values()],
    listAllAccounts: async () => [...entries.values()],
  }

  registerWithAuths(ctx, pool, overrides)

  return {
    accounts: () => [...entries.values()],
    call: async (method, payload) => {
      const h = handler
      if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      return (await res.json() as { result: RpcResult }).result
    },
  }
}

/**
 * 真 `Context` + 真 `AccountPool` 的变体。
 *
 * ⚠️ **「账号/凭据是否被毁」这一类断言必须用它**：上面的内存桩 `removeAccount`
 * 只删数组元素、**不会 unset 凭据**（真 `AccountPool.removeAccount` 才会），
 * 用它根本测不出「凭据被连带删除」那一半 —— 会写出恒真的用例。
 */
function makeRealHarness(
  /**
   * 替身集合；**可以传工厂**：有些替身（如 gemini 的 `persistLogin`）需要直接写
   * 凭据库才能复刻「先落凭据、再记账」的真实顺序 —— 工厂拿得到 harness 内部的 store。
   */
  overrides: Record<string, unknown> | ((store: Map<string, string>) => Record<string, unknown>),
  patchPool?: (pool: AccountPool) => void,
): {
  call(method: string, payload: unknown): Promise<RpcResult>
  pool: AccountPool
  store: Map<string, string>
  credentialKeys(): string[]
} {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register() { return { get: () => state.value, replace: (v: unknown) => { state.value = v } } },
    describe() { return [] },
  } as never)
  let handler: Handler | undefined
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: Handler }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject =
    (_deps: string[], callback: (c: unknown) => void) => callback(ctx)

  const pool = new AccountPool(ctx)
  patchPool?.(pool)
  const stubs = typeof overrides === 'function' ? overrides(store) : overrides
  registerWithAuths(ctx, pool, stubs)

  const h = handler
  if (h === undefined) throw new Error('jet-hub RPC 端点未注册')
  return {
    pool,
    store,
    credentialKeys: () => [...store.keys()],
    call: async (method, payload) => {
      const res = await h(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      return (await res.json() as { result: RpcResult }).result
    },
  }
}

/**
 * codearts 是**回调式**登录：`startLogin` 立即返回，结果在 `result` 上
 *（可由用例决定何时失败）。它是「后台失败 ⇒ failLogin」这条腿的天然探针。
 */
function codeartsStubWithRejectableResult(): {
  auth: Record<string, unknown>
  reject(reason: string): void
  resolve(): void
} {
  let rejectResult: ((reason: unknown) => void) | undefined
  let resolveResult: (() => void) | undefined
  const result = new Promise<void>((resolve, reject) => {
    rejectResult = reject
    resolveResult = resolve
  })
  return {
    auth: {
      startLogin: async () => ({
        loginUrl: 'https://example.test/codearts/login',
        result,
        close: async () => {},
      }),
    },
    reject: (reason: string) => {
      // ⚠️ 必须**稍后**才 reject（不能在 startLogin 里 `Promise.reject`）：
      //    RPC 在 `startLogin` 与 `.catch()` 之间还有一次 `await addAccount`，
      //    立即 reject 会先触发一次 unhandledRejection。
      rejectResult?.(new Error(reason))
    },
    resolve: () => { resolveResult?.() },
  }
}

/**
 * gemini 替身：`persistLogin` **真写凭据库**。
 *
 * ⚠️ 必须有这个替身：`login.poll` 判「登录成功」的判据就是**凭据 resolve 出值**，
 * 不写凭据的成功路径在真 `AccountPool` 下会被判成「进行中」。
 */
function geminiStubThatPersists(store: Map<string, string>): Record<string, unknown> {
  return {
    startLogin: async () => ({
      loginUrl: 'https://accounts.google.com/stub',
      result: Promise.resolve({ sub: 'sub-1', email: 'user@example.test' }),
      close: async () => {},
    }),
    persistLogin: async (credential: unknown, opts: { refName: string }) => {
      store.set(opts.refName, JSON.stringify(credential))
    },
  }
}

describe('IKLI7J 根因 2：占位条目已被清理的失败态也必须有终态', () => {
  it('★ 后台登录失败（条目被清理）⇒ 同一 accountId 报终态失败而非 {done:false}', async () => {
    const codearts = codeartsStubWithRejectableResult()
    const h = makeHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    expect(created.ok, 'account.create 应当成功').toBe(true)
    const accountId = created.value?.accountId as string

    // 授权被拒：后台 result 落定为失败 ⇒ failLogin（记原因 + 删占位条目）。
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(h.accounts(), '失败后占位条目应当已被清理').toHaveLength(0)

    const polled = await h.call('login.poll', { accountId, provider: 'codearts' })
    expect(polled.ok).toBe(true)
    // 原先这里与「用户还没授权完」同形：`{done:false}` ⇒ 静默转圈 5 分钟。
    expect(polled.value?.done, '条目消失必须被解释成终态').toBe(true)
    expect(polled.value?.success).toBe(false)
    expect(String(polled.value?.error)).toContain('授权被拒绝')
  })

  it('★ 终态失败必须**幂等**：重复轮询仍报同一条原因，不得退回 {done:false}', async () => {
    // ⚠️ 客户端是 1 秒一次的 setInterval + 异步回调，轮询**可能重叠**。
    //    若「读到即清」，一次丢包/慢响应就把唯一那次原因吃掉 ⇒ 退回静默转圈。
    const codearts = codeartsStubWithRejectableResult()
    const h = makeHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const first = await h.call('login.poll', { accountId, provider: 'codearts' })
    const second = await h.call('login.poll', { accountId, provider: 'codearts' })
    expect(first.value?.success).toBe(false)
    expect(second.value?.success, '第二次轮询不得退化成「进行中」').toBe(false)
    expect(second.value?.error).toBe(first.value?.error)
  })

  it('★ 终态失败**只作用于自己的 accountId**：另一次登录照常成功', async () => {
    // 防「用一个全局失败标志代替按账号记录」这类实现：那会让一次失败
    // 把后续所有登录都判死。
    const codearts = codeartsStubWithRejectableResult()
    const h = makeRealHarness((store) => ({
      codearts: codearts.auth,
      gemini: geminiStubThatPersists(store),
    }))

    const failed = await h.call('account.create', { provider: 'codearts' })
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const ok = await h.call('account.create', { provider: 'gemini' })
    const okId = ok.value?.accountId as string
    // 等 gemini 的后台 `.then` 跑完（它先写凭据、再回填）。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const polled = await h.call('login.poll', { accountId: okId, provider: 'gemini' })
    expect(polled.value?.done).toBe(true)
    expect(polled.value?.success, '另一次成功登录被前一次失败污染了').toBe(true)

    // 而失败那次仍如实报失败（两条记录互不覆盖）。
    const failedPoll = await h.call('login.poll', {
      accountId: failed.value?.accountId as string,
      provider: 'codearts',
    })
    expect(failedPoll.value?.success).toBe(false)
  })
})

describe('IKLI7J 回归护栏：不得把「进行中」误报成失败', () => {
  it('★ 用户尚未完成授权 ⇒ 仍是 {done:false}，且不携带 success/error', async () => {
    const codearts = codeartsStubWithRejectableResult()
    const h = makeHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string

    const polled = await h.call('login.poll', { accountId, provider: 'codearts' })
    expect(polled.value?.done, '未授权完不得报 done').toBe(false)
    // ⚠️ 关键：**不能**带 `success:false`，否则用户正常授权途中会被弹错。
    expect(polled.value?.success, '正常进行中不得被标成失败').toBeUndefined()
    expect(polled.value?.error).toBeUndefined()
    // 占位条目必须还在（轮询靠它判进度）。
    expect(h.accounts()).toHaveLength(1)
  })

  it('★ 占位条目存在但凭据未写入 ⇒ 仍 {done:false}（不得误报终态）', async () => {
    // 这条是**全部 provider** 的通用中间态：占位条目就是为了让前端看到进度。
    // 若把「条目在但凭据没写」判成失败，正常登录会被立刻打断。
    const codearts = codeartsStubWithRejectableResult()
    const h = makeHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string
    for (let i = 0; i < 3; i += 1) {
      const polled = await h.call('login.poll', { accountId, provider: 'codearts' })
      expect(polled.value?.done).toBe(false)
      expect(polled.value?.success).toBeUndefined()
    }
  })

  it('★ 完全未知的 accountId（从未 account.create）⇒ 仍 {done:false}', async () => {
    // `login.poll` 是**可被外部调用**的端点，不能因为「查不到」就报登录失败。
    const h = makeHarness({ codearts: codeartsStubWithRejectableResult().auth })
    const polled = await h.call('login.poll', { accountId: 'nobody-at-all', provider: 'codearts' })
    expect(polled.ok).toBe(true)
    expect(polled.value?.done).toBe(false)
    expect(polled.value?.success).toBeUndefined()
  })

  it('★ 成功路径逐字未变：done:true + success:true', async () => {
    const h = makeRealHarness((store) => ({ gemini: geminiStubThatPersists(store) }))
    const created = await h.call('account.create', { provider: 'gemini' })
    const accountId = created.value?.accountId as string
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const polled = await h.call('login.poll', { accountId, provider: 'gemini' })
    expect(polled.value?.done).toBe(true)
    expect(polled.value?.success).toBe(true)
    expect(polled.value?.error).toBeUndefined()
    expect((await h.pool.listAllAccounts()).map((a) => a.id)).toEqual([accountId])
  })
})

describe('IKLI7J 终态记录的边界：过期与容量', () => {
  it('★ 上限只防内存：写满后**最早**的记录被淘汰、最新一条仍报终态', async () => {
    // 淘汰会把一条**仍在被轮询**的记录挤掉 ⇒ 退回静默。红队实测这个上限必须远大于
    // 「同时在轮询的登录数」（客户端一次只允许一轮，但 RPC 可被外部脚本调用）。
    // ⚠️ 用例**不写死上限数值**：跑 300 次失败，只断言「最早没了、最新还在」，
    //    这样调大上限不会假红。
    let seq = 0
    const h = makeHarness({
      codearts: {
        startLogin: async () => {
          seq += 1
          const n = seq
          return {
            loginUrl: `https://example.test/codearts/${n}`,
            // 每次 startLogin 都返回一个**立即失败**的结果 ⇒ failLogin。
            result: Promise.reject(new Error('codearts: 授权被拒绝')),
            close: async () => {},
          }
        },
      },
    })
    const ids: string[] = []
    for (let i = 0; i < 300; i += 1) {
      const created = await h.call('account.create', { provider: 'codearts' })
      const id = created.value?.accountId as string
      ids.push(id)
      // 等后台 `.catch` 跑完（failLogin 同步写记录）。
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    }
    const oldest = await h.call('login.poll', { accountId: ids[0], provider: 'codearts' })
    expect(oldest.value?.success, '最早的记录应已被上限淘汰（内存有界）').toBeUndefined()
    expect(oldest.value?.done).toBe(false)
    const newest = await h.call('login.poll', { accountId: ids[ids.length - 1], provider: 'codearts' })
    expect(newest.value?.success, '最新一条必须仍报终态').toBe(false)
  })

  it('★ 超过 TTL 的失败记录不得再被当作终态（也不得抛错）', async () => {
    // 记录是内存态、按账号 id 索引；没有 TTL 就会在当前进程里长住。
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-14T00:00:00Z'))
      const codearts = codeartsStubWithRejectableResult()
      const h = makeHarness({ codearts: codearts.auth })
      const created = await h.call('account.create', { provider: 'codearts' })
      const accountId = created.value?.accountId as string
      codearts.reject('codearts: 授权被拒绝')
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const failed = await h.call('login.poll', { accountId, provider: 'codearts' })
      expect(failed.value?.success).toBe(false)

      // 31 分钟后（TTL = 30 分钟）该记录失效。
      vi.setSystemTime(new Date('2026-10-14T00:31:00Z'))
      const later = await h.call('login.poll', { accountId, provider: 'codearts' })
      expect(later.ok).toBe(true)
      expect(later.value?.success, '过期记录不得再被当作终态').toBeUndefined()
      expect(later.value?.done).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('IKLI7J 审计修正：已落盘的登录绝不能被「失败收尾」毁掉（净回归）', () => {
  /**
   * 这条守的是**上游独立审计打穿过的净回归**：若把「凭据落盘 / 记账回填」罩在
   * 同一个 `try` 里并在 catch 一律 `failLogin`（删账号，而真
   * `AccountPool.removeAccount` 会连带 unset 凭据），一次**已经成功**的登录
   * 会被后来的记账失败抹掉。
   *
   * ⚠️ 必须用 `makeRealHarness`（内存桩的 `removeAccount` 不会 unset 凭据）。
   */
  it('★ 落库成功但回填 updateAccount 抛错：必须报成功，账号与凭据都不得被删', async () => {
    const h = makeRealHarness(
      (store) => ({ gemini: geminiStubThatPersists(store) }),
      (pool) => {
        const original = pool.updateAccount.bind(pool)
        let first = true
        ;(pool as unknown as {
          updateAccount(id: string, patch: Record<string, unknown>): Promise<void>
        }).updateAccount = async (id, patch) => {
          if (first) {
            first = false
            throw new Error('模拟存储写失败')
          }
          return original(id, patch as never)
        }
      },
    )
    const created = await h.call('account.create', { provider: 'gemini' })
    const accountId = created.value?.accountId as string
    // 等后台 `.then` 跑完（它先写凭据、再回填，回填那步会抛）。
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const polled = await h.call('login.poll', { accountId, provider: 'gemini' })

    // 凭据已落盘 ⇒ 这次登录就是成了；回填只是展示字段，不得反过来判失败。
    expect(polled.value?.success, '凭据已在却报失败 ⇒ 用户丢掉一个已登好的账号').toBe(true)
    expect((await h.pool.listAllAccounts()).map((a) => a.id)).toEqual([accountId])
    expect(h.credentialKeys()).toHaveLength(1)
  })

  it('★ 读不到账号池时：只记终态，**不得删账号**（删除不可逆，宁可留卡片）', async () => {
    // 池实现抛错（或替身缺 `findAccount` —— 上游 spec 实测踩过一次：那一刻所有失败
    // 收尾都静默失效）时，绝不能把「读不到」当成「没有凭据」去删号。
    const codearts = codeartsStubWithRejectableResult()
    const h = makeRealHarness(
      { codearts: codearts.auth },
      (pool) => {
        ;(pool as unknown as { findAccount: () => never }).findAccount = () => {
          throw new Error('池读失败（模拟实现异常）')
        }
      },
    )
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const polled = await h.call('login.poll', { accountId, provider: 'codearts' })

    expect(polled.value?.success, '读不到池也必须让用户看到原因').toBe(false)
    expect(
      (await h.pool.listAllAccounts()).map((a) => a.id),
      '读不到池就删号 ⇒ 把「读不到」当成「没有」，一次可能成功的登录被不可逆地销毁',
    ).toEqual([accountId])
  })

  it('★ 登录途中账号被用户删除 ⇒ 文案必须是人话，不得泄漏内部错误串', async () => {
    const codearts = codeartsStubWithRejectableResult()
    const h = makeRealHarness({ codearts: codearts.auth })
    const created = await h.call('account.create', { provider: 'codearts' })
    const accountId = created.value?.accountId as string
    await h.call('account.delete', { accountId })
    codearts.reject('codearts: 授权被拒绝')
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const polled = await h.call('login.poll', { accountId, provider: 'codearts' })
    // 条目没了 ⇒ 这里本来就会走 `failLogin` 的「条目已被删除」分支。
    expect(polled.value?.success).toBe(false)
    expect(String(polled.value?.error), '内部错误串（Account … not found）泄漏给用户了')
      .not.toContain('not found')
    expect(String(polled.value?.error)).toContain('已被删除')
  })
})

describe('IKLI7J 接线守卫：两侧必须同改，缺一处就退回静默转圈', () => {
  const clientSource = readFileSync(
    new URL('../../plugin-src/client/jet-hub.js', import.meta.url),
    'utf8',
  )
  const serverSource = readFileSync(
    new URL('../../src/jet-hub-rpc.ts', import.meta.url),
    'utf8',
  )

  /**
   * ⚠️ 源码断言一律用**行锚定正则**，不用 `indexOf('原始片段')`：
   * 本文件与源码的注释里都**引用**了这些片段（例如「旧写法 `if (!pollRes?.done) return;`」），
   * `indexOf` 会先命中注释 —— 本仓库记过同型事故（取证命令自匹配修复提交本身）。
   */
  function lineIndex(pattern: RegExp): number {
    const match = pattern.exec(clientSource)
    return match === null ? -1 : match.index
  }

  it('★ 客户端必须先判 success === false，再判 done（顺序不能反）', () => {
    const failureIdx = lineIndex(/^\s*if \(pollRes\?\.success === false\) \{$/m)
    const doneIdx = lineIndex(/^\s*if \(!pollRes\?\.done\) return;$/m)
    expect(failureIdx, '客户端丢失了终态失败判据（issue IKLI7J 根因 1 回归）').toBeGreaterThan(-1)
    expect(doneIdx, '客户端的 done 早退判据不见了').toBeGreaterThan(-1)
    // ⚠️ 顺序断言是**必须**的：写成「先 `!done` 早退、再判 success」等于没改 ——
    //    `done:false` 的失败仍会被丢掉（这正是 issue 原文的缺陷形态）。
    expect(failureIdx, 'success 判据必须在 done 早退之前').toBeLessThan(doneIdx)
  })

  it('★ 客户端终态失败分支必须真的把错误展示出来（不能只 loadAccounts）', () => {
    const failureIdx = lineIndex(/^\s*if \(pollRes\?\.success === false\) \{$/m)
    const doneIdx = lineIndex(/^\s*if \(!pollRes\?\.done\) return;$/m)
    const branch = clientSource.slice(failureIdx, doneIdx)
    // ⚠️ 手机版形态适配：本面板的 create 流程**没有** `setError`/`setPhase` 可用
    //    （错误文案只在 'error' 阶段渲染，而该流程运行时 phase 恒为 'ready'），
    //    故失败提示走 `setProbeNotice({ tone:'error' })` —— 与同文件既有的
    //    「弹窗被拦截」「已复用本机凭据」两条提示同一出口。
    expect(branch).toContain('setProbeNotice(')
    expect(branch).toContain("tone: 'error'")
    expect(branch).toContain('stopPoll()')
  })

  it('★★ 三条终态路径都必须**先停表再 await**（否则 1 秒轮询会重入）', () => {
    /**
     * ⚠️⚠️ 手机版特有的要求（上游没有这个窗口）。
     *
     * 轮询是 `setInterval(..., 1000)`，而手机版的失败/超时分支都改用了
     * `setProbeNotice`（本面板没有可用的 setError/setPhase，见分支内注释），
     * 于是必须 `await loadAccounts()` / `loadCredits()` 才能让列表与额度刷新。
     *
     * 若把 `stopPoll()` 放在 await **之后**：await 期间 `pollRef.current` 仍非 0，
     * 下一拍会**再次进入**同一分支 —— 重复拉账号、重复设提示，且提示时序不可控。
     *
     * ⇒ 判据：两个终态分支里 `stopPoll()` 的下标必须**早于**该分支内第一个 `await`。
     */
    const branches: Array<{ name: string; from: RegExp; to: RegExp }> = [
      {
        name: '超时分支',
        from: /^\s*if \(Date\.now\(\) > deadline\) \{$/m,
        to: /^\s*const pollRes = await rpcCall\('login\.poll'/m,
      },
      {
        name: '终态失败分支',
        from: /^\s*if \(pollRes\?\.success === false\) \{$/m,
        to: /^\s*if \(!pollRes\?\.done\) return;$/m,
      },
    ]
    for (const { name, from, to } of branches) {
      const fromMatch = from.exec(clientSource)
      expect(fromMatch, `找不到 ${name}`).not.toBeNull()
      const fromIdx = (fromMatch as RegExpExecArray).index
      const toMatch = to.exec(clientSource.slice(fromIdx))
      expect(toMatch, `找不到 ${name} 的结束锚点`).not.toBeNull()
      // ⚠️⚠️ **必须剥注释后再判**：本分支的块注释里逐行写了「停表在前 ⇒ …」
      //    以及「必须先 stopPoll() 再 await」这类说明，裸文本扫描会把**注释**里的
      //    那行当成调用 —— 于是真实现把 stopPoll() 挪到 await 之后也照样「绿」
      //    （本仓库记过的同型事故：判据自匹配修复注释本身）。
      const body = stripComments(
        clientSource.slice(fromIdx, fromIdx + (toMatch as RegExpExecArray).index),
      )
      // ⚠️ 用**行锚定**正则而不是 \`indexOf\`：本文件与被测源码的注释里都引用了
      //    \`stopPoll()\`（例如「必须先 stopPoll() 再 await」），裸 indexOf 会先命中注释。
      const stopMatch = /^\s*stopPoll\(\);?$/m.exec(body)
      expect(stopMatch, `${name} 没有 stopPoll() 调用`).not.toBeNull()
      const stopIdx = (stopMatch as RegExpExecArray).index
      // ⚠️ 用「await + 空白 + 标识符」而不是裸 `await`：注释里也出现过这个词，
      //    裸匹配会把注释当代码（本仓库记过的同型事故）。
      const awaitIdx = body.search(/await\s+[A-Za-z_$]/)
      expect(awaitIdx, `${name} 没有 await（判据前提变了）`).toBeGreaterThan(-1)
      expect(
        stopIdx,
        `${name} 的 stopPoll() 排在 await 之后 ⇒ 1 秒轮询会在 await 期间重入`,
      ).toBeLessThan(awaitIdx)
    }
  })

  it('★ 客户端超时分支必须给提示（原先静默关窗 + 停表）', () => {
    const timeoutIdx = lineIndex(/^\s*if \(Date\.now\(\) > deadline\) \{$/m)
    const pollIdx = lineIndex(/^\s*const pollRes = await rpcCall\('login\.poll'/m)
    expect(timeoutIdx, '超时分支不见了').toBeGreaterThan(-1)
    expect(pollIdx).toBeGreaterThan(timeoutIdx)
    const timeoutBranch = clientSource.slice(timeoutIdx, pollIdx)
    expect(timeoutBranch, '超时仍静默结束 ⇒ issue 期望 3 未落实').toContain('登录超时')
    expect(timeoutBranch).toContain('setProbeNotice(')
    /**
     * ⚠️ **文案不得把原因写死成「未完成授权」**（上游独立审计发现）：走到超时还有几种
     * 与「没授权」相反的情形（用户已授权但凭据形状不被接受 / 账号途中被删 /
     * 失败记录被 TTL 或上限淘汰）。写死原因会给排障者错误的第一个假设。
     */
    expect(
      timeoutBranch,
      '超时文案把原因写死成「未完成授权」⇒ 排障者会被引向错误方向',
    ).toContain('账号条目已被删除')
  })

  it('★ 服务端：每个后台登录失败告警都必须配一条终态记录（计数断言，防漏接）', () => {
    // ⚠️ 判据用**计数**而不是「某串字符在不在」：接线是并列的十余处，
    //    「有一处在」不能推出「处处都在」（本仓库反复记录过的形态）。
    // ⚠️⚠️ **计数前必须先剥注释**（红队 W2）：块注释里一行裸文本
    //    `failLogin(id, error)` 即可把计数配平。
    //
    // ⚠️ 手机版与上游的差异：上游有 officeace（`await failLogin(accountId, …)`）
    //    与 accio（只记终态、不删条目，是**唯一的例外**）两个 provider；手机版
    //    **不引入**它们 ⇒ 这里全部 11 处后台失败都走 `failLogin(id, …)`，
    //    没有例外项。断言据此写成「告警数 === failLogin 数」。
    const code = stripComments(serverSource)
    const warns = code.match(/login failed for \$\{id\}/g) ?? []
    const failLoginCalls = code.match(/^\s+void failLogin\(id, (?:err|error)\)$/gm) ?? []
    const recordOnly = code.match(/^\s+recordLoginFailure\(id, error\)$/gm) ?? []
    expect(warns.length, '后台失败告警条数变了？先核对是否新增/删除了 provider 分支')
      .toBeGreaterThanOrEqual(11)
    expect(
      recordOnly.length,
      '手机版没有 accio 那个「只记终态、不删条目」的例外（不引入该 provider）',
    ).toBe(0)
    expect(
      failLoginCalls.length,
      `告警 ${warns.length} 条，但走 failLogin 的只有 ${failLoginCalls.length} 条`
      + ' ⇒ 漏接的那家失败时会留下幽灵账号（或静默转圈）',
    ).toBe(warns.length)
  })

  it('★ 客户端失败判据只能有一处（多一行早退就能让真分支变死代码）', () => {
    // 红队实测：在真失败分支**之前**插一行 `if (pollRes?.success === false) return;`
    // 会让真分支变成死代码（用户又只能等 5 分钟），而只按「首个匹配之后的文本是否
    // 含 setError」判的守卫**照样全绿**。⇒ 用计数把「诱饵早退」挡掉。
    const count = (clientSource.match(/pollRes\?\.success === false/g) ?? []).length
    expect(count, '出现多处 success===false ⇒ 可能有一处是让真分支变死代码的早退').toBe(1)
  })

  it('★ 客户端必须把「轮询请求本身失败」的痕迹带进超时文案（原先被裸 catch 吞掉）', () => {
    // 红队攻击 5d：`login.poll` 自身 `ok:false` 时，裸 `catch {}` 让真实原因永不上屏。
    const timeoutIdx = lineIndex(/^\s*if \(Date\.now\(\) > deadline\) \{$/m)
    const pollIdx = lineIndex(/^\s*const pollRes = await rpcCall\('login\.poll'/m)
    const timeoutBranch = clientSource.slice(timeoutIdx, pollIdx)
    expect(timeoutBranch, '超时文案没带上轮询失败痕迹').toContain('lastPollError')
    // 记录点必须在轮询的 catch 里（否则 lastPollError 恒为 null，等于没做）。
    expect(clientSource, '轮询 catch 没记录失败').toContain('pollErrorCount += 1')
  })

  it('★ 服务端：`login.poll` 必须在查账号池之前先查终态记录', () => {
    // ⚠️ 同样用行锚定正则（源码注释里引用了这两个片段）。
    const start = serverSource.indexOf("case 'login.poll': {")
    expect(start, '找不到 login.poll 分支').toBeGreaterThan(-1)
    const branch = serverSource.slice(start)
    const failureMatch = /^\s*const failure = loginFailureOf\(req\.accountId\)$/m.exec(branch)
    const listMatch = /^\s*const accounts = await pool\.listAllAccounts\(\)$/m.exec(branch)
    expect(failureMatch, 'login.poll 丢失了终态查询').not.toBeNull()
    expect(listMatch).not.toBeNull()
    // ⚠️ 顺序同理：`failLogin` 是「先写记录、再异步删条目」，
    //    落在「记录已写、条目未删」的窗口里也必须报出终态。
    expect(
      (failureMatch as RegExpExecArray).index,
      '终态查询必须在查账号池之前',
    ).toBeLessThan((listMatch as RegExpExecArray).index)
  })
})
