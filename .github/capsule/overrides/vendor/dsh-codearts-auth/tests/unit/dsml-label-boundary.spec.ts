/**
 * `dsml-label-boundary.spec.ts` —— 前视边界必须含「协议标签名首字母」。
 *
 * ## 为什么单独立一个 spec（2026-10-14 移植上游二次审计修正）
 *
 * `dsml-marker-normalizer.spec.ts` 的用例 ⑧ 覆盖了「`DSML` 后有分隔边界时
 * 仍要修」，但它列的合法边界集合是 `｜` / 空白 / `>` / `/` / `$`，
 * **漏了字母**。
 *
 * 上游实测形态：`<｜｜DSML｜｜ invoke name="…">` —— 右侧双竖线后紧跟的是
 * `invoke` 的 `i`。旧前视遇到字母就跳过 ⇒ 第一段把 `<｜｜DSML` 修成
 * `<｜DSML`，第二段却跳过 ⇒ 留下 `<｜DSML｜｜invoke` 这种**半修形态**，
 * 比不修更糟（看起来修过、实际仍解析不了）。
 *
 * 本文件把这个坑钉住：合法边界 = 旧集合 **∪ 协议标签名首字母**
 * （`t`ool_calls、`c`alls、`i`nvoke、`p`arameter、`t`hought）。
 */

import { describe, expect, it } from 'vitest'
import { createDsmlMarkerNormalizer, fixDsmlMarkers } from '../../src/sse.js'

const BAR = '\uFF5C'

/** 协议标签名（开闭标签都可能是坏标记的右邻）。 */
const LABELS = ['tool_calls', 'calls', 'invoke', 'parameter', 'thought'] as const

/** 把 text 按所有切分点二分帧喂给归一化器。 */
function feedByAllSplits(text: string): string[] {
  const results: string[] = []
  for (let cut = 0; cut <= text.length; cut++) {
    const n = createDsmlMarkerNormalizer()
    let out = n.push(text.slice(0, cut))
    out += n.push(text.slice(cut))
    out += n.flush()
    results.push(out)
  }
  return results
}

describe('前视必须含协议标签名首字母（上游二次审计修正）', () => {
  /**
   * 每个标签名逐个验：右侧双竖线后紧跟该标签首字母时必须修。
   * 这是本 spec 的核心 —— 旧前视在这里全部漏判。
   */
  for (const label of LABELS) {
    it(`① 右侧双竖线 + ${label}（首字母 ${label[0]}）→ 必须修`, () => {
      const broken = `<${BAR}${BAR}DSML${BAR}${BAR}${label} name="write">`
      const expected = `<${BAR}DSML${BAR}${label} name="write">`
      expect(fixDsmlMarkers(broken), `${label} 前的双竖线必须收敛`).toBe(expected)
    })
  }

  it('② 开标签侧的同一形态（`</` 闭标签）也要修', () => {
    const broken = `</${BAR}${BAR}DSML${BAR}${BAR}invoke>`
    const expected = `</${BAR}DSML${BAR}invoke>`
    expect(fixDsmlMarkers(broken)).toBe(expected)
  })

  it('③ 半修形态不得出现（第一段修了、第二段必须也修）', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR} invoke name="write">`
    const fixed = fixDsmlMarkers(broken)
    expect(fixed.includes(`${BAR}${BAR}`), '不得残留双竖线').toBe(false)
    expect(fixed).toBe(`<${BAR}DSML${BAR} invoke name="write">`)
  })

  /**
   * 反向：不泛化成「任意字母」—— `DSMLX` 这类以 DSML 开头的普通词仍不得误伤。
   * 这是本轮要同时守住的两侧。
   */
  it('④ 反向：非协议标签的字母开头词仍不得误伤', () => {
    const discussing = `<${BAR}${BAR}DSMLX 这不是标记，只是文字`
    expect(fixDsmlMarkers(discussing), 'DSMLX 不是标记，原样保留').toBe(discussing)
    const rightSide = `工具名 DSML${BAR}${BAR}Xyz 也不是标记`
    expect(fixDsmlMarkers(rightSide), '右侧非协议字母也不改').toBe(rightSide)
  })

  it('⑤ 协议首字母集合之外的字母（如 x/z）仍不误伤', () => {
    // `x` / `z` 不在 [tcip] 里 ⇒ 保持旧行为（不修也不误伤）
    const text = `<${BAR}${BAR}DSMLx 普通词`
    expect(fixDsmlMarkers(text)).toBe(text)
  })

  it('⑥ 二分帧穷举：坏标记 + 标签名，任意切分结果一致', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR}tool_calls>正文</${BAR}${BAR}DSML${BAR}${BAR}tool_calls>`
    const expected = broken.replaceAll(`${BAR}${BAR}DSML`, `${BAR}DSML`).replaceAll(`DSML${BAR}${BAR}`, `DSML${BAR}`)
    const results = feedByAllSplits(broken)
    const bad = results.filter(r => r !== expected)
    expect(bad, `${bad.length}/${results.length} 种切法失败`).toEqual([])
  })

  it('⑦ 流式：跨帧粘合出「标签名紧跟双竖线」也必须修', () => {
    const n = createDsmlMarkerNormalizer()
    const out = n.push(`<${BAR}${BAR}DSML${BAR}`) + n.push(`${BAR}invoke name="pwsh">`) + n.flush()
    expect(out).toBe(`<${BAR}DSML${BAR}invoke name="pwsh">`)
  })
})
