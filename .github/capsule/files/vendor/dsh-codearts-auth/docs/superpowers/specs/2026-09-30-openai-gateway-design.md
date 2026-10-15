# DSH OpenAI Chat Completions 网关设计

## 目标

在现有 `dsh-codearts-auth` 插件内增加一个独立目录，实现 DSH Desktop 的本机模型网关。其他 Agent 通过标准 OpenAI Chat Completions 协议访问 Jet Hub 中已经登录的 CodeArts、Qoder、ZCode 及其他 provider，不直接读取或实现各 provider 的凭据和专用协议。

## 范围

第一期只提供：

- `GET /v1/models`
- `POST /v1/chat/completions`
- `127.0.0.1` 本机监听，默认端口 `8326`
- `Bearer` API Key 鉴权
- `stream: true` 的 SSE 流式响应
- `stream: false` 的聚合 JSON 响应
- 普通文本、reasoning、工具调用、工具结果、用量、取消和错误转换
- DSH 当前有可用凭据的模型目录
- Jet Hub 模型黑名单只影响 `/v1/models` 展示，不阻止显式请求既有模型

第一期不提供：

- Anthropic Messages 或 OpenAI Responses 对外协议
- 账号登录、账号增删、积分领取等新的管理接口
- Pi 专用协议或 Pi 专用状态
- 直接从 Pi 读取 `.credentials.yaml`
- 外网监听

## 配置约定

| 配置 | 默认值 |
|---|---|
| 监听地址 | `127.0.0.1` |
| 监听端口 | `8326` |
| 端口环境变量 | `DSH_OPENAI_GATEWAY_PORT` |
| API Key 环境变量 | `DSH_OPENAI_GATEWAY_API_KEY` |
| API Key 文件 | DSH home 下 `openai-gateway/api-key` |

如果未设置 `DSH_OPENAI_GATEWAY_API_KEY`，首次启动时使用密码学安全随机值生成 API Key，并原子写入独立文件；后续启动复用该值。环境变量优先于文件。API Key 不写入日志。

端口被占用时启动失败并记录明确错误，不随机更换端口，避免已配置的 Agent 静默失效。

## 架构

```text
其他 Agent
  │ OpenAI Chat Completions
  ▼
`src/openai-gateway/` HTTP server
  │ provider/model 路由与请求转换
  ▼
DSH `ctx.llm.listModels()` / `ctx.llm.stream()`
  │
  ▼
现有 provider adapter + AccountPool + Jet Hub credentials
  │
  ▼
CodeArts / Qoder / ZCode / ...
```

网关只负责标准 HTTP 边界、模型目录和格式转换；账号池、凭据续期、限流换号、专用签名、WASM、CAPTCHA 和上游协议继续由现有 DSH provider 实现。

网关生命周期由 `src/index.ts` 做一处最小接线：插件 `apply()` 后启动，插件销毁时关闭 HTTP server。所有业务逻辑留在 `src/openai-gateway/`，不修改现有 provider adapter。

## 模型目录

网关从 DSH LLM runtime 获取 provider 路由和模型目录，并以 `provider/model` 作为外部模型 ID：

```text
codearts/GLM-5.3
qoder/qfmodel
qodercn/qfmodel
zcode/GLM-5.3-Flash
```

只列出当前能解析凭据的 provider 模型。模型展示遵守 Jet Hub 的 disabled-model 黑名单；隐藏模型不出现在 `/v1/models`，但显式请求仍交给 DSH 路由处理。

不同 provider 的同名模型不合并。`/v1/models` 使用 OpenAI 模型对象的最小字段，并附带 DSH 能提供的上下文、输出上限和输入模态元数据。

## 请求转换

外部请求解析为：

- `provider/model` 拆分为 DSH `provider` 和 `model`；
- OpenAI `messages` 转换为 DSH 的 `Message[]`、`ContentBlock[]`；
- OpenAI `system`、`user`、`assistant`、`tool` 角色映射到 DSH 的系统、文本、工具调用和工具结果块；
- OpenAI `tools` 转换为 DSH `ToolSchema[]`；
- `max_completion_tokens` 优先于 `max_tokens`，最终映射为 DSH `maxTokens`；
- `temperature` 和 `stop` 映射到 DSH 对应字段；
- `reasoning_effort` 映射为 DSH `ReasoningEffortId`；
- `stream` 控制输出形式。

第一期支持 `tool_choice: auto` 和 `tool_choice: none`；指定具体函数的强制选择暂不实现，收到时返回明确的 OpenAI 风格 400 错误。

`top_p`、频率惩罚、存在惩罚等 DSH 当前没有对应字段的兼容参数不参与模型请求，不伪造 provider 行为；必要时保留为兼容输入并记录调试级信息，不记录完整请求或凭据。

请求消息中的图片暂按 DSH 当前 `ImageBlock` 能力转换；如果外部请求的图片无法安全转换为 DSH 附件引用，则返回明确错误，不静默丢图。

## 流式输出

消费 `ctx.llm.stream(GenerateOptions)` 的 `StreamChunk`，转换为 OpenAI SSE：

- `block-start`：初始化文本、reasoning 或 tool-call 块；
- `text-delta`：输出 `choices[].delta.content`；
- `reasoning-delta`：输出兼容的 reasoning 字段；
- `tool-call-delta`：输出 `tool_calls[].function.name/arguments`；
- `usage`：在最终 chunk 或兼容的 usage 字段中输出 token 统计；
- `finish`：映射为 `stop`、`tool_calls`、`length`、`error` 或 `aborted`，随后输出 `data: [DONE]`。

非流式请求复用同一转换器，先完整消费 DSH stream，再组装一个 OpenAI Chat Completion 响应，避免维护第二套 provider 调用逻辑。

每个请求创建独立 `AbortController`；客户端断开、请求取消或 server shutdown 时中止 DSH stream。网关不重试模型请求，重试和账号轮换继续使用各 provider adapter 已有策略。

## 错误处理

- 缺少或错误 API Key：`401`；
- JSON、路径、模型 ID 或必填字段非法：`400`；
- DSH provider 不存在或模型无法解析：`404` 或明确的 `400`；
- DSH 上游错误：转换为 OpenAI `error` 对象，保留稳定错误码和可读消息；
- DSH 取消：返回可识别的 aborted 错误，不伪装为正常 `stop`；
- 流已经开始后发生错误：发送 SSE 错误事件并关闭流，避免静默结束。

错误响应不包含 access token、refresh token、AK/SK、完整请求体或完整上游响应。

## 安全边界

- 只绑定 `127.0.0.1`；
- 所有非健康接口要求 `Authorization: Bearer <gateway-key>`；
- API Key 单独存储，不进入 Jet Hub 账号备份；
- 不从 Pi 侧暴露或复制 provider 凭据；
- 日志只记录端点、provider/model、HTTP 状态和错误摘要，不记录 prompt、tool 参数或鉴权头；
- server close 必须幂等，并清理活动请求。

## 文件边界

新增目录：

```text
src/openai-gateway/
  auth.ts          # API Key 读取、生成、持久化和鉴权
  config.ts        # 地址、端口、路径及环境变量解析
  models.ts        # DSH 模型目录到 OpenAI model 对象的转换
  messages.ts      # OpenAI messages/tools 到 DSH 消息块的转换
  stream.ts        # DSH StreamChunk 到 OpenAI SSE/JSON 的转换
  server.ts        # HTTP server、路由、请求生命周期和 shutdown
  index.ts         # 对外装配入口
```

测试放入：

```text
tests/unit/openai-gateway-*.spec.ts
```

现有 `src/index.ts` 只增加 gateway 的启动/停止接线和必要的 `ctx.llm` 依赖传入。不得将网关实现嵌入既有 provider adapter。

## 验收标准

1. 未配置 API Key 时首次启动生成文件，重启后 Key 不变化。
2. 配置环境变量时优先使用环境变量。
3. 非本机地址不可监听，端口冲突可诊断失败。
4. 无凭据 provider 不出现在 `/v1/models`。
5. `provider/model` 能正确路由到 DSH `ctx.llm`。
6. 普通文本的流式与非流式响应均能被标准 OpenAI 客户端解析。
7. 工具声明、工具调用、工具结果可以完成至少一轮往返。
8. reasoning、usage、finish reason 不丢失或错误伪装。
9. 客户端断开后 DSH 请求收到 abort。
10. CodeArts、Qoder 或 ZCode 至少选一个真实 provider 完成本机端到端验证；如果真实 provider 不可用，必须使用注入的 DSH stream 替身完成协议闭环，并明确记录真实验证缺口。
11. `pnpm typecheck`、相关单元测试和 `pnpm build:all` 通过。
12. 代码提交到用户指定的 `git@gitee.com:wjm251/deepseek-harness-codearts.git`，提交信息使用中文并说明变更和验证结果。
