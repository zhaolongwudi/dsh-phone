import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  DYNAMIC_CONTEXT_WINDOW_FLOOR,
  DYNAMIC_CONTEXT_WINDOW_START,
  contextWindowFromFailureText,
  contextWindowKey,
  dynamicContextWindowFor,
  learnedContextWindow,
  rememberContextWindowFailure,
  resetLearnedContextWindows,
} from '../../src/context-window-learn.js'

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

  it('兜底是动态值，且真值优先（`widest ??` 的顺序不得颠倒）', () => {
    expect(source).toContain('widest ?? dynamicContextWindowFor(contextWindowKey(AGGREGATE_PROVIDER, modelKey))')
  })

  it('撞墙处（且仅在归成溢出码时）记录学习', () => {
    expect(source).toContain('if (code === CONTEXT_WINDOW_EXCEEDED_CODE) {')
    expect(source).toContain('rememberContextWindowFailure(')
  })

  it('动态值不进记忆化缓存（解析到真值才缓存，学过才能立刻生效）', () => {
    expect(source).toContain('allResolved && widest !== undefined')
  })

  it('写死的 200K 兜底常量已删除', () => {
    expect(source).not.toContain('AGGREGATE_FALLBACK_CONTEXT_WINDOW')
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
