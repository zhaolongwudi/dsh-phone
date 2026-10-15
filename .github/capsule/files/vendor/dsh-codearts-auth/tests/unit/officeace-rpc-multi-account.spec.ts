/**
 * `officeace-rpc-multi-account.spec.ts` —— OfficeAce **多账号/号池**契约守卫。
 *
 * ## 这个文件为什么存在（以及它取代了什么）
 *
 * 2026-10-13 曾加过一个 `officeace-rpc-single-credential.spec.ts`，守的是
 * 「禁止建第二个 OfficeAce 账号」。那条约束是**错的**：它把一个实现缺陷
 * （所有卡片共用 `session.json` 一份凭据）当成了产品约束，用「拦截功能」
 * 去掩盖「数据会互相覆盖」。用户提了一个致命反问：
 *   「我要是想添加几个不同的账号呢？提示删除我怎么用号池？」
 *
 * 真正的修法是**让每个账号有自己的凭据**，而不是禁止多账号。凭据存储已从
 * 「自己写 `session.json`」改为**走 DSH 凭据库、按 `credentialRef` 索引**
 * （与 gemini / raccoon / minimax 的 `persistLogin(credential, { refName })`
 * 同款范式）—— 号池多账号由此天然成立。故原文件删除，改为本文件。
 *
 * ## 守的三条不变量
 *
 * | # | 不变量 | 违反的后果（实测） |
 * |---|--------|------------------|
 * | 1 | 允许建**多个**账号，各自有独立 credentialRef | 号池不可用，禁用功能 |
 * | 2 | 第二次登录**不覆盖**第一个账号的凭据 | 旧账号静默失效（数据损坏） |
 * | 3 | 两个账号的凭据**内容互相独立** | 串号：换号等于换掉所有人 |
 *
 * ⚠️ 不变量 2/3 是原 `single-credential` 文件想防的事 —— 但那个文件防错了
 *    地方（拦在入口），这里防对了地方（**凭据隔离**）。
 *
 * ⚠️ 本文件**不发真实网络**：`startLogin` / `completeLogin` 用桩替代。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'

/**
 * 造一个能注册 RPC 的最小 ctx（抄自 `zcode-rpc-login.spec.ts`，
 * 那里有逐条踩坑注释）。
 *
 * ⚠️ `credentials` 用**内存 Map** 实现：本文件的核心就是验证「凭据按 ref
 *    隔离」，所以它必须是可观测的存储，而不是被 mock 掉的黑盒。
 */
function makeCtx(): {
  ctx: Context
  credentials: Map<string, string>
  handler: () => ((req: Request) => Promise<Response>) | undefined
} {
  const ctx = new Context()
  const store = new Map<string, string>()
  ctx.provide('credentials', {
    resolve: async (ref: string) => {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'fake' }
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
  return { ctx, credentials: store, handler: () => handler }
}

/**
 * 桩 `officeace` auth：两步式登录的第二步（`login.poll`）会调 `completeLogin`
 * 与 `persistLogin`，这里让它们**立刻成功**并返回可区分的凭据。
 *
 * ⚠️ `accountSeq` 让每次登录产出**不同**凭据内容 —— 不变量 3（内容互相独立）
 * 就靠这个可区分性来断言。
 */
function makeOfficeAceStub(options: { autoComplete?: boolean } = {}) {
  const { autoComplete = true } = options
  let seq = 0
  return {
    startLogin: async () => ({
      authorizeUrl: 'https://auth.huaweicloud.com/stub',
      state: 'stub-state',
      _internal: {
        codeVerifier: 'stub-verifier',
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
      },
    }),
    pollLoginCode: async () => (autoComplete ? 'stub-code' : undefined),
    completeLogin: async () => {
      seq += 1
      return {
        modelAppKey: `app-key-${seq}`,
        modelAppSecret: `app-secret-${seq}`,
        maasBaseUrl: 'https://officeace.example',
        access: `ak-${seq}`,
        secret: `sk-${seq}`,
        securityToken: `token-${seq}`,
        projectId: 'p',
        expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        refreshToken: `refresh-${seq}`,
        dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
        accountId: `account-${seq}`,
      }
    },
    persistLogin: async (
      credential: Record<string, unknown>,
      opts: { refName: string; credentials: { set(ref: string, value: string): Promise<void> } },
    ) => {
      // ⚠️ **真实地**按 ref 写进凭据库 —— 本文件验证的就是这个行为，
      //    不能 mock 掉，否则断言的是桩而不是实现。
      await opts.credentials.set(opts.refName, JSON.stringify(credential))
      return { accountId: credential.accountId }
    },
  }
}

function makeRpc(officeace: Record<string, unknown>) {
  const { ctx, credentials, handler } = makeCtx()
  const pool = new AccountPool(ctx)
  registerJetHubRpc(
    ctx, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never,
      officeace: officeace as never,
    } as never,
    undefined,
  )
  const h = handler()
  if (h === undefined) throw new Error('handler 未注册')
  const call = async (method: string, payload: unknown) => {
    const res = await h(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    // ⚠️ 括号**不可省**：`x as T['result']` 会被解析成索引访问类型而非取属性。
    const body = (await res.json()) as {
      result: { ok: boolean; value?: any; error?: { code: string; message: string } }
    }
    return body.result
  }
  return { call, pool, credentials }
}

/** 造一个账号并等它登录完成（两步式：create → 轮询 poll）。 */
async function addAccount(
  call: (method: string, payload: unknown) => Promise<any>,
): Promise<{ accountId: string; credentialRef: string }> {
  const created = await call('account.create', { provider: 'officeace' })
  expect(created.ok, 'account.create 应当成功').toBe(true)
  const accountId = created.value.accountId as string
  // 两步式：轮询直到 done（桩里第一次 poll 即完成）。
  for (let i = 0; i < 20; i++) {
    const polled = await call('login.poll', { accountId })
    if (polled.value?.done === true) break
  }
  return { accountId, credentialRef: `OFFICEACE_ACCOUNT_${'X'}` }
}

describe('OfficeAce 号池：多账号共存（凭据按 credentialRef 隔离）', () => {
  it('① 允许添加多个账号，且各有独立 credentialRef', async () => {
    const { call, pool } = makeRpc(makeOfficeAceStub() as unknown as Record<string, unknown>)

    await addAccount(call)
    await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    expect(accounts, '多账号被拦截了 ⇒ 号池不可用').toHaveLength(2)
    const refs = accounts.map((a) => a.credentialRef)
    expect(new Set(refs).size, `credentialRef 重复了 ⇒ 凭据会互相覆盖：${refs.join(', ')}`).toBe(2)
  })

  it('② 第二次登录**不覆盖**第一个账号的凭据（旧账号不会静默失效）', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub() as unknown as Record<string, unknown>,
    )

    await addAccount(call)
    const first = (await pool.listAccounts('officeace'))[0]!
    const firstSnapshot = credentials.get(first.credentialRef)
    expect(firstSnapshot, '第一个账号的凭据未落库').toBeDefined()

    await addAccount(call)

    // ⚠️ 核心断言：第一个账号的凭据**原样还在**。
    expect(
      credentials.get(first.credentialRef),
      '第二次登录把第一个账号的凭据覆盖了 ⇒ 旧账号静默失效',
    ).toBe(firstSnapshot)
  })

  it('③ 两个账号的凭据内容互相独立（串号 ⇒ 换号会换掉所有人）', async () => {
    const { call, pool, credentials } = makeRpc(
      makeOfficeAceStub() as unknown as Record<string, unknown>,
    )

    await addAccount(call)
    await addAccount(call)

    const accounts = await pool.listAccounts('officeace')
    const [a, b] = accounts
    const credA = credentials.get(a!.credentialRef)
    const credB = credentials.get(b!.credentialRef)
    expect(credA, 'A 的凭据缺失').toBeDefined()
    expect(credB, 'B 的凭据缺失').toBeDefined()
    expect(credA, '两个账号指向同一份凭据 ⇒ 串号').not.toBe(credB)

    // 内容层面也应当可区分（不同账号 = 不同 AK / refresh token）。
    const parsedA = JSON.parse(credA!) as { access: string }
    const parsedB = JSON.parse(credB!) as { access: string }
    expect(parsedA.access).not.toBe(parsedB.access)
  })
})
