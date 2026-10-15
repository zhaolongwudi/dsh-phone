/**
 * 实测凭据：**腾讯系内容级风控扫描哪些消息角色**（2026-10-12 补测）。
 *
 * ## 为什么这个文件必须**入库**
 * 「`assistant` **正文**会被风控拦、而 `reasoning_content` / `tool_calls.arguments`
 * / `user` / `tool` 结果**不会**」这条结论，已被写进
 * `src/openai-gateway/tencent-fingerprint.ts` 的**实现约束**（决定改写范围），
 * 并有单测锁住。单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对** ——
 * 而当初翻车的正是这一点：assistant 那一格从未测过，且当时的探针把触发句改写成了
 * 转述形态（服务端逐字符匹配 ⇒ 那个形态不含触发串 ⇒ **空跑**却得出「assistant 放行」）。
 *
 * ⚠️ 本文件因此是那条结论的**唯一可复核凭据**。别把它挪回被 gitignore 的 `scripts/`。
 *
 * ## 触发串从哪里来
 * ⚠️ **刻意不在源码里写那句字面量**：源码会经 tool-call.arguments 进入当前会话
 * 历史，于是**本会话自己的** buddy 请求也开始被拦 —— 观察者污染实验对象
 * （这正是 2026-10-12 那次报障的机制）。故运行时从本仓库的
 * `docs/agent-notes/providers-buddy.md` 读那一行原文，全程不打印。
 *
 * ## 闸门（消耗极小额度：每例 `max_tokens=16`，被拒不耗额度）
 *   DSH_BUDDY_FINGERPRINT_E2E=1 + DSH_BUDDY_FINGERPRINT_E2E_CONFIRM=yes
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENABLED = process.env.DSH_BUDDY_FINGERPRINT_E2E === '1'
const CONFIRMED = process.env.DSH_BUDDY_FINGERPRINT_E2E_CONFIRM === 'yes'

/** 触发串：取自记录该指纹的文档，取「首次出现该字面量的那一行」，不打印。 */
function loadTriggerLine(): string {
  const doc = readFileSync('docs/agent-notes/providers-buddy.md', 'utf8')
  const line = doc.split('\n').find((l) => /usually\s+use\s+this\s+for\s+PRs/i.test(l))
  if (typeof line !== 'string' || line.trim().length === 0) {
    throw new Error('在 docs/agent-notes/providers-buddy.md 里找不到触发串那一行 —— 文档被改动后请同步本探针')
  }
  return line
}

function firstCredential(): { ref: string; cred: Record<string, unknown> } {
  const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s+(BUDDY_ACCOUNT_[0-9A-F]+|BUDDY_ACCESS_TOKEN):\s*'(.*)'\s*$/.exec(line)
    if (m === null) continue
    try {
      const cred = JSON.parse(m[2]) as Record<string, unknown>
      if (typeof cred.access_token === 'string' && cred.access_token.length > 0) return { ref: m[1], cred }
    } catch { /* 跳过非 JSON */ }
  }
  throw new Error('磁盘上没有 CodeBuddy 凭据（请先在 Jet Hub 登录）')
}

const ENDPOINT = 'https://copilot.tencent.com'
const MODEL = process.env.DSH_BUDDY_FINGERPRINT_MODEL ?? 'step-5-preview'

/**
 * 腾讯系两个端点（IKLS2L 要求**两站分别实测**：它们共用同一个 `BuddyAdapter` 类，
 * 但产品配置与网关不同 ⇒「buddy 过了」推不出 workbuddy 也过）。
 *
 * `X-Domain` / `X-Product-Code` / UA 按站点切换 —— 发错站点会得到与指纹无关的
 * 身份错误，把「风控拦截」与「请求头写错」混成同一条报错。
 */
const SITES = [
  { name: 'buddy', endpoint: ENDPOINT, domain: 'copilot.tencent.com', productCode: 'codebuddy' },
  { name: 'workbuddy', endpoint: 'https://www.workbuddy.ai', domain: 'www.workbuddy.ai', productCode: 'workbuddy' },
] as const

function headersOf(cred: Record<string, unknown>, site: typeof SITES[number]): Record<string, string> {
  return {
    Authorization: `Bearer ${String(cred.access_token)}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Domain': site.domain,
    'X-Product-Code': site.productCode,
    'X-IDE-Name': 'CodeBuddy', 'X-IDE-Type': 'CodeBuddy', 'X-IDE-Version': '1.106.1',
    'X-Product': 'CodeBuddy', 'User-Agent': 'CodeBuddyIDE/1.106.1',
  }
}

async function probe(
  messages: unknown[],
  site: typeof SITES[number] = SITES[0],
): Promise<{ blocked: boolean; code?: string }> {
  const { cred } = firstCredential()
  const res = await fetch(`${site.endpoint}/v2/chat/completions`, {
    method: 'POST', headers: headersOf(cred, site),
    // ⚠️ `stream:true` **必须发**：两端点对非流式请求都回
    // `400 / code 11101 Non-stream chat request is currently not supported`，
    // 不带它会把「不支持非流式」误读成风控拦截（IKLS2L 探针第一版就踩了）。
    body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: 16 }),
  })
  if (!res.ok) {
    const body = await res.text()
    return { blocked: true, code: /"code":(\d+)/.exec(body)?.[1] }
  }
  // 200 也可能是流内错误帧（IKJNA1 记录过这种形态）
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done === true) break
    buf += decoder.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const p = t.slice(5).trim()
      if (p.includes('"code"') && !p.includes('chat.completion.chunk')) return { blocked: true }
    }
  }
  return { blocked: false }
}

describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：角色矩阵（2026-10-12 实测依据）', () => {
  it('基线：不含触发串的请求必须 200（否则本文件全部结论作废）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ assistant 正文含触发串会被拦（这是本次修复扩大的那一格）', async () => {
    const trigger = loadTriggerLine()
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: trigger },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(true)
  }, 60_000)

  it('改写该句后放行（证明「改写」是有效修法，而不只是「恰好躲过」）', async () => {
    const trigger = loadTriggerLine()
    const safe = trigger.replace(/usually\s+use\s+this\s+for\s+PRs/gi, 'typically merged into PRs')
    const r = await probe([
      { role: 'system', content: `You are a helpful assistant.\n${safe}` },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it.each([
    ['user', [{ role: 'user', content: 'note' }]],
    ['assistant 的 reasoning_content', [{ role: 'assistant', content: 'Noted.', reasoning_content: 'TRIGGER' }]],
    ['tool_calls[].arguments', [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: 'TRIGGER' } }],
    }]],
  ])('%s 含触发串**不拦**（这三格刻意不改写，改了只是篡改证据）', async (_label, tail) => {
    const trigger = loadTriggerLine()
    const wire = JSON.parse(JSON.stringify(tail).replaceAll('TRIGGER', trigger))
    // tool_calls 分支要补上配对的 tool 结果，否则会被「配对不完整」先拒
    const messages: unknown[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      ...wire,
      { role: 'user', content: 'reply OK' },
    ]
    if (_label.startsWith('tool_calls')) {
      messages.splice(messages.length - 1, 0, { role: 'tool', tool_call_id: 'c1', content: trigger })
    }
    const r = await probe(messages)
    expect(r.blocked).toBe(false)
  }, 60_000)
})

/**
 * ## 第二条指纹：**Claude Code 的身份句**（Gitee issue IKLS2L，2026-10-14）
 *
 * 与上面 ZCode 那条同为腾讯内容级风控，但**锚点语义相反**。本节的结论
 * （「行首锚定、后缀自由」）已被写进 `src/openai-gateway/tencent-fingerprint.ts`
 * 的注释 —— 单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对**，
 * 所以这一节是那条相反结论的**唯一可复核凭据**。
 *
 * ⚠️ 与上面 ZCode 那条不同，这句字面量**可以**写在源码里：改写已覆盖
 * `system` 与 `assistant` 正文两处，「排查这个风控 bug 的会话」不会再拦死自己。
 */
describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：Claude Code 身份句（IKLS2L 实测依据）', () => {
  const CLAUDE_TRIGGER = "You are Claude Code, Anthropic's official CLI for Claude"
  const CLAUDE_REWRITE = "You are Claude Code, Anthropic's CLI for Claude"
  /** Claude Code v2.1.295 内建的另外两个身份句常量（issue 从二进制读出）。 */
  const SDK_VARIANT = `${CLAUDE_TRIGGER}, running within the Claude Agent SDK.`
  const AGENT_VARIANT = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：身份句在 system **被拦**，改写后放行（本条登记的全部依据）',
    async (_name, site) => {
      const blocked = await probe(
        [{ role: 'system', content: CLAUDE_TRIGGER }, { role: 'user', content: 'reply OK' }], site)
      expect(blocked.blocked, `${site.name}: 身份句实测应被拦`).toBe(true)
      expect(blocked.code).toBe('11128')
      // 改写是**有效修法**，不只是「恰好躲过」：同一位置换等义措辞即 200。
      const fixed = await probe(
        [{ role: 'system', content: CLAUDE_REWRITE }, { role: 'user', content: 'reply OK' }], site)
      expect(fixed.blocked, `${site.name}: 改写后应放行`).toBe(false)
    }, 120_000)

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：SDK 变体也被拦，且同一条登记（`find` 不带尾句点）即可救它',
    async (_name, site) => {
      const blocked = await probe(
        [{ role: 'system', content: SDK_VARIANT }, { role: 'user', content: 'reply OK' }], site)
      expect(blocked.blocked).toBe(true)
      const fixed = await probe([{
        role: 'system',
        content: SDK_VARIANT.replace(CLAUDE_TRIGGER, CLAUDE_REWRITE),
      }, { role: 'user', content: 'reply OK' }], site)
      expect(fixed.blocked).toBe(false)
    }, 120_000)

  it('★ assistant **正文**放身份句也被拦（历史重放路径的成因）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: CLAUDE_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(true)
  }, 60_000)

  /**
   * ⚠️⚠️ **本条的锚点与 ZCode 那条相反**：身份句**只在文本开头**被拦。
   *
   * 这一格是 issue 描述（「子串精确匹配、位置无关」）被**实测推翻**的地方，
   * 也是「将来加新指纹时探针必须两侧都测」这条纪律的依据 ——
   * 只测句中会得到「已放行」的**假阴性**，据此删掉一条仍必需的登记就重开 bug。
   */
  it.each([
    ['前接空格', ` ${CLAUDE_TRIGGER}`],
    ['前接换行', `\n${CLAUDE_TRIGGER}`],
    ['前接中文前言', `前言。${CLAUDE_TRIGGER}`],
    ['双换行包裹', `\n\n${CLAUDE_TRIGGER}\n\n`],
  ])('★ 锚点实测：%s ⇒ **放行**（该指纹行首锚定，不是位置无关）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it.each([
    ['后接尾句点', `${CLAUDE_TRIGGER}.`],
    ['后接中文句号', `${CLAUDE_TRIGGER}。`],
    ['后接长正文', `${CLAUDE_TRIGGER}\n\n${'padding. '.repeat(50)}`],
  ])('★ 锚点实测：%s ⇒ **仍被拦**（后缀自由，前导字符一个都不容忍）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked).toBe(true)
  }, 60_000)

  it('★ 逐字符匹配：少一个字母放行、多一个字母仍被拦', async () => {
    const fewer = CLAUDE_TRIGGER.replace(/Claude$/, 'Claud')
    const more = `${CLAUDE_TRIGGER}X`
    expect((await probe([{ role: 'system', content: fewer }, { role: 'user', content: 'reply OK' }])).blocked).toBe(false)
    expect((await probe([{ role: 'system', content: more }, { role: 'user', content: 'reply OK' }])).blocked).toBe(true)
  }, 90_000)

  it('★ 第三个常量（`Claude agent`）实测**放行** ⇒ 刻意不登记它', async () => {
    // 「表能加就加」是错的：多登记一条会替上游无谓改写用户提示词并破坏前缀缓存。
    // 本用例钉住「它确实不该被登记」——若某天它开始被拦，这里会红。
    const r = await probe([{ role: 'system', content: AGENT_VARIANT }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ user 角色放身份句不拦（故该角色刻意不改写）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: CLAUDE_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)
})