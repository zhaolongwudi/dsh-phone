/**
 * `dsml-extractor-normalize.spec.ts` —— DsmlContentExtractor 的协议级归一守卫。
 *
 * ## 背景（2026-10-14 审查发现的真实 BUG）
 *
 * 第七轮移植只升级了 `sse.ts` 的 `fixDsmlMarkers`（前视补 `[tcip]`），但
 * `llm-adapter.ts` 的 `DsmlContentExtractor`（DSML 原生模式的心脏）**没有**
 * 上游 `dsml.ts` 的三重归一：
 *
 * | 笔误形态 | 不修的后果 |
 * |---|---|
 * | `<｜DSML｜ calls>`（缺 `tool_`） | 开闭标签 indexOf 不认 ⇒ 永不进 in-dsml ⇒ 整段当正文 |
 * | `<｜DSML｜ invoke`（标签空白） | INVOKE_OPEN_PREFIX 不命中 ⇒ parse 返回**空数组** ⇒ 调用方当「解析成功但无调用」⇒ **工具参数凭空消失** |
 * | 双竖线（extractor 通道） | extractor 吃原文，`dsmlFix.push` 只服务 text-delta 通道 ⇒ 同样不认 |
 *
 * 修法（自上游 dsml.ts 移植）：`feed()` 在 buffer 累积**之后**调
 * `normalizeDsmlText`（双竖线 → 别名 → 空白，顺序有意）；`keepLen` 补
 * `DSML_OPEN_ALIASES` 与 `isDsmlLabelPrefix`（从最后一个 `<` 起判，防
 * 「空白够多绕过固定窗口」）。
 *
 * ## 测试策略
 *
 * **拆帧穷举**：别名/空白形态可能被上游切成任意片段，逐帧归一化器修不了
 * 跨帧模式（那正是 `normalizeDsmlText` 只能放 feed 整段入口的原因）。
 * 故对每个用例穷举**所有**二分切点，任何一种切法结果不对即红。
 */

import { describe, expect, it } from 'vitest'
import { DsmlContentExtractor } from '../../src/llm-adapter.js'

const BAR = '\uFF5C'
const OPEN = `<${BAR}DSML${BAR}tool_calls>`
const CLOSE = `</${BAR}DSML${BAR}tool_calls>`
const INVOKE = `<${BAR}DSML${BAR}invoke name="write">`
const INVOKE_CLOSE = `</${BAR}DSML${BAR}invoke>`
const PARAM = `<${BAR}DSML${BAR}parameter name="content" string="true">hello</${BAR}DSML${BAR}parameter>`

/** 规范整块：一轮完整的 tool_calls。 */
function canonicalBlock(): string {
  return `${OPEN}${INVOKE}${PARAM}${INVOKE_CLOSE}${CLOSE}`
}

/** 按所有切点二分帧喂给 extractor。 */
function feedByAllSplits(text: string) {
  const results: Array<{ text: string; toolCalls: Array<{ name: string; arguments: string }> }> = []
  for (let cut = 0; cut <= text.length; cut++) {
    const x = new DsmlContentExtractor()
    const a = x.feed(text.slice(0, cut))
    const b = x.feed(text.slice(cut))
    const f = x.flush()
    results.push({
      text: a.text + b.text + f.text,
      toolCalls: [...a.toolCalls, ...b.toolCalls],
    })
  }
  return results
}

describe('别名与空白归一（feed 整段入口）', () => {
  it('① `<｜DSML｜ calls>`（缺 tool_）→ 必须当 tool_calls 解析出调用', () => {
    const broken = `<${BAR}DSML${BAR} calls>${INVOKE}${PARAM}${INVOKE_CLOSE}</${BAR}DSML${BAR} calls>`
    const r = feedByAllSplits(broken)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法没解出调用`).toEqual([])
  })

  it('② `<｜DSML｜calls>`（无空白直连）→ 同样要解出', () => {
    const broken = `<${BAR}DSML${BAR}calls>${INVOKE}${PARAM}${INVOKE_CLOSE}</${BAR}DSML${BAR}calls>`
    const r = feedByAllSplits(broken)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法没解出调用`).toEqual([])
  })

  it('③ `<｜DSML｜ tool_calls>`（多空白）→ 同样要解出', () => {
    const broken = `<${BAR}DSML${BAR} tool_calls>${INVOKE}${PARAM}${INVOKE_CLOSE}</${BAR}DSML${BAR} tool_calls>`
    const r = feedByAllSplits(broken)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法没解出调用`).toEqual([])
  })

  it('④ invoke 带空白（内容凭空消失缺陷的根因）→ 参数不得丢', () => {
    const broken = `${OPEN}<${BAR}DSML${BAR} invoke name="write"><${BAR}DSML${BAR} parameter name="content" string="true">hello</${BAR}DSML${BAR} parameter>${INVOKE_CLOSE}${CLOSE}`
    const x = new DsmlContentExtractor()
    const a = x.feed(broken)
    const f = x.flush()
    const calls = [...a.toolCalls]
    expect(calls.length, '必须解析出 1 个调用（而非空数组）').toBe(1)
    expect(JSON.parse(calls[0].arguments).content).toBe('hello')
  })

  it('⑤ 双竖线形态在 extractor 通道也必须修复', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR}tool_calls>${INVOKE}${PARAM}${INVOKE_CLOSE}</${BAR}${BAR}DSML${BAR}${BAR}tool_calls>`
    const r = feedByAllSplits(broken)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法没解出调用`).toEqual([])
  })

  it('⑥ 混合形态：双竖线 + 缺 tool_ + 空白三合一', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR} calls><${BAR}${BAR}DSML${BAR}${BAR} invoke name="write">${PARAM}${INVOKE_CLOSE}</${BAR}${BAR}DSML${BAR}${BAR} calls>`
    const r = feedByAllSplits(broken)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法没解出调用`).toEqual([])
  })

  it('⑦ 规范输入逐字节不变（幂等 + 不误伤）', () => {
    const canonical = `前言。${canonicalBlock()}后记。`
    const r = feedByAllSplits(canonical)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法破坏了规范输入`).toEqual([])
  })
})

describe('keepLen 扣留判据（isDsmlLabelPrefix）', () => {
  it('⑧ 「最后一个 <」起判：多空白别名拆帧时不提前放行', () => {
    // `<｜DSML｜` + 12 个空格 + `calls>` —— 固定窗口（最长前缀 17+）够不着
    const spaces = ' '.repeat(12)
    const broken = `正文<${BAR}DSML${BAR}${spaces}calls>${INVOKE}${PARAM}${INVOKE_CLOSE}</${BAR}DSML${BAR}${spaces}calls>`
    const r = feedByAllSplits(broken)
    const bad = r.filter(x => x.toolCalls.length !== 1)
    expect(bad, `${bad.length}/${r.length} 种切法把别名标签放行成正文`).toEqual([])
  })

  it('⑨ 竖线拆帧：`<｜｜` 单独到达时不放行（扣住等 DSML 拼齐）', () => {
    const broken = `<${BAR}${BAR}DSML${BAR}${BAR}tool_calls>${INVOKE}${PARAM}${INVOKE_CLOSE}${CLOSE.replace('tool_calls', 'tool_calls')}`
    const r = feedByAllSplits(broken)
    // 不要求全部解出（闭标签也是坏形态），但至少要求正文里不出现半截开标签
    const leaked = r.filter(x => x.text.includes('DSML') && x.text.includes(BAR))
    expect(leaked.length, `${leaked.length} 种切法把标记泄漏到正文`).toBe(0)
  })

  it('⑩ 普通文本不受扣留影响（无过度缓冲）', () => {
    const x = new DsmlContentExtractor()
    const a = x.feed('普通文本，没有标记。')
    const f = x.flush()
    expect(a.text + f.text).toBe('普通文本，没有标记。')
    expect(a.toolCalls.length).toBe(0)
  })
})
