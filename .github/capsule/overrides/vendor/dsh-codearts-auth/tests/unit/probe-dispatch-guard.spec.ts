/**
 * 探测分派守卫：loomy / raccoon / minimax 必须走**自己的**适配器，绝不落 `else`。
 *
 * ## 为什么单独一份 spec（而不是塞进 account-probe-adapter.spec.ts）
 *
 * 那份 spec 用 `vi.mock` 把每个适配器换成桩，从而断言「构造了哪个类」。
 * 本文件改用**行为判据**（探测请求真的发往哪个 host），理由有两条：
 * 1. 它**不依赖 mock 的构造记录**，因此能独立于桩的接线正确性；
 * 2. 它锁的是**用户可观测**的后果 —— 落 `else` 的症状就是请求发去了
 *    华为云端点（`CodeArtsAdapter` 的 SDK-HMAC-SHA256 签名）而必然失败。
 *
 * ## 缺陷史（本仓库已第 5、6、7 次同型）
 *
 * 判据是「该 provider **现在**会不会写 `modelRateLimits`」（写了才有标记可清，
 * 才需要探测分派）。手机版的 `probeWithAdapter` 仍是 `else if` 链 + `else`
 * 兜底到 `CodeArtsAdapter`，因此**漏一家 ⇒ 那家的标记永远清不掉**：
 * - loomy / raccoon：上游 2026-10-08 记为「第 5 次」，手机版**未移植**该修复；
 * - minimax：上游 2026-10-11（issue IKJW32 接上请求级换号后）新增。
 *
 * ⚠️ **raccoon 是用户可见缺陷**：客户端未登记 `rateLimit: false` ⇒
 * 「重测 / 重置」按钮**会渲染**，点击后必然报
 * 「codearts: no usable credential; log in first」（本机实测）。
 * loomy 的按钮被隐藏（登记了 `rateLimit: false`），但 RPC 仍可达 ⇒ 纵深防御。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbePool, ProviderAccountEntry } from '../../src/types.js'

/** 记录探测请求真的发往了哪个 URL。 */
function stubFetch(): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(String(input))
    // 一律回 401：结论必然是「仍受限」，但关键在于是**谁**把请求发到了**哪里**。
    return new Response('{"code":401,"message":"nope"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

function makeEntry(provider: string, model: string): ProviderAccountEntry {
  return {
    id: `${provider}-1`,
    provider,
    credentialRef: `${provider.toUpperCase()}_ACCOUNT_TEST`,
    enabled: true,
    nickname: provider,
    /**
     * ⚠️ 必须带限流标记：`retestAccount` 的探测目标是
     * `Object.keys(entry.modelRateLimits)`，没有标记时它**根本不构造适配器**
     * —— 那样这些用例会变成**假绿**（既抓不到缺陷，也守不住修复）。
     */
    modelRateLimits: { [model]: Date.now() + 3_600_000 },
  } as unknown as ProviderAccountEntry
}

function makePool(entry: ProviderAccountEntry): ProbePool {
  return {
    findAccount: () => entry,
    listAccountsByProvider: () => [entry],
    resolveCredentialForAccount: async () => ({ access_token: 'stub-token' }),
    clearModelRateLimits: async () => 0,
    updateModelRateLimit: async () => {},
  } as unknown as ProbePool
}

/** 华为云 CodeArts 端点 —— 落 `else` 时请求会发到这里。 */
const CODEARTS_HOSTS = ['huaweicloud.com', 'devcloud', 'codearts']

describe('account-probe 分派守卫：loomy / raccoon / minimax 不得落入 CodeArts 分支', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  for (const [provider, model, host] of [
    ['loomy', 'loomy-model', 'xunfei.cn'],
    ['raccoon', 'raccoon-model', 'xiaohuanxiong.com'],
    ['minimax', 'MiniMax-M3', 'minimax.cn'],
  ] as const) {
    it(`${provider} 的探测请求发往自己的端点（${host}），而不是华为云`, async () => {
      const calls = stubFetch()
      const { retestAccount } = await import('../../src/account-probe.js')
      const id = `${provider}-1`
      const result = await retestAccount(makePool(makeEntry(provider, model)), id)

      // 构造了适配器并发出了请求（没有标记时 tested 会是 0 —— 那才是假绿）。
      expect(result.tested).toBe(1)
      expect(result.stillLimited).toHaveLength(1)
      expect(calls.length).toBeGreaterThan(0)

      // 核心断言 ①：请求发往该家自己的 host。
      expect(calls.some((url) => url.includes(host))).toBe(true)
      // 核心断言 ②：**没有**发往华为云（落 else 的症状）。
      for (const bad of CODEARTS_HOSTS) {
        expect(calls.some((url) => url.includes(bad))).toBe(false)
      }
      // 核心断言 ③：错误文案里不得出现 codearts 的凭据报错 —— 那是落 else 的
      // 直接症状（本机实测：'无法确认：codearts: no usable credential; log in first'）。
      expect(result.stillLimited[0]?.message ?? '').not.toContain('codearts')
    })
  }
})
