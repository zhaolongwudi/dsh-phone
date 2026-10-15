import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REGISTRY,
  creditCapabilitiesOf,
  descriptorOf,
} from '../../src/provider-registry.js'

describe('ProviderDescriptor：与既有产物的逐条一致性', () => {
  it('id 一律纯小写字母（带连字符会让四处正则断言静默漏算）', () => {
    for (const d of PROVIDER_REGISTRY) {
      expect(d.id, `${d.id} 必须纯小写字母`).toMatch(/^[a-z]+$/)
    }
  })

  it('id 不重复', () => {
    const ids = PROVIDER_REGISTRY.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个 provider 都有非空 label / logoClass', () => {
    // ⚠️ 不断言 icon：registry **刻意不持有图标**（那会让宿主产物白白背上
    //    几十 KB 的 data URI 字面量，而宿主从不使用图标）。图标在客户端的
    //    PROVIDER_ICONS 里，由 Step 8 那条「两边 id 集合相等」的守卫覆盖。
    for (const d of PROVIDER_REGISTRY) {
      expect(d.label.length, `${d.id} 缺 label`).toBeGreaterThan(0)
      expect(d.logoClass.length, `${d.id} 缺 logoClass`).toBeGreaterThan(0)
    }
  })

  it('共 17 条（16 个真渠道 + aggregate）', () => {
    // ⚠️ 2026-10-13 合并：officeace（第 15）与 accio（第 16）**同一次**并入，
    //    故从 15/14 直接跳到 17/16 —— 不是漏了一格。
    expect(PROVIDER_REGISTRY).toHaveLength(17)
    expect(PROVIDER_REGISTRY.filter((d) => d.channel).length).toBe(16)
    expect(PROVIDER_REGISTRY.find((d) => d.id === 'aggregate')?.channel).toBe(false)
  })

  it('descriptorOf 按 id 取；未知返回 undefined', () => {
    expect(descriptorOf('buddy')?.label).toBe('CodeBuddy (腾讯)')
    expect(descriptorOf('nope')).toBeUndefined()
  })
})

describe('从 registry 派生的能力表与既有断言逐条相等', () => {
  it('CREDITS 派生结果与既有 6 条 toEqual 断言一致', () => {
    const caps = creditCapabilitiesOf()
    expect(caps.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.buddy).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.workbuddy).toEqual({ balance: true, dailyCheckin: false })
    expect(caps.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.qodercn).toEqual({ balance: true, dailyCheckin: true })
    expect(caps.loomy).toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
  })

  it('只有 cline 有 subscriptionQuota（既有断言 toEqual([\'cline\'])）', () => {
    const withQuota = Object.entries(creditCapabilitiesOf())
      .filter(([, c]) => c.subscriptionQuota === true)
      .map(([id]) => id)
      .sort()
    expect(withQuota).toEqual(['cline'])
  })

  /**
   * ⚠️ **三张派生表必须同款：外层与内层各自 `Object.freeze`**（2026-10-08 复审修复）。
   *
   * 重构前 `credits-capabilities.js` 是**逐条手写的字面量**、每条各自带
   * `Object.freeze({…})`；改成派生时只保住了外层的 `Object.freeze(creditCapabilitiesOf())` —— 那只冻结
   * **外层容器**，**内层条目仍可被改写**。同文件另外两张表
   *（`RATE_LIMIT_CAPABILITIES` / `ACCOUNT_TEST_CAPABILITIES`）各自都留着
   * `Object.freeze({…})`，故这是**只在其中一张表上静默失效的保险**。
   *
   * ⚠️ 这条用例本身就是「保险的保险」：本仓库的约定是「保险失效比变红更糟」——
   * 静默失效的守卫比没有守卫更危险（它会让人以为已经守住了），故冻结本身
   * 也必须由一条会变红的断言守着。
   */
  it('⚠️ 派生表的每个条目自身也是冻结的（外层冻结挡不住内层改写）', async () => {
    const caps = creditCapabilitiesOf()
    // `creditCapabilitiesOf()` 返回的是**未冻结的外层**（冻结由调用方做：
    // 客户端 `Object.freeze(creditCapabilitiesOf())`）—— 但**每条必须已冻结**，
    // 否则调用方的外层冻结只是一道挡不住内层改写的空保险。
    for (const [id, entry] of Object.entries(caps)) {
      expect(Object.isFrozen(entry), `${id} 的能力条目应逐条冻结`).toBe(true)
    }
    // ⚠️ 三张表**同款**才算修好：另两张（限流 / 测试）各自都留着逐条冻结，
    //    若只有积分表缺，那是「只在其中一张表上静默失效的保险」。
    const client = await import('../../plugin-src/client/credits-capabilities.js')
    for (const [name, table] of [
      ['CREDITS_CAPABILITIES', client.CREDITS_CAPABILITIES],
      ['RATE_LIMIT_CAPABILITIES', client.RATE_LIMIT_CAPABILITIES],
      ['ACCOUNT_TEST_CAPABILITIES', client.ACCOUNT_TEST_CAPABILITIES],
    ] as const) {
      expect(Object.isFrozen(table), `${name} 外层应冻结`).toBe(true)
      for (const [id, entry] of Object.entries(table)) {
        expect(Object.isFrozen(entry), `${name}.${id} 应逐条冻结`).toBe(true)
      }
    }
    expect(Object.isFrozen(PROVIDER_REGISTRY), 'registry 数组应冻结').toBe(true)
  })

  it('permanentLock 恰好是既有的 6 家（officeace 2026-10-12 加入）', () => {
    const locked = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true)
      .map((d) => d.id).sort()
    expect(locked).toEqual(['buddy', 'lobsterai', 'loomy', 'officeace', 'trae', 'workbuddy'])
  })

  it('usesExpiryWindow 恰好是既有的 5 家（loomy 不在内，它没有窗口概念）', () => {
    const win = PROVIDER_REGISTRY.filter((d) => d.usesExpiryWindow === true)
      .map((d) => d.id).sort()
    expect(win).toEqual(['buddy', 'lobsterai', 'officeace', 'trae', 'workbuddy'])
  })

  it('rateLimit === false 恰好是 4 家（officeace 2026-10-12、accio 2026-10-13 加入）', () => {
    const off = PROVIDER_REGISTRY.filter((d) => d.rateLimit === false)
      .map((d) => d.id).sort()
    // ⚠️ 四家**理由各不相同**（见 registry 里各自的字段注释）：
    // - loomy：根本不返回限流错误（静默降级扣永久积分）；
    // - gemini / officeace：限流是服务端配额窗口制，本地标记与重测都不改变配额；
    // - accio：**不写 `modelRateLimits` 且不在 `probeById` 里** ⇒
    //   两个按钮恒为惰性（零请求、零清除）。
    // 新增一家时**不要**只改这里：判据是 registry 的落地问法
    //「这个按钮点下去，能不能让用户少受限一次？」
    expect(off).toEqual(['accio', 'gemini', 'loomy', 'officeace'])
  })

  it('accountTest === true 恰好是 gemini', () => {
    const t = PROVIDER_REGISTRY.filter((d) => d.accountTest === true).map((d) => d.id)
    expect(t).toEqual(['gemini'])
  })

  it('creditPackages 恰好是既有的 7 家（officeace 2026-10-12 加入）', () => {
    const p = PROVIDER_REGISTRY.filter((d) => d.creditPackages === true)
      .map((d) => d.id).sort()
    expect(p).toEqual(['buddy', 'lobsterai', 'officeace', 'qoder', 'qodercn', 'trae', 'workbuddy'])
  })

  it('autoCheckinExcluded 恰好是 zcode', () => {
    const x = PROVIDER_REGISTRY.filter((d) => d.autoCheckinExcluded === true).map((d) => d.id)
    expect(x).toEqual(['zcode'])
  })

  it('channel === true 的 15 家都有 settingsNamespace 除了 opencode', () => {
    const withNs = PROVIDER_REGISTRY.filter((d) => d.settingsNamespace !== undefined)
      .map((d) => d.id).sort()
    expect(withNs).toEqual([
      'accio', 'buddy', 'cline', 'codearts', 'gemini', 'lobsterai', 'loomy', 'minimax',
      'officeace', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy', 'zcode',
    ])
  })
})

describe('客户端图标表与 registry 同步（行为断言）', () => {
  it('PROVIDER_ICONS 的键集合与 registry 的 id 集合完全相等', async () => {
    // ⚠️ 直接 import 客户端的导出，**不读源码文本**。
    //    失败时 toEqual 的 diff 会明确指出缺哪个 id。
    //
    // ⚠️ 2026-10-08：初稿 import 的是 `plugin-src/client/jet-hub.js`，
    //    但**实测失败** —— 本仓库 `node_modules` 里**没有 react**
    //    （`react` 只在 `build.mjs` 的 `external` 里、由宿主注入），
    //    报 `Cannot find package 'react' imported from .../jet-hub.js`。
    //    故按 brief 的 fallback：图标与 `PROVIDER_ICONS` 抽到**纯数据模块**
    //    `plugin-src/client/provider-icons.js`（无 react 依赖），测试指向它。
    //    这与本仓库既有的 `aggregate-panel-logic.js` / `badge-model.js` /
    //    `new-account.js` 同款 —— 都是「为可单测而从 jet-hub.js 拆出」。
    const { PROVIDER_ICONS } = await import('../../plugin-src/client/provider-icons.js')
    expect(Object.keys(PROVIDER_ICONS).sort())
      .toEqual(PROVIDER_REGISTRY.map((d) => d.id).sort())
  })

  it('每个图标都是非空 data URI（防止键存在但值是 undefined）', async () => {
    const { PROVIDER_ICONS } = await import('../../plugin-src/client/provider-icons.js')
    for (const [id, icon] of Object.entries(PROVIDER_ICONS)) {
      expect(typeof icon, `${id} 的图标类型`).toBe('string')
      expect((icon as string).startsWith('data:image/'), `${id} 的图标必须是 data URI`).toBe(true)
    }
  })
})
