import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { CodeArtsAdapter, QUEUE_STATUS_BASE } from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

/**
 * CodeArts（`llm-adapter.ts`）**400 报文判据**的回归：请求超出上下文窗口时
 * 必须归成 `CONTEXT_WINDOW_EXCEEDED`，而不是不可重试的 `INVALID_REQUEST`。
 *
 * ## 为什么必须有用例钉住（归错码的代价不对称）
 *
 * `dsh-compaction-basic` 的 `agent/request-error` listener 第一行就是
 * `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
 * ⇒ 归成 `INVALID_REQUEST` 就**连一次压缩的机会都没有**，长会话越过窗口后
 * **每轮报废**；归成溢出的最坏结果只是一次无效的压缩尝试。
 *
 * ## 本轮修的两个漏洞（`buddy-adapter.ts:641-651` 已记录同款结论）
 *
 * 1. **只喂 `errorDetail(body)`**：它在能提取到 `error.*` / `message` 时会返回
 *    拼接后的**短文本**，丢掉 `extError.code`（`context_length_exceeded` 这种
 *    稳定命中的结构化字段）⇒ 「仅 msg」形态漏判；
 * 2. **没有网关措辞兜底**：`prompt is too long: N tokens > M maximum`
 *    宿主分类器认不出（其各分支都要求 `context` / `for this model` 等字样）。
 *
 * ⚠️ 反向用例（普通 400 / 空报文 / 宽泛「too long」）**不可删**：判据放宽必须
 * 以「不误伤内容类 400」为界，否则会把别的问题也拖进压缩重试链。
 *
 * ⚠️ 这些用例**驱动真实的 `adapter.stream()`**（不是重写一份判据），因此
 * 「接线是否真的把完整报文喂进判据」也被覆盖 —— 只断言 helper 是不够的。
 */

const CREDENTIAL: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/**
 * 用给定状态码/报文驱动真实 adapter，返回抛出的 `LlmError.code`。
 *
 * 状态端点一律回 `working`（= 未排队）⇒ 走「按原错误分类立即抛出」那条路，
 * 正是本轮要覆盖的分支。`abortMs` 只给排队用例收口用（排队分支会重试 30 分钟）。
 */
async function failureCodeFor(status: number, body: string, abortMs?: number): Promise<string> {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith(QUEUE_STATUS_BASE)) {
      return new Response(JSON.stringify({ status: 'working' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const adapter = new CodeArtsAdapter({
    credentialRef: 'CODEARTS_ACCESS_TOKEN' as never,
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    fetchImpl,
  })
  const controller = new AbortController()
  const timer = abortMs === undefined ? undefined : setTimeout(() => controller.abort(), abortMs)
  try {
    for await (const _chunk of adapter.stream({
      model: 'GLM-5.2', messages: [], signal: controller.signal,
    } as never)) { /* drain */ }
    return '(no throw)'
  } catch (error) {
    return (error as { code?: string }).code ?? `(no code: ${(error as Error).message})`
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const json = (value: unknown) => JSON.stringify(value)

describe('codearts 400：上下文超限必须归成 CONTEXT_WINDOW_EXCEEDED', () => {
  it('`errorDetail` 能提取文本时，`extError.code` 仍必须参与判定（本轮修的核心）', async () => {
    // 三种「errorDetail 会返回短文本」的形态：extError 是唯一的溢出依据。
    // 修复前这三条全部被漏判成 INVALID_REQUEST。
    expect(await failureCodeFor(400, json({
      error_code: 'InferHub.X.400', error_msg: 'request rejected',
      extError: { code: 'context_length_exceeded' },
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')

    expect(await failureCodeFor(400, json({
      message: 'request rejected', extError: { code: 'context_length_exceeded' },
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')

    expect(await failureCodeFor(400, json({
      error: { message: 'bad request' }, extError: { code: 'context_length_exceeded' },
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('网关措辞 `prompt is too long: N tokens > M maximum` 有兜底（宿主分类器认不出）', async () => {
    expect(await failureCodeFor(400, json({
      error_code: 'InferHub.X.400',
      error_msg: 'prompt is too long: 100001 tokens > 100000 maximum',
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('宿主英文措辞照旧命中（不许因改判据而丢）', async () => {
    expect(await failureCodeFor(400, json({
      error: { message: "This model's maximum context length is 128000 tokens." },
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('反向：普通 400 / 空报文 / 宽泛 too long 一律仍是 INVALID_REQUEST', async () => {
    expect(await failureCodeFor(400, json({ error_code: 'OTHER', error_msg: 'bad request' })))
      .toBe('INVALID_REQUEST')
    expect(await failureCodeFor(400, '')).toBe('INVALID_REQUEST')
    // ⚠️ 只认「too long」而不要求 `N tokens > M` 共现，会把内容类 400 误判成溢出。
    expect(await failureCodeFor(400, json({ error_code: 'X', error_msg: 'prompt is too long, please shorten it' })))
      .toBe('INVALID_REQUEST')
  })

  it('反向：状态码与额度语义优先于超限文案', async () => {
    // 401/403 先判，恒归 AUTH（网关故障常在报文里捎带无关文案）。
    expect(await failureCodeFor(401, json({ error: { message: 'maximum context length exceeded' } })))
      .toBe('AUTH')
    expect(await failureCodeFor(429, json({ error_code: 'X', error_msg: 'slow down' })))
      .toBe('RATE_LIMIT')
    expect(await failureCodeFor(500, json({ error_code: 'X', error_msg: 'boom' })))
      .toBe('SERVER')
    expect(await failureCodeFor(400, json({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' })))
      // ⚠️ **字面量 `'QUOTA_EXCEEDED'`，不是 harness 的 `QUOTA_EXCEEDED_CODE`（= `'QUOTA'`）**
      // —— 2026-10-12 自上游 c2546558 移植（Gitee issue IKJVCW）：DSH 客户端对
      // `'QUOTA'`/`'ACCOUNT_QUOTA'`/`'AUTH'` 三个码会**丢弃适配器写的 message、
      // 换成固定文案**（`message.failure.quota` =「当前请求的额度已用尽」），于是
      // 带解禁时间的那句说明到不了用户眼前。可重试性与 `'QUOTA'` 一致。
      .toBe('QUOTA_EXCEEDED')
  })

  it('反向：排队语义不被改判（TM.00001041 仍走排队分支）', async () => {
    expect(await failureCodeFor(400, json({
      error_code: 'TM.00001041', error_msg: '并发会话数已达上限',
    }), 1500)).toBe('QUEUE')
  })
})

describe('codearts 400 接线（源码文本断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../..', 'src/llm-adapter.ts'), 'utf8')

  it('400 判据喂**完整报文**并复用共享判据（不再只喂 errorDetail）', () => {
    expect(source).toContain("import { isContextOverflowBody } from './openai-compat.js'")
    expect(source).toContain('if (isContextOverflowBody(body)) return CONTEXT_WINDOW_EXCEEDED_CODE')
    // 旧的漏判形态必须消失（它是本轮缺陷的判据）。
    expect(source).not.toContain('if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE')
  })
})
