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

describe('聚合层接线（源码文本断言）', () => {
  const source = read('src/aggregate-adapter.ts')

  it('声明值 = 候选最大值；**学习值不得再收窄它**（2026-10-12 修正）', () => {
    // ⚠️ 这是**反向**断言。9.22 之前这里有个 `applyLearnedWindow`：它按**虚拟模型**收窄
    //    声明值 ⇒ 一个窄候选撞墙就把整个虚拟模型压低，之后**换回宽窗口的候选也不恢复**
    //    （用户 2026-10-12 实测提出：「换回 100 万的模型后上限还是 25.6 万」）。
    //    而虚拟声明本就取候选最大值 ⇒ 池整体窄时它自然就窄 —— 那层收窄既多余又有害。
    expect(source).toContain('const declared = widest ?? dynamicContextWindowFor(contextWindowKey(AGGREGATE_PROVIDER, modelKey))')
    expect(source).toContain('const resolved = declared')
    // 反向：任何「再把学习值套回声明值」的写法都不得回来。⚠️ 判据用**方法调用**形态，
    // 因为 JSDoc 里正当地提到了这个名字（裸词断言会误判自己的注释）。
    expect(source).not.toContain('this.applyLearnedWindow')
    expect(source).not.toContain('if (learned < declared) {')
    // 反向：旧的「真值优先、动态值只做 fallback」一行式也不得回来。
    expect(source).not.toContain('const resolved = widest ?? dynamicContextWindowFor(')
  })

  it('学习值只用于**筛选候选**（按候选键）；zcode 的单渠道收窄口径不变', () => {
    expect(source).toContain('const cap = learnedContextWindow(contextWindowKey(candidate.provider, candidate.realId))')
    // zcode 的键**就是该渠道自己**（单渠道），不存在「一个候选压低整个池」的问题 ⇒ 判据不变。
    expect(read('src/zcode-adapter.ts')).toContain(
      'learned !== undefined && (contextWindow === undefined || learned < contextWindow)',
    )
  })

  it('缓存存的就是对外值（候选最大值），记忆化分支不再套学习值', () => {
    expect(source).toContain('this.contextWindowCache.set(modelKey, widest)')
    expect(source).not.toContain('this.contextWindowCache.set(modelKey, resolved)')
    expect(source).toContain('if (remembered !== undefined) return remembered')
  })

  it('撞墙处（且仅在归成溢出码时）**按该候选**记录学习', () => {
    expect(source).toContain('if (code === CONTEXT_WINDOW_EXCEEDED_CODE) {')
    expect(source).toContain('rememberContextWindowFailure(')
    // ⚠️ 必须记**候选键**：记虚拟模型会粘性压低整个虚拟模型的对外声明（见上一条）。
    expect(source).toContain('contextWindowKey(target.provider, target.realId), message,')
    // 反向：不得再把虚拟模型键喂给失败学习。
    expect(source).not.toContain('contextWindowKey(AGGREGATE_PROVIDER, modelKey), message')
  })

  it('**截断也算证据**：`finish: max-tokens` 时用观测规模记上限（方案 B，2026-10-12）', () => {
    // 上游常常不报错、只按自己的上限截断 ⇒ 只挂失败路径的学习器完全收不到信号。
    expect(source).toContain("chunk.type === 'finish' && chunk.reason.kind === 'max-tokens'")
    expect(source).toContain('rememberContextWindowCeiling(')
    expect(source).toContain('const seen = contextTokensOfUsage(chunk.usage)')
    // ⚠️ F-04 后，观测规模**按会话分桶**（`lastContextTokensBySession`）：原先那个
    //    进程级 `self.lastContextTokens = Math.max(...)` 只增不减、且跨会话串味
    //    （一个小会话会被别的大会话的峰值判成「装不下」）⇒ 已改为此形态。
    //    断言同步改为新写法：请求内取最大落局部变量，落桶交给
    //    `recordSessionContextTokens`（**覆盖**语义，压缩变小后能如实下降）。
    expect(source).toContain('requestTokens = Math.max(requestTokens ?? 0, seen)')
    expect(source).toContain('self.recordSessionContextTokens(sessionKey, requestTokens)')
    // 反向：进程级只增峰值那个字段不得回来（F-04 的根因形态）。
    expect(source).not.toContain('self.lastContextTokens = Math.max(self.lastContextTokens ?? 0, seen)')
    // ⚠️ 同样只记**候选键**（2026-10-12 修正）：虚拟模型那侧自本次修正起不再记学习值。
    expect(source).toContain('contextWindowKey(target.provider, target.realId), observed,')
    expect(source).not.toContain('const virtual = rememberContextWindowCeiling(')
  })

  it('**派发前按本轮体积跳过太窄的候选**（方案 C，2026-10-12）', () => {
    expect(source).toContain('let attemptTargets: readonly DispatchTarget[] = targets')
    expect(source).toContain('for (let index = 0; index < attemptTargets.length; index += 1)')
    expect(source).toContain('const cap = learnedContextWindow(contextWindowKey(candidate.provider, candidate.realId))')
    // 留 5% 余量（上游按「输入 + 输出」计总量）。
    expect(source).toContain('Math.ceil(observedTokens * 1.05)')
    // ⚠️ 兜底：全被筛掉时**不得**凭空得出「没有可用候选」。
    expect(source).toContain('放弃筛选、照常逐个尝试')
  })


  it('**零输出撞墙 ⇒ 换下一个候选重发**（方案 F，2026-10-12 接线；此前只有 auto 接了）', () => {
    // 判据必须复用共享守卫（`zero-output-guard.ts` 是唯一权威），不得另写一份。
    expect(source).toContain("import {")
    expect(source).toContain("} from './zero-output-guard.js'")
    expect(source).toContain('zeroProbe = noteChunk(zeroProbe, chunk)')
    expect(source).toContain('if (chunk.type === \'finish\' && isZeroOutputWallHit(zeroProbe)) {')
    expect(source).toContain('self.zeroOutputCooldowns = noteZeroOutputHit(')
    expect(source).toContain('if (reroute) continue')
    // ⚠️ 已开块/已吐内容**不得**重发（重发会让内容灌进错误的块类型）。
    expect(source).toContain('if (emitted || openedBlocks.size > 0) {')
  })

  it('冷却中的候选在派发前被跳过（与体积筛选同一处，避免重复撞墙）', () => {
    expect(source).toContain('isTargetCoolingDown(self.zeroOutputCooldowns, candidate.provider, candidate.realId')
  })

  it('动态值不进记忆化缓存（解析到真值才缓存，学过才能立刻生效）', () => {
    expect(source).toContain('allResolved && widest !== undefined')
  })

  it('写死的 200K 兜底常量已删除', () => {
    expect(source).not.toContain('AGGREGATE_FALLBACK_CONTEXT_WINDOW')
  })
})

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

  it('usage 规模解析：totalTokens 优先，缺失时四项求和，全无则 undefined', () => {
    const source = read('src/aggregate-adapter.ts')
    expect(source).toContain('function contextTokensOfUsage(')
    expect(source).toContain('if (typeof usage.totalTokens === \'number\'')
    expect(source).toContain('return sum > 0 ? sum : undefined')
  })
})

describe('zcode 接线（源码文本断言）', () => {
  const adapter = read('src/zcode-adapter.ts')
  const upstream = read('src/zcode-upstream.ts')

  it('目录对缺窗口的模型给起步值，不再写死 200K', () => {
    expect(upstream).toContain(': DYNAMIC_CONTEXT_WINDOW_START,')
    expect(upstream).not.toContain(': 200_000,')
  })

  it('适配器只在「学到的值更小」时才覆盖目录声明值（真值仍优先）', () => {
    expect(adapter).toContain(
      'learned !== undefined && (contextWindow === undefined || learned < contextWindow)',
    )
  })

  it('撞墙处（且仅在归成溢出码时）记录学习', () => {
    expect(adapter).toContain('if (code === CONTEXT_WINDOW_EXCEEDED_CODE) {')
    expect(adapter).toContain('rememberContextWindowFailure(')
  })
})

/**
 * ★ 已学窗口的**持久化**（9.22 要点 2）：只落硬证据、重启读回、成功自愈、disposer 所有权。
 *
 * ## 为什么「只落硬证据」必须被用例钉住
 *
 * 落盘**推翻了** 9.11「只记进程内」的决定，而那次决定防的是「把学错的值永久固化」。
 * 能否安全落盘**完全取决于**「只落有证据的值」这一条 —— 一旦有人顺手把「减半猜」
 * 的值也写下去，固化的风险立刻回来。故此处逐条钉死。
 */
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
