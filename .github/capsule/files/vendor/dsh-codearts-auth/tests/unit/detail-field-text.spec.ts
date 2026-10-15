/**
 * `detail-field-text.spec.ts` —— `detail` 腿的契约（IKLBSH A1，2026-10-14 移植）。
 *
 * ## 背景
 *
 * 上游代理的顶层 catch 会把异常包成
 * `{"error":"acp-proxy failure","detail":"<真实原因>"}`。只认 `error` 那条腿时，
 * 用户看到的是没有信息量的摘要，真正的原因全在 `detail` 里。
 *
 * 本仓库原有多份同义的 `errorDetail`（openai-compat / llm-adapter / buddy /
 * lobsterai / trae / accio），各写一条判据必然漂移 ⇒ 抽成 `detailFieldText`
 * 只留一份实现。
 *
 * ## 两条不变量（本文件的灵魂）
 *
 * 1. **只加不减**：detail 腿必须排最后，只影响「所有既有腿都落空」那一种形态；
 *    既有腿的优先级与产出逐字节不变。
 * 2. **分类不受影响**：`detail` 会加长分类判据的输入 ⇒ 可能翻转错误码
 *    （`INVALID_REQUEST` → `QUOTA_EXCEEDED` / `CONTEXT_WINDOW_EXCEEDED`）。
 *    故分类出口必须排除 detail 腿。
 */

import { describe, expect, it } from 'vitest'
/* ⚠️ API 形态随 rc.11 更新（2026-10-15）：两个出口从「选项式」
   `errorDetail(body, { forClassify: true })` 拆成了独立函数
   `errorDetailForClassify(body)` —— 这本身是更好的设计（两个语义不同的
   出口不该共用一个带布尔开关的函数）。断言语义不变。 */
import { detailFieldText, errorDetail, errorDetailForClassify } from '../../src/openai-compat.js'

describe('detailFieldText（唯一实现）', () => {
  it('① 字符串 detail 原样返回', () => {
    expect(detailFieldText({ error: 'acp-proxy failure', detail: 'connect ETIMEDOUT 10.0.0.1:443' }))
      .toBe('connect ETIMEDOUT 10.0.0.1:443')
  })
  it('② 嵌套对象只认 message（不 stringify 整对象）', () => {
    expect(detailFieldText({ detail: { message: 'upstream 502', code: 502 } })).toBe('upstream 502')
  })
  it('③ 空字符串 detail 视为缺失', () => {
    expect(detailFieldText({ detail: '' })).toBeUndefined()
  })
  it('④ 非对象一律 undefined', () => {
    expect(detailFieldText(null)).toBeUndefined()
    expect(detailFieldText('str')).toBeUndefined()
    expect(detailFieldText(42)).toBeUndefined()
    expect(detailFieldText([{ detail: 'x' }])).toBeUndefined()
  })
  it('⑤ 无 detail 字段时为 undefined', () => {
    expect(detailFieldText({ error: 'x', message: 'y' })).toBeUndefined()
  })
  it('⑥ 嵌套对象无 message 时为 undefined', () => {
    expect(detailFieldText({ detail: { code: 502 } })).toBeUndefined()
  })
})

describe('errorDetail 的只加不减', () => {
  it('⑦ 既有腿命中时，detail 不掺和（优先级不变）', () => {
    // `message` 是既有腿且排在 detail 前 ⇒ 产出必须与加 detail 腿之前一致
    const body = JSON.stringify({ message: 'bad request', detail: 'insufficient quota' })
    // detail 排在最后 ⇒ 既有腿之后追加，而不是替换
    expect(errorDetail(body)).toBe('bad request insufficient quota')
  })
  it('⑧ 所有既有腿落空时，detail 兜底（原形态是退回整段裸 JSON）', () => {
    const body = JSON.stringify({ error: 'acp-proxy failure', detail: 'connect ETIMEDOUT' })
    // error 是既有腿（openai-compat 认字符串形态的 data.error）⇒ 拼在 detail 前
    expect(errorDetail(body)).toBe('acp-proxy failure connect ETIMEDOUT')
  })
  it('⑨ 嵌套 detail 也兜底', () => {
    const body = JSON.stringify({ error: 'proxy', detail: { message: 'upstream reset' } })
    expect(errorDetail(body)).toBe('proxy upstream reset')
  })
  it('⑩ 非 JSON 错误体仍返回原文', () => {
    expect(errorDetail('plain text failure')).toBe('plain text failure')
  })
  it('⑪ 无 detail 的普通报文行为不变', () => {
    const body = JSON.stringify({ code: 400, message: 'invalid model' })
    expect(errorDetail(body)).toBe('code=400 invalid model')
  })
})

describe('分类出口必须排除 detail 腿', () => {
  /**
   * 这是本文件最重要的一条：detail 里的额度/超限措辞会**翻转错误码**。
   * 上游实测表（两轮审计独立确证）：
   *   {"message":"bad request","detail":"insufficient quota"}
   *     只算既有腿 → INVALID_REQUEST；加 detail → QUOTA_EXCEEDED
   */
  it('⑫ forClassify 时 detail 不进入分类输入', () => {
    const body = JSON.stringify({ message: 'bad request', detail: 'insufficient quota' })
    // 分类出口拿到的必须只是既有腿
    expect(errorDetailForClassify(body)).toBe('bad request')
  })
  it('⑬ forClassify 时超限措辞同样被排除', () => {
    const body = JSON.stringify({ message: 'bad request', detail: 'prompt is too long for this model' })
    expect(errorDetailForClassify(body)).toBe('bad request')
  })
  it('⑭ 展示出口与分类出口在无 detail 时逐字节相同', () => {
    const body = JSON.stringify({ error_code: 'E1001', error_msg: 'auth failed' })
    expect(errorDetail(body)).toBe(errorDetailForClassify(body))
  })
})
