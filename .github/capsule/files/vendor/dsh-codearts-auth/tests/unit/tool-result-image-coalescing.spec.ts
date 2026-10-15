/**
 * `tool-result-image-coalescing.spec.ts` —— 工具结果图片必须与提问**同在一条 user 消息**
 * （Gitee issue IKLIFH，2026-10-14 自上游移植）。
 *
 * ## 被守住的缺陷（真实报障）
 *
 * 「codebuddy hy4 不支持识别图片」。上游实测（2026-10-14，直连
 * `copilot.tencent.com`，hy4-preview，同一张 1024x768 双色图，问「左右分别什么颜色」）：
 *
 * | wire 形态                                     | 上游行为            |
 * |-----------------------------------------------|---------------------|
 * | 图与提问**同一条** user                        | ✅ 「左白右蓝」     |
 * | 图与提问**同一条**，且前面已存在 tool 消息     | ✅ 「左白右蓝」     |
 * | 图单独一条 user（有提示句），问在下一条       | ❌ 「图像已被过滤」 |
 * | 图单独一条 user（**无**提示句），问在下一条   | ❌ 「不支持图片识别」|
 * | 图并入 `role:'tool'` 消息本身                 | ❌ 「不支持读取图片」|
 *
 * ⇒ 触发条件是**图片与提问不在同一条 user 消息**。
 *
 * ⚠️ 症状极具误导性：wire 上**确实有图**（抓包可见 `image_url` data URL）、
 * 上游也**不报错**（HTTP 200 + 正常流），只是模型**看不见**并自称
 * 「当前模型不支持图片输入」⇒ 用户会误判成模型能力问题、反复换模型。
 *
 * ## 三处同型实现
 *
 * `openai-compat.ts`（zcode / qoder / opencode 等复用）、`buddy-adapter.ts`、
 * `lobsterai-adapter.ts` —— 三份 `serializeMessages` 各有自己的
 * `pendingToolImages` / `flushToolImages`，修复必须**三处同步**（漏一处 =
 * 那一家继续「看不见图」且完全无痕）。
 *
 * ## ⚠️ 手机版对上游实现的**有意收窄**（本文件的第一条用例锁它）
 *
 * 上游 `flushToolImages` **无条件**把图排到文本之前。本仓库实测：那会翻转
 * **普通贴图**（无工具结果）的既有顺序 —— `[text, image]` 变成 `[image, text]`，
 * 使既有 spec 的断言变红（`stream sends user images as inline image_url parts`
 * 与「贴图这一轮会自动重看目录」，buddy / lobsterai 同型）。
 *
 * 顺序本身**不影响模型能否看见图片**（上游注释亦称「两种顺序实测都能被看到」），
 * 故手机版按最小改动原则收窄：**无挂图时 `own` 原样发出**（旧行为逐字节不变），
 * 只有确实要「图与提问合条」时才做图前置的重排。
 *
 * ## 为什么本文件用**真适配器**而不是只做源码扫描
 *
 * 图片合条是**行为**（wire 形态），源码扫描只能证明「接线在」，证明不了
 * 「发出去的那条到底长什么样」。故下面用 `openai-compat.serializeMessages`
 * 这个**导出的纯函数**做行为断言（它是三份实现里唯一可直接调用的），
 * 再对三份实现各做**结构守卫**（收窄分支与合条分支必须同时在）。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { serializeMessages } from '../../src/openai-compat.js'

/**
 * 去掉整行注释与块注释内容（**只为源码断言**）。
 *
 * ⚠️ 修复注释里**引用**了被断言的标识符（如 `flushToolImages`），用裸文本扫描会把
 * 注释当代码 ⇒ 真实现改了也照样绿。剥注释只处理整行 `//` 与块注释区间，
 * 够用且不误伤 URL 里的 `//`。
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

const IMAGE_ID = 'att-1'
const IMAGE_URLS = new Map([[IMAGE_ID, 'data:image/png;base64,AQID']])

/** 三处同型实现（IKLIFH 必须同步修；漏一处 = 那一家继续「看不见图」）。 */
const sources: Record<string, string> = {
  'openai-compat.ts': readFileSync(new URL('../../src/openai-compat.ts', import.meta.url), 'utf8'),
  'buddy-adapter.ts': readFileSync(new URL('../../src/buddy-adapter.ts', import.meta.url), 'utf8'),
  'lobsterai-adapter.ts': readFileSync(new URL('../../src/lobsterai-adapter.ts', import.meta.url), 'utf8'),
}

/** 构造：assistant tool_call → 工具结果内嵌图片 → （可选中间 user）→ 提问。 */
function messagesWithAsk(ask: string, middle?: string) {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'read_image', arguments: '{}' }] },
    {
      role: 'tool',
      toolCallId: 'tc1',
      content: [
        { type: 'text', text: 'preview 1024x768px.' },
        { type: 'image', attachment: { attachmentId: IMAGE_ID } },
      ],
    },
    ...middle === undefined ? [] : [{ role: 'user', content: middle }],
    { role: 'user', content: ask },
  ] as never
}

/** 含 `image_url` 的那条消息下标（`-1` = 图片丢失）。 */
function imageIndexOf(wire: Array<Record<string, unknown>>): number {
  return wire.findIndex((m) => Array.isArray(m.content)
    && (m.content as Array<{ type: string }>).some((p) => p.type === 'image_url'))
}

/** 含指定文本的那条消息下标（字符串与 parts 两种 content 形态都认）。 */
function textIndexOf(wire: Array<Record<string, unknown>>, needle: string): number {
  return wire.findIndex((m) => (typeof m.content === 'string' && m.content.includes(needle))
    || (Array.isArray(m.content)
      && (m.content as Array<{ text?: string }>).some((p) => typeof p.text === 'string' && p.text.includes(needle))))
}

describe('Issue IKLIFH：工具结果图片必须与提问同条', () => {
  it('★ 图片与提问合并为同一条 user 消息（真实报障形态）', () => {
    const wire = serializeMessages(messagesWithAsk('这页写了什么？'), IMAGE_URLS)
    const toolIndex = wire.findIndex((m) => m.role === 'tool')
    expect(toolIndex, '工具结果必须下发').toBeGreaterThan(-1)
    // 协议约束：tool 必须紧跟其 assistant tool_calls，否则上游 400。
    const assistantIndex = wire.findIndex((m) => m.role === 'assistant')
    expect(toolIndex).toBe(assistantIndex + 1)

    const imageIndex = imageIndexOf(wire)
    const askIndex = textIndexOf(wire, '这页写了什么')
    expect(imageIndex, '图片不得静默丢弃').toBeGreaterThan(-1)
    expect(askIndex, '提问不得静默丢弃').toBeGreaterThan(-1)
    // ⚠️ 核心断言：图与问**同一条**（本 issue 的正题）。
    expect(imageIndex, '图片必须与提问同条').toBe(askIndex)
    // 且必须排在 tool 之后（否则违反 tool 配对约束）。
    expect(imageIndex).toBeGreaterThan(toolIndex)
  })

  it('★ 中间多一条 user 时，图、延后正文与提问必须合为**同一条**（F-21）', () => {
    /**
     * ⚠️⚠️ **本用例在 2026-10-14 的 F-21 修复里被改写**（原断言写反了）。
     *
     * 原断言是 `expect(askIndex).toBeGreaterThan(imageIndex)` —— 即「图与提问
     * **分处两条**、提问在后面」。而 IKLIFH 自己的实测表写得明明白白：
     *
     * | wire 形态 | 上游行为 |
     * |---|---|
     * | 图单独一条 user（**有**提示句），问在下一条 | ❌「图像已被过滤」|
     *
     * ⇒ 原断言锁定的正是**要消灭的缺陷形态**（只是它比「纯图无文本」轻一档，
     * 所以当时没被发现）。上游 `32681a8b` 补修 IKLIFH 漏网序列时给出的对照是
     * 「修复前 [3]=`image_url+text(好的)`、[4]=`"这页写了什么？"`；
     * 修复后 [3]=`image_url+text(好的)+text(这页写了什么？)`（同一条）」。
     *
     * 故改为断言**同一条**，并把中间那条 user 的正文也纳入（它不得被丢弃）。
     * 判别力没有下降：把 F-21 的 `deferred` 判据回退成
     * `toolResults.length > 0`，本用例立刻变红（已实测）。
     */
    const wire = serializeMessages(messagesWithAsk('这页写了什么？', '好的'), IMAGE_URLS)
    const toolIndex = wire.findIndex((m) => m.role === 'tool')
    const imageIndex = imageIndexOf(wire)
    const askIndex = textIndexOf(wire, '这页写了什么')
    const middleIndex = textIndexOf(wire, '好的')
    expect(imageIndex, '图片发出').toBeGreaterThan(-1)
    expect(imageIndex, '图排在 tool 之后').toBeGreaterThan(toolIndex)
    expect(askIndex, '提问未被吞掉').toBe(imageIndex)
    expect(middleIndex, '中间那条 user 的正文未被吞掉').toBe(imageIndex)
    const imageMsg = wire[imageIndex] as { content: Array<{ type: string }> }
    expect(imageMsg.content.some((p) => p.type === 'text'), '图不得单独成一条（无任何文本）').toBe(true)
  })

  it('★★ 含工具结果的那条 user 消息**自带的正文**也不得丢失（deferred 的保护对象）', () => {
    /**
     * ⚠️⚠️ 这条是 `deferred` 的**唯一可观测判据**。
     *
     * 真实 harness 形态下，工具结果搭载在一条 **user** 消息里，而那条消息
     * **同时可以带用户自己的正文**（例如用户一边贴说明一边触发工具）。
     * `deferred` 的语义是「整条延后，留到下一条 user 消息搭车发出」——
     * 若把 deferred 关掉（或忘写延后落点 `pendingOwnParts = combined ?? …`），
     * 那条正文既不立即发（`combined` 为 undefined 且含工具结果）、
     * 也不留到下一次 ⇒ **静默丢失**。
     *
     * ⚠️ 首版用例只用了「纯 tool-result 的 user 消息」（其 text 为空），
     * 于是把 `deferred` 改成 `false` 时**零红**（实测）—— 判别力缺口。
     * 本用例补上「带正文」的形态。
     */
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'read_image', arguments: '{}' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是工具结果，请结合它回答' },
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            content: [
              { type: 'text', text: 'preview 1024x768px.' },
              { type: 'image', attachment: { attachmentId: IMAGE_ID } },
            ],
          },
        ],
      },
      { role: 'user', content: '这页写了什么？' },
    ] as never, IMAGE_URLS)

    // ⚠️ 正文不得丢（deferred 失效时它会静默消失）。
    expect(textIndexOf(wire, '这是工具结果，请结合它回答'), '含工具结果那条的正文被丢了（deferred 失效）')
      .toBeGreaterThan(-1)
    // ⚠️ 且提问同样不得丢。
    expect(textIndexOf(wire, '这页写了什么')).toBeGreaterThan(-1)
    // 图片仍必须与提问同条（本轮的正题）。
    expect(imageIndexOf(wire)).toBe(textIndexOf(wire, '这页写了什么'))
  })

  it('★ 历史末尾只有工具结果时，图片与延后正文仍须同条发出', () => {
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'read_image', arguments: '{}' }] },
      {
        role: 'tool',
        toolCallId: 'tc1',
        content: [
          { type: 'text', text: 'x' },
          { type: 'image', attachment: { attachmentId: IMAGE_ID } },
        ],
      },
    ] as never, IMAGE_URLS)
    expect(imageIndexOf(wire), '末尾残留图片仍发出').toBeGreaterThan(-1)
  })

  it('★ 无挂图时不凭空多发 user 消息（纯文本形态逐字节不变）', () => {
    // 修法把纯文本路径也交给了 `flushToolImages`，若它对「无挂图」也发消息，
    // 每轮纯文本对话都会多一条空 parts 消息（实测上游报 `model_param_invalid`）。
    const wire = serializeMessages([{ role: 'user', content: '你好' }] as never, undefined)
    const users = wire.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(typeof users[0]!.content, '纯文本必须是字符串（不是 parts 数组）').toBe('string')
    expect(users[0]!.content).toBe('你好')
  })

  it('★ 普通贴图（无工具结果）的 [text, image] 顺序不得被翻转（手机版收窄的守卫）', () => {
    /**
     * ⚠️ 这是**手机版相对上游的收窄**判据。
     *
     * 上游 `flushToolImages` 无条件做「图前置」重排：对这条「用户自己贴图」
     * 的消息（`own` 有图，但**没有**挂起的工具结果图片）也会重排成
     * `[image, text]`，翻转既有行为 —— 本仓库实测它让 buddy / lobsterai
     * 既有的两条 order 断言变红。
     *
     * ⇒ 手机版只在 `pendingToolImages` 非空时才重排。本用例锁死这条收窄：
     * 顺序必须与用户输入一致（`text` 在前）。
     */
    const wire = serializeMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么颜色？' },
          { type: 'image', attachment: { attachmentId: IMAGE_ID } },
        ],
      },
    ] as never, IMAGE_URLS)
    const users = wire.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]!.content, '普通贴图顺序被翻转了（手机版收窄失效）').toEqual([
      { type: 'text', text: '这是什么颜色？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
  })
})

describe('IKLIFH 边界：延后的正文与顶层图片绝不静默丢失', () => {
  it('★★ 含工具结果的 user 消息其正文，在下一条普通 user 处必须被发出', () => {
    /**
     * ⚠️⚠️ **真实数据丢失**（本仓库行为探针定位；上游同段等价、同样存在）。
     *
     * 上一条 user 消息含工具结果 ⇒ 它的**自身正文**被延后进 `pendingOwnParts`。
     * 下一条 user 若既没有挂起图片、自己也没有图，则 `combined` 的判据
     *（原先只写 `pendingToolImages.length > 0 || hasImage`）恒为 false ⇒
     * `combined === undefined` ⇒ `flushToolImages(undefined)` 因
     * 「无挂图且 own 为空」**提前 return** ⇒ 那份正文**从未被发出**。
     *
     * 实测（修复前）：wire 上只剩「追问」，`工具的说明正文` 消失 —— 模型看不到。
     */
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'f', arguments: '{}' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '工具的说明正文' },
          { type: 'tool-result', toolCallId: 'tc1', content: [{ type: 'text', text: 'out' }] },
        ],
      },
      { role: 'user', content: '追问' },
    ] as never, undefined)
    expect(textIndexOf(wire, '工具的说明正文'), '延后的正文被静默丢弃').toBeGreaterThan(-1)
    expect(textIndexOf(wire, '追问')).toBeGreaterThan(-1)
  })

  it('★★ 同一条 user 既带顶层图片又带工具结果时，顶层正文与图片都不得丢', () => {
    /**
     * 另一条同源路径：`parts`（本条自己的图）与 `deferred`（含工具结果）
     * 同时成立。修复前 `combined` 虽因 `hasImage` 为真而存在，但那条消息的
     * **顶层正文与顶层图片**会被 `pendingOwnParts = combined ?? …` 覆盖进延后队列，
     * 而工具结果循环之后的落点又把队列清成 undefined —— 同样静默丢失。
     */
    const wire = serializeMessages([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'tc1', name: 'f', arguments: '{}' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '顶层正文' },
          { type: 'image', attachment: { attachmentId: IMAGE_ID } },
          { type: 'tool-result', toolCallId: 'tc1', content: [{ type: 'text', text: 'out' }] },
        ],
      },
      { role: 'user', content: '问' },
    ] as never, IMAGE_URLS)
    expect(textIndexOf(wire, '顶层正文'), '顶层正文被丢弃').toBeGreaterThan(-1)
    expect(imageIndexOf(wire), '顶层图片被丢弃').toBeGreaterThan(-1)
    expect(textIndexOf(wire, '问')).toBeGreaterThan(-1)
  })

  it('★ 三处实现的 combined 判据都必须计入 pendingOwnParts（结构守卫）', () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(
        /const combined:[\s\S]{0,200}pendingOwnParts !== undefined/.test(src),
        `${name} 的 combined 判据漏了 pendingOwnParts ⇒ 延后正文会静默丢失`,
      ).toBe(true)
    }
  })
})

describe('IKLIFH 三处同型实现的结构守卫（漏一处即那一家继续「看不见图」）', () => {

  for (const [name, src] of Object.entries(sources)) {
    describe(name, () => {
      it('★ `flushToolImages` 必须接受 `own` 形参（= 支持「搭车」）', () => {
        expect(
          src,
          `${name} 的 flushToolImages 丢了 own 形参 ⇒ 图片只能单独成条（IKLIFH 复现）`,
        ).toContain('const flushToolImages = (own?: Array<Record<string, unknown>>): void => {')
      })

      it('★ 必须保留「无挂图时原样发出」的收窄分支', () => {
        expect(
          src,
          `${name} 丢了无挂图的收窄分支 ⇒ 无条件重排会翻转普通贴图的既有顺序`,
        ).toContain('if (!hasImages) {')
      })

      it('★ 必须保留「图与提问同条」的合条分支（含 F-05 的补救文本）', () => {
        // ⚠️ 2026-10-14（F-05）：合条分支在「本条无任何文本」时补一句说明文本，
        // 故发出的是 `...ownTextOrHint` 而不是 `...ownText`。守卫同步跟上，
        // 并**加强**到同时钉住补救文本本身 —— 否则「补文本」这一半可以被悄悄删掉。
        expect(
          src,
          `${name} 丢了合条分支 ⇒ 图片又会被单独发成一条 user 消息`,
        ).toContain("wire.push({ role: 'user', content: [...pendingToolImages, ...ownImages, ...ownTextOrHint] })")
        expect(
          src,
          `${name} 丢了「无自身文本时补说明文本」⇒ 纯图无文本的独立条会复现（模型看不见图）`,
        ).toContain("const ownTextOrHint = ownText.length > 0 ? ownText : [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }]")
      })

      it('★ 含工具结果的那条 user 消息必须整条延后（tool 配对约束）', () => {
        // ⚠️ 2026-10-14（F-21）：延后判据从「只看本条有没有工具结果」扩成三个条件，
        // 断言同步换成**完整形态**（原先只断言首行前缀，回退后两行也照样绿）。
        expect(src, `${name} 丢了 deferred 判据`).toContain(`const deferred = toolResults.length > 0
      || pendingToolImages.length > 0
      || pendingOwnParts !== undefined`)
        expect(src, `${name} 丢了延后落点`).toContain('pendingOwnParts = combined ??')
      })

      it('★ 纯文本必须保持**字符串** content（parts 数组会被上游 400）', () => {
        expect(
          src,
          `${name} 的纯文本分支被改成 parts ⇒ 上游报 model_param_invalid`,
        ).toContain("if (combined === undefined) wire.push({ role: 'user', content: text })")
      })

      it('★ 工具结果循环**末尾不得**再 flush（IKLIFH 的关键时序）', () => {
        // 若在本条末尾就 flush，图片此刻刚入队，会单独成一条紧随 tool 之后，
        // 而提问在再下一条 ⇒ 精确复现 IKLIFH。
        // ⚠️⚠️ **必须先剥注释**：本仓库的修复注释里**引用**了 `flushToolImages`
        //（「若在本条末尾就 flush … 明细见 flushToolImages 的表」），用裸文本扫描
        // 会把注释当代码 ⇒ 真实现改了也照样「绿」（本仓库记过的同型事故）。
        const code = stripComments(src)
        const loopEnd = code.indexOf('    for (const result of toolResults) {')
        expect(loopEnd, `${name} 找不到工具结果循环`).toBeGreaterThan(-1)
        const tail = code.slice(loopEnd)
        // 循环体内的末尾（在下一个 `  }` 之前）不得出现 flushToolImages 调用
        const bodyEnd = tail.indexOf('\n  }\n')
        const body = bodyEnd === -1 ? tail : tail.slice(0, bodyEnd)
        expect(
          /flushToolImages\(/.test(body),
          `${name} 在工具结果循环末尾又 flush 了 ⇒ 图片会单独成条，IKLIFH 复现`,
        ).toBe(false)
      })
    })
  }
})
