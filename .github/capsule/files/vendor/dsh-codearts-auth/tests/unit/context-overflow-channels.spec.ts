import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { httpErrorCodeForZcode } from '../../src/zcode-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { httpErrorCode, isContextOverflowBody, sseFailureCode } from '../../src/openai-compat.js'

/**
 * 「上下文超限」归码在**其余两条通道**上的回归（2026-10-11，Step A 尾巴 ③④）。
 *
 * ## 背景：同一语义此前有**三份**判据
 *
 * 共享层（`openai-compat.ts`）与 `buddy-adapter.ts` / `llm-adapter.ts` 已统一为
 * 「宿主分类器 + 网关措辞兜底」，但还有两处漏在外面：
 *
 * 1. **zcode 的 400 分支**只喂宿主 `isContextWindowExceededError`，**没有**网关措辞
 *    兜底 —— 而 zcode 的端点是 **Anthropic 协议**的
 *    `/api/v1/zcode-plan/anthropic/v1/messages`，Anthropic 原生的超限报文正是
 *    `prompt is too long: N tokens > M maximum`（宿主分类器**认不出这句**）。
 * 2. **lobsterai 的流内失败**（HTTP 200 + SSE 错误帧）此前固定写 `SERVER` ——
 *    归成 `SERVER` **不触发** DSH 的压缩恢复链，直连的长会话越过窗口后每轮报废。
 *
 * ⚠️ 两处都改为**复用共享判据**，不再各写一份（本仓库红线：同一语义不得两套判据）。
 *
 * ## 为什么反向用例不可删
 *
 * zcode 的状态码/业务码映射被多轮真实事故打磨过（`3007` captcha、`3012` 风控、
 * `1005` 装并发、边缘页短路）。放宽 400 判据**必须**证明这些语义一条都没动，
 * 否则就是又一次「只改了一半」。
 */

/** 最小可用的 lobsterai 凭据（本文件只驱动流内错误分支）。 */
const LOBSTERAI_CREDENTIAL = {
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: String(Date.now() + 7_200_000),
  uid: 'uid-1',
  user_id: 'yid-1',
}

/** 用给定的流内错误帧驱动真实 adapter，返回抛出的 `LlmError.code`。 */
async function lobsteraiStreamCode(frame: unknown): Promise<string> {
  const fetchImpl = (async () => new Response(
    `data: ${JSON.stringify(frame)}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )) as unknown as typeof fetch
  const adapter = new LobsteraiAdapter({
    credentialRef: 'LOBSTERAI_ACCOUNT_TEST' as never,
    resolveCredential: async () => LOBSTERAI_CREDENTIAL as never,
    refresh: async () => {},
    fetchImpl,
  })
  try {
    for await (const _chunk of adapter.stream({
      model: 'glm-5.2', messages: [], signal: new AbortController().signal,
    } as never)) { /* drain */ }
    return '(no throw)'
  } catch (error) {
    return (error as { code?: string }).code ?? '(no code)'
  }
}

describe('zcode 400：Anthropic 原生超限措辞必须归成 CONTEXT_WINDOW_EXCEEDED', () => {
  it('`prompt is too long: N tokens > M maximum`（Anthropic 原生形态）', () => {
    // zcode 走 Anthropic 的 /v1/messages，这是它最常见的超限报文；
    // 修复前落 INVALID_REQUEST（不触发压缩 ⇒ 长会话每轮报废）。
    expect(httpErrorCodeForZcode(400, JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 209715 tokens > 200000 maximum' },
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('宿主英文措辞照旧命中（不许因改判据而丢）', () => {
    expect(httpErrorCodeForZcode(400, JSON.stringify({
      error: { message: "This model's maximum context length is 128000 tokens." },
    }))).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('反向：普通 400 / 空报文 / 宽泛 too long 一律仍是 INVALID_REQUEST', () => {
    expect(httpErrorCodeForZcode(400, JSON.stringify({ error: { message: 'bad request' } })))
      .toBe('INVALID_REQUEST')
    expect(httpErrorCodeForZcode(400, '')).toBe('INVALID_REQUEST')
    // 只认「too long」而不要求 `N tokens > M` 共现 ⇒ 会把内容类 400 误判成溢出。
    expect(httpErrorCodeForZcode(400, JSON.stringify({
      error: { message: 'prompt is too long, please shorten it' },
    }))).toBe('INVALID_REQUEST')
  })

  it('反向：zcode 既有业务码/状态码语义一条不动', () => {
    expect(httpErrorCodeForZcode(400, '{"code":3007,"msg":"captcha verify failed"}')).toBe('RATE_LIMIT')
    expect(httpErrorCodeForZcode(405, '{"code":3012,"msg":"request has been blocked"}')).toBe('PERMISSION')
    expect(httpErrorCodeForZcode(429, '{"code":"1113"}')).toBe('QUOTA_EXCEEDED')
    expect(httpErrorCodeForZcode(429, '余额不足或无可用资源包')).toBe('QUOTA_EXCEEDED')
    // 上游把并发限流装进额度码（2026-10-06 事故）：文案必须优先于码。
    expect(httpErrorCodeForZcode(429, '{"code":1005,"msg":"user concurrency limit exceeded"}'))
      .toBe('RATE_LIMIT')
    expect(httpErrorCodeForZcode(401, '')).toBe('AUTH')
    expect(httpErrorCodeForZcode(400, '{"type":"1002"}')).toBe('AUTH')
    expect(httpErrorCodeForZcode(500, 'boom')).toBe('SERVER')
    // 瞬断 5xx 的正文含 `13012` 不许被当成风控 3012（否则放弃可自愈的重试）。
    expect(httpErrorCodeForZcode(503, 'backend 13012 unavailable')).toBe('SERVER')
    // HTML 边缘页里的裸数字不许当业务码（边缘页必须最先短路）。
    expect(httpErrorCodeForZcode(500, '<html><title>1005</title></html>')).toBe('SERVER')
  })
})

describe('lobsterai 流内失败：复用共享判据，不再固定 SERVER', () => {
  it('流内错误帧里的超限文案 → CONTEXT_WINDOW_EXCEEDED', async () => {
    expect(await lobsteraiStreamCode({
      error: { message: 'prompt is too long: 100001 tokens > 100000 maximum' },
    })).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(await lobsteraiStreamCode({
      error: { message: "This model's maximum context length is 128000 tokens." },
    })).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('反向：普通流内错误仍 SERVER（不把业务失败当溢出）', async () => {
    expect(await lobsteraiStreamCode({ error: { message: '模型不可用' } })).toBe('SERVER')
  })

  it('共享判据本身：超限 → 规范码，其余 → SERVER', () => {
    expect(sseFailureCode('prompt is too long: 5 tokens > 4 maximum')).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(sseFailureCode('boom')).toBe('SERVER')
  })
})

describe('三条通道同源（源码文本断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

  it('zcode 复用共享判据，不再只喂宿主分类器', () => {
    const source = read('src/zcode-adapter.ts')
    /* ⚠️ 同上：只验证符号被导入，不钉顺序与空格。 */
    expect(source).toMatch(/import \{[^}]*\bcollectImages\b[^}]*\} from '\.\/openai-compat\.js'/)
    expect(source).toMatch(/import \{[^}]*\bisContextOverflowBody\b[^}]*\} from '\.\/openai-compat\.js'/)
    expect(source).toContain('if (isContextOverflowBody(trimmed)) return CONTEXT_WINDOW_EXCEEDED_CODE')
    // 旧的漏判形态必须消失（它漏掉 Anthropic 原生措辞）。
    expect(source).not.toContain('if (isContextWindowExceededError(trimmed)) return CONTEXT_WINDOW_EXCEEDED_CODE')
  })

  it('lobsterai 流内失败复用共享判据，不再固定 SERVER', () => {
    const source = read('src/lobsterai-adapter.ts')
    /* ⚠️ 改为**语义判据**（2026-10-15）：只验证两个符号确实从共享层导入，
       不钉 import 的精确文本 —— rc.11 与胶囊的导入顺序/空格不同但语义相同，
       钉精确文本会随任何一次 import 重排假红（「验证手段自身腐坏」）。 */
    expect(source).toMatch(/import \{[^}]*\bhttpErrorCode\b[^}]*\} from '\.\/openai-compat\.js'/)
    expect(source).toMatch(/import \{[^}]*\bsseFailureCode\b[^}]*\} from '\.\/openai-compat\.js'/)
    expect(source).toContain('fromStream ? sseFailureCode(text) : httpErrorCode(status, text)')
    // 旧的固定 SERVER 形态必须消失。
    expect(source).not.toContain("fromStream ? 'SERVER' : httpErrorCode(status, text)")
  })

  it('共享判据对两条通道都导出（HTTP 层与流内层同源）', () => {
    const source = read('src/openai-compat.ts')
    expect(source).toContain('export function isContextOverflowBody(body: string): boolean')
    expect(source).toContain('export function sseFailureCode(text: string): string')
    // HTTP 层与流内层必须调用**同一个**判定函数。
    expect(source).toContain('if (isContextOverflowBody(body)) return CONTEXT_WINDOW_EXCEEDED_CODE')
    expect(source).toContain("return isContextOverflowBody(text) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'SERVER'")
  })

  /**
   * **聚合层的兜底网也必须用同一判据**（2026-10-11 9.16 补）。
   *
   * `aggregate-adapter.ts` 的 `isContextOverflowFailure` 是「候选适配器没归好码」时的
   * 最后一道网（`resolveUpstreamCode` 依赖它）。它原先只喂宿主
   * `isContextWindowExceededError`，于是**网关措辞**
   * （`prompt is too long: N tokens > M maximum`，宿主分类器认不出）在这道网上漏判。
   * 这正是 9.15/9.16 在另外三条通道上修掉的同一类缺陷 ⇒ 这里断言它也已同源。
   */
  it('聚合层兜底网复用共享判据（不再只喂宿主分类器）', () => {
    const source = read('src/aggregate-adapter.ts')
    expect(source).toContain("import { isContextOverflowBody } from './openai-compat.js'")
    expect(source).toContain('return detail.length > 0 && isContextOverflowBody(detail)')
    // 旧的「仅宿主分类器」形态必须消失。
    expect(source).not.toContain('return detail.length > 0 && isContextWindowExceededError(detail)')
  })

  /**
   * ⚠️ **buddy 那份重复常量的防分叉闸门**（Step A 尾巴 ②，2026-10-11）。
   *
   * `buddy-adapter.ts` 有一份与共享层**逐字相同**的 `GATEWAY_PROMPT_TOO_LONG`
   * （它刻意不复用 `openai-compat.ts` 的协议层，见该模块头）。当时**有意不合并**：
   * 合并需要把 102KB 的 buddy 适配器变成 capsule override ⇒ 它会与上游脱钩，
   * 而「override 基线漂移」正是本仓库踩过的坑（见接力文档踩坑 6 / #15）。
   * 两份判据**今天逐字节相同**，所以合并是纯重构、零功能收益、却引入长期风险。
   *
   * 但「两份同义判据」本身是真实风险（`misc.md`：「同一语义两套判据，必有一处是错的」）：
   * 将来只改一份就会**静默分叉**（buddy 与共享层对同一报文给出不同归类）。
   * ⇒ 本用例把「两份必须一致」变成 CI 断言：一旦有人只改一份，**这里立刻红**，
   *   逼他要么同步两份、要么按正确流程合并（而不是静默漂移）。
   */
  it('buddy 的网关措辞常量必须与共享层逐字一致（防静默分叉）', () => {
    const shared = read('src/openai-compat.ts')
    const buddy = read('src/buddy-adapter.ts')
    const pick = (source: string, name: string): string => {
      const matched = new RegExp(`const ${name} = (/.*/i)`).exec(source)
      if (matched === null) throw new Error(`${name} 未找到`)
      return matched[1]!
    }
    const sharedPattern = pick(shared, 'PROMPT_TOO_LONG_BODY')
    const buddyPattern = pick(buddy, 'GATEWAY_PROMPT_TOO_LONG')
    expect(buddyPattern).toBe(sharedPattern)
    // 两份都必须仍然**窄**（同时要求「prompt is too long」与「N tokens > M」）。
    expect(sharedPattern).toContain('prompt')
    expect(sharedPattern).toContain('tokens?')
  })

  it('共享层 httpErrorCode 的 400 分支确实看报文（防止有人改回不看 body）', () => {
    expect(httpErrorCode(400, JSON.stringify({ error: { message: 'maximum context length exceeded' } })))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(httpErrorCode(400, JSON.stringify({ error: { message: 'bad request' } })))
      .toBe('INVALID_REQUEST')
    expect(isContextOverflowBody('prompt is too long: 9 tokens > 8 maximum')).toBe(true)
    expect(isContextOverflowBody('nope')).toBe(false)
  })
})
