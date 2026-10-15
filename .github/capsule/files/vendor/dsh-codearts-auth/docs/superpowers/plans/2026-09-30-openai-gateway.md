# DSH OpenAI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 `dsh-codearts-auth` 插件中增加一个监听 `127.0.0.1:8326` 的标准 OpenAI Chat Completions 网关，复用 DSH 已有 provider 和 Jet Hub 账号池。

**Architecture:** 网关业务全部放在 `src/openai-gateway/`。`index.ts` 只负责创建并登记网关生命周期。网关通过 Node `http` 接收请求，使用 `ctx.llm.listModels()` 生成模型目录，使用 `ctx.llm.stream(GenerateOptions)` 转发请求，并把 DSH `StreamChunk` 转成 OpenAI SSE 或聚合 JSON。

**Tech Stack:** Node.js `http` / `fs` / `crypto`，TypeScript NodeNext，Vitest，现有 `@deepseek-ai/dsh-llm` runtime。

## Global Constraints

- 只监听 `127.0.0.1`，默认端口 `8326`，环境变量 `DSH_OPENAI_GATEWAY_PORT` 可覆盖。
- 环境变量 `DSH_OPENAI_GATEWAY_API_KEY` 优先；未配置时首次生成并保存到 DSH home 的 `openai-gateway/api-key`。
- 端口占用不得随机换端口；启动失败必须日志可诊断。
- 网关代码只能放在 `src/openai-gateway/`，`src/index.ts` 只保留最小启停接线。
- 对外只实现 OpenAI Chat Completions：`GET /v1/models`、`POST /v1/chat/completions`。
- 不记录 API Key、provider 凭据、prompt、完整工具参数和完整上游响应。
- 先写失败测试，确认 RED 后再写实现；完成后运行 typecheck、相关单测、build:all。

---

### Task 1: 网关配置、API Key 和模型目录纯函数

**Files:**
- Create: `src/openai-gateway/config.ts`
- Create: `src/openai-gateway/auth.ts`
- Create: `src/openai-gateway/models.ts`
- Test: `tests/unit/openai-gateway-config.spec.ts`
- Test: `tests/unit/openai-gateway-models.spec.ts`

**Interfaces:**
- `resolveGatewayConfig(env?: NodeJS.ProcessEnv): { host: string; port: number; apiKeyEnv?: string }`
- `loadOrCreateApiKey(home: string, env?: NodeJS.ProcessEnv): string`
- `toOpenAiModelId(provider: string, model: string): string`
- `toOpenAiModels(providers: readonly { provider: string; models: readonly { id: string; name: string; description?: string; contextWindow?: number; maxTokens?: number; inputModalities?: readonly string[] }[] }[]): object[]`

- [ ] **Step 1: Write failing tests** for default/override port, invalid port, environment-key priority, persistent generated key, stable `provider/model` ids, and model metadata.
- [ ] **Step 2: Run `pnpm exec vitest run tests/unit/openai-gateway-config.spec.ts tests/unit/openai-gateway-models.spec.ts` and confirm missing-module failures.**
- [ ] **Step 3: Implement the smallest pure config/auth/model helpers.** Use `randomBytes(32).toString('base64url')`, create `openai-gateway` directory, write a temporary file then rename it, and never return/log the key from logging code.
- [ ] **Step 4: Run the two spec files and confirm pass.**

### Task 2: OpenAI request validation and DSH message conversion

**Files:**
- Create: `src/openai-gateway/messages.ts`
- Test: `tests/unit/openai-gateway-messages.spec.ts`

**Interfaces:**
- `parseModelRoute(model: unknown): { provider: string; model: string }`
- `toGenerateOptions(body: OpenAiChatRequest, signal: AbortSignal): GenerateOptions`
- `OpenAiGatewayError` with `status`, `type`, and `code` fields.

- [ ] **Step 1: Write failing tests** for `provider/model`, required `messages`, system/user/assistant/tool conversion, OpenAI tool schema conversion, `max_completion_tokens` precedence, reasoning effort, `tool_choice` auto/none, malformed tool calls, and unsupported forced function selection.
- [ ] **Step 2: Run the spec and confirm RED.**
- [ ] **Step 3: Implement typed request parsing.** Map text to DSH `text` blocks, assistant tool calls to `tool-call`, tool results to `tool-result`; use generated message ids and valid DSH message sources. Reject malformed input with HTTP-appropriate 400 errors. Do not attempt to invent fields absent from `GenerateOptions`.
- [ ] **Step 4: Run the spec and confirm GREEN.**

### Task 3: DSH stream to OpenAI response conversion

**Files:**
- Create: `src/openai-gateway/stream.ts`
- Test: `tests/unit/openai-gateway-stream.spec.ts`

**Interfaces:**
- `toOpenAiSse(chunks: AsyncIterable<StreamChunk>, requestId: string, model: string): AsyncIterable<string>`
- `collectOpenAiCompletion(chunks: AsyncIterable<StreamChunk>, requestId: string, model: string): Promise<object>`
- `failureToOpenAiError(error: unknown): { status: number; body: object }`

- [ ] **Step 1: Write failing tests** for text deltas, reasoning deltas, tool-call deltas, usage, stop/tool_calls/length finish reasons, error/aborted finish chunks, `[DONE]`, non-stream aggregation, and malformed DSH errors.
- [ ] **Step 2: Run the spec and confirm RED.**
- [ ] **Step 3: Implement one chunk accumulator used by both SSE and non-stream paths.** Emit valid OpenAI SSE `id`, `object`, `created`, `model`, `choices`, and final usage where available. Do not emit a successful stop after an error or abort.
- [ ] **Step 4: Run the spec and confirm GREEN.**

### Task 4: HTTP server and lifecycle

**Files:**
- Create: `src/openai-gateway/server.ts`
- Create: `src/openai-gateway/index.ts`
- Test: `tests/unit/openai-gateway-server.spec.ts`

**Interfaces:**
- `createOpenAiGateway(options: { ctx: Context; llm: LlmRuntimeLike; home?: string; env?: NodeJS.ProcessEnv; logger?: GatewayLogger }): { start(): Promise<void>; close(): Promise<void>; address(): { host: string; port: number } }`
- Internal `LlmRuntimeLike` only includes `listProviders`, `listModels`, `resolveModelInfo`, and `stream`.

- [ ] **Step 1: Write failing HTTP tests** for unauthorized requests, `GET /v1/models`, method/path/content-type validation, streamed and non-streamed chat requests, model routing, client abort propagation, health-independent 404, and port conflict.
- [ ] **Step 2: Run the spec and confirm RED.**
- [ ] **Step 3: Implement Node `http.createServer`.** Authenticate with exact `Authorization: Bearer <key>`, parse bounded JSON body, call `listModels` for catalogs and `stream` for generation, wire request close/abort to an `AbortController`, set CORS and OpenAI content types, and close all active requests during shutdown.
- [ ] **Step 4: Run the server spec and confirm GREEN.**

### Task 5: Minimal DSH plugin wiring

**Files:**
- Modify: `src/index.ts` near `apply(ctx)` final registration/effect block
- Modify: `package.json` only if the existing TypeScript build excludes the new directory
- Test: `tests/unit/openai-gateway-wiring.spec.ts` if a focused lifecycle seam is needed

- [ ] **Step 1: Add a failing wiring test or compile-time seam** proving `apply()` creates the gateway once and registers cleanup without changing provider adapter registrations.
- [ ] **Step 2: Run the focused test and confirm RED.**
- [ ] **Step 3: Add only the import, `createOpenAiGateway` call, asynchronous start logging, and `ctx.effect` cleanup.** Do not move or edit existing adapter logic.
- [ ] **Step 4: Run the focused test and typecheck.**

### Task 6: Documentation, full verification, commit and push

**Files:**
- Modify: `README.md` with gateway usage and security notes
- Modify: `docs/superpowers/specs/2026-09-30-openai-gateway-design.md` only if implementation clarifies a contradiction
- No unrelated files

- [ ] **Step 1: Run focused gateway unit tests.**
- [ ] **Step 2: Run `pnpm typecheck`.**
- [ ] **Step 3: Run `pnpm test` and record pre-existing failures separately from gateway failures.**
- [ ] **Step 4: Run `pnpm build:all`.**
- [ ] **Step 5: Start the built plugin/DSH Desktop or a controlled DSH profile, call `/v1/models` and one non-destructive chat request where a free/available provider is usable; if no provider can be safely called, run the injected-runtime HTTP integration test and document the live verification gap.**
- [ ] **Step 6: Review `git diff`, ensure no secrets or generated credential files are included, and commit using Chinese detailed message:**
  `feat(网关): 增加 DSH OpenAI Chat Completions 本机出口`
- [ ] **Step 7: Add or update remote `git@gitee.com:wjm251/deepseek-harness-codearts.git`, push the complete verified commit, and verify remote branch/commit.**
