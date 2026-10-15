/**
 * ★★ **临期折算的分派真的走能力注册表**（Task 5 的核心验收）。
 *
 * ## 本文件锁的**两条**不变式
 *
 * ### 一、清单 == runtime 里挂了 `expiry` 域的渠道集合
 *
 * ⚠️ 这条**不是同义反复**，也**不能**被消除 —— 两个概念**不是同一件事**：
 *
 * | 东西 | 回答的问题 | 何时确定 |
 * |---|---|---|
 * | `WIRED_EXPIRY_PROVIDERS` | 「这个渠道**接入了**临期折算吗」 | **编译期**（本文件有没有为它写折算原语） |
 * | `ProviderRuntime.expiry` | 「运行时该调**哪个**原语」 | **`apply()` 时**（注册） |
 *
 * 前者被 `aggregate-adapter.ts` 的**四处**过滤（加 `aggregate-expiry.ts`
 * 的「未接入」短路，共 5 个消费点）与**大量不调 `apply()` 的既有测试**消费
 *（实测：在 `tests/unit` 里 grep「临期探针工厂名 + 左括号」共 36 处，减去本文件
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）
 * ⇒ 它**必须**是编译期常量（若改为从 runtime 派生，那些场景下
 * 恒为空数组，`refreshCatalog` 会把**所有虚拟模型过滤掉**、聚合目录整个变空）。
 * 而后者必须等 `apply()`。⇒ 两者的一致性**只能**靠断言锁住。
 *
 * 它锁的真实漂移是：「**有人加了 runtime 注册却忘了加清单**」（或反之）——
 * 症状是「某渠道静默退出聚合候选」或「某渠道被广告却恒不可用」，**都没有日志**。
 *
 * ### 二、折算真的**分派给** runtime 的实现
 *
 * ⚠️ 判据是**注入哨兵**，不是「把旧逻辑抄一遍再自比」：本仓库已两次踩过
 * 同义反复用例（就地复刻旧逻辑、断言它自己的返回值 —— 删掉整个分支照样全绿）。
 * 哨兵值**不可能**由硬编码的 `switch` 产生 ⇒ 恢复旧实现必红。
 * ⚠️ 哨兵**逐个渠道互不相同**：这样「A 渠道拿到了 B 渠道的实现」
 *（本仓库自陈复发 6 次的位置参数错位形态）也会红，而不只是「有没有查表」。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NEVER, UNUSABLE } from '../../src/aggregate-core.js'
import { WIRED_EXPIRY_PROVIDERS, createExpiryProbe } from '../../src/aggregate-expiry.js'
import { apply } from '../../src/index.js'
import { clearProviderRuntimes, registerProviderRuntime, registeredRuntimeIds, runtimeOf } from '../../src/provider-runtime.js'
import { descriptorOf } from '../../src/provider-registry.js'

/** 已接入临期折算的渠道（**期望值** —— 真相源是下面两个不变式）。 */
// ⚠️ 2026-10-13 合并审计加入 accio：用户要求「聚合的 qwen3.8-flash 轮换列表里要有
//    accio」，而**决定候选表可见性的是这张表**（不是 AGGREGATE_CHANNELS）⇒
//    只把它加进 AGGREGATE_CHANNELS 是无效接线（模型层归并了，候选层被剔除）。
// ⚠️ 2026-10-13 加入 officeace：用户要求「officeace 加入聚合轮换」。它与 buddy 系
//    **同形**（订阅的每个积分桶都带 `expiresAt`），折算原语见 `officeaceExpiry`。
const EXPECTED_WIRED = [
  'accio', 'buddy', 'codearts', 'lobsterai', 'loomy', 'officeace', 'trae', 'workbuddy', 'zcode',
]

class FakeCredentials {
  async resolve(): Promise<undefined> { return undefined }
  async describe() { return { configured: false, writable: true } }
  async set(): Promise<void> {}
  async unset(): Promise<void> {}
}
class FakeCommands {
  register() { return () => {} }
}
class FakeLlm {
  registerConfigurableProviders() { return { replace: () => {} } }
  registerAdapter() { return { replace: () => {} } }
  async listModels(): Promise<never[]> { return [] }
}
class FakeSettings {
  register(): void {}
  describe(): Array<{ ns: string }> { return [] }
}

/**
 * 跑一次**真实 `apply()`**。
 *
 * ⚠️ 必须先清空注册表：它是**模块级** Map，而 `registerProviderRuntime` 对重复 id
 * 采取「保留先注册者」⇒ 不清空的话第二次 `apply()` 的注册会被整体跳过，
 * `runtimeOf()` 指向上一轮的实例（与 `provider-runtime-wiring.spec.ts` 同因）。
 */
function applyOnce(): void {
  clearProviderRuntimes()
  const ctx = new Context()
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  ctx.provide('settings', new FakeSettings() as never)
  apply(ctx)
}

/** runtime 里**真的挂了 `expiry` 域**的渠道集合（真跑 `apply()` 后读）。 */
function runtimeExpiryProviders(): string[] {
  return registeredRuntimeIds()
    .filter((id) => runtimeOf(id)?.expiry !== undefined)
    .sort()
}

/** 造一个「有可用账号」的池桩（折算会真的走到 runtime 的实现）。 */
function poolWithAccount(): never {
  return {
    disabledModelsFor: () => new Set<string>(),
    listAvailableCredentials: async () => [{ entry: { id: 'a1' }, credential: {} }],
  } as never
}

afterEach(() => { clearProviderRuntimes() })

describe('★ 不变式一：清单 == runtime 里挂了 expiry 域的渠道（真跑 apply()）', () => {
  it('★★ 逐项相等（漏注册一家即红，且点名是哪个）', () => {
    applyOnce()
    const runtimeIds = runtimeExpiryProviders()
    const listed = [...WIRED_EXPIRY_PROVIDERS].sort()
    // ⚠️ 双向点名：`toEqual` 的 diff 在 7 项时不易读，故显式列出缺/多。
    const missingInList = runtimeIds.filter((id) => !listed.includes(id))
    const missingInRuntime = listed.filter((id) => !runtimeIds.includes(id))
    expect(
      missingInList,
      `以下渠道挂了 runtime 的 expiry 域，却**不在** WIRED_EXPIRY_PROVIDERS 里 ⇒ `
      + `它们的模型会被目录过滤掉（用户看不到）：${missingInList.join(', ')}`,
    ).toEqual([])
    expect(
      missingInRuntime,
      `以下渠道在清单里，但 runtime **没有** expiry 域 ⇒ 折算恒 UNUSABLE，`
      + `清单在广告一个不可用的渠道：${missingInRuntime.join(', ')}`,
    ).toEqual([])
    expect(listed).toEqual(EXPECTED_WIRED)
  })

  it('★ 清单里的每个渠道都**真的有**可调用的 credentialExpiry', () => {
    applyOnce()
    for (const id of WIRED_EXPIRY_PROVIDERS) {
      expect(typeof runtimeOf(id)?.expiry?.credentialExpiry, `${id} 的 expiry 域不可调用`).toBe('function')
    }
  })

  it('⚠️ 未接入的渠道（清单外）在 runtime 里也**没有** expiry 域', () => {
    applyOnce()
    // raccoon / cline 是真实渠道但未接入折算；aggregate / auto 是虚拟 provider。
    for (const id of ['raccoon', 'cline', 'minimax', 'qoder', 'gemini']) {
      expect(runtimeOf(id)?.expiry, `${id} 不该有 expiry 域`).toBeUndefined()
    }
    // 清单本身不得含未接入渠道（否则 aggregate-adapter 会广告恒不可用的候选）。
    expect(WIRED_EXPIRY_PROVIDERS).not.toContain('raccoon')
    expect(WIRED_EXPIRY_PROVIDERS).not.toContain('cline')
  })

  it('★ 未接入的渠道折算为 UNUSABLE（**不是 NEVER**）', async () => {
    // ⚠️ 若返回 NEVER，一个我们对其一无所知的渠道会被排在候选**最前**
    //（NEVER = 长期有效、可当选），而 UNUSABLE = 本次剔除。
    const probe = createExpiryProbe({} as never, async () => undefined)
    expect(await probe('cline')).toBe(UNUSABLE)
    expect(await probe('raccoon')).toBe(UNUSABLE)
    expect(await probe('not-a-channel')).toBe(UNUSABLE)
    expect(UNUSABLE).not.toBe(NEVER)
  })
})

describe('★★ 不变式二：折算真的分派给 runtime（哨兵注入，硬编码 switch 不可能通过）', () => {
  it('★ 7 家各注册一个**互不相同**的哨兵 ⇒ 探针逐个返回自己的哨兵', async () => {
    clearProviderRuntimes()
    const sentinelOf = new Map<string, number>()
    for (const [index, id] of EXPECTED_WIRED.entries()) {
      const sentinel = 1_700_000_000_000 + index * 1000
      sentinelOf.set(id, sentinel)
      registerProviderRuntime({
        descriptor: descriptorOf(id)!,
        expiry: { credentialExpiry: async () => sentinel },
      })
    }

    for (const [id, sentinel] of sentinelOf) {
      // ⚠️ 每个渠道一个**新探针**：缓存是探针实例级的，复用会让后一个渠道命中
      //    前一个的缓存 —— 那样本用例就测不到分派，只测到缓存。
      const probe = createExpiryProbe(poolWithAccount(), async () => 'm1')
      expect(await probe(id), `${id} 没有走 runtime 的 expiry 域（或拿到了别家的实现）`)
        .toBe(sentinel)
    }
  })

  it('★ 探针原样透传 runtime 的结论（NEVER / UNUSABLE 两个语义相反的哨兵都不改写）', async () => {
    // ⚠️ 分派层**不得**改写原语的结论：`NEVER`（长期、可当选）与 `UNUSABLE`
    //（查不到、剔除）语义相反，压成一个就是本模块头警告的「把未知当可用」。
    clearProviderRuntimes()
    registerProviderRuntime({
      descriptor: descriptorOf('buddy')!,
      expiry: { credentialExpiry: async () => NEVER },
    })
    registerProviderRuntime({
      descriptor: descriptorOf('zcode')!,
      expiry: { credentialExpiry: async () => UNUSABLE },
    })
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('buddy')).toBe(NEVER)
    // zcode 的实现回 UNUSABLE ⇒ 该账号被跳过 ⇒ 一个都没成功 ⇒ 渠道级 UNUSABLE。
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('zcode')).toBe(UNUSABLE)
  })

  it('★★ 清单内的渠道若 runtime **没有** expiry 域 ⇒ 兜底 `UNUSABLE`（**不是 `NEVER`**）', async () => {
    // ⚠️⚠️ 本用例守的是 `credentialExpiry` 的**兜底分支**
    //   （`runtime?.expiry === undefined` ⇒ `UNUSABLE`）。
    //
    // 它此前**零覆盖**（独立复审实测证伪）：要走到那一行，两个前置条件必须**同时**成立 ——
    //   ① 渠道**在** `WIRED_EXPIRY_PROVIDERS` 里 —— 否则更早的「未接入」短路
    //     （`if (!WIRED_EXPIRY_PROVIDERS.includes(provider)) return UNUSABLE`）就返回了；
    //   ② 它的 runtime **没有** `expiry` 域 —— 而生产装配下 ①⇒② 由本文件的不变式一
    //     挡住（清单 == runtime 里挂了 expiry 域的集合）。
    // ⇒ 既有的「未接入」用例全部**只**命中①之外的短路分支，没有一条能到这一行：
    //   把这里的 `UNUSABLE` 改成 `NEVER` 曾**不会让任何用例变红**。
    //
    // 而 `NEVER` 正是本模块的**第一红线**：它的语义是「可用、只是无临期额度」，
    // **参与排序且可当选**。返回它 = 把一个我们对其余额一无所知的渠道排到候选
    // **最前**并选中它 —— 而该渠道可能压根没有可用账号。
    clearProviderRuntimes()
    // ⚠️ 只注册 descriptor，**刻意不挂** `expiry` 域（这就是②）。
    registerProviderRuntime({ descriptor: descriptorOf('buddy')! })
    // 前置条件必须显式断言：否则「渠道不在清单里」时本用例会退化成
    // 「又测了一遍短路分支」—— 绿得毫无意义（本仓库记录过的同义反复形态）。
    expect(WIRED_EXPIRY_PROVIDERS, '前置条件①：buddy 必须在清单里').toContain('buddy')
    expect(runtimeOf('buddy')?.expiry, '前置条件②：buddy 的 runtime 必须**没有** expiry 域')
      .toBeUndefined()

    // 池里有可用账号 ⇒ 探测不会在「无可用账号」处提前返回，真的走到分派那一行。
    const probe = createExpiryProbe(poolWithAccount(), async () => 'm1')
    expect(
      await probe('buddy'),
      'buddy 在清单里、runtime 却没有 expiry 域 ⇒ 必须 `UNUSABLE`（剔除该候选）。'
      + '返回 `NEVER` 会让这个「我们一无所知」的渠道被排在候选最前并当选',
    ).toBe(UNUSABLE)
  })

  it('★ 分派是**按 id** 的：把某家的实现换掉，只有它受影响（错位即红）', async () => {
    // ⚠️ 这条独立于上一条：上一条证明「查了表」，本条证明「查对了键」。
    //    若分派写成「按注册顺序取第一个」或键写错，上一条可能仍绿（哨兵恰好对），
    //    但本条会红 —— 因为只有 trae 被换成了哨兵，其余必须仍是原语的真实结论。
    clearProviderRuntimes()
    const sentinel = 987_654_321
    registerProviderRuntime({
      descriptor: descriptorOf('trae')!,
      expiry: { credentialExpiry: async () => sentinel },
    })
    registerProviderRuntime({
      descriptor: descriptorOf('loomy')!,
      expiry: { credentialExpiry: async () => NEVER },
    })
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('trae')).toBe(sentinel)
    expect(await createExpiryProbe(poolWithAccount(), async () => 'm1')('loomy')).toBe(NEVER)
  })
})
