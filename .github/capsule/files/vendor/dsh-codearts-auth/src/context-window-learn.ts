/**
 * 「拿不到供应商上限」的模型的**上下文窗口学习器**（手机版补充，2026-10-11）。
 *
 * ## 它解决什么
 *
 * `LlmModelInfo.context.contextWindow` 是 DSH 压缩阈值的**唯一**依据，而它**必须有值**
 * ——`context` 为空时压缩链直接抛 `compaction-basic: no context capacity for …`。
 * 可有些渠道**根本不声明**窗口（远端目录缺字段、静态表只有估值），历史上这些模型
 * 一律按保守的 200K 声明 ⇒ 真实窗口有 1M 的模型也**永远只用得上五分之一**。
 *
 * 用户口径（2026-10-11，接力文档「设计约定 3」）：
 * **能从供应商拿到的上限一律用真值**；**只有拿不到上限的模型**才用动态方案 ——
 * **起步给大 → 撞墙报错 → 收窄**，并配合 DSH 自带的压缩恢复链。
 * ⇒ 本模块只服务**兜底**路径：调用方一旦拿到了供应商的真实声明，**不得**查这里。
 *
 * ## 接入点（三处）
 * - `aggregate-adapter.ts`：虚拟模型**所有候选都没声明**窗口时的兜底；
 * - `zcode-adapter.ts` + `zcode-upstream.ts`：zcode 远端目录对第三方模型**不带**
 *   `contextWindow`（那批模型此前被目录统一写成写死的 200K），现改为目录给**起步值**、
 *   适配器每请求读**学习值**（`resolveModel` 不被缓存 ⇒ 收窄立刻生效）。
 * - `aggregate-adapter.ts` 的 `dispatch`：**截断**（`finish: max-tokens`）也算证据 ——
 *   上游不报错、只按自己的上限截断时，用本轮观测规模（`usage.totalTokens`）记上限
 *   （{@link rememberContextWindowCeiling}），并据此在派发前跳过太窄的候选。
 *
 * ## ⚠️ 为什么「收窄」必须快
 *
 * 声明得比真实窗口**大**时，DSH 的压缩阈值会跟着算宽：撞墙后压缩一次、阈值仍高于
 * 真实上限，就会「撞墙 → 压缩 → 再撞墙」。所以这里**优先从报文里直接读出真实上限**
 * （`… > 1048576 maximum` / `maximum context length is 128000`），读不出才退化成
 * 「减半」逐步收敛。
 *
 * ## ⚠️ 为什么只记忆在**进程内**（用户选择，不落盘）
 *
 * 代价是每次重启后重新撞一次墙；换来的是**不会把一个学错的值永久固化**——
 * 而「固化错误值」正是 2026-10-11 那次「永远显示 200K」事故的形态
 * （见 `aggregate-adapter.ts` 里 `contextWindowFor` 的记忆化修正）。
 *
 * ## ⚠️ 有意为之的边界
 *
 * 判据**只认英文**、且只认宿主分类器已经认定的那两族数字形态：**中文超限报文不猜**
 * （设备 42 个会话里没有真实样本可依据，见接力文档 9.10）。中文报文会落到「减半」
 * 兜底路径，照样收敛，只是多撞几次。
 *
 * @module src/context-window-learn.ts
 */

/** 拿不到供应商上限时的**起步声明**（用户口径：起步给大，撞墙再收窄）。 */
export const DYNAMIC_CONTEXT_WINDOW_START = 1_000_000

/**
 * 收窄的**下限**。
 *
 * 兜底路径每次撞墙减半（1M → 500K → 250K → …），没有下限时一次异常报文就能把某个
 * 模型压到荒谬区间。而声明偏小只会让压缩更早发生（不致命），故下限取「小窗口模型」
 * 的量级 32K —— 真实上限低于它的模型在这个生态里极罕见。
 */
export const DYNAMIC_CONTEXT_WINDOW_FLOOR = 32_768

/** 进程内学习表（`provider` + 模型 → 已学到的窗口）。**不落盘**，重启即忘。 */
const learned = new Map<string, number>()

/** `provider` + 模型 id → 学习表的键（NUL 分隔，避免 `a/b` 与 `a_b` 这类撞键）。 */
export function contextWindowKey(provider: string, model: string): string {
  return `${provider}${String.fromCharCode(0)}${model}`
}

/** 动态声明值：学过用学到的，没学过给起步值。 */
export function dynamicContextWindowFor(key: string): number {
  return learned.get(key) ?? DYNAMIC_CONTEXT_WINDOW_START
}

/**
 * 已学到的窗口；没学过返回 `undefined`。
 *
 * ⚠️ 与 {@link dynamicContextWindowFor} 的区别就在这个 `undefined`：**zcode 适配器**
 * 要的是「学过就用学到的、没学过才回落目录声明值」，故它读本函数而不是起步值那个。
 */
export function learnedContextWindow(key: string): number | undefined {
  return learned.get(key)
}

/**
 * 从上游失败报文里读**真实上限**。
 *
 * 只认两族**英文**数字形态（都是宿主 `isContextWindowExceededError` 已经认定的措辞）：
 * - `This model's maximum context length is 128000 tokens` ⇒ 128000；
 * - `prompt is too long: 1061554 tokens > 1048576 maximum` ⇒ 1048576。
 *
 * ⚠️ **不要**在这里加「看起来像数字就当窗口」的宽判据：报文里还有用量、状态码、
 * 时间戳，误取一次就会把声明压到错误的量级（而收窄是**有记忆**的）。
 * 合理性区间 `[1024, 1e8]` 兜住极端形态。
 */
export function contextWindowFromFailureText(text: string): number | undefined {
  const patterns = [
    /maximum\s+context\s+length\s+is\s+([\d,]+)/i,
    /([\d,]+)\s*(?:tokens?\s*)?maximum\b/i,
  ]
  for (const pattern of patterns) {
    const matched = pattern.exec(text)
    if (matched === null) continue
    const value = Number(matched[1]?.replace(/,/g, ''))
    if (Number.isFinite(value) && value >= 1_024 && value <= 100_000_000) return value
  }
  return undefined
}

/**
 * 撞墙时调用：**优先记住报文里的真实上限**，读不出就按当前声明值**减半**。
 *
 * 返回收窄后的值（调用方用于日志/诊断）。可重复调用：每次都在上一次的基础上继续收窄。
 */
export function rememberContextWindowFailure(key: string, failureText: string): number {
  const next = contextWindowFromFailureText(failureText) ?? Math.max(
    DYNAMIC_CONTEXT_WINDOW_FLOOR,
    Math.floor(dynamicContextWindowFor(key) / 2),
  )
  learned.set(key, next)
  return next
}

/**
 * **截断时**调用：把观测到的本轮规模记为该键的**上限下界**。
 *
 * ## 为什么与 {@link rememberContextWindowFailure} 分开
 *
 * 那个读的是**失败报文**里的 `maximum`；而上游常常**不报错** —— 它按自己的上限把输出
 * 截断（`finish_reason: length` / DSH 的 `finish: max-tokens`），报错通道里什么都没有。
 * 实测（2026-10-12，`aggregate/auto` → loomy `spark-x`）：会话 20.9 万 token、
 * 虚拟模型声明 1M，spark-x 真实上限约 262K ⇒ 连续两轮以 `max-tokens` 收场，
 * 而学习器一条信号都没收到（它只挂在失败路径上）。
 *
 * ## 取值语义与方向
 *
 * `observedTokens` = 截断发生时**在飞的总量**（`usage.totalTokens`）。它证明
 * 「该键的有效上限 ≲ 这个数」，故：
 * - 记入后**只用于收窄**（比当前值大就不记）⇒ 放大声明值这种事永远不会发生；
 * - 低于 {@link DYNAMIC_CONTEXT_WINDOW_FLOOR} 的观测值**不记**（那是异常报文，不是窗口）；
 * - 后续更小的截断会继续压低它（单调收窄，方向保守）。
 *
 * ⚠️ 收窄的代价只是「压缩更早发生」（浪费一点上下文），而不收窄的代价是
 * **每轮都撞同一个天花板**（用户实测：连续两轮被截断）。
 *
 * @returns 记入后的值；未记入（观测无效 / 不比当前值小）返回 `undefined`。
 */
export function rememberContextWindowCeiling(key: string, observedTokens: number): number | undefined {
  if (!Number.isFinite(observedTokens) || observedTokens < DYNAMIC_CONTEXT_WINDOW_FLOOR) return undefined
  const current = learned.get(key)
  if (current !== undefined && current <= observedTokens) return undefined
  const next = Math.floor(observedTokens)
  learned.set(key, next)
  return next
}

/** 清空学习表（单测用；本模块只有进程内状态，无持久化）。 */
export function resetLearnedContextWindows(): void {
  learned.clear()
}
