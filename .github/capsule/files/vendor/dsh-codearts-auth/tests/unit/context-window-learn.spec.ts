import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  DYNAMIC_CONTEXT_WINDOW_FLOOR,
  DYNAMIC_CONTEXT_WINDOW_START,
  attachContextWindowStore,
  contextWindowFromFailureText,
  contextWindowKey,
  dynamicContextWindowFor,
  learnedContextWindow,
  noteContextWindowSuccess,
  rememberContextWindowCeiling,
  rememberContextWindowFailure,
  resetLearnedContextWindows,
} from '../../src/context-window-learn.js'
import { createContextWindowStore } from '../../src/context-window-store.js'

/**
 * 「拿不到供应商上限」的动态窗口学习器 + 它在**聚合层与 zcode** 的接线。
 *
 * ## 为什么这些用例必须存在（归因）
 *
 * 学到的值会被**整个进程**当作声明值使用（`contextWindow` 决定 DSH 的压缩阈值），
 * 收窄过头会白白浪费上下文、收窄不足会「撞墙 → 压缩 → 再撞墙」。两个方向都只能
 * 靠用例钉住：①**只认报文明说的上限**，不从任意数字里猜；②**解析不出才减半**，
 * 且必须收敛到下限而不是无限缩小。
 *
 * ⚠️ 用户口径（接力文档「设计约定 3」）：**能拿到供应商真值的一律用真值**，
 * 本学习器**只服务兜底路径** —— 所以最后两段用源码文本钉住优先级顺序：
 * 聚合层是「`widest ?? 动态值`」、zcode 是「学到的只在**更小**时才覆盖声明值」，
 * 防止有人把它改成「动态值优先」。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

const KEY = contextWindowKey('aggregate', 'glm-5.3-flash')

beforeEach(() => {
  resetLearnedContextWindows()
})

describe('context-window-learn：起步值与记忆', () => {
  it('没学过时给起步值 1M（用户口径：起步给大）', () => {
    expect(DYNAMIC_CONTEXT_WINDOW_START).toBe(1_000_000)
    expect(dynamicContextWindowFor(KEY)).toBe(1_000_000)
  })

  it('学到的值立刻生效（不需要重启，也不落盘）', () => {
    const learned = rememberContextWindowFailure(KEY, "This model's maximum context length is 128000 tokens.")
    expect(learned).toBe(128_000)
    expect(dynamicContextWindowFor(KEY)).toBe(128_000)
  })

  it('键按 provider + 模型隔离，且用 NUL 分隔（`a/b`+`c` 不与 `a`+`b/c` 撞键）', () => {
    rememberContextWindowFailure(KEY, 'maximum context length is 200000 tokens')
    expect(dynamicContextWindowFor(contextWindowKey('zcode', 'glm-5.3-flash'))).toBe(1_000_000)
    expect(dynamicContextWindowFor(contextWindowKey('aggregate', 'auto'))).toBe(1_000_000)
    expect(contextWindowKey('a/b', 'c')).not.toBe(contextWindowKey('a', 'b/c'))
  })

  it('`learnedContextWindow` 没学过时是 undefined（zcode 靠它区分「回落声明值」）', () => {
    expect(learnedContextWindow(KEY)).toBeUndefined()
    rememberContextWindowFailure(KEY, 'maximum context length is 200000 tokens')
    expect(learnedContextWindow(KEY)).toBe(200_000)
  })
})

describe('context-window-learn：从报文抓真实上限', () => {
  it('认网关措辞 `N tokens > M maximum`', () => {
    expect(rememberContextWindowFailure(KEY, 'prompt is too long: 1061554 tokens > 1048576 maximum')).toBe(1_048_576)
  })

  it('认 `maximum context length is N`（含千分位逗号）', () => {
    expect(contextWindowFromFailureText('maximum context length is 262144 tokens')).toBe(262_144)
    expect(contextWindowFromFailureText('maximum context length is 1,048,576 tokens')).toBe(1_048_576)
  })

  it('不从无关数字里猜上限（反向）', () => {
    expect(contextWindowFromFailureText('input has 500000 tokens')).toBeUndefined()
    expect(contextWindowFromFailureText('{"code":429,"message":"slow down"}')).toBeUndefined()
    // 过小的「上限」是伪形态（报文里的用量/状态码），认了就会把声明压到错误量级。
    expect(contextWindowFromFailureText('prompt is too long: 900 tokens > 512 maximum')).toBeUndefined()
  })
})

describe('context-window-learn：解析不出时减半收敛', () => {
  it('连续撞墙逐次减半，并停在下限', () => {
    expect(rememberContextWindowFailure(KEY, '上游 400：请求过大')).toBe(500_000)
    expect(rememberContextWindowFailure(KEY, '上游 400：请求过大')).toBe(250_000)
    expect(rememberContextWindowFailure(KEY, '上游 400：请求过大')).toBe(125_000)
    for (let i = 0; i < 8; i += 1) rememberContextWindowFailure(KEY, '上游 400：请求过大')
    expect(dynamicContextWindowFor(KEY)).toBe(DYNAMIC_CONTEXT_WINDOW_FLOOR)
  })

  it('中文报文不猜措辞，走减半兜底（证据不足时不引入第二套判据）', () => {
    expect(rememberContextWindowFailure(KEY, '上下文超限，请缩短输入')).toBe(500_000)
  })
})


/* ⚠️ **聚合层接线的源码文本断言（原 30+ 条）已删除**（2026-10-15，随 Gitee rc.11 同步）。
   理由：rc.11 用 contextWindowFor 从候选集**推导**窗口上限，取代了胶囊的「按会话分桶观测 + learnedContextWindow 覆盖」架构；且 context-window-learn.ts 的注释明确写着「不要拿历次观测的峰值」。逐条改写等于为重写整个 spec，而它们测的架构已不存在。
   删除依据：这些断言钉的是**已不存在的架构**（逐条对照 rc.11 源码确认）。
   保留的用例测的是胶囊自有模块（context-window-learn / context-window-store）
   的纯函数与持久化行为，与聚合层架构无关，仍然有效。 */

describe('截断学习与 loomy spark-x 口径（2026-10-12 用户实测）', () => {
  it('`rememberContextWindowCeiling`：只收窄、不放大，且低于下限不记', () => {
    const key = contextWindowKey('loomy', 'spark-x')
    expect(learnedContextWindow(key)).toBeUndefined()
    expect(rememberContextWindowCeiling(key, 209_000)).toBe(209_000)
    expect(learnedContextWindow(key)).toBe(209_000)
    // 更大的观测值**不得**把声明放大。
    expect(rememberContextWindowCeiling(key, 300_000)).toBeUndefined()
    expect(learnedContextWindow(key)).toBe(209_000)
    // 更小的观测继续收窄（单调、方向保守）。
    expect(rememberContextWindowCeiling(key, 150_000)).toBe(150_000)
    // 无效观测不记（「未知不编造」）。
    expect(rememberContextWindowCeiling(contextWindowKey('a', 'b'), Number.NaN)).toBeUndefined()
    expect(rememberContextWindowCeiling(contextWindowKey('a', 'b'), 1_000)).toBeUndefined()
  })

  it('spark-x 的声明值改为 Loomy **客户端自己的口径** 262144', () => {
    const product = read('src/loomy-product.ts')
    expect(product).toContain("contextWindow: 262_144")
    // 反向：远端那条 1M 声明不得回来（它是本次报障的成因）。
    expect(product).not.toContain("spark-x', name: 'Spark X2.5 · x0.1', contextWindow: 1_048_576")
  })

  /* ⚠️ 「usage 规模解析」用例已删除（2026-10-15，随 rc.11 同步）：
     它测的 `contextTokensOfUsage`（totalTokens 优先 / 四项求和 / 全无则 undefined）
     是胶囊旧架构的辅助函数，rc.11 的 aggregate-adapter 用 contextWindowFor 推导窗口、
     该函数已不存在。usage 规模的解析职责现由 dsh-llm 侧承担。 */
})


/* ⚠️ **zcode 接线的源码文本断言已删除**（2026-10-15，随 Gitee rc.11 同步）。
   理由：rc.11 的 zcode 适配器改用目录声明值 + 学习值覆盖，不再有本 spec 钉的那两处写法。
   删除依据：这些断言钉的是**已不存在的架构**（逐条对照 rc.11 源码确认）。
   保留的用例测的是胶囊自有模块（context-window-learn / context-window-store）
   的纯函数与持久化行为，与聚合层架构无关，仍然有效。 */

describe('★ 已学窗口持久化（9.22）：只落硬证据 / 读回 / 自愈', () => {
  /** 假后端：只记录 `remember` 调用，不碰文件系统（真文件的 round-trip 见最后一条）。 */
  function makeFakeStore(initial: Array<[string, number]> = []) {
    const windows = new Map<string, number>(initial)
    const writes: Array<[string, number]> = []
    return {
      windows,
      writes,
      load: () => windows,
      remember: (key: string, window: number) => {
        writes.push([key, window])
        windows.set(key, window)
      },
      flush: () => {},
    }
  }

  it('只落「报文里读出来的真实上限」；「减半猜」的值不落盘（但内存仍要记）', () => {
    const store = makeFakeStore()
    const detach = attachContextWindowStore(store)
    try {
      const reported = contextWindowKey('loomy', 'spark-x')
      const guessed = contextWindowKey('buddy', 'glm-4.6')
      rememberContextWindowFailure(reported, "This model's maximum context length is 262144 tokens")
      rememberContextWindowFailure(guessed, '上游返回了一个无法解析的错误')
      expect(store.writes, '只有报文里读得出上限的那次才该落盘').toEqual([[reported, 262_144]])
      expect(learnedContextWindow(guessed), '猜出来的值仍然要记在内存里').toBeDefined()
    } finally {
      detach()
    }
  })

  it('挂载时从盘上 hydrate，且与内存已有值取**更小**的那个', () => {
    const key = contextWindowKey('loomy', 'spark-x')
    rememberContextWindowCeiling(key, 100_000) // 内存里先有更大的
    const store = makeFakeStore([[key, 60_000]]) // 盘上是更小的
    const detach = attachContextWindowStore(store)
    try {
      expect(learnedContextWindow(key), '取更小 ⇒ 更早压缩 ⇒ 安全方向').toBe(60_000)
    } finally {
      detach()
    }
  })

  it('自愈：成功轮的实测规模可放宽偏小的值并落盘；实测更小则什么都不做', () => {
    const store = makeFakeStore()
    const detach = attachContextWindowStore(store)
    try {
      const key = contextWindowKey('loomy', 'spark-x')
      rememberContextWindowFailure(key, 'maximum context length is 8192') // 被误读成很小的值
      expect(noteContextWindowSuccess(key, 120_000), '实测装得下 12 万 ⇒ 放宽').toBe(120_000)
      expect(learnedContextWindow(key)).toBe(120_000)
      expect(store.windows.get(key), '放宽后的值也要落盘').toBe(120_000)
      expect(noteContextWindowSuccess(key, 100_000), '只放大、不缩小').toBeUndefined()
      expect(learnedContextWindow(key)).toBe(120_000)
    } finally {
      detach()
    }
  })

  it('disposer 只摘自己：旧实例的 dispose 不会摘掉新挂载', () => {
    const storeA = makeFakeStore()
    const storeB = makeFakeStore()
    const detachA = attachContextWindowStore(storeA)
    const detachB = attachContextWindowStore(storeB)
    detachA()
    const key = contextWindowKey('loomy', 'spark-x')
    rememberContextWindowFailure(key, 'maximum context length is 123456')
    expect(storeB.writes, '写入应落到仍挂载的 B').toEqual([[key, 123_456]])
    expect(storeA.writes, 'A 已被摘除，不该再收到写入').toEqual([])
    detachB()
  })

  it('真文件 round-trip：写盘后由**新实例**读回（重启不丢）', async () => {
    const { existsSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'cw-spec-'))
    const previous = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = home
    try {
      const key = contextWindowKey('loomy', 'spark-x')
      const detach1 = attachContextWindowStore(createContextWindowStore({ logger: { warn: () => {} } } as never))
      rememberContextWindowFailure(key, 'prompt is too long: 300000 tokens > 262144 maximum')
      detach1()
      expect(existsSync(join(home, 'jet-hub', 'context-windows.json')), '应真的写盘').toBe(true)
      // 模拟重启：清内存 + 新实例挂同一份盘
      resetLearnedContextWindows()
      expect(learnedContextWindow(key)).toBeUndefined()
      const detach2 = attachContextWindowStore(
        createContextWindowStore({ logger: { warn: () => {} } } as never),
      )
      try {
        expect(learnedContextWindow(key), '重启后仍然知道').toBe(262_144)
      } finally {
        detach2()
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = previous
    }
  })
})
