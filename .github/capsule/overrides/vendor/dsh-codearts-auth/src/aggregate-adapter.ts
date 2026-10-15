/**
 * 聚合 provider：**一个规范模型名，多渠道候选**，按临期积分自动选渠道。
 *
 * ## 与 `jet-hub-auto` 的分工
 *
 * | | `jet-hub-auto/auto` | `aggregate/auto` | `aggregate/<规范模型>` |
 * |---|---|---|---|
 * | 候选来源 | 5 个渠道的所有模型 | 所有渠道的所有模型 | **该虚拟模型**的候选表 |
 * | 渠道内选模型 | 按倍率挑最便宜 | 同左 | 固定 realId，无选择 |
 * | 用途 | 不挑模型，谁临期烧谁 | 同左 | 锁定模型质量，渠道间轮询 |
 *
 * 两者**共用** `aggregate-core` 的排序与哨兵口径（见该模块头：两份实现必然漂移）。
 *
 * ## 目录是**动态**的
 *
 * 虚拟模型表由各渠道的**当前**目录推导（`buildVirtualModels`）⇒ 用户新增/关闭
 * 渠道模型后，下次 `listModels` 自动反映，无需重启。⚠️ 故**不缓存**目录，
 * 只缓存「一次选型」的结果（见 {@link AggregateAdapterOptions.ttlMs}）。
 *
 * ## DSH 的两条硬约束（违反即报错）
 *
 * 1. `listModels` 每条必须 `provider === 注册路由`、id/name 非空且**id 不重复**
 *    （否则 `INVALID_CATALOG`）；
 * 2. `resolveModel` 返回的 `provider`/`id` 必须与请求**逐字相符**
 *    （否则 `INVALID_MODEL_INFO`）—— 这是「多虚拟模型」必须按入参回填的原因。
 *
 * @module src/aggregate-adapter.ts
 */

import type { Context } from '@deepseek-ai/cordis'
import { activeRoutes } from './active-route.js'
// ⚠️ 零输出撞墙的判据与目标级冷却（issue IKJW31 的 B 方案）——**唯一权威**在那个模块。
//    本文件此前只在该模块头里被列为「调用方之一」却**从未接线**（真实缺口，2026-10-12
//    用户实测报障）：`jet-hub-auto` 能在「上游收下请求却零输出」时改道下一个 provider，
//    而聚合层只能把 `finish: max-tokens` 原样透出（DSH 对 max-tokens **不自动重试**）
//    ⇒ 用户侧看到「回答被截断」，且下一次仍派给同一家（最便宜的那家）。
//    ⚠️ 判据复用共享函数，**不在这里另写一份**（本仓库红线：同一语义不得两套判据）。
import {
  emptyZeroOutputProbe,
  isTargetCoolingDown,
  isZeroOutputWallHit,
  noteChunk,
  noteZeroOutputHit,
  zeroOutputKey,
  ZERO_OUTPUT_COOLDOWN_MS,
  type ZeroOutputCooldownMap,
} from './zero-output-guard.js'

// ⚠️ `contentHasImage` 是**值导入**（`auto-adapter.ts` 同款）：带图判定必须与宿主
// capability 判据**同一函数**（它含 tool-result 递归），自己写一遍必然漂移。
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AccountPool } from './account-pool.js'
// ⚠️ 只导入**类型**（拒绝表的结构）—— 运行时读写由装配层注入的 `rejections()` 承担，
// 适配器不直接碰 `state.json`（保持「适配器不持有持久化」的分层）。
import type { AggregateRejectionMap } from './jet-hub-store.js'
import { buildVirtualModels, type VirtualModel } from './aggregate-catalog.js'
// ⚠️ `NEVER` / `UNUSABLE` **必须**从这里导入（Task 3 的共享底座）。它们从不在
// `auto-adapter.ts` 里 `export` —— 从那里导入会编译失败（Task 3 复审已确认）。
// ⚠️ `ExpiryProbe` 也在这里：它是**纯类型**，而 `aggregate-expiry.ts`（探针实现）
// 与 `auto-adapter.ts` 都要引用它 ⇒ 放底座才能让两者都依赖底座而**不互相依赖**。
import {
  NEVER,
  UNUSABLE,
  rankCandidates,
  type ExpiryProbe,
  type RankedCandidate,
} from './aggregate-core.js'
import { CANONICAL_REASONING_EFFORTS, translateReasoningEffort } from './reasoning-ladder.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
// ⚠️ 只导入**常量**（不导入 `createExpiryProbe`）⇒ 依赖方向仍是
// `aggregate-adapter → aggregate-expiry → aggregate-core`，无环。
import { WIRED_EXPIRY_PROVIDERS } from './aggregate-expiry.js'
// ⚠️ 动态窗口学习器（Step B 切片一）：只服务「候选**全都不声明**窗口」的**兜底**路径 ——
// 一旦拿到供应商真值（`widest !== undefined`）就用真值，**不查**它（约定 3）。
import {
  contextWindowKey,
  dynamicContextWindowFor,
  learnedContextWindow,
  noteContextWindowSuccess,
  rememberContextWindowCeiling,
  rememberContextWindowFailure,
} from './context-window-learn.js'
// ⚠️ 共享的「上下文超限」判据（宿主分类器 + 网关措辞兜底）。
// 本文件的兜底网（`isContextOverflowFailure`）原先**只喂宿主分类器**，于是
// 「HTTP 200/400 + 通用码 + `prompt is too long: N tokens > M maximum`」这类
// 报文在这里**漏判**（那正是 9.15/9.16 在四条通道上统一修掉的那一类）。
// 复用同一判据是刻意的：本仓库红线「同一语义不得两套判据」。
import { isContextOverflowBody } from './openai-compat.js'

/** 注册到 `ctx.llm` 的路由，也是 `providerInfo().id`（DSH 校验二者相等）。 */
export const AGGREGATE_PROVIDER = 'aggregate'

/** 「不挑模型」的虚拟模型 id。 */
export const AGGREGATE_AUTO_MODEL = 'auto'

/**
 * ⚠️ 这里**不再有**「候选全无声明时的写死兜底值」。
 *
 * 沿革（别把它改回去）：2026-10-11 曾把兜底改成 1M（**被用户否决**：一刀切不符合
 * 「各家声明各不相同」的真实），随后查明真问题是**记忆化固化**（解析不到声明也写缓存
 * ⇒ 目录就绪后仍返回固化值）。本轮按用户新口径（接力文档「设计约定 3」）改为
 * **动态方案**：能拿到真值的用真值；拿不到的起步给大 → 撞墙 → 收窄
 * （见 `context-window-learn.ts` 的 {@link dynamicContextWindowFor}）。
 */

/**
 * 临期探针的类型 `ExpiryProbe` 定义在 **`aggregate-core.ts`**（纯类型、零 IO）——
 * 实现是 `aggregate-expiry.ts` 的 `createExpiryProbe`，`auto-adapter.ts` 的
 * `expiryOf` 也复用它（薄委托）。
 *
 * ⚠️ **未接入的 provider 必须返回 `UNUSABLE`** —— 返回 `NEVER` 会让一个我们对其
 * 余额一无所知的渠道以「永久积分」身份参与轮换（见 `aggregate-expiry.ts` 的
 * 逐渠道判据表与长注释）。
 */

/** 聚合层的选型缓存时长（与 auto 同量级）。 */
export const AGGREGATE_TTL_MS = 60_000

/** 目录推导的缓存时长。
 *
 * ⚠️ **必须有这个缓存**：`refreshCatalog` 要向**每一个**渠道调 `listModels`，
 * 而其中数家会**发网络请求**取远端目录（buddy / workbuddy / lobsterai / trae /
 * cline / zcode）。而模型选择器会频繁问目录 ⇒ 没有缓存时，每打开一次选择器都会
 * 扇出十几次上游请求。
 *
 * ⚠️ 但**不能缓存太久**：用户新增/关闭渠道模型后，聚合目录要跟着变（这正是
 * 「目录是动态的」那条设计）。60 秒与各家自己的目录缓存同量级。
 */
export const AGGREGATE_CATALOG_TTL_MS = 60_000

export interface AggregateAdapterOptions {
  accountPool: AccountPool
  /** 注入的当前时刻（测试用）。 */
  now?: () => number
  /** 选型缓存时长（测试用）。 */
  ttlMs?: number
  /** 目录推导缓存时长（测试用；生产用 {@link AGGREGATE_CATALOG_TTL_MS}）。 */
  catalogTtlMs?: number
  /** 临期探针（省略时用 `createExpiryProbe`；单测注入替身）。 */
  expiryProbe?: ExpiryProbe
  /**
   * 读取「拒绝轮换」表（虚拟模型 id → provider → realId → true）。
   *
   * ⚠️ 必须是**函数**而不是快照：设置面板上的开关改完后，**下一次请求**就要生效。
   * 传快照会让用户以为开关坏了（要重启插件才生效）。
   * 省略时视为「没有任何拒绝」（全部候选参与轮换）。
   *
   * ⚠️ 与 `choiceCache` 的耦合：改了拒绝表必须调
   * {@link AggregateAdapter.clearChoiceCache}，否则 60 秒 TTL 内仍会用旧的候选序
   *（RPC 端点负责这件事，见 `aggregate.setRejected`）。
   */
  rejections?: () => AggregateRejectionMap
}

/**
 * 一次 `usage` 帧代表的**本轮规模**（token）。
 *
 * DSH 的 `TokenUsage` 各计数是**互斥**的（`inputTokens` 只含未缓存部分，缓存命中另计
 * `cacheReadTokens`/`cacheWriteTokens`）⇒ 「在飞的上下文规模」= 四者之和；
 * 上游给了 `totalTokens` 时以它为准（那是权威口径）。
 *
 * ⚠️ 拿不到任何正数就返回 `undefined`（**不编造**）：方案 B/C 都建立在
 * 「确实观测到规模」之上，猜一个值会让筛选误伤宽窗口候选。
 */
function contextTokensOfUsage(
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  } | undefined,
): number | undefined {
  if (usage === undefined) return undefined
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) {
    return usage.totalTokens
  }
  const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
  let sum = 0
  for (const part of parts) {
    if (typeof part === 'number' && Number.isFinite(part) && part > 0) sum += part
  }
  return sum > 0 ? sum : undefined
}

/** 聚合适配器。 */
export class AggregateAdapter extends LlmAdapter {
  /** 上次目录读取结果（面板与 listModels 共用一次推导）。 */
  private catalog: VirtualModel[] = []
  /** 上次推导时刻（目录缓存的判据）。 */
  private catalogAt = 0
  /**
   * **按虚拟模型**缓存的候选序（键 = 虚拟模型 id）。
   *
   * ## 为什么需要它（规格 §9 要求，初版漏实现 ⇒ 死配置）
   *
   * `candidatesFor` 会对每个候选渠道 `await probe(...)` —— 那是一次**上游余额
   * GET**。而 `prepareCall` 是**每请求一次**（`dsh-llm/lib/index.js:1667`），
   * 于是 `auto` 最坏每轮要打十几次余额查询；而**旧的 `auto` 有 60 秒缓存**
   * （`auto-adapter.ts` 的 `AUTO_CHOICE_TTL_MS`）⇒ 新主路径反而**严格劣于**旧路径。
   *
   * ⚠️ 必须**按模型分别缓存**（规格 §9）：不同虚拟模型的候选表不同，共用一条会让
   * A 模型的候选序被 B 模型的请求覆盖。
   * ⚠️ 缓存的是**候选序**，不是「最终选中的渠道」—— 失败切换仍在同一次请求内
   * 逐个尝试（那是 `dispatch` 的事，与本缓存无关）。
   * ⚠️ 一分钟内临期时刻不会显著变化，故 60 秒 TTL 不破坏「临期优先」的语义。
   */
  private readonly choiceCache = new Map<string, { at: number; targets: DispatchTarget[] }>()
  /** 虚拟模型 → 解析出的最大上下文窗口。仅在**全部候选**解析成功时记忆化。 */
  private readonly contextWindowCache = new Map<string, number>()
  /**
   * 「目标收下请求却零输出」的目标级冷却表（issue IKJW31 的 B 方案，2026-10-12 接线）。
   *
   * ⚠️ **纯内存、进程内、不落盘**：它优化的是「本次运行内别再三连撞同一堵墙」，
   * 重启后重新试探是**正确**行为（用户可能已升级插件、上游可能已扩容）。
   * ⚠️ 与 `jet-hub-auto` 的 `zeroOutputCooldowns` **同一语义、同一判据**，只是各记各的
   * （两家路由的候选池不同，共用一张表会让一家的失败影响另一家的选型）。
   */
  private zeroOutputCooldowns: ZeroOutputCooldownMap = new Map()


  /**
   * `provider\u0000realId` → 该候选**声明**的上下文窗口（解析时顺手记下）。
   *
   * ⚠️ 用途是**派发前按本轮体积跳过太窄的候选**（方案 C，2026-10-12）：
   * `aggregate/auto` 的候选横跨十几个渠道，声明的窗口相差两个数量级（1M vs 32K），
   * 而 DSH 只看到虚拟模型那**一个**窗口。若不筛，一个 20 万 token 的会话会被派给
   * 3.2 万窗口的候选 ⇒ 上游报超限（或按自己的上限截断）。
   * ⚠️ 只记「确实有声明」的值；未知的候选**不筛**（未知 ≠ 太窄）。
   */
  private readonly candidateWindow = new Map<string, number>()

  /**
   * 各会话**最近一次观测到的本轮上下文规模**（token，来自 `usage` 帧的 `totalTokens`）。
   *
   * ## ⚠️⚠️ 为什么必须按会话分桶、且必须逐请求覆盖（Issue F-04，2026-10-14）
   *
   * 修法前这里是**一个进程级字段 + `Math.max` 只增不减**，却被当成「本轮体积」喂给
   * 两处消费（方案 C 的派发前筛选、方案 B 的 `finish: max-tokens` 学习）。后果：
   *
   * | # | 消费点 | 后果 |
   * |---|---|---|
   * | ① | 方案 C 筛选 | 进程内任一会话产生过一次大 usage（文档实测过 90 万）后，**另一个几千 token 的小会话**发请求时 `required = 峰值 × 1.05` 高于池内全部候选已知上限 ⇒ `kept` 与 `cooling` 同时为空 ⇒ 主动抛 `CONTEXT_WINDOW_EXCEEDED` ⇒ DSH 压缩后重发 ⇒ 值不变 ⇒ **压缩重试死循环**，该会话在进程存活期内永久不可用 |
   * | ② | 方案 B 学习 | 把**峰值**而非本次尝试的 `turnTokens` 喂给 `rememberContextWindowCeiling`，而它**只在更小时覆盖** ⇒ 宽候选观测过 90 万后，窄候选真实撞墙 26.2 万时永远学不进 ⇒ cap 恒 90 万 ⇒ 恒不跳过窄候选 ⇒ 反复截断 |
   *
   * 故语义收窄为两条：
   * 1. **按 `options.sessionId` 分桶** —— 一个会话的规模不得成为另一个会话的判据；
   * 2. **逐请求覆盖**（不再跨请求 `Math.max`）—— 会话被压缩变小后，下一次观测要能
   *    如实降到小值。`Math.max` 只保留在**同一次请求内部**（一次请求里 usage 可能
   *    到多帧，规模只会增长，取最大才安全）。
   *
   * ⚠️ 无 `sessionId` 的请求落在同一个 `''` 桶里；它们**不会**因此互相锁死 ——
   * 主动抛错时会清桶（见下方 `CONTEXT_WINDOW_EXCEEDED` 分支），退回「未知 ⇒ 不筛」。
   *
   * ⚠️ 容量上限 512：与会话数同阶，超出按插入序淘汰最旧的一条（与
   * `candidateWindow` 那种「只增不清」的表刻意不同 —— 那正是 F-53 的形态）。
   */
  private readonly lastContextTokensBySession = new Map<string, number>()

  /**
   * 「上次**实际**转发成功的渠道」——按虚拟模型分别记录（P3，供用量徽标显示）。
   *
   * ## ⚠️ 语义是**真实历史**，不是预测
   *
   * 只在**产出可见内容时**写入（= 这个候选真的成功了）。**不做预测**：
   * 预测的胜者可能因失败切换而实际未被使用，徽标显示一个错的渠道比不显示更误导。
   *
   * ## ⚠️ 纯内存、进程内
   *
   * 插件重启即清空 ⇒ 徽标「无历史 ⇒ 不渲染」（规格 §6.3 的 P4）。
   * ⚠️ **不落盘**：这是展示用的瞬时状态，写盘只会带来无谓的 IO 与陈旧值
   *（重启后显示一个早已不用的渠道，反而误导）。
   *
   * ⚠️ 与 `choiceCache` 的区别：那个缓存的是**候选序**（可预测），
   * 本表记录的是**实际结果**（已发生）——两者不可互相推导。
   */
  private readonly activeProviderByModel = new Map<string, string>()
  /**
   * 「上次实际转发成功的渠道 + 真实 modelId」（与 `activeProviderByModel` 同一门控：
   *    整轮正常结束才写；不落盘、只记**真实历史**）。
   */
  private readonly activeTargetByModel = new Map<string, { provider: string; realId: string }>()

  constructor(private readonly ctx: Context, private readonly options: AggregateAdapterOptions) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: '聚合（跨渠道临期优先）' }
  }

  /**
   * 该虚拟模型下被**拒绝轮换**的候选集合，键是 `` `${provider}\u0000${realId}` ``。
   *
   * ⚠️ 用 `\u0000` 作分隔符（不是 `:` 或 `/`）：provider id 与 realId 里都可能含
   * 冒号或斜杠（如 `cline-free/deepseek-v4.1-flash`），用它们会**误判**（把
   * `a/b` + `c` 与 `a` + `b/c` 拼成同一个键）。NUL 在两者里都不可能出现。
   */
  rejectedIn(canonicalId: string): ReadonlySet<string> {
    const table = this.options.rejections?.() ?? {}
    const byProvider = table[canonicalId]
    const out = new Set<string>()
    if (byProvider === undefined) return out
    for (const [provider, byRealId] of Object.entries(byProvider)) {
      for (const [realId, flag] of Object.entries(byRealId)) {
        if (flag === true) out.add(`${provider}\u0000${realId}`)
      }
    }
    return out
  }

  /**
   * 该虚拟模型下**实际应被拒绝**的候选集合（**含 D4 的 id 漂移降级**）。
   *
   * ## ⚠️ 为什么需要它（规格 §0.3 D4 + §1.9 + §5.1 的成文要求）
   *
   * 规格 §5.1 的判据表：
   * ```
   * 查 (虚拟模型, provider, realId) 是否有拒绝记录
   * ├─ 有精确匹配 → 拒绝该候选
   * ├─ 无精确匹配，但该 (虚拟模型, provider) 下有**任何**拒绝记录
   * │     且该记录对应的 realId **已不在当前候选中**（id 漂移）
   * │     → 降级为渠道级拒绝（该虚拟模型下该渠道全部候选都被拒），并记一条 warn
   * └─ 无记录 → 参与轮换
   * ```
   *
   * ## ⚠️ 不实现它的**真实后果**（规格 §1.9 记录的静默失效）
   *
   * `lobsterai` 的候选 id 会随「远端可用 / 兜底」切换：远端是 `deepseek-flash`
   *（真 V4.1 Flash），兜底表是 `deepseek-v4-flash`（更旧的型号）。
   * 若拒绝记录只锁 `realId`，**状态一翻转就匹配不上、静默失效** ——
   * 用户明确拒绝过的候选**悄悄复活**，而他以为还拒着。
   *
   * ⚠️ 降级判据是「该记录对应的 realId **已不在当前候选中**」——
   *    **不是**「没有精确匹配」（那样会把「同渠道的另一个候选没被拒」也降级掉，
   *    那是过度拒绝，方向相反的错误）。
   *
   * @param virtual - 当前的虚拟模型（用来知道该渠道眼下有哪些 realId）
   * @returns 应拒绝的 `provider\u0000realId` 集合（**已展开为渠道级**，若降级发生）
   */
  rejectedFor(virtual: { key: string; candidates: readonly { provider: string; realId: string }[] }): ReadonlySet<string> {
    const table = this.options.rejections?.() ?? {}
    const byProvider = table[virtual.key]
    const out = new Set<string>()
    if (byProvider === undefined) return out

    for (const [provider, byRealId] of Object.entries(byProvider)) {
      // 该渠道眼下有哪些 realId（用于判断「记录里的 id 是否已漂移走」）。
      const currentIds = new Set(
        virtual.candidates.filter((c) => c.provider === provider).map((c) => c.realId),
      )
      // ⚠️ 只把**当前候选里**被拒的那些放进返回集：
      //    已漂移走的旧 id 不该出现在返回集里（它匹配不到任何候选，留着只是噪音）。
      let hasExact = false
      for (const realId of currentIds) {
        if (byRealId[realId] === true) {
          out.add(`${provider}\u0000${realId}`)
          hasExact = true
        }
      }
      // 该渠道眼下没有候选 ⇒ 无从降级（不是漂移，是这个渠道眼下没候选）。
      if (currentIds.size === 0) continue
      // 该渠道**是否已有精确命中**：有的话漂移规则不适用（规格判据的「无精确匹配」前提）。
      if (hasExact) continue
      // 走到这里 = 该渠道在当前候选里**一条都没精确命中**。
      // 再看它是否有**任何** `true` 记录（那些 realId 都不在当前候选里 ⇒ 即漂移）。
      const hasDrifted = Object.entries(byRealId).some(([, flag]) => flag === true)
      if (!hasDrifted) continue
      // ⚠️ 只在「无精确命中 + 有记录漂移走」时降级为渠道级（规格 §5.1 的判据）。
      this.ctx.logger?.warn?.(
        `[aggregate] ${virtual.key} 下 ${provider} 的拒绝记录已漂移`
        + `（记录里的 realId 不在当前候选 ${JSON.stringify([...currentIds])} 中）`
        + `⇒ **降级为渠道级拒绝**（该渠道在这个虚拟模型下全部候选都被拒）。`
        + `⚠️ 若这是误判，请在设置页「聚合」面板的该模型子列表里重新打开它`
        + `（那会**清掉该渠道的全部拒绝记录**，含已漂移的旧 id，故降级随即解除）。`,
      )
      // ⚠️⚠️ **这里刻意**不做**任何状态写入**（真实教训）：
      //    我第一版让本方法「顺手把漂移的旧键迁移到当前 realId」——
      //    但本方法是**读取路径**（每次路由决策、每次面板刷新都调），
      //    在读操作里改状态会在面板刷新时产生莫名其妙的持久化写入，
      //    也让判据依赖于「有没有成功写盘」。⇒ 恢复能力改由**写路径**提供：
      //    `AccountPool.setAggregateRejected(..., false)` 在「重新打开」时会
      //    一并清掉该 (虚拟模型, 渠道) 下**全部**记录（含漂移的旧 id）
      //    ⇒ 表里既无精确命中也无漂移记录 ⇒ 降级自然解除。
      //    见 `src/account-pool.ts` 的长注释与 `tests/unit/aggregate-rejections.spec.ts`。
      for (const realId of currentIds) out.add(`${provider}\u0000${realId}`)
    }
    return out
  }

  /**
   * 清空选型缓存。
   *
   * ⚠️ **改了拒绝表之后必须调它**：`choiceCache` 的 TTL 是 60 秒，而面板上的开关
   * 是「立刻生效」的语义 —— 不清缓存的话，用户在面板上关掉的候选在 60 秒内仍会被
   * 尝试（用户会以为开关坏了）。RPC 的 `aggregate.setRejected` / `clearRejected`
   * 负责调用。
   */
  clearChoiceCache(): void {
    this.choiceCache.clear()
  }

  /**
   * 「上次**实际**转发成功的渠道」（P3，供用量徽标）。
   *
   * ⚠️ **纯内存读、零网络零余额查询** —— 徽标在**门控阶段**就要拿到它
   *（规格 §6.3 的 P2：重定向必须发生在门控之前），查网络会让外层渲染抖动。
   *
   * @param canonicalId - 虚拟模型 id。**省略时返回「最近一次任意虚拟模型的转发渠道」**
   *   （规格 §8.4：徽标只关心「当前在跑的是哪个渠道」，不必区分模型）。
   *   实现上「最近一次」取 `Map` 的**最后一个插入项** —— 但 `Map` 的迭代顺序是
   *   **插入顺序**而非「最近写入顺序」（覆盖已存在的键**不改变**其位置）。
   *   ⚠️ 故这里**显式维护一个「最近写入」指针**，而不是依赖迭代顺序
   *   （否则「切回一个之前用过的渠道」时顺序会错，徽标显示旧渠道）。
   * @returns 渠道 id；无历史时 `null`（调用方据此**不渲染**徽标）。
   */
  activeProvider(canonicalId?: string): string | null {
    if (typeof canonicalId === 'string' && canonicalId.length > 0) {
      return this.activeProviderByModel.get(canonicalId) ?? null
    }
    return this.lastActiveProvider
  }

  /**
   * 「上次实际转发成功的**渠道 + 具体模型**」；无历史时 `null`。
   *
   * ⚠️ 与 {@link activeProvider} 同源、同一提交点、同样**纯内存零网络**
   *   （徽标在门控阶段同步渲染，查网络会让渠道变一次徽标闪一次）。
   * ⚠️ 用途：`auto` 的徽标只显示渠道时，用户不知道跑的是哪个模型
   *   （用户 2026-10-09 报障）。**服务端先把这个事实暴露出来**，客户端胶囊据此显示。
   */
  activeTarget(canonicalId?: string): { provider: string; realId: string } | null {
    if (typeof canonicalId === 'string' && canonicalId.length > 0) {
      return this.activeTargetByModel.get(canonicalId) ?? null
    }
    if (this.lastActiveProvider === null) return null
    return { provider: this.lastActiveProvider, realId: this.lastActiveModel ?? '' }
  }

  /** 最近一次（任意虚拟模型）实际转发成功的真实 modelId；无历史时 `null`。 */
  private lastActiveModel: string | null = null

  /** 最近一次（任意虚拟模型）实际转发成功的渠道；无历史时 `null`。 */
  private lastActiveProvider: string | null = null

  /**
   * 「按临期排序」用的候选到期时刻（面板的可选按钮，用户 2026-10-07 选定方案 C）。
   *
   * ## ⚠️⚠️ 这是**唯一**会做余额探测的面板端点 —— 且**只在用户显式点击时**调用
   *
   * 为什么必须单独一个方法而不是给 `describeCatalog` 加参数：那个方法的契约是
   * **零余额查询**（规格 §8.3，且有专门用例断言 `expiryProbe` 零调用）。
   * 面板一打开就打十几次上游请求是不可接受的；而「按临期排序」**必须**探测才知道顺序。
   * ⇒ 两者分开：默认零探测，用户点按钮才走这里。
   *
   * ## 为什么需要它（用户报障）
   *
   * 面板标题写「临期优先」，但候选列表来自 `aggregate-catalog.ts` 的
   * `candidates.sort(...)` —— 那是按 `provider` **字母序**
   * （用户原话：「codearts 的 4.1 flash 没有显示在最后」）。
   * ⇒ 标题与列表**矛盾**（面板没说真话）。
   *
   * ## 返回形状
   *
   * `{ <provider>: expiry }` —— 按渠道去重（同一渠道的多个候选共享一次探测，
   * 与 `candidatesFor` 的 `seen` 表同一口径，避免重复打上游）。
   * ⚠️ 探测失败（`UNUSABLE`）也如实返回该值，由客户端决定怎么显示/排序
   *（`sortCandidatesByExpiry` 把非有限值排最后）。
   *
   * ⚠️ **只读**：不改拒绝表、不写缓存、不落盘。
   */
  async describeExpiryOrder(signal?: AbortSignal): Promise<Record<string, number>> {
    await this.ensureCatalog()
    signal?.throwIfAborted()
    const probe = this.expiryProbe()
    const out: Record<string, number> = {}
    // ⚠️ 按渠道去重：同一渠道在多个虚拟模型下重复出现，只探一次。
    for (const virtual of this.catalog) {
      for (const candidate of virtual.candidates) {
        if (!WIRED_EXPIRY_PROVIDERS.includes(candidate.provider)) continue
        if (Object.hasOwn(out, candidate.provider)) continue
        signal?.throwIfAborted()
        try {
          out[candidate.provider] = await probe(candidate.provider, signal)
        } catch (error) {
          // ⚠️ **中止不得被吞成默认值**（与 `candidatesFor` 同一口径）：
          //    用户取消时应该立刻以 AbortError 结束，而不是把每个渠道都记成
          //    「查不到」后返回一份全错的有序表。
          if (isAbortLike(error, signal)) throw error
          out[candidate.provider] = UNUSABLE
        }
      }
    }
    return out
  }

  /**
   * 组装给设置面板的目录（**只读、零余额查询**，规格 §8.3）。
   *
   * ⚠️⚠️ **不得调用 `expiryProbe` / `resolveModelInfo`** —— 面板一打开就会对每个
   * 渠道打一次上游请求；而本端点只回答「有哪些虚拟模型、各自有哪些候选、哪些被拒」，
   * 与余额无关。实时余额仍由各渠道自己的面板负责。
   *
   * ⚠️ 「按临期排序」需要探测 ⇒ 它走**单独的** {@link describeExpiryOrder}，
   * 不在这里加参数（那会破坏本方法的零查询契约，且有专门用例断言）。
   *
   * ⚠️ 也**不得**改动拒绝表（纯读）。
   *
   * @param force - **绕过目录 TTL 缓存**（面板的「刷新」按钮用）。
   *   ⚠️ 真实缺陷（对抗审计实测证伪）：初版**不传 force**，而 `refreshCatalog` 有
   *   60 秒缓存 ⇒ 面板的「刷新」按钮实际是「读缓存」，用户在渠道侧新增/关闭模型后
   *   点刷新**看不到任何变化**，会以为聚合坏了。同时 `refreshCatalog` 的 `force`
   *   参数在**全仓零调用点**（死参数）—— 两处都是这条缺陷的一部分。
   *   ⚠️ 只有**用户显式点刷新**时才传 `true`：`listModels` 等高频路径必须继续走缓存，
   *   否则每次打开模型选择器都会重推整个目录。
   */
  async describeCatalog(force = false, signal?: AbortSignal): Promise<Array<{
    canonicalId: string
    name: string
    candidates: Array<{
      provider: string
      realId: string
      realName: string
      price: number
      viaPatch: boolean
      rejected: boolean
    }>
  }>> {
    const catalog = await this.refreshCatalog(force, signal)
    return catalog.map((virtual) => {
      // ⚠️ 用 `rejectedFor`（含 D4 的 id 漂移降级），不是 `rejectedIn` ——
      //    面板显示的拒绝状态必须与**轮换实际用的**判据一致（否则面板会显示
      //    「参与轮换」而实际被降级拒掉，或反之）。
      const rejected = this.rejectedFor(virtual)
      return {
        canonicalId: virtual.key,
        name: this.nameOf(virtual),
        // ⚠️⚠️ **必须过滤掉「未接入临期折算」的候选**（真实缺陷，用户报障 2026-10-07）。
        //
        // 用户截图：面板的候选子列表里出现了 **lobsterai**（还有 raccoon / trae），
        // 而它们**不在** `WIRED_EXPIRY_PROVIDERS` 里。
        //
        // 探针实测（真实链路）：
        // - **轮换**只发往 buddy ✅（未接入渠道经 `expiryProbe` 得 `UNUSABLE`、被排除）
        // - **面板**却列出 `buddy, lobsterai` ❌
        //
        // ⇒ 面板在**撒谎**：显示一个永远不会被用的渠道，用户看到后去关它
        //   （点「参与轮换」）也毫无作用，还会以为聚合真的会用 lobsterai。
        //
        // ⚠️ 为什么之前漏了：`refreshCatalog` 里那条过滤是**模型层**的
        //   （「虚拟模型只要有一个已接入候选就保留」），它**不过滤候选本身**。
        //   我只在模型层做了过滤，忘了候选层。规格 §9.2.1 的精神（只广告可路由的
        //   东西）对**候选**同样适用。
        //
        // ⚠️ 过滤后模型**不会**变成空候选：模型层已保证至少有一个已接入候选
        //   （否则整条不会进 `this.catalog`）。有一条用例锁住这一点。
        candidates: virtual.candidates
          .filter((candidate) => WIRED_EXPIRY_PROVIDERS.includes(candidate.provider))
          .map((candidate) => ({
            provider: candidate.provider,
            realId: candidate.realId,
            realName: candidate.realName,
            price: candidate.price,
            // ⚠️ 面板据此标 `⚠️补丁`（规格 §7.1）—— 补丁条目是人工核查的重点。
            viaPatch: candidate.via === 'patch',
            rejected: rejected.has(`${candidate.provider}\u0000${candidate.realId}`),
          })),
      }
    })
  }

  /**
   * 拒绝表的**内容指纹**（参与缓存键，见 `candidatesFor`）。
   *
   * 只对「哪些候选被拒」这件事取指纹 —— 与键的**顺序**无关（同一集合的不同书写
   * 顺序是同一张表，不该导致缓存失效）。用排序后的拼接而非 JSON.stringify，
   * 正是为了避开键顺序的影响。
   */
  private rejectionFingerprint(): string {
    const table = this.options.rejections?.() ?? {}
    const parts: string[] = []
    for (const [canonicalId, byProvider] of Object.entries(table)) {
      for (const [provider, byRealId] of Object.entries(byProvider)) {
        for (const [realId, flag] of Object.entries(byRealId)) {
          if (flag === true) parts.push(`${canonicalId}\u0000${provider}\u0000${realId}`)
        }
      }
    }
    parts.sort()
    return parts.join('\u0001')
  }

  /**
   * 重新推导虚拟模型表（**带 TTL 缓存**，理由见 {@link AGGREGATE_CATALOG_TTL_MS}）。
   *
   * ⚠️ 逐个渠道 `try/catch`：某一个渠道目录读取失败**不得**让整个聚合目录变空
   * （那会让用户在别的渠道都正常时突然看不到任何模型）。
   *
   * @param force - 绕过缓存（设置页手动刷新用）。
   */
  async refreshCatalog(force = false, signal?: AbortSignal): Promise<VirtualModel[]> {
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.catalogTtlMs ?? AGGREGATE_CATALOG_TTL_MS
    if (!force && this.catalogAt !== 0 && now - this.catalogAt < ttl) return this.catalog

    // ⚠️ **中止必须在最前面查**（真实缺陷，对抗审计实测证伪 —— 这是同型缺陷的**第四处**）：
    //    本函数原先**没有 `signal` 形参**，逐渠道 `catch` 吞掉**一切**错误
    //   （含 `AbortError`），随后**仍然** `this.catalogAt = now` ⇒ **截断的目录被缓存
    //    60 秒**。后果：用户取消一次请求后，被取消的那个渠道会**从聚合目录里消失
    //    60 秒**，而理由是「读取 xxx 目录失败」—— 与「用户主动取消」完全无关，
    //    且与「该渠道真的没登录」无法区分。
    //    ⚠️ 与模块头铁律一致：「中止 **立刻抛 `AbortError`**，绝不折算」。
    signal?.throwIfAborted()

    const providers = this.providerIds()
    const catalogs: Record<string, readonly { id: string; name?: string }[]> = {}
    for (const provider of providers) {
      try {
        // ⚠️ `LlmRuntime.listModels(provider)` 只接受一个参数、**没有 signal 通道**
        //   （`dsh-llm/lib/index.js:1471`），故无法把 signal 透传下去；中止靠
        //    下面 catch 里的 `isAbortLike` 与循环开头的 `throwIfAborted` 兜住。
        catalogs[provider] = await this.ctx.llm.listModels(provider)
      } catch (error) {
        // ⚠️ **中止不得被吞成 warn**（本函数此前正是这样：把「用户取消」记成
        //    「读目录失败」并继续，且把截断结果缓存 60 秒）。
        signal?.throwIfAborted()
        if (isAbortLike(error, signal)) throw error
        this.ctx.logger?.warn?.(
          `[aggregate] 读取 ${provider} 目录失败，本次跳过该渠道：${String(error)}`,
        )
      }
      signal?.throwIfAborted()
    }
    // ⚠️ **只播报「至少有一个已接入候选」的虚拟模型**（审计轮次二实测证伪的缺陷）。
    //
    // 聚合目录会广告出所有能推导出规范名的模型 —— 包括**候选全来自未接入临期
    // 折算的渠道**那些。但那些候选一律被折算成 `UNUSABLE`（正确），于是用户选中
    // 它拿到的报错是：
    //   `MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
    //    或所有渠道都无可用账号）`
    // ⇒ 把「该渠道的折算尚未实现」**谎报成**「你没登录 / 渠道被关」，正是本仓库
    //    反复修的那类误导性报错。实测（探针）：只接 `cline`（未接入）时目录仍含
    //    `deepseek-v4-1-flash` 与 `muse-spark-1-3`。
    //
    // ⚠️ `auto` **不参与**该过滤（它由 `listModels` / `listAllModels` 单独合成，
    //    不在 `this.catalog` 里）—— 它的池跨全部渠道，任一已接入渠道有账号就能路由。
    // ⚠️ 先记下**上一次**推导出的全量目录（下面的判据要用它判断「用户关的是整个 provider」）。
    const previousIds = [AGGREGATE_AUTO_MODEL, ...this.catalog.map((m) => m.key)]
    this.catalog = buildVirtualModels(catalogs)
      .filter((virtual) => virtual.candidates.some((c) => WIRED_EXPIRY_PROVIDERS.includes(c.provider)))
    // 目录重建 ⇒ 候选集可能变化 ⇒ 上下文窗口缓存全部失效（窗口取自候选能力）。
    // 目录重建 ⇒ 候选集可能变化 ⇒ 上下文窗口缓存全部失效（窗口取自候选能力）。
    this.contextWindowCache.clear()
    /**
     * ⚠️⚠️ **逐候选窗口表必须与上面那张缓存一起清**（Issue F-53）。
     *
     * 两张表的写入点都在 `contextWindowFor`（同一趟 `resolveModelInfo` 顺便记下），
     * 但此前只清 `contextWindowCache` ⇒ `candidateWindow` **只增不清**：
     * 渠道被停用/账号被删后，它名下的候选条目仍留在表里，而方案 C 的派发前筛选
     * 正是读它（`cap < required` ⇒ 跳过）—— 于是一个**已经不在候选池里**的渠道
     * 留下的窄窗口，会继续参与「这个虚拟模型装不装得下」的判断；反过来，
     * 换渠道后重新解析出的更宽窗口也不会顶掉旧值（`set` 覆盖只发生在
     * 该候选重新进入解析路径时，被清掉缓存才可能发生）。
     * 两张表同源同生命周期，清一张留一张必有一处是错的。
     */
    this.candidateWindow.clear()
    this.catalogAt = now
    // ⚠️⚠️ **维持「整个 provider 已关闭」的语义**（真实缺陷，实测复现）。
    //
    // ## 机制（本适配器的**动态目录**与宿主「一键关闭」的**快照**假设相撞）
    //
    // 宿主的「供应商一键关闭」（`jet-hub-rpc.ts` 的 `provider.setEnabled`）把**当时的**
    // 全量目录 id 写进黑名单；而 `provider.status` 的判据是
    // `closed = total > 0 && disabled === total`，`total` 取自 `listAllModels()`。
    //
    // ⚠️ 对**其余 14 家**，目录是**固定**的 ⇒ 「写一次快照」永远成立；
    //    而本适配器的目录是**动态推导**的（登录新渠道就长出新的虚拟模型）
    //    ⇒ 旧黑名单**盖不住**新模型 ⇒ `disabled < total` ⇒
    //    **开关自动翻回「已打开」**，且新模型**可被选中**（用户明明关了聚合）。
    //
    // 实测（探针，修前）：
    // ```
    // ① 关闭 ⇒ 黑名单 [auto, deepseek-v4-1-flash]，status {total:2,disabled:2,closed:true}
    // ② 登录 codearts ⇒ 目录 [auto, deepseek-v4-1-flash, glm-5-3]
    //    status {total:3,disabled:2,closed:false} ⇒ 开关显示「已打开」   ← 缺陷
    // ③ aggregate.listModels() 播报 ["glm-5-3"]                       ← 泄漏
    // ```
    //
    // ## 判据（只在「整个 provider 已关闭」时补写）
    //
    // 「整个 provider 已关闭」= 黑名单非空，**且**它覆盖了**上一次**推导出的全量目录
    //（`previousIds` 里每个 id 都被标记为关闭）。那说明用户关的是**整个 provider**。
    //
    // ⚠️ **不得无条件补写**：
    //   - 用户从未关闭过（黑名单为空）⇒ 凭空补写会**静默关闭整个 provider**（灾难且难察觉）；
    //   - 用户只是**逐个**关了某几个模型（黑名单没覆盖上快照）⇒ 不该被升级成整 provider 关闭。
    // ⚠️ 补写是**异步落盘**，不阻塞本次目录返回；失败只记 warn（下次推导会再试）。
    this.maintainProviderClosedState(previousIds)
    return this.catalog
  }

  /**
   * 若聚合 provider 处于「整个已关闭」态，则把**新增的**虚拟模型补进黑名单。
   *
   * ⚠️ 详见 {@link refreshCatalog} 末尾的长注释：这是为了弥补宿主
   * 「一键关闭写快照」与「聚合目录动态推导」之间的语义缺口。
   *
   * @param previousIds - **上一次**推导出的全量目录（含 `auto`）——
   *   用它判断「用户关的是整个 provider」而不是逐个关了某几个模型。
   */
  private maintainProviderClosedState(previousIds: readonly string[]): void {
    // ⚠️ **防御性取值**：`listDisabledModels` 是 `AccountPool` 的方法，而单测的池桩
    //    往往只实现被测到的那几个（`disabledModelsFor` / `getAvailableAccount`…）。
    //    这里缺方法时**直接跳过**（而不是抛）—— 否则本方法会把 67 条既有用例全打红
    //    （实测：`TypeError: this.options.accountPool.listDisabledModels is not a function`）。
    //    ⚠️ 语义上也正确：拿不到黑名单就无从判断「是否整 provider 关闭」，
    //    保守地什么都不做（不写任何状态）。
    const readDisabled = (this.options.accountPool as {
      listDisabledModels?: (provider: string) => Record<string, boolean>
    }).listDisabledModels
    if (typeof readDisabled !== 'function') return
    const disabled = readDisabled.call(this.options.accountPool, AGGREGATE_PROVIDER)
    // 从未关闭过 ⇒ 什么都不做（凭空补写会静默关闭整个 provider）。
    const hasAnyDisabled = Object.values(disabled).some((flag) => flag === true)
    if (!hasAnyDisabled) return
    // ⚠️ 关键判据：上一次的全量目录**是否全被标记为关闭**。
    //    是 ⇒ 用户关的是**整个 provider** ⇒ 新长出来的模型也要补上。
    //    否 ⇒ 用户只是逐个关了某几个模型 ⇒ 不碰（不该升级成整 provider 关闭）。
    const closedWholeProvider = previousIds.length > 0
      && previousIds.every((id) => disabled[id] === true)
    if (!closedWholeProvider) return
    // 本次**新增**的（尚未被标记的）模型。
    const missing = [AGGREGATE_AUTO_MODEL, ...this.catalog.map((m) => m.key)]
      .filter((id) => disabled[id] !== true)
    if (missing.length === 0) return
    // ⚠️ 同理防御：写方法也来自池，缺了就跳过。
    const writeDisabled = (this.options.accountPool as {
      setModelsDisabled?: (provider: string, ids: readonly string[]) => Promise<void>
    }).setModelsDisabled
    if (typeof writeDisabled !== 'function') return
    void writeDisabled.call(this.options.accountPool, AGGREGATE_PROVIDER, missing)
      .catch((error: unknown) => {
        this.ctx.logger?.warn?.(
          `[aggregate] 补写「整个 provider 已关闭」的黑名单失败（下次目录推导会再试）：${String(error)}`,
        )
      })
  }

  /**
   * 参与聚合的渠道 id 白名单 —— **只含本插件注册的渠道**。
   *
   * ## ⚠️ 为什么必须是白名单，不能用 `listProviders()`
   *
   * 初版直接 `ctx.llm.listProviders()` 并注释成「本插件注册的全部渠道」，但那个 API
   * 返回的是**宿主全部**存活路由 —— 它会纳入 `deepseek-account`、`pi-ai` 等
   * **别的插件**的 provider（真实缺陷，全分支终审 I1）。后果：
   *
   * 1. **广告出无法路由的虚拟模型**：那些渠道的临期折算没接入（`createExpiryProbe`
   *    只接了 buddy / workbuddy / loomy / codearts / zcode），一律折算成 `UNUSABLE`
   *    ⇒ 它们的虚拟模型**永远没有可用候选**。用户选中后拿到的是
   *    「没有任何可用候选（渠道被关闭、模型被关、或所有渠道都无可用账号）」——
   *    把「该渠道尚未接入」**谎报成「你没登录」**，正是本仓库反复修的误导性报错。
   * 2. **跨渠道归一被污染**：宿主自带 provider 的模型会被并进聚合目录
   *    （实测 `deepseek-account:deepseek-flash` 与 `qoder:dfmodel` 会被合并成同一个
   *    虚拟模型），使「跨渠道归一」把**非本插件渠道**也算成候选。
   *
   * ⚠️ 用字面量而非 import 各 `product.ts` 的常量：那要引入 12 个模块，显著加重本文件
   * 的依赖；而这些 id 是**稳定契约**（`index.ts` 的 `modelAdapters` 表同样用字面量）。
   * 新增 provider 时**两处都要加**（与 `modelAdapters` 同一约定）。
   */
  private static readonly AGGREGATE_CHANNELS: readonly string[] = Object.freeze([
    'codearts',
    'buddy',
    'workbuddy',
    'lobsterai',
    'qoder',
    'qodercn',
    'trae',
    'cline',
    'loomy',
    'raccoon',
    'minimax',
    'gemini',
    'zcode',
    'opencode',
  ])

  /**
   * 本插件注册的渠道 id（`aggregate` 与 `jet-hub-auto` 自身除外）。
   *
   * ⚠️ 先取 `listProviders()` 的**存活路由**再与白名单取交集：这样宿主没装载的渠道
   * 不会进目录（否则会广告出连适配器都没有的模型），同时**排除**别的插件的 provider。
   */
  private providerIds(): string[] {
    let alive: ReadonlySet<string>
    try {
      alive = new Set(this.ctx.llm.listProviders().map((info) => info.id))
    } catch {
      // `listProviders` 缺席或抛错时退回空表 —— 目录为空比崩溃好（调用方会看到
      // 只有 auto 的聚合目录，用户仍可用 auto 与其它 provider 直连）。
      alive = new Set()
    }
    return AggregateAdapter.AGGREGATE_CHANNELS
      .filter((id) => alive.has(id) && id !== AGGREGATE_PROVIDER && id !== 'jet-hub-auto')
  }

  /** 对外播报虚拟模型（含 `auto`），**套用户黑名单**。 */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.refreshCatalog()
    const disabled = this.options.accountPool.disabledModelsFor(AGGREGATE_PROVIDER)
    const entries: LlmModelInfo[] = []
    if (!disabled.has(AGGREGATE_AUTO_MODEL)) entries.push(this.autoModelInfo())
    for (const model of models) {
      if (disabled.has(model.key)) continue
      entries.push({ provider, id: model.key, name: this.pickerNameOf(model), inputModalities: ['text', 'image'] })
    }
    return entries
  }

  /**
   * **不套黑名单**的全量目录 —— 设置页要用它渲染开关。
   *
   * ⚠️ 与其余 14 个适配器的同名方法同约定：被用户关闭的模型也必须出现在这里，
   * 否则用户在设置页**连开关都摸不着**（`jet-hub-rpc.ts` 对 `model.list` 的
   * 注释记录了该缺陷）。
   * ⚠️ 必须是**同步**方法（`jet-hub-rpc.ts` 的 `ModelCatalogSource` 契约要求），
   * 故只读上一次推导结果（由 {@link listModels} 刷新）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return [
      { id: AGGREGATE_AUTO_MODEL, name: this.autoModelInfo().name },
      ...this.catalog.map((model) => ({ id: model.key, name: this.pickerNameOf(model) })),
    ]
  }

  /** `auto` 的元数据。 */
  private autoModelInfo(): LlmModelInfo {
    return {
      provider: AGGREGATE_PROVIDER,
      id: AGGREGATE_AUTO_MODEL,
      name: 'Auto（聚合 · 跨渠道）',
      description: '不指定模型：在所有渠道的所有可用模型里挑积分最快作废的那个。',
      inputModalities: ['text', 'image'],
    }
  }

  /** 虚拟模型的展示名。
   *
   * ⚠️ **不加「（单渠道）」之类的后缀**（与 brief 初版的 `nameOf` 不同）：
   * 设计文档 §12.1（`2026-10-06-aggregate-provider-design.md:669-673`）把新 provider
   * 定成「目录展示规范名 + 运行期渠道后缀」**单一形态**，并逐字写死三处的名字都是
   * 规范名（`listModels` / `resolveModel` → `DeepSeek V4.1 Flash`；`prepareCall`
   * → `DeepSeek V4.1 Flash · buddy`）。加后缀会让选择器与服务端目录名不一致，
   * 且 `prepareCall` 会拼出 `…（单渠道） · buddy` 这类双重后缀。
   * 「有没有冗余渠道」是**设置页**的信息（§7.3：按厂商分组、组内按候选渠道数降序、
   * 展开看逐条候选），不该混进模型展示名。
   */
  /** 虚拟模型的展示名 —— **设置页与解析路径用**（不带倍率，见 {@link pickerNameOf}）。
   *
   * ⚠️ 本方法**保持无倍率**：`resolveModel` 与 `describeCatalog` 的返回值被三处
   * 既有断言逐字钉住（`aggregate-adapter.spec.ts:88`、`aggregate-rejections.spec.ts:251`、
   * `aggregate-catalog.spec.ts:21` 全是 `'DeepSeek V4.1 Flash'`），且 `describeCatalog`
   * 的候选子列表**逐条**显示倍率（`candidateRowLabel`）—— 在模型名上再叠一次
   * 会出现「两个倍率」的重复展示。倍率只加在**模型选择器**那一条路径上，
   * 即 {@link pickerNameOf}。
   */
  private nameOf(model: VirtualModel): string {
    return model.name
  }

  /**
   * **模型选择器**里的展示名 = 规范名 + 倍率后缀（如 `GLM-5.3-Flash · 最低 x0.06`）。
   *
   * ## 为什么需要它（用户报障 2026-10-08）
   *
   * 用户原话：「没倍率显示？」—— 切到聚合后，选择器里每条虚拟模型**都没有倍率**，
   * 而同屏的普通渠道（`GLM-5.3-Flash · x0.06`）有。用户据此无法判断「聚合给我
   * 挑的是不是便宜的那个」，而本功能的全部卖点正是「省钱烧临期」。
   *
   * 根因：`nameOf` 只回规范名，而倍率其实**早就算好了** ——
   * `aggregate-catalog.ts` 的 `CandidateEntry.price` 就是 `priceFactorFromName(realName)`
   * 的结果，只是从没被展示层用过。
   *
   * ## ⚠️⚠️ 为什么文案是「**最低** x…」而不是直接 `· x…`（真实缺陷，复审实测）
   *
   * 初版取全局最小 `price` 并直接拼成 `· x0.03`，其注释推理是「轮换的**第二**判据
   * 是同临期档内倍率升序 ⇒ 最便宜候选最可能被选中」。**该推理在跨临期档时不成立**：
   * `rankCandidates` 的第一判据是**临期升序**，倍率只在**同档内**才起作用。
   * 复审实测（真实 `lib/aggregate-adapter.js` + 真实 `prepareCall`）：
   *
   * ```
   * 候选：buddy x0.29（临期 100，最早） / codearts x0.03（临期 900）
   * 选择器显示："DeepSeek V4.1 Flash · x0.03"   <-- 让用户以为会挑便宜的
   * 实际发往  ：["buddy"]                         <-- 实际挑的是最贵的
   * ```
   *
   * ⇒ 直接写 `x0.03` 会**误导用户**，与本 PR 自己在 `types.ts` 立下的判据
   *（「往静态名里写死倍率就是编造」）同型：显示的价与实际会用的价不符。
   *
   * ⚠️ 修法**不是**「按临期最早那档取最便宜候选」：`CandidateEntry` 里**没有**
   * `expiry`（临期是运行期由 `expiryProbe` 折算的，见 `aggregate-expiry.ts`），
   * 而本方法被 `listModels` / `listAllModels` 调用、**契约要求同步**
   *（`ModelCatalogSource` 的注释）⇒ 这里根本拿不到临期档。若为它改成异步或
   * 触发一轮余额查询，代价远大于收益（选择器渲染路径不能打网络）。
   * ⇒ 采用**如实表达下界**的口径：`最低 x0.03` 的语义是「这个虚拟模型下最便宜的
   * 可路由候选」，它**不声称**本次会选它 —— 用户据此仍能判断「值不值得选这个
   * 模型」，且不会被误导成「一定会用 0.03」。
   *
   * ⚠️ **不显示「区间」**（如 `x0.03–x0.29`）：那会变成最长行，而选择器是窄菜单
   *（与 `buddy-adapter.ts` 的「不写 `（促销 …）`」同一取舍）。
   *
   * ## 三条不显示倍率的规则（都是既有约定）
   *
   * 1. **全部候选都无标注**（`Infinity`）⇒ 不加后缀。直接拼会渲染出
   *    `xInfinity`，那是明显的渲染缺陷（`aggregate-panel-logic.js` 同款判据）。
   * 2. **`0` 显示「免费」**（本仓库既有口径，见 `candidateRowLabel`）。
   * 3. **解析不出就不猜**：宁可没有倍率，也不编一个（`buddy.ts` 同款理由：
   *    编造倍率比不显示更糟）。
   *
   * ⚠️ 只用于 `listModels` / `listAllModels`（选择器与设置页「显示列表」）。
   * **不得**用于 `resolveModel` / `describeCatalog` —— 见 {@link nameOf} 的注释。
   */
  private pickerNameOf(model: VirtualModel): string {
    const prices = model.candidates
      // ⚠️ 只取**已接入临期折算**的候选（与 `describeCatalog` 的过滤同一口径）：
      //    未接入的渠道经 `expiryProbe` 得 `UNUSABLE`、**永远不会被路由到**，
      //    把它的价格显示出来等于替一个用不上的候选报价（规格 §9.2.1：
      //    只广告可路由的东西）。
      .filter((candidate) => WIRED_EXPIRY_PROVIDERS.includes(candidate.provider))
      .map((candidate) => candidate.price)
      .filter((price) => Number.isFinite(price))
    if (prices.length === 0) return model.name
    const best = Math.min(...prices)
    // ⚠️ 「最低」二字不可省：见方法头那段实测 —— 省掉会让用户以为本次就用这个价。
    return `${model.name} · 最低 ${best === 0 ? '免费' : `x${best}`}`
  }

  /**
   * 解析某个虚拟模型的能力元数据。
   *
   * ⚠️ `provider`/`id` 必须**按入参回填**（多虚拟模型下不能硬编码）：DSH 的
   * `normalizeModelInfo` 逐字校验，不符即 `INVALID_MODEL_INFO`。
   * ⚠️ `inputModalities` 恒含 `image`：聚合是整池，池里有能看图的渠道，如实声明；
   * 「这次选中的渠道收不收得了图」由分发阶段改道保证。
   * ⚠️ **档位声明规范化档位的并集**（不是候选集交集）—— 理由见下方
   * {@link aggregateReasoningInfo} 的注释。
   */
  /**
   * 解析一个虚拟模型。
   *
   * ⚠️ `signal` 是**本适配器自己加的可选第三参**（`LlmAdapter` 契约只要求前两个）——
   *    `prepareCall` 拿得到 signal（它是第三参），把它透传到目录读取，
   *    否则真实请求路径的取消**不生效**（见 `ensureCatalog` 的长注释）。
   *    ⚠️ DSH 运行时直接调本方法时**不传**第三参，那是正常的（缓存命中时无需取消）。
   */
  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (model === AGGREGATE_AUTO_MODEL) {
      const info = this.autoModelInfo()
      return {
        provider,
        id: model,
        name: info.name,
        ...(info.description === undefined ? {} : { description: info.description }),
        inputModalities: ['text', 'image'],
        context: { contextWindow: await this.contextWindowFor(model, this.aggregateCandidatePool(), signal) },
        reasoning: aggregateReasoningInfo(),
      }
    }
    await this.ensureCatalog(signal)
    const virtual = this.catalog.find((entry) => entry.key === model)
    if (virtual === undefined) {
      const available = this.catalog.slice(0, 5).map((entry) => entry.key).join('、')
      // ⚠️ **不要把用户指向不存在的 UI**（第 3 轮审计实测）：
      // 初版文案说「完整清单见 Jet Hub 设置页的「聚合」面板」—— 但那个面板**不存在**
      //（客户端 `PROVIDERS` 里没有 `aggregate`；逐候选拒绝的子列表属 P2）。用户按提示
      // 去找会找不到，属误导性指引。
      // ⇒ 指向**真实存在**的位置：模型选择器里的 `aggregate` 分组（存活路由即可见）。
      throw new LlmError(
        `aggregate: 未知模型「${model}」。当前可用：auto${available === '' ? '' : `、${available}`}`
        + '（完整清单见模型选择器里的「聚合（跨渠道临期优先）」分组）',
        'INVALID_REQUEST',
      )
    }
    return {
      provider,
      id: model,
      name: this.nameOf(virtual),
      inputModalities: ['text', 'image'],
      context: { contextWindow: await this.contextWindowFor(model, virtual.candidates, signal) },
      reasoning: aggregateReasoningInfo(),
    }
  }

  /**
   * 目录为空时先推导一次（避免 resolveModel 在 listModels 之前被调用时找不到模型）。
   *
   * ⚠️⚠️ **必须接收并透传 `signal`**（真实缺陷，独立审计实测证伪）：
   *   本方法原先调 `this.refreshCatalog()` **不传 signal** ⇒ **真实请求路径**
   *  （`prepareCall` → `resolveModel` → 本方法）的中止**不生效** ——
   *   实测「取消于 50ms 仍跑满 312ms 的 `listModels` 才抛错」。
   *   此前只有 `describeCatalog`（面板路径）串了 signal，故 `refreshCatalog`
   *   自己的中止逃逸是对的，但**调用它的真实路径拿不到取消信号**。
   */
  private async ensureCatalog(signal?: AbortSignal): Promise<void> {
    if (this.catalog.length === 0) await this.refreshCatalog(false, signal)
  }

  /** 当前的临期探针：注入优先，否则保守返回 UNUSABLE。 */
  private expiryProbe(): ExpiryProbe {
    return this.options.expiryProbe ?? (() => Promise.resolve(UNUSABLE))
  }

  /**
   * 绑定「本次候选序」到一次分发。
   *
   * ⚠️ 候选序必须在**这里**算好（`prepareCall` 是异步的）：返回的 `stream` 闭包
   * 契约是**同步返回 AsyncIterable**（`PreparedAdapterCall`），闭包里拿不到
   * `await` 的机会 ⇒ 临期折算、档位表都得在这之前备齐。
   */
  async prepareCall(
    _provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    // ⚠️ 关于「目录刷新后是否会服务陈旧缓存」（第 5 轮审计实测）：
    // **不会**，但**不是**因为这两行的先后顺序 —— 而是因为 `candidatesFor` **自己也调
    // `ensureCatalog()`**（其首行），故无论谁先跑都会先刷新目录。
    // 实测：把两者调换顺序，行为不变（我最初据此写了一条「顺序保证」用例 + 注释，
    // 但交换顺序后该用例**仍通过** ⇒ 它是同义反复，已删除；注释也就此订正）。
    //
    // 真正的保证是：`ensureCatalog` 一旦刷新，`this.catalog` 即**当前**目录，于是
    // 已下架的模型既过不了 `resolveModel`（抛 `INVALID_REQUEST`）、也进不了
    // `candidatesFor` 的候选序。
    // ⚠️ 唯一残留的陈旧面是 `choiceCache`（60 秒）：它可能在 TTL 内仍含**某个候选**
    //（该虚拟模型的一个已下架 realId）。但它是在 `resolveModel` 通过**之后**才被读，
    // 而那时该虚拟模型已确认**当前存在** ⇒ 最坏情况是「发一个已下架候选、失败、切换」，
    // 由 `dispatch` 的失败切换兜住。
    const resolved = await this.resolveModel(AGGREGATE_PROVIDER, model, signal)
    const targets = await this.candidatesFor(model, signal)
    if (targets.length === 0) {
      // ⚠️ **不要指向不存在的 UI**（第 3 轮审计实测）：初版说「请在 Jet Hub 设置页的
      // 「聚合」面板检查」，但那个面板**不存在**（P2 才做）。⇒ 改为指向真实可操作的位置，
      // 并把「未接入临期折算」这一最常见原因**说清楚**（它此前被谎报成「你没登录」）。
      throw new LlmError(
        `aggregate: 「${model}」当前没有任何可用候选（渠道被关闭、模型被关、`
        + '或所有渠道都无可用账号）。'
        + '请在模型选择器里换用「聚合（跨渠道临期优先）」分组下的其它模型，'
        + '或直连对应渠道使用该模型。',
        'MISSING_CREDENTIAL',
      )
    }
    // ⚠️ 带图候选序**预解析**（`prepareCall` 是异步的，而 `stream` 闭包必须同步返回）
    // —— 与主候选序共用同一批 `DispatchTarget`，只做一次 `filter`，零额外开销。
    const imageTargets = targets.filter((target) => target.imageCapable)

    return {
      /**
       * ⚠️ 模型名后缀附的是「**首选**渠道」（候选序第一个 = 临期最早的那个），
       * **不是**「本次实际发往的渠道」。
       *
       * ## 为什么做不到「实际发往」（架构约束，不是疏忽）
       *
       * `prepareCall` 是**同步返回元数据 + 一个 stream 入口**的函数，而 DSH 在
       * **发起请求之前**就要拿到 `model.name`（它用于 UI 展示与账目归属）。
       * 而「实际发往哪个渠道」只有在 {@link dispatch} 真正尝试成功之后才确定
       *（候选序第一个可能失败并切换）。两者是**不同时刻**的信息。
       *
       * ⚠️ 我用 `· <渠道>` 加 `title` 说明它是**首选**（而不是改文档去承诺做不到的事）。
       * 真实历史由 `activeProvider()` 记录，由用量徽标显示（那条链路是准确的）。
       * ⚠️ README 原写「本次实际发往的渠道」—— **那是过度承诺**，已同步订正。
       */
      model: {
        ...resolved,
        // 后缀是**首选**渠道（临期最早），失败时会切换。
        name: `${resolved.name} · ${targets[0]!.provider}`,
        description: `聚合路由：首选 ${targets[0]!.provider}（临期最早）；失败会按候选序自动切换`,
      },
      stream: (options: GenerateOptions) => {
        // 带图判定必须在闭包里做：`prepareCall` 只拿到 provider/model，拿不到
        // `options.messages`。⚠️ 用与宿主 capability 同一函数（含 tool-result 递归）。
        const hasImage = options.messages.some((message) => contentHasImage(message.content))
        if (!hasImage) return this.dispatch(targets, options, model)
        if (imageTargets.length === 0) {
          // 全池都不支持图片：**如实报错**，不把图降级成文字占位（后者会让模型
          // 「看到一张图被抹掉」却不知道用户发了什么，属静默丢数据）。
          throw new LlmError(
            `aggregate: 「${model}」的候选渠道都不支持图片输入。`
            + '请换一个支持图片的模型，或去掉图片后重试。',
            'INVALID_REQUEST',
          )
        }
        // 带图时只用声明支持图片的候选（顺序仍是临期升序）。
        this.ctx.logger?.warn?.(
          `[aggregate] 带图请求：改用支持图片的 ${imageTargets.length} 个候选`
          + `（共 ${targets.length} 个），首个为 ${imageTargets[0]!.provider}（${imageTargets[0]!.realId}）`,
        )
        return this.dispatch(imageTargets, options, model)
      },
    }
  }

  /**
   * 构造本次请求的候选序（临期升序 → 倍率升序），并备好每条的档位表。
   *
   * ⚠️ **带按虚拟模型的 TTL 缓存**（规格 §9）—— 否则每次 `prepareCall` 都要对每个
   * 候选渠道重跑一次上游余额查询（见 {@link choiceCache} 的长注释）。
   */
  private async candidatesFor(model: string, signal?: AbortSignal): Promise<DispatchTarget[]> {
    await this.ensureCatalog()
    signal?.throwIfAborted()
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.ttlMs ?? AGGREGATE_TTL_MS
    // ⚠️ **缓存键含「拒绝表指纹」**：这样面板改了拒绝表之后，即使调用方**忘记**
    //    清缓存，本方法也不会命中旧条目（旧键的指纹不同）。
    //    为什么不让调用方负责清：忘了清 = 用户在面板上关掉的候选在 60 秒内仍被尝试
    //    = 用户以为开关坏了，而这类「依赖调用方记得」的约定在本仓库已多次静默失效。
    //    `clearChoiceCache()` 仍保留（RPC 调它可立即释放内存），但**正确性不依赖它**。
    const cacheKey = `${model}\u0000${this.rejectionFingerprint()}`
    const cached = this.choiceCache.get(cacheKey)
    // ⚠️ 命中缓存**不查 signal**（与旧 auto 的注释同因）：`prepareCall` 每次都会
    // 调本方法，若命中分支也查 signal，同一个取消事件在 60 秒窗口的不同位置会产出
    // 两种不同结果（极难复现）。真正的中止由入口处的 `throwIfAborted()` 与
    // `dispatch` 的逐候选检查负责。
    if (cached !== undefined && now - cached.at < ttl) return cached.targets
    const probe = this.expiryProbe()

    // `auto`：候选池是所有渠道的所有模型（与 jet-hub-auto 同语义）。
    // ⚠️ 被「拒绝轮换」的候选**不进池**（规格 §5 的 L3）——在**建池时**就排除，
    //    而不是折算后过滤：后者会白白为它做一次余额探测（一次上游 GET）+ 一次能力解析。
    //    ⚠️ `auto` 分支的拒绝键是**空串**（`auto` 不是虚拟模型，没有自己的拒绝表）——
    //    这不代表「auto 不受拒绝影响」：`auto` 的池是**所有虚拟模型的候选并集**，
    //    故下面在遍历每个 virtual 时**按那个 virtual 的键**取拒绝集。
    const pool: RankedCandidate[] = []
    if (model === AGGREGATE_AUTO_MODEL) {
      for (const virtual of this.catalog) {
        const rejected = this.rejectedFor(virtual)
        for (const candidate of virtual.candidates) {
          if (rejected.has(`${candidate.provider}\u0000${candidate.realId}`)) continue
          pool.push({ provider: candidate.provider, realId: candidate.realId, expiry: NEVER, price: candidate.price })
        }
      }
    } else {
      const virtual = this.catalog.find((entry) => entry.key === model)
      if (virtual === undefined) return []
      // ⚠️ `rejectedFor`（含 D4 漂移降级）—— 这是**建池**路径，用户拒绝的候选必须真的不进池。
      const rejected = this.rejectedFor(virtual)
      for (const candidate of virtual.candidates) {
        if (rejected.has(`${candidate.provider}\u0000${candidate.realId}`)) continue
        pool.push({ provider: candidate.provider, realId: candidate.realId, expiry: NEVER, price: candidate.price })
      }
    }

    // 逐候选折算临期（同一渠道只探一次）。
    const seen = new Map<string, number>()
    for (const candidate of pool) {
      let expiry = seen.get(candidate.provider)
      if (expiry === undefined) {
        try {
          expiry = await probe(candidate.provider, signal)
        } catch (error) {
          // ⚠️⚠️ **中止不得被吞成 `UNUSABLE`**（与 `aggregate-expiry.ts` 的
          // `createExpiryProbe` 同一口径，见那里的长注释）。
          //
          // 探针在「探测途中被取消」时会**刻意重抛** `AbortError`；若这里直接
          // `expiry = UNUSABLE`，取消请求的用户会看到「没有任何可用候选」而不是
          // 中止 —— 且因为**每个**渠道都被这样折算，整池候选会被全部剔除，
          // 该报错与「真的没登录」无法区分。
          // ⚠️ 真实缺陷（Task 7 复审 M4）：本处是同一缺陷的**第二实例** ——
          // `aggregate-expiry.ts` 已修，这里漏了。
          signal?.throwIfAborted()
          if (isAbortLike(error, signal)) throw error
          expiry = UNUSABLE
        }
        seen.set(candidate.provider, expiry)
      }
      candidate.expiry = expiry
    }
    signal?.throwIfAborted()

    const ranked = rankCandidates(pool)
    // 尝试上限 = **所有虚拟模型里最长候选表的长度**。
    //
    // ## 为什么这个值同时满足两个看似矛盾的要求
    //
    // | 场景 | 候选数 | 与 limit 的关系 | 结果 |
    // |---|---|---|---|
    // | 指定虚拟模型 | ≤ limit（limit 取的就是最长表） | 全部保留 | **末位候选轮得到** |
    // | `auto`（池 = 所有渠道所有模型） | 可达 100+，远大于 limit | 被截断 | **有封顶** |
    //
    // ⇒ 同一个值既保证「指定模型不漏候选」，又给 `auto` 的巨池封顶。这正是 issue
    // 记录的口径（「`MAX_ATTEMPTS` 必须 ≥ 最长候选表长度，否则末位候选永远轮不到；
    // 且要封顶」）。
    //
    // ⚠️⚠️ **不要写成 `Math.max(ranked.length, maxAttemptsFor(...))`**（初版的错误）：
    // 那会让 `limit ≥ ranked.length` 恒成立 ⇒ `slice(0, limit)` **永不截断** ⇒
    // 上限形同虚设、`maxAttemptsFor` 变成死代码。实测（Task 6 复审）：把
    // `maxAttemptsFor` 改成 `return 1` 对该路径**毫无行为影响** —— 那就是架空。
    // 真实代价：`auto` 全候选失败时会依次尝试 100+ 次（trae 一家就 32 个模型），
    // 每次都可能是网络超时 ⇒ 长时间挂起。
    const limit = maxAttemptsFor(this.catalog)
    const targets: DispatchTarget[] = []
    for (const candidate of ranked.slice(0, limit)) {
      const capability = await this.capabilityOf(candidate.provider, candidate.realId, signal)
      targets.push({ ...candidate, ...capability })
    }
    // ⚠️ 只在**非空**时写缓存：空候选通常意味着「所有渠道都不可用」——那是**瞬时**
    // 状态（如额度刚好用尽、账号正在限流），缓存 60 秒会让用户在这期间即使恢复了
    // 也仍报「没有任何可用候选」。
    if (targets.length > 0) this.choiceCache.set(cacheKey, { at: now, targets })
    return targets
  }

  /**
   * 取目标模型的两项能力：**思考档位 id** 与**是否收得了图片**。
   *
   * ⚠️ 两项**共用同一次 `resolveModelInfo` 调用** —— 不额外发请求。这是把图片
   * 能力做成「顺带取回」而不是「另查一遍」的原因（选型路径上每次请求都会走这里，
   * 多一次解析就是多一次上游交互）。
   *
   * ⚠️ 失败时按**保守**方向回落：档位为空（不下发该字段）、图片为 `false`
   * （不把它当带图候选）。理由见 {@link DispatchTarget.imageCapable}。
   */
  /**
   * 虚拟模型声明给宿主的上下文窗口：**取候选集里已声明的最大值**（移植自上游
   * Gitee 原作者 contextWindowFor 的实现口径）。
   *
   * ## 为什么是「最大值」
   *
   * 聚合的派发按临期在候选间切换，请求实际发往哪家取决于运行时状态；目录元数据
   * 只有一份，声明任何具体一家的窗口都会在切到别家时失真。取最大值 ⇒ 压缩阈值与
   * 占用指示器按最宽的候选计算，切换供应商时「实际可用 ≥ 已声明」恒成立。
   *
   * ⚠️ **学习值不再收窄本值**（2026-10-12 修正，用户实测提出；原先有个
   * `applyLearnedWindow` 在这里收窄）：学习值是按**虚拟模型**记的，于是「一个窄窗口
   * 候选撞墙」会把整个虚拟模型的对外声明**粘性压低**，之后即使换回宽窗口的候选也
   * **不恢复**（DSH 压缩阈值 = 声明 × 0.8 ⇒ 长期过早压缩，宽候选的能力被白白让掉）。
   * 而且那层保护本就**多余**：池整体窄时这个「最大值」自然就窄、压缩自然早发生；
   * 真正需要「这个候选装不下」这层信息的只有**筛选**（方案 C），它读的是**候选键**。
   *
   * ## ⚠️ 只有当每一个候选都解析成功时才记忆化
   *
   * 若把「某候选解析失败 ⇒ 用兜底值」的结果也写进缓存，目录服务抖动一次就会把
   * 兜底值固化整个 TTL 周期。失败时返回值照给（调用方需要立即拿到可用值），但
   * 不写缓存，下一次调用重新尝试解析。
   */
  private async contextWindowFor(
    modelKey: string,
    candidates: readonly { provider: string; realId: string }[],
    signal?: AbortSignal,
  ): Promise<number> {
    // ⚠️ 缓存里存的就是**对外值**（候选里的最大值）—— 学习值**不再**收窄它
    //    （理由见本函数 JSDoc 的「学习值不再收窄本值」）。
    const remembered = this.contextWindowCache.get(modelKey)
    if (remembered !== undefined) return remembered
    let widest: number | undefined
    let allResolved = true
    // 手机版诊断（2026-10-11）：逐候选记录解析结果，定位「声明在哪一家丢失」。
    const traces: string[] = []
    for (const candidate of candidates) {
      let window: number | undefined
      try {
        const info = await this.ctx.llm.resolveModelInfo(candidate.provider, candidate.realId, signal)
        // 已解析；未声明窗口的渠道（undefined）不参与取大。
        window = info.context?.contextWindow
      } catch (error) {
        // 中止不得被吞成「解析失败」（与 capabilityOf 同一口径）。
        signal?.throwIfAborted()
        if (isAbortLike(error, signal)) throw error
        allResolved = false
        traces.push(`${candidate.provider}(${candidate.realId})=解析失败`)
        continue
      }
      traces.push(`${candidate.provider}(${candidate.realId})=${window ?? '未声明'}`)
      if (window !== undefined && (widest === undefined || window > widest)) widest = window
      // ⚠️ 顺手记下**逐候选**的声明窗口（方案 C 用）：派发前按本轮体积跳过太窄的候选。
      //    这里本来就在逐个 resolve，故不额外产生调用。
      if (window !== undefined) {
        this.candidateWindow.set(
          candidate.provider + String.fromCharCode(0) + candidate.realId,
          window,
        )
      }
    }
    // ⚠️ 兜底**必须**是动态值：候选全都没声明时也得给一个正数（`context` 为空会让压缩链
    // 直接抛 `compaction-basic: no context capacity …`），而写死 200K 会让真有 1M 窗口的
    // 模型永远只用到五分之一。学习值/起步值都来自 `context-window-learn.ts`，
    // 撞墙后由 `dispatch` 的失败路径收窄。
    // ⚠️ 它**不进** `contextWindowCache`（见下方记忆化条件）——学过之后要立刻生效。
    // ⚠️ 候选全无声明时才用动态起步值（`dynamicContextWindowFor` = 学到的 ?? 起步值）。
    const declared = widest ?? dynamicContextWindowFor(contextWindowKey(AGGREGATE_PROVIDER, modelKey))
    const resolved = declared
    // ⚠️ **手机版修正（2026-10-11，用户实测报障）**：记忆化必须同时要求
    // 「无抛错」**和**「真的解析到了声明」。原条件只看 `allResolved`（没抛错）——
    // 渠道目录未就绪时 `resolveModelInfo` 会**成功返回但不带窗口声明**（undefined），
    // 5 家全 undefined ⇒ 兜底值被当成「解析成功」**写进缓存固化**：此后即使各家
    // 目录就绪、各自声明了不同窗口（实测同一虚拟模型 5 家候选声明各异），
    // 也永远返回固化的兜底值 ⇒ GUI 恒显示 200K。
    // ⇒ 只缓存「确有声明」的结果（widest !== undefined）；解析不出时**不缓存**，
    //    下一次调用重新尝试（目录就绪后自然取到各家声明的最大值）。
    //    兜底值仅作本次的**瞬时**回落，不进入任何缓存。
    // ⚠️ **缓存的是声明值 widest，不是收窄后的 resolved**：把收窄值缓存下来会让
    //    「后来才学到的更小值」被固化挡住（收窄必须立刻生效）。
    if (allResolved && widest !== undefined) this.contextWindowCache.set(modelKey, widest)
    // 诊断日志：每次实际解析（未命中缓存）打一行汇总，含逐候选窗口与是否固化。
    this.ctx.logger?.info?.(
      `[jet-hub] 窗口解析 ${modelKey}: ${traces.join(', ')} → ${resolved}`
        + `${allResolved && widest !== undefined ? '（已缓存）' : '（未缓存）'}`,
    )
    return resolved
  }

  /**
   * auto 的候选池：所有虚拟模型的候选并集（去重）。
   * 与 candidatesFor 的 auto 分支同口径，但不做余额探测（这里只要候选表）。
   */
  private aggregateCandidatePool(): readonly { provider: string; realId: string }[] {
    const SEP = String.fromCharCode(0)
    const seen = new Set<string>()
    const pool: { provider: string; realId: string }[] = []
    for (const virtual of this.catalog) {
      for (const candidate of virtual.candidates) {
        const key = candidate.provider + SEP + candidate.realId
        if (seen.has(key)) continue
        seen.add(key)
        pool.push({ provider: candidate.provider, realId: candidate.realId })
      }
    }
    return pool
  }

  private async capabilityOf(
    provider: string,
    realId: string,
    signal?: AbortSignal,
  ): Promise<{ efforts: readonly string[]; imageCapable: boolean }> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, realId, signal)
      const efforts = (info.reasoning?.efforts ?? [])
        .map((effort) => String(effort.id))
        .filter((id) => id.length > 0)
      return { efforts, imageCapable: info.inputModalities?.includes('image') === true }
    } catch (error) {
      // ⚠️⚠️ **中止不得被折算成「无档位 / 不支持图片」**（真实缺陷，全分支终审 I3：
      // 这是同一缺陷的**第三处** —— `aggregate-expiry.ts` 与 `candidatesFor` 各修过一处）。
      //
      // `resolveModelInfo` **接收 `signal`**（`dsh-llm/lib/index.js` 的
      // `resolveModelInfo(provider, model, signal)`）⇒ 中止时它会抛 `AbortError`，
      // 而这个 throw 落在本 `try` 内。若直接回落到保守默认值，取消请求的用户会看到
      // 「候选渠道都不支持图片输入」这类**与中止无关**的误导性报错，且整轮不会中止。
      // 与本仓库口径相反：中止应**立刻**以 `AbortError` 结束
      //（`aggregate-core.ts` 的哨兵注释：「abort 立刻抛，绝不折算」）。
      signal?.throwIfAborted()
      if (isAbortLike(error, signal)) throw error
      return { efforts: [], imageCapable: false }
    }
  }

  /**
   * 按候选序**逐个尝试**，成功即返回；全部失败则抛最后一个错误。
   *
   * ## 为什么必须自己实现失败切换
   *
   * DSH 层没有跨 provider 重试：`dsh-llm-retry` 的 `retryStateKey(provider, policyKey)`
   * 只重试**同一** provider/model。故跨渠道切换只能在这里做。
   *
   * ## 为什么 `catch` 要包在**迭代过程**外层
   *
   * 生产路径只走 `prepareCall` 返回的 `call.stream`，而真实错误发生在**迭代
   * 过程中**（dsh-llm 的 `iterator.next()`），不是 `prepareCall` 自己抛的
   * ⇒ `try` 必须包住 `for await`。
   *
   * ## ⚠️⚠️ 只在「一个 chunk 都还没产出」时才能切换（本实现的关键约束）
   *
   * 已 `yield` 出去的内容**收不回来**。若某个候选先吐了「答案是……」然后中途失败，
   * 我们再切到下一个候选，用户看到的是：
   *
   * ```
   * 答案是……答案是 42。
   *      ↑ A 的半截        ↑ B 的完整答案
   * ```
   *
   * 这是**两段拼接的畸形回答**，比「半截 + 报错」严重得多 —— 前者看起来像一句
   * 正常但奇怪的话，用户会当成模型的问题；后者至少明确告诉用户失败了。
   * 本仓库对「静默降级」有明确红线（反复修过的那类缺陷），而拼接畸形内容更甚。
   *
   * ⇒ 规则：**该候选只要产出过「可见内容」，其后任何失败都直接向上抛**，不再尝试下一个。
   * 「切换」只发生在「尚未产出任何可见内容」的失败上（连接失败、认证失败、上游立刻
   * 返回错误 —— 这些恰好是跨渠道切换真正有价值的情形）。
   *
   * ## ⚠️ 为什么判据是「可见内容」而不是「任何 chunk」（Task 6 复审 M23）
   *
   * 初版用「产出过任何 chunk」作判据，于是候选**只吐了 `block-start` / `usage`
   * 这类元数据帧**就失败时，也会放弃切换 —— 那是**过度保守**，白白丢掉一次
   * 本可成功的切换机会。
   *
   * 而只产出元数据帧时切换是**安全**的（实测 `BlockAssembler` 的语义）：
   * - `block-start` 是**幂等**的（`if (!this.partials.has(chunk.index))`）——
   *   下一个候选重发同 index 的 `block-start` 不会产生重复块；
   * - `usage` 是**覆盖**语义（`this._usage = chunk.usage`）—— 后到的会顶掉前一个；
   * - 两者都**不含用户可见的正文**。
   *
   * ⇒ 判据：只有 `text` / `reasoning` / `image` / `tool-call` / `tool-result`
   * 以及 `*-delta` / `block-end` 算「可见内容」；`block-start` 与 `usage` 不算。
   * ⚠️ 未知类型一律**算可见内容**（保守方向：宁可少切换，不可拼接畸形回答）。
   *
   * ## 档位必须逐候选翻译
   *
   * 请求里的 `reasoningEffort` 来自**上一次对话**，可能带着别的模型族的档位名
   * （如给只声明 `enabled` 的模型发 `xhigh`）。原样转发会被 DSH 按 id 严格校验
   * 拦下 `UNSUPPORTED_REASONING_EFFORT`。故复用仓库既有的
   * {@link translateReasoningEffort}：不可表达时**不下发该字段**而非抛错。
   */
  private dispatch(
    targets: readonly DispatchTarget[],
    options: GenerateOptions,
    /**
     * 本次请求的虚拟模型 id（`auto` 或规范键）—— 用于给「上次实际选中的渠道」
     * 记录**归属**（P3：徽标按虚拟模型分别记忆，规格 §6.3 的 P3「每虚拟模型一条」）。
     */
    modelKey: string,
  ): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* () {
      let lastError: unknown
      /**
       * 已透出的 `block-start` 块（`index → blockType`），**跨候选累积**。
       *
       * ⚠️ 为什么需要它（真实缺陷，对抗审计用真实 `BlockAssembler` 实测证伪）：
       * `BlockAssembler` 对 `block-start` 的判据是**按 `index` 幂等且不更新
       * `blockType`** ⇒ 候选 A 开了 `tool-call` 块后失败、候选 B 重开同 index 的
       * `text` 块时，B 的正文会被灌进 A 的 tool-call 块 ⇒ 下游只看到**空 tool-call**、
       * 用户答案丢失（`finish=stop`，无报错）。
       *
       * ⚠️ 实测三种组合（真实 `BlockAssembler`）：
       *   text→text ✅ 安全 ｜ usage→text ✅ 安全 ｜ tool-call→text ❌ 丢答案
       * ⇒ 记录类型，切换前判定（`text` 是安全类型，因为它最可能就是下一个候选要开的）。
       */
      const openedBlocks = new Map<number, string>()
      /**
       * **方案 C（2026-10-12）：派发前按本轮体积跳过太窄的候选**。
       *
       * ## 为什么必须筛
       * `aggregate/auto` 的候选横跨十几个渠道，声明窗口相差两个数量级；而 DSH 只看到
       * 虚拟模型那一个（取候选最大值）⇒ 一个 20 万 token 的会话会被派给 3.2 万窗口的
       * 候选，上游报超限、或按自己的上限把输出截断（用户 2026-10-12 实测的正是后者）。
       *
       * ## 判据
       * - 本轮体积取**最近一次观测**（`usage.totalTokens` 的最大值）；没观测过 ⇒ **不筛**
       *   （首轮无从判断，且「未知不编造」）。
       * - 候选上限取**学习值优先**（`learnedContextWindow`，来自截断/超限学习），
       *   否则取它声明的窗口；**两者都没有 ⇒ 不筛**（未知 ≠ 太窄）。
       * - 留 5% 余量：上游按「输入 + 输出」计总量，贴着上限派发必然失败。
       *
       * ## ⚠️ 兜底：一个都不剩时**按成因分两路**（2026-10-12 起）
       * - 全被**体积**筛掉（确定找不出装得下的候选）⇒ **主动报
       *   `CONTEXT_WINDOW_EXCEEDED`**，交给 DSH 的压缩链压缩后重发
       *   —— 硬发只会被上游静默截断（9.22 要点 5）。
       * - 全在**零输出冷却**中（**瞬时针**，不构成「装不下」的证据）⇒ 照常逐个尝试。
       */
      let attemptTargets: readonly DispatchTarget[] = targets
      /**
       * ⚠️⚠️ **筛选用的「本轮体积」必须来自本会话，且不得是进程级峰值**（Issue F-04）。
       * 判据与取舍见 `lastContextTokensBySession` 的声明处注释。
       * ⚠️ 本会话没有观测过 ⇒ `undefined` ⇒ **不筛**（「未知不编造」；首轮无从判断）。
       */
      const sessionKey = String(options.sessionId ?? '')
      const observedTokens = self.lastContextTokensBySession.get(sessionKey)
      /**
       * **本次请求**（本次 `dispatch`）观测到的最大上下文规模。
       *
       * ⚠️ 「请求内取最大」必须落在**这个局部变量**上，不能落进会话表：usage 帧在
       * 一次请求里可能来多帧（规模只会增长，取最大才安全），而**跨请求必须覆盖**
       * ——否则会话被压缩变小后观测值降不下来，又回到「只增峰值」的老毛病。
       * 判据与后果见 `lastContextTokensBySession` 的声明处注释。
       */
      let requestTokens: number | undefined
      /**
       * 因**零输出冷却**被跳过的候选（与体积无关的**瞬时针**）。
       *
       * ⚠️ 必须与体积原因分开记：冷却不构成「装不下」的证据，故它不能参与
       * 下方「全被筛掉 ⇒ 主动压缩」的判据（判据里的 `cooling.length === 0`）。
       */
      const cooling: string[] = []
      /**
       * ⚠️⚠️ **零输出冷却表必须无条件消费**（Issue F-54）。
       *
       * 原实现把冷却检查放在「本会话观测过 usage」（`observedTokens !== undefined`）
       * 那个大 `if` **内部**，于是冷却表在两种情形下**永不消费**：
       *
       * ① 会话没观测过 usage（首轮，或 usage 帧丢失）⇒ 整块不执行；
       * ② 观测到了，但**没有**候选因体积被跳过 ⇒ 末尾
       *    `kept.length > 0 && skipped.length > 0` 不成立 ⇒ `attemptTargets`
       *    仍是全量 ⇒ 冷却候选**照旧被派发**。
       *
       * 两种情形的后果一致：上一轮刚吞掉一次请求、零输出的候选，这一轮又拿到
       * 请求 —— 方案 F 的「本次运行内别再三连撞同一堵墙」在大多数请求上压根
       * 没生效。故把冷却筛选**提到体积判据之前独立做一遍**：它的依据
       *（「这个目标上一轮零输出」）是已经发生的事实，与体积无关。
       */
      const liveTargets: DispatchTarget[] = []
      for (const candidate of targets) {
        // ⚠️ 零输出冷却中的目标**优先跳过**（与体积无关的理由）：它上一轮刚吞掉
        //    一次请求、零输出（方案 F 记的冷却），再派给它只会重复一次失败。
        if (isTargetCoolingDown(self.zeroOutputCooldowns, candidate.provider, candidate.realId, self.options.now?.() ?? Date.now())) {
          cooling.push(`${candidate.provider}(${candidate.realId})=零输出冷却中`)
          continue
        }
        liveTargets.push(candidate)
      }
      if (cooling.length > 0 && liveTargets.length > 0) {
        attemptTargets = liveTargets
        self.ctx.logger?.info?.(
          `[jet-hub] 候选筛选 ${modelKey}: 跳过 ${cooling.length} 个零输出冷却中的候选`
          + `[${cooling.join(', ')}]`,
        )
      } else if (cooling.length > 0) {
        // 全在冷却中（**瞬时针**，不是装不下）：压缩对它毫无帮助 ——
        // 照常逐个尝试，冷却目标会自己失败并切换。
        self.ctx.logger?.warn?.(
          `[jet-hub] 候选筛选 ${modelKey}: ${cooling.length} 个候选全在零输出冷却中`
          + `[${cooling.join(', ')}]，放弃筛选、照常逐个尝试`,
        )
      }
      /**
       * 全在冷却中 ⇒ 下方体积筛选**整块不做**：`attemptTargets` 此时仍是全量，
       * 若照筛会把冷却候选按体积再判一次，与「冷却不构成装不下的证据」相矛盾
       *（原实现在这种情况下也是全量尝试）。
       */
      const allCooling = cooling.length > 0 && liveTargets.length === 0
      if (!allCooling && observedTokens !== undefined && observedTokens > 0) {
        const required = Math.ceil(observedTokens * 1.05)
        const kept: DispatchTarget[] = []
        const skipped: string[] = []
        for (const candidate of attemptTargets) {
          const sep = String.fromCharCode(0)
          const cap = learnedContextWindow(contextWindowKey(candidate.provider, candidate.realId))
            ?? self.candidateWindow.get(candidate.provider + sep + candidate.realId)
          if (cap !== undefined && cap < required) {
            skipped.push(`${candidate.provider}(${candidate.realId})=${cap}`)
            continue
          }
          kept.push(candidate)
        }
        if (kept.length > 0 && skipped.length > 0) {
          attemptTargets = kept
          self.ctx.logger?.info?.(
            `[jet-hub] 候选筛选 ${modelKey}: 本轮约 ${observedTokens} tokens（需 ${required}），`
            + `跳过 ${skipped.length} 个太窄候选 [${skipped.join(', ')}]`,
          )
        } else if (kept.length === 0 && cooling.length === 0) {
          // ⚠️⚠️ **全被体积筛掉 ⇒ 确定装不下**（每个候选都有已知上限，且都低于本轮体积）。
          //    硬发出去正是用户 2026-10-12 实测的形态：上游收下请求、按自己的上限把输出
          //    **静默截断**（`finish: max-tokens`），报错通道里什么都没有、学习器也收不到信号。
          //    ⇒ 主动归成 CONTEXT_WINDOW_EXCEEDED —— DSH 的压缩恢复链**只认这个码**
          //    （`dsh-compaction-basic` 的 request-error listener 第一行即本判据），
          //    压缩后重发才是唯一出路（9.22 要点 5：不硬发被截断）。
          //    代价刻意取**不对称**：误判最多白压缩一次；硬发的代价是**回答被截断**。
          // ⚠️⚠️ **必须先清掉本会话的观测再抛**（Issue F-04）：这条判词的含义是
          //    「按**陈旧**观测看，没有候选装得下」，而不是「我们量到了本轮的真实体积」。
          //    留着它，DSH 压缩后重发的下一次请求会读到**同一个数字**、再抛一次 ⇒
          //    **压缩重试死循环**（进程存活期内该会话永久不可用）。
          //    清掉后退回「未知 ⇒ 不筛」（与没有观测的既有分支同一条路径），
          //    硬发的代价最多是被上游截断，而循环的代价是**会话彻底不可用**。
          self.lastContextTokensBySession.delete(sessionKey)
          throw new LlmError(
            `aggregate: 本轮约 ${observedTokens} tokens（本会话最近一次观测），已超出全部 `
            + `${targets.length} 个候选的已知上限 [${skipped.join(', ')}]，已在压缩上下文后重试。`,
            CONTEXT_WINDOW_EXCEEDED_CODE,
          )
        } else if (kept.length === 0) {
          // 剩下的唯一成因是「非冷却候选全被体积筛掉，而池里仍有候选在零输出冷却中」：
          // 冷却（**瞬时针**）不是装不下的证据，压缩对它毫无帮助 —— 照常逐个尝试。
          self.ctx.logger?.warn?.(
            `[jet-hub] 候选筛选 ${modelKey}: 非冷却候选全部装不下（需 ${required}），`
            + `但仍有 ${cooling.length} 个候选在零输出冷却中 [${cooling.join(', ')}]，照常逐个尝试`,
          )
        }
      }
      for (let index = 0; index < attemptTargets.length; index += 1) {
        // ⚠️ 索引必须落在**筛选后**的 `attemptTargets` 上（2026-10-12 复核发现的错配）：
        //    方案 C 的 `kept` 是**子集而非前缀**，读 `targets[index]` 会把刚被判定
        //    「装不下」的候选重新派出去，而真正装得下的候选反而永远轮不到
        //    —— 恰好在最需要筛选的场景（宽候选排在窄候选之后）里筛了个空。
        const target = attemptTargets[index]!
        // 该候选是否已经产出过内容（决定失败时能否安全切换，见上方长注释）。
        let emitted = false
        /**
         * **本次尝试**实测到的规模（`usage.totalTokens`），成功时用于**自愈**（9.22）。
         *
         * ⚠️ 与 `self.lastContextTokens` 的区别是**关键**的：那个是跨候选、跨轮次的
         * 累积峰值，可能来自一个窗口宽得多的候选；拿它去放宽窄候选就是「填大」
         *（危险方向）。这里只记本次尝试真正收到的值。
         */
        let turnTokens: number | undefined
        /** 本候选的「零输出撞墙」探针（见下方方案 F 的接线）。 */
        let zeroProbe = emptyZeroOutputProbe()
        /** 本次尝试是否因「零输出撞墙」而改道（决定内层 break 后走 continue）。 */
        let reroute = false
        /**
         * ⚠️⚠️ **在「转发一开始」就记下真实目标**（`activeRoutes`，供客户端实时读数）。
         *
         * 与下面 `activeProviderByModel` 的「只在整轮跑完才写」**判据相反**，这是
         * 刻意的：那张表回答「该看哪个渠道的余额」，写失败候选会让徽标指向一个刚
         * 失败、甚至已无额度的账号；而本表回答「**此刻正在用什么**」，等整轮跑完
         * 才更新就失去了实时性（长回答几十秒内用户都看不到）。
         *
         * ⇒ 两个语义、两处写入，**不要合并**（详见 `active-route.ts` 模块头）。
         * ⚠️ 每次尝试都覆盖写：失败切换后读数跟着变，这正是「实时」应有的行为。
         */
        activeRoutes.record(AGGREGATE_PROVIDER, target.provider, target.realId)
        /**
         * 本候选「已产出可见内容 ⇒ 待定记录」的渠道（`undefined` = 没产出过内容）。
         *
         * ⚠️ 只有**整个流正常结束**才提交进 `activeProviderByModel`（规格 §6.3 P3
         * 的「只在成功时写」）—— 见产出内容处的注释与流结束后的提交处。
         */
        let pendingProvider: string | undefined
        try {
          for await (const chunk of self.streamThrough(target, options)) {
            // ⚠️⚠️ **必须在置 `emitted` 之前**判这个失败帧（顺序是语义性的）。
            //
            // 为什么需要这一段：`streamThrough` 走的是**嵌套公共入口**
            // `ctx.llm.stream(...)`，而它把适配器失败**归一化成终止 chunk 而不是抛出**
            //（`dsh-llm/lib/index.js`：`catch (error) { yield adapterFailureChunk(...);
            // return }`，两处；宿主版 JSDoc 原文「Adapter selection, dispatch, and
            // iteration failures become terminal `error` or `aborted` finish chunks」）。
            //
            // 故**只靠 `catch` 永远等不到上游失败** —— 拿到的是一个普通的
            // `{ type: 'finish', reason: { kind: 'error' } }`。若照常置 `emitted`
            // 并 yield，内层生成器正常结束、`return` ⇒ **第二个候选永不尝试**，
            // 整个「失败切换」在生产路径上完全失效（真实缺陷，Task 6 复审实测）。
            //
            // ⚠️ 该帧**不 yield**：它讲的是「这个候选失败了」，而我们要换候选重试；
            // 把它透出去会让消费者以为整轮已经结束。
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              // ⚠️⚠️ **必须保真上游的 `code`，不能拍平成 `'SERVER'`**（真实缺陷，
              // 全分支终审 C1 实测）。
              //
              // 为什么：`'SERVER'` **在** DSH 的 `DEFAULT_RETRYABLE_CODES`
              // （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`，
              // `dsh-llm/lib/index.js:251`）里，而 `QUOTA_EXCEEDED` / `AUTH` /
              // `MISSING_CREDENTIAL` **不在**。拍平后：
              // - 「今日额度已用尽」这类**确定性**错误会被当可重试 ⇒
              //   `dsh-llm-retry` 按 code 判定（`retryStateKey`），每次重试都会
              //   **重跑整个候选循环** ⇒ 最坏 5 × N 次上游调用 + 退避（≈15.5s）。
              //   这正是 AGENTS.md 第 9 条记录的用户报障形态（qoder `110` 被归
              //   `SERVER` 后「白重试 5 次」）。
              // - 它还会**绕过 `dead-model-store` 的豁免**：`IGNORED_CODES` 豁免
              //   `AUTH` / `QUOTA_EXCEEDED` / `RATE_LIMIT` / `MISSING_CREDENTIAL` /
              //   `PERMISSION_DENIED`，但**不豁免 `SERVER`** ⇒ 上游的认证/额度错误
              //   会被 `isModelGoneError` 的文案判据命中，把**整个虚拟模型**记成
              //   30 天失效（终审 C2）。
              // - 也违反 spec §4.3 的成文要求：「复用各适配器抛出的既有
              //   `LlmError.code`（`QUOTA_EXCEEDED` / `RATE_LIMIT` / `AUTH` …）；
              //   不自行解析上游 body」—— 初版既没复用也没解析，而是**丢弃**。
              //
              // ⚠️ 兜底：上游可能不给 `code`（或给空串）—— 那时才退回 `'SERVER'`
              //（它至少是「可重试」的合理默认；给出空 code 会让 DSH 无法归类）。
              const upstreamCode = chunk.reason.failure.code
              // ⚠️ **必须把 failure 的其余事实一并带上**（真实缺陷，对抗审计实测证伪）：
              //    旧实现只传 `message` + `code` ⇒ **丢弃** `status` /
              //    `providerRetryAfterMs` / `requestId`。而 `LlmError` 的第三参
              //    明确接受并校验这三者（`dsh-llm/lib/index.js:1026-1048`）。
              //
              //    ⚠️ 其中 `providerRetryAfterMs` 是**服务端指定延迟**的机器通道 ——
              //    丢了它，退避只能靠固定策略（AGENTS.md 第 8 条记录的 qoder 排队
              //    问题同源：服务端要等 30 秒，而固定退避最多 8 秒 ⇒ 永远等不到）。
              //    ⚠️ `status` / `requestId` 则是排障时定位上游故障的关键线索。
              //
              //    ⚠️⚠️ **不要在这里重写 `LlmError` 的校验**（真实缺陷，独立审计实测证伪：
              //    我自己上一版正是这么写的，结果在**边界值**上反而**丢弃**了原始失败）。
              //
              //    上一版写「`status` 是整数且 ≥100、`providerRetryAfterMs` 有限、
              //    `requestId` 非空」，而 `LlmError` 的真实校验（`dsh-llm/lib/index.js:1037-1039`）
              //    更严：`status` **还要 ≤599**、`providerRetryAfterMs` **还要 >0**。
              //    ⇒ `status=700` / `providerRetryAfterMs=0` 时 `LlmError` **抛校验错**
              //      ⇒ 原始的上游 `message` / `code` **全丢** —— 一个「保真」修复
              //      在边界上**丢弃**了失败。这正是本仓库首条红线的形态
              //      （「同一语义两套判据，必有一处是错的」）。
              //
              //    ⇒ 修法：**判据只留一份**（在 `LlmError` 里）。先试带全部事实，
              //      若它拒绝（抛校验错）就**退回最小集合**（message + code）——
              //      我方永不与它分叉，且**任何**边界值都不会丢掉原始失败。
              const failure = chunk.reason.failure
              const message = `aggregate: ${target.provider}（${target.realId}）上游失败`
                + `${describeFailure(failure)}`
              // ⚠️ 手机版补充（2026-10-11）：上游其实说的是「请求超出上下文窗口」时，
              //    必须如实归成 `CONTEXT_WINDOW_EXCEEDED`，否则 DSH 的压缩恢复链
              //    **根本不会启动**（`dsh-compaction-basic` 的 request-error listener
              //    第一行就是这个判据）——归成 `SERVER` / `INVALID_REQUEST` 的代价是
              //    **长会话越过窗口后每轮报废**，而误归一次的最坏代价只是一次无效压缩。
              //    方向不对称，与 `buddy-adapter.ts` / `gemini-adapter.ts` 的成文口径一致。
              const code = resolveUpstreamCode(upstreamCode, message)
              // ⚠️ **动态窗口学习**（Step B 切片一）：上游确实说「超出窗口」时把上限记下来。
              //    取值优先级：报文里的**真实上限** > 当前声明值**减半**（见
              //    `context-window-learn.ts`）。这一步必须紧跟归码、不能放到「重试之后」——
              //    压缩链一启动就会重发请求，越早收窄越少「撞墙 → 压缩 → 再撞墙」。
              //    ⚠️ 这里**不设**「该模型当前是否走兜底」的前置条件：记录本身无害，而
              //    `contextWindowFor` 只在**候选全无声明**时才查学习表 —— 某家一旦给了真值，
              //    真值仍然优先（约定 3）。反过来若声明与真实不符，这里记下的至少更接近真实。
              //    ⚠️⚠️ **按该候选记，不按虚拟模型记**（2026-10-12 修正，用户实测提出）：
              //    原先记虚拟模型 ⇒ 一个窄候选撞墙就把**整个虚拟模型**的对外声明粘性
              //    压低，之后即使换回宽窗口的候选也**不恢复**（DSH 压缩阈值 = 声明 × 0.8
              //    ⇒ 长期过早压缩、宽候选的能力被让掉）。而且那层保护**多余**：虚拟声明
              //    本就取候选最大值，池整体窄时声明自然窄；需要「这个候选装不下」这层
              //    信息的只有**筛选**（方案 C），它读的正是候选键。
              if (code === CONTEXT_WINDOW_EXCEEDED_CODE) {
                const learned = rememberContextWindowFailure(
                  contextWindowKey(target.provider, target.realId), message,
                )
                self.ctx.logger?.info?.(
                  `[jet-hub] 窗口学习 ${target.provider}（${target.realId}）: `
                  + `上游报超限 → 记该候选 ${learned}`,
                )
              }
              // ⚠️⚠️ **逐字段独立回退**（不是整袋回退）。
              //
              // 我先前的两版都有问题：
              // ① 第一版**自己重写**了 `LlmError` 的校验，而它与真实校验不一致
              //   （缺 `status ≤ 599`、缺 `providerRetryAfterMs > 0`）⇒ 边界值上
              //   `LlmError` **抛校验错** ⇒ 上游 message/code **全丢**（Critical）。
              // ② 第二版改成「试全字段、失败就退回最小集合」——修好了 ①，
              //   但**整袋回退**会让**合法**字段陪葬：实测
              //   `status:429 + providerRetryAfterMs:30000 + requestId:''`
              //   ⇒ 合法的 429 与 30000ms 退避**一并被丢**（而 30000ms 正是
              //   服务端指定退避的机器通道，AGENTS.md 第 8 条）。
              //
              // ⇒ 正确做法：**每个字段各自试探**。判据仍只有 `LlmError` 一份
              //  （我方不重写校验），但一个字段越界**只丢它自己**。
              const accepted: LlmErrorOptions = {}
              const probe = (field: keyof LlmErrorOptions, value: unknown): void => {
                if (value === undefined) return
                try {
                  // 用**真实校验**试探：构造一个只带该字段的错误，被拒就丢弃该字段。
                  void new LlmError(message, code, { [field]: value } as LlmErrorOptions)
                  Object.assign(accepted, { [field]: value })
                } catch {
                  // ⚠️ 只丢**这一个**字段，其余照常保真。
                }
              }
              probe('status', failure.status)
              probe('providerRetryAfterMs', failure.providerRetryAfterMs)
              // ⚠️ `requestId` 是 branded 类型（`ProviderRequestId`）——
              //    必须经构造函数 brand（与 `ReasoningEffortId` 同款先例，
              //    见本文件 `resolveModel` 的档位声明），不能直接传 `string`。
              probe('requestId', typeof failure.requestId === 'string'
                ? ProviderRequestId(failure.requestId) : undefined)
              lastError = new LlmError(message, code, accepted)
              throw lastError
            }
            // ⚠️ `aborted` ≠ `error`：中止是**调用方的意愿**，绝不能当成「换个候选
            // 重试」（那会让用户取消后仍继续跑）。与本仓库既有口径一致
            //（`aggregate-core.ts` 的哨兵注释：「abort **立刻抛 AbortError**，
            // 绝不折算」；`auto-adapter.ts` 同款注释）。
            if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
              throw abortError()
            }
            // ⚠️ 只在产出**可见内容**时才算「已吐内容」（Task 6 复审 M23）：
            // 仅 `block-start` / `usage` 这类元数据帧是**可安全重放**的，不该
            // 因此放弃切换机会。判据与理由见 `isVisibleContent`。
            //
            // ⚠️⚠️ 但 `block-start` 的「可重放」**只对同类型成立**（真实缺陷，
            // 对抗审计用真实 `BlockAssembler` 实测证伪）：
            // `BlockAssembler.push` 对 `block-start` 的判据是**按 `index` 幂等且
            // 不更新 `blockType`** ⇒ 若候选 A 开了 `tool-call` 块后失败、候选 B
            // 重开同 index 的 `text` 块，**B 的 `blockType` 被忽略**、B 的正文被
            // 灌进 A 的 tool-call 块 ⇒ 下游只看到一个**空 tool-call**、
            // **用户答案丢失**且 `finish=stop`（无报错）。
            // 实测三种组合（真实 `BlockAssembler`）：
            //   text→text ✅ 安全 ｜ usage→text ✅ 安全 ｜ tool-call→text ❌ 丢答案
            // ⇒ 记录**已开块的类型**，切换时若新候选要开**不同类型**则禁止切换。
            if (chunk.type === 'block-start') {
              openedBlocks.set(chunk.index, chunk.blockType)
            }
            if (isVisibleContent(chunk)) {
              emitted = true
              // ⚠️ **先记「待定」渠道，不立刻写进 Map**（真实缺陷，对抗审计实测证伪）。
              //
              // 规格 §6.3 P3 的原文是「**只在成功时写** —— 写失败候选会让徽标指向一个
              // 刚刚失败、甚至已无额度的渠道」。而旧实现写在「首个可见 chunk」时：
              // 若该候选吐了一个 `text-delta` **之后整轮失败**（如 `socket hang up`），
              // 用户**什么也没拿到**，徽标却记下了这个**失败**的渠道。
              //
              // ⇒ 改为：这里只记 `pendingProvider`，等**这一轮的 `for await` 正常结束**
              //   （即候选真的把整轮跑完）才提交进 Map。见下方 `return` 之前的提交处。
              pendingProvider = target.provider
            }
            // ⚠️⚠️ **方案 B（2026-10-12）：把「截断」也变成可学的信号**。
            //
            // ## 为什么必须单独处理（用户实测报障的根因）
            //
            // 既有学习钩子只在**失败**（`finish: error` 且归成 `CONTEXT_WINDOW_EXCEEDED`）
            // 时触发。但多数上游**不报错**：它们按自己的上限把输出截断，回
            // `finish_reason: length`（DSH 侧显示「已达到输出 token 上限」）。
            // 实测（本机 2026-10-12，`aggregate/auto` → loomy spark-x）：
            // 会话 20.9 万 token、虚拟模型声明 1M ⇒ DSH 压缩阈值 800K 永不触发，
            // 而 spark-x 真实上限约 262K ⇒ 连续两轮以 `max-tokens` 收场。
            // ⇒ 这种形态下**没有任何失败帧**，学习器完全是瞎的。
            //
            // ## 判据与取值
            //
            // `finish: max-tokens` = 模型在本轮**用尽了自己的预算**，此刻在飞的
            // 规模（`usage.totalTokens`）就是该候选的有效上限**下界**。
            // 记它有两个作用：
            // 1. **虚拟模型**收窄 ⇒ 对外声明变小 ⇒ DSH 下轮更早压缩（用户要的
            //    「自动降低上限并压缩」）；
            // 2. **该候选**收窄 ⇒ 方案 C 的筛选在后续轮次**跳过**它（20 万 token 的
            //    会话不再派给 26 万上限的 spark-x）。
            // ⚠️ 只在**有观测值**时记：拿不到 usage 就不猜（「未知不编造」）。
            if (chunk.type === 'usage') {
              const seen = contextTokensOfUsage(chunk.usage)
              if (seen !== undefined) {
                turnTokens = seen
                // ⚠️ `Math.max` **只作用于同一次请求内部**（落在这个局部变量上）；
                //    落桶是**覆盖**，这样会话被压缩变小后观测值能如实下降
                //    ——「只增峰值」正是 F-04 的根因。详见字段声明处注释。
                requestTokens = Math.max(requestTokens ?? 0, seen)
                self.recordSessionContextTokens(sessionKey, requestTokens)
              }
            }
            if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') {
              /**
               * ⚠️⚠️ **学习值必须取「本次尝试」的规模，不是进程/会话峰值**（Issue F-04 第 ② 条）。
               *
               * 原先读的是那个进程级只增峰值 ⇒ 一处**静默的学习失效**：宽候选观测过
               * 90 万之后，窄候选（真实上限 26.2 万）以 max-tokens 收场时送进去的是
               * 90 万 ⇒ `rememberContextWindowCeiling` 「只在更小时覆盖」⇒
               * **永远学不进 26.2 万** ⇒ cap 恒 90 万 ⇒ 方案 C 恒不跳过该窄候选 ⇒
               * 每轮都派给它、每轮都被截断。
               *
               * ⇒ 改用 `turnTokens`（只由本次尝试的 usage 帧记录）。这与它在
               * :1511 声明处的自警「拿峰值去放宽窄候选就是填大（危险方向）」同一口径，
               * 本条只是把同一判断补到学习点上。
               * ⚠️ 没观测到 usage ⇒ `undefined` ⇒ **不学**（「未知不编造」）。
               */
              const observed = turnTokens
              if (observed !== undefined) {
                // ⚠️ **只记该候选**（2026-10-12 修正，与上面的失败路径同口径）：记虚拟模型
                //    会把整个虚拟模型的对外声明粘性压低 ⇒ 换回宽候选也不恢复。
                const perCandidate = rememberContextWindowCeiling(
                  contextWindowKey(target.provider, target.realId), observed,
                )
                self.ctx.logger?.warn?.(
                  `[jet-hub] 窗口学习(截断) ${modelKey}: ${target.provider}（${target.realId}）`
                  + `以 max-tokens 收场，本轮 ${observed} tokens ⇒ 记该候选 ${perCandidate ?? '未记'}`,
                )
              }
            }
            // ⚠️⚠️ **零输出撞墙 ⇒ 换下一个候选重发**（方案 F，2026-10-12 接线）。
            //
            // 判据在 `zero-output-guard.ts`（**唯一权威**）：`max-tokens` **且零输出**。
            // ⚠️ 必须同时要求零输出 —— 有输出的 `max-tokens` 是「正常答到半截撞了输出
            // 上限」，换候选会把已经产出的内容撤回（本文件上方两道守卫正是防这个）。
            //
            // ⚠️ 判定必须在**透出该终止帧之前**：一旦把 `max-tokens` 交给 harness，
            //    本轮就结束了（DSH 对 `max-tokens` 不自动重试），改道机会随即消失。
            //
            // ⚠️ 额外要求 `openedBlocks.size === 0`：`block-start` **不算**可见内容
            //（见 `isVisibleContent`），故「零输出」仍可能已经开过块 —— 而按 index
            // 幂等的 `BlockAssembler` 会让下一个候选的内容灌进错误类型的块（本文件
            // 上方那段长注释记录的真实缺陷）。零输出 + 没开过块才是**可安全重发**的形态。
            zeroProbe = noteChunk(zeroProbe, chunk)
            if (chunk.type === 'finish' && isZeroOutputWallHit(zeroProbe)) {
              if (emitted || openedBlocks.size > 0) {
                // 已开块/已吐内容：**如实透出**（重发会丢内容，比截断更糟）。
                self.ctx.logger?.warn?.(
                  `[aggregate] ${target.provider}（${target.realId}）零输出撞墙，但已开过 `
                  + `${openedBlocks.size} 个块，不重发（重发会让内容灌进错误的块类型）`,
                )
              } else if (index + 1 < attemptTargets.length) {
                self.zeroOutputCooldowns = noteZeroOutputHit(
                  self.zeroOutputCooldowns, target.provider, target.realId, self.options.now?.() ?? Date.now(),
                )
                self.ctx.logger?.warn?.(
                  `[aggregate] ${modelKey}: ${target.provider}（${target.realId}）收下请求却零输出`
                  + `（疑似声明窗口虚高），改道下一个候选重发；该目标在 `
                  + `${Math.round(ZERO_OUTPUT_COOLDOWN_MS / 60_000)} 分钟内不再被选`,
                )
                reroute = true
                break
              } else {
                // 没有下一个候选：**如实透出**这轮的终止帧（不吞掉、不伪造成功）。
                self.ctx.logger?.warn?.(
                  `[aggregate] ${modelKey}: ${target.provider}（${target.realId}）收下请求却零输出，`
                  + `但候选序已到末位；如实上报该结果`,
                )
              }
            }
            yield chunk
          }
          // ⚠️ 零输出撞墙改道：内层 `break` 出来，**不提交**任何「实际选中」记录，
          //    直接试下一个候选（与 auto-adapter 的 `yield* this.dispatch(next, ...)` 同语义）。
          if (reroute) continue
          // ⚠️ 走到这里 = 该候选的流**正常结束**（没有抛错、没有失败帧）⇒ 提交「实际选中」。
          //
          // ⚠️ **成功自愈**（9.22）：整轮正常结束 ⇒ **本次尝试**的实测规模证明「该键至少
          //    能装这么多」。若此前学到的值比它小，说明那个值偏小（报文误读、或收敛途中
          //    的中间值）⇒ 放宽它，避免「重启后仍按一个偏小的值过早压缩」。
          //    方向安全：该值来自**真正成功**的请求，必然 ≤ 真实上限（不会「填大」）。
          if (turnTokens !== undefined) {
            // ⚠️ 只对**该候选**自愈：虚拟模型那侧自 2026-10-12 起不再记学习值
            //    （见 `dispatch` 的两处学习点与本文件 `contextWindowFor` 的注释）。
            const candidateHealed = noteContextWindowSuccess(
              contextWindowKey(target.provider, target.realId), turnTokens,
            )
            if (candidateHealed !== undefined) {
              self.ctx.logger?.info?.(
                `[jet-hub] 窗口自愈 ${target.provider}（${target.realId}）: `
                + `本轮 ${turnTokens} tokens 成功 ⇒ 放宽到 ${candidateHealed}`,
              )
            }
          }
          if (pendingProvider !== undefined) {
            // ⚠️ 是**实际发往**的 `target.provider`，不是候选序第一个（带图改道时可能不同）。
            // ⚠️ 同时更新「最近一次」指针：`Map` 的迭代顺序是**插入顺序**，
            //    覆盖已存在的键**不改变**其位置 ⇒ 不能靠它取「最近」。
            self.activeProviderByModel.set(modelKey, pendingProvider)
            self.lastActiveProvider = pendingProvider
            // ⚠️ 与渠道**同一提交点**记下具体模型（真实 modelId）：`auto` 的徽标只显示
            //    渠道时用户不知道跑的是哪个模型（用户 2026-10-09 报障）。门控完全一致
            //    —— 只有整轮正常结束才算「真的用了这家这个模型」。
            self.activeTargetByModel.set(modelKey, { provider: pendingProvider, realId: target.realId })
            self.lastActiveModel = target.realId
          }
          return
        } catch (error) {
          lastError = error
          // ⚠️ 中止/取消**不换候选**，立刻向上抛。
          if (isAbortLike(error, options.signal)) throw error
          if (emitted) {
            // 已经吐过内容：不能切换（否则把两段回答拼在一起）。
            self.ctx.logger?.warn?.(
              `[aggregate] ${target.provider}（${target.realId}）在产出内容后失败，`
              + `不再切换候选（已产出的内容无法撤回）：${String(error)}`,
            )
            throw error
          }
          // ⚠️⚠️ **已开过任何块 ⇒ 不得切换**（含 `text`）。
          //
          // ## 为什么不能按类型豁免（我先前的修法有**实证明文的盲区**）
          //
          // 我第一版按「已开的块类型」判断：开过**非 `text`** 才拒绝切换。
          // 但适配器**无法预知**下一个候选会开什么类型 ⇒ 若 A 开 `text`
          //（守卫眼中的「安全类型」）而 B 开 `tool-call`，则 B 的 `blockType`
          // 被 `BlockAssembler` 忽略（它按 `index` 幂等、**不更新 `blockType`**）
          // ⇒ **工具调用丢失**。探针（真实 `BlockAssembler`）逐字输出：
          // ```
          // A 开 text → B 开 tool-call
          // blocks = [{"type":"text","text":""}]   ← tool-call 消失，只剩空 text 块
          // ```
          // ⇒ 按类型豁免**必然有缺口**，两个方向都要堵。
          //
          // ## 代价（有意的、可接受的）
          //
          // `text→text` 实测是**安全**的（同类型重放不丢内容），而一刀切会让这种
          // 情形也放弃切换 —— 但那只是**少一次重试**（用户看到一次失败），
          // 而盲区的代价是**工具调用/答案丢失**（用户拿到残缺结果且无报错）。
          // 方向取**安全**：宁可少切换，不可丢内容。
          //
          // ## ⚠️ 已知代价（对抗审计实测指出，**有意保留**）
          //
          // 本守卫收得**比必要更紧**：它在「B 用**从未用过的 index**」时也拒绝切换，
          // 而那种重放**实测是安全的** —— 探针（真实 `BlockAssembler`）：
          // ```
          // A 开 text(0) → B 开 text(7)
          // blocks = [{"type":"text","text":""},{"type":"text","text":"B的答案"}]
          // ```
          // ⇒ B 的答案**完整保留**（只多一个来自 A 的**空块**）。
          //
          // 即：**在切换前无法知道** B 会用新 index 还是复用旧 index（那是上游的自由），
          // 故「按 index 是否复用」收窄需要**预读 B 的第一个 block-start** —— 那会把
          // 本方法从「透传流」改成「带前瞻的缓冲」，属更大的改动面
          //（与下方「延迟 block-start」的替代方案是同一类改动）。
          //
          // ⚠️ 代价的**方向**是刻意的：过紧只是**少一次重试**（用户看到一次失败，可重发），
          //    而过松（允许切换）在**复用 index** 时会**丢答案/丢工具调用**（静默、无报错）。
          //    两者不对称，故取过紧。
          //
          // ⚠️ 另：`openedBlocks` 在 `block-end` 时**也不清**（保持「开过就记住」的简单语义）。
          //    ⚠️ 我一度用「闭合后 index 仍被占用」为它辩护 —— 那个**前提经探针证实是对的**
          //   （`block-end` 只往 partial 挂 `block` 字段、**不删** `partials` 条目 ⇒
          //    后续 `block-start(同 index)` 仍被忽略），
          //    ⚠️ 但**本场景实际拦切换的是 `emitted`，不是 `openedBlocks`**：
          //    `isVisibleContent` 只排除 `block-start` / `usage` ⇒ `block-end` **算可见内容**
          //    ⇒ 收到它时 `emitted` 已置真 ⇒ 由「已吐内容不切换」拦住。
          //    这是**反向验证发现的**：故意让 `block-end` 清掉 `openedBlocks`，79 条仍全绿。
          //    ⇒ 不清理的理由是**简单**（而非「清了会错」）；若将来真的因此放行了切换，
          //      再由那时的新证据决定 —— 现在不为一个未触发的场景加复杂度。
          //
          // ⚠️ 严格的替代方案是**延迟 `block-start`**（缓冲到第一个 delta 一起发，
          //    使「已开块」等价于「已吐内容」）—— 那确实是本仓库既有做法
          //   （`buddy-adapter.ts:2068` 的 `announced: '名字可用的那一刻才发'`），
          //    但它要改动**所有**候选的产出路径（含 tool-call 的 id/name 装配时机），
          //    属于比本修复更大的改动面。留给后续任务，此处取安全的一刀切。
          if (openedBlocks.size > 0) {
            const opened = [...openedBlocks.values()]
            self.ctx.logger?.warn?.(
              `[aggregate] ${target.provider}（${target.realId}）已开启 `
              + `${JSON.stringify(opened)} 块后失败，不再切换候选`
              + `（BlockAssembler 对 block-start 按 index 幂等且不更新 blockType，`
              + `而下一个候选会开什么类型不可预知 ⇒ 切换可能把它的内容灌进错误类型的块）：`
              + `${String(error)}`,
            )
            throw error
          }
          // ⚠️ 判据必须用**筛选后**的 `attemptTargets`（2026-10-12 复核，与循环头同一处错配）：
          //    用 `targets.length` 会在尾部候选被筛掉时谎报「切换下一个候选」，
          //    而下一轮循环已结束（走到这里仍会如实抛出最后一个错误）。
          if (index + 1 < attemptTargets.length) {
            // ⚠️ 显式点名「上下文超限」（手机版补充，2026-10-11）：此前日志只有泛化的
            //    失败文案，看不出这次切换是因为**请求超出该候选的窗口**。
            //    为什么这情形会真实发生：{@link contextWindowFor} 按候选**最大值**声明
            //    窗口（切换渠道时「实际可用 ≥ 已声明」恒成立的代价），而**实际选中**的
            //    候选窗口可能更窄 ⇒ 溢出后换下一个候选正是应有的行为，需在日志里可辨认。
            //    ⚠️ **只影响日志文案，不改任何行为**：既不把失败改归成
            //    `CONTEXT_WINDOW_EXCEEDED`（那会触发 DSH 的压缩重试链，见
            //    `zero-output-guard.ts` 模块头「为什么不把这类失败归成…」），
            //    也不改变切换范围（本日志位于 `emitted` / `openedBlocks` 两道
            //    「不许切换」判据**之后**，走到这里就一定会切换）。
            const overflow = isContextOverflowFailure(error)
              ? '（上下文超限：请求超出该候选窗口）' : ''
            self.ctx.logger?.warn?.(
              `[aggregate] ${target.provider}（${target.realId}）失败${overflow}，切换下一个候选：${String(error)}`,
            )
          }
        }
      }
      throw lastError ?? new LlmError('aggregate: 所有候选都失败', 'SERVER')
    })()
  }

  /** 把请求转发给一个候选，按目标档位表翻译 `reasoningEffort`。 */
  /**
   * 记录某会话**最近一次请求**观测到的上下文规模（Issue F-04）。
   *
   * ⚠️ 语义是**覆盖**，不是取最大 —— 会话被压缩变小后观测值必须能如实下降，
   * 否则又回到「只增峰值」的老毛病（那正是 F-04 的根因）。
   * 「请求内取最大」由调用方的局部变量负责（usage 一次请求可能来多帧）。
   * ⚠️ 容量上限 512（超出淘汰最旧一条）：与会话数同阶，防无界增长。
   */
  private recordSessionContextTokens(sessionKey: string, value: number): void {
    // `delete` + `set` 保证插入序即「最近写入序」，淘汰最旧一条时才有确定语义。
    this.lastContextTokensBySession.delete(sessionKey)
    this.lastContextTokensBySession.set(sessionKey, value)
    if (this.lastContextTokensBySession.size > 512) {
      const oldest = this.lastContextTokensBySession.keys().next()
      if (!oldest.done) this.lastContextTokensBySession.delete(oldest.value)
    }
  }

  private streamThrough(target: DispatchTarget, options: GenerateOptions): AsyncIterable<StreamChunk> {
    const base = { ...options, provider: target.provider, model: target.realId }
    const requested = options.reasoningEffort
    if (requested === undefined) return this.ctx.llm.stream(base)
    const requestedEffort = String(requested)
    if (target.efforts.length === 0) {
      return this.ctx.llm.stream({ ...base, reasoningEffort: undefined })
    }
    const mapped = translateReasoningEffort(requestedEffort, target.efforts)
    if (mapped.kind === 'exact') return this.ctx.llm.stream(base)
    if (mapped.kind === 'mapped') {
      return this.ctx.llm.stream({
        ...base,
        reasoningEffort: ReasoningEffortId(mapped.effort) as GenerateOptions['reasoningEffort'],
      })
    }
    return this.ctx.llm.stream({ ...base, reasoningEffort: undefined })
  }

  /** 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('aggregate: 请通过模型选择器使用', 'INVALID_REQUEST')
  }
}

/** 一个转发目标：候选 + 该模型声明的档位 id + 它收不收得了图片。 */
interface DispatchTarget extends RankedCandidate {
  efforts: readonly string[]
  /**
   * 该候选是否声明支持图片输入。
   *
   * ⚠️ **解析失败时必须是 `false`**（保守方向）：把「不知道」当成「支持」会让带图
   * 请求被发到一个可能收不了图的渠道，而失败现象是**上游报错**（用户看不出真因）；
   * 当成「不支持」最多是**少用一个候选**（带图时换一个已声明支持的），代价小得多。
   * 与全仓「未知不编造」一致。
   */
  imageCapable: boolean
}

/**
 * 候选循环的**尝试上限**。
 *
 * ⚠️ **不得写死常量**（issue 明确记录：那个参数在 contributor 的实现里调整过 4 次
 * 才固化）。写死一个偏小的值会让**末位候选永远轮不到** —— 等于「加了渠道但没生效」。
 */
export function maxAttemptsFor(models: readonly VirtualModel[]): number {
  let longest = 1
  for (const model of models) {
    if (model.candidates.length > longest) longest = model.candidates.length
  }
  return Math.max(1, longest)
}

/**
 * 聚合模型的**档位声明** —— 规范化档位的**并集**（不是候选集交集）。
 *
 * ## 为什么是并集而不是交集（真实数据修正）
 *
 * 初版设计写的是「取候选集的能力交集」。**该口径在真实数据下是错的**：各渠道的
 * 档位命名空间彼此几乎不相交 ——
 *
 * | 渠道 | 档位 id |
 * |---|---|
 * | codearts | `on` / `off`（只有开关，注释明确「不臆造强度阶梯」） |
 * | buddy / workbuddy | `low` / `high` / `max`（**逐模型不同**） |
 * | zcode | `low` / `high` / `max` |
 * | loomy | `none` / `low` / `medium` / `high` / `xhigh` |
 * | trae | `light` / `high` / `extra_high`（**私有名**） |
 * | lobsterai | `off` / `high` / `xhigh` |
 * | raccoon | `on` / `off` |
 *
 * `deepseek-v4.1-flash` 跨 buddy + codearts + cline ⇒ **交集为空**。而空档位的后果
 * 本仓库有明确记录（`opencode-adapter.ts`：「档位为空时**不声明**本字段，声明空数组
 * 会让 UI 出现一个没有任何档位的空选择器」）⇒ 取交集会让**聚合模型的档位选择器
 * 全部消失**，与本功能目标相反。
 *
 * ⇒ 声明规范化并集，转发时由 `translateReasoningEffort` 逐候选翻译（Task 6）：
 * `exact` 原样、`mapped` 就近同族（同距取更强）、`unexpressible`/`unknown` 时
 * **不下发该字段**让上游走自己的默认。
 *
 * ## 展示名用官方中文
 *
 * DSH 客户端**直接渲染 `efforts[].name`**（不本地化、不查字典）⇒ 必须给中文。
 * 权威来源是 Qoder IDE 的 i18n 词条（`qoder-product.ts` 有逐字记录）：
 * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
 *
 * ⚠️ `unknown` 档位（`CANONICAL_REASONING_EFFORTS` 里没有的）**回退为 id 本身** ——
 * 宁可显示英文原值，也不猜一个可能错译的中文（与 `opencode-adapter` 同取向）。
 */
export function aggregateReasoningInfo(): LlmModelReasoningInfo {
  return {
    efforts: CANONICAL_REASONING_EFFORTS.map((effort) => ({
      id: ReasoningEffortId(effort),
      name: AGGREGATE_EFFORT_LABELS[effort] ?? effort,
    })),
    // ⚠️ 默认档取 `high`，**与各渠道自己的默认一致**：实测 buddy / trae / lobsterai
    // 的 `defaultReasoningEffort` 清一色是 `high`（`product.ts` 里 14 处）。取它
    // 则聚合与直连的体感一致；取 `medium` 会让用户觉得「聚合比直连想得少」，取
    // `max` 则最费 token/积分 —— 与本功能「省钱烧临期」的目标相反。
    defaultEffort: ReasoningEffortId('high'),
  }
}

/** 规范档位 → 官方中文名（来源：Qoder IDE i18n 词条，见 {@link aggregateReasoningInfo}）。 */
const AGGREGATE_EFFORT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: '最强',
})

/**
 * 该 chunk 是否含**用户可见的内容**（决定失败时能否安全切换到下一个候选）。
 *
 * ## ⚠️⚠️ 判据（**已订正**：`block-start` **不可**跨候选重放）
 *
 * 只有**真正可无条件重放**的帧才允许切换。实测 `BlockAssembler` 的语义：
 *
 * | 帧 | `BlockAssembler` 的处理 | 可否跨候选重放 |
 * |---|---|---|
 * | `usage` | `this._usage = chunk.usage` ⇒ **覆盖**，且**不建块** | ✅ 可 |
 * | `block-start` | `if (!this.partials.has(index))` ⇒ **按 index 幂等** | ❌ **不可** |
 * | `text` / `reasoning` / `image` / `tool-call` / `tool-result` | 累积进正文 | ❌ 不可 |
 * | `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` | 累积进正文 | ❌ 不可 |
 * | `finish` | 终止帧（本函数在此之前已单独处理） | — |
 *
 * ## ⚠️ 为什么 `block-start` **不可**重放（真实缺陷，对抗审计用真实 `BlockAssembler` 证伪）
 *
 * 旧注释断言「`block-start` 幂等 ⇒ 可安全重放」—— **那是错的**：
 * 幂等判据**只看 `index`**，**不更新 `blockType`**：
 *
 * ```js
 * case 'block-start': {
 *   if (!this.partials.has(chunk.index)) {   // ← 已存在 ⇒ 直接 return
 *     this.order.push(chunk.index)
 *     this.partials.set(chunk.index, { blockType: chunk.blockType, … })
 *   }
 *   return
 * }
 * ```
 *
 * ⇒ 候选 A 开了 `block-start(0, 'tool-call')` 后失败、候选 B 重发
 * `block-start(0, 'text')` 时，**B 的 `blockType` 被忽略**、**B 的正文被灌进
 * A 的 tool-call 块**。探针（真实 `BlockAssembler`）逐字输出：
 * ```
 * blocks   = [{"type":"tool-call","id":"call-0","name":"","arguments":""}]
 * partials = [[0,{"blockType":"tool-call","text":"B 的正文",…}]]
 * finish   = {"kind":"stop"}
 * ```
 * ⇒ 下游只看到一个**空的 tool-call**、**用户可见答案丢失**，且 `finish=stop`
 * 看起来是干净结束（**无任何报错**）。
 *
 * ## ⇒ 判据
 *
 * **只有 `usage` 不算可见内容**（覆盖语义 + 不建块）；其余一律算。
 *
 * ⚠️ **未知类型一律算可见内容**（返回 `true`）：保守方向是「宁可少切换，
 * 不可拼接畸形回答」—— 拼接两段回答比报错严重得多（前者看起来像一句正常但
 * 奇怪的话，用户会当成模型的问题）。
 */
function isVisibleContent(chunk: StreamChunk): boolean {
  // ⚠️ `block-start` / `usage` 都**不算**可见内容 —— 但**能否切换还要看"有没有开过块"**
  //    （见 `dispatch` 里的 `openedBlocks` 判定）：`block-start` 对 `index`
  //    幂等且**不更新 `blockType`**，故**同类型**重放安全、**异类型**会丢答案。
  return chunk.type !== 'block-start' && chunk.type !== 'usage'
}

/**
 * 把一个 LLM 失败描述成一句可读文案（供日志与抛错消息用）。
 *
 * ⚠️ `failure` 的 `message` / `code` 都是**上游或适配器给的**，可能为空串 ——
 * 空串会让文案变成「上游失败」而后跟一片空白，排查时毫无线索。故缺失时回落到
 * 各自的占位说明，而不是拼出 `：` 结尾的悬空句。
 *
 * ⚠️ **`status` 只打「会被 `LlmError` 接受」的值**（真实缺陷，对抗审计实测指出）：
 * 旧实现写 `typeof failure.status === 'number'` ⇒ `NaN` / `200.5` / `700` 这些
 * **越界值会被打进文案**，而它们在构造 `LlmError` 时被**丢弃**（见下方逐字段试探）
 * ⇒ **日志说了一个实际没生效的值**（排查时按 `status=700` 去查上游会白费功夫）。
 * 判据与 `LlmError` 逐字一致（`100 ≤ n ≤ 599` 的整数）。
 */
function describeFailure(failure: { message?: string; code?: string; status?: number }): string {
  const parts: string[] = []
  if (typeof failure.message === 'string' && failure.message.length > 0) parts.push(failure.message)
  if (typeof failure.code === 'string' && failure.code.length > 0) parts.push(`code=${failure.code}`)
  if (typeof failure.status === 'number' && Number.isInteger(failure.status)
    && failure.status >= 100 && failure.status <= 599) {
    parts.push(`status=${failure.status}`)
  } else if (typeof failure.status === 'number') {
    // ⚠️ 越界值**如实标注为「已丢弃」**（而不是默默丢掉、也不是伪装成有效值）——
    //    这样日志既不说谎，也不隐藏「上游给了一个奇怪的状态码」这个排查线索。
    parts.push(`status=${String(failure.status)}（越界，已丢弃）`)
  }
  return parts.length === 0 ? '（上游未给出原因）' : `：${parts.join(' ')}`
}

/**
 * 判一个候选失败是不是「请求超出该候选的上下文窗口」——**仅供日志点名**。
 *
 * ## 为什么需要一个判定（问题形态）
 *
 * 聚合把虚拟模型的窗口按候选**最大值**声明（见 {@link contextWindowFor}），而实际
 * 选中的候选窗口可能更窄 ⇒ 上游会以「上下文超限」拒绝 ⇒ 聚合换下一个候选重试。
 * 这条链路此前在日志里与普通失败**完全同形**，看不出是「窗口不够」还是真故障。
 *
 * ## 为什么用两条判据（而不是只看错误码）
 *
 * 两者都来自宿主同一个模块，**没有本地重新实现措辞匹配**（本仓库红线：同一语义
 * 不得两套判据）：
 * 1. `code === CONTEXT_WINDOW_EXCEEDED_CODE` —— 机器可路由的**规范码**
 *    （`@deepseek-ai/dsh-llm` 的成文要求：「route on this, never by parsing message」）。
 *    已验证 `dsh-llm-pi-ai` / `dsh-llm-deepseek` 真的会下发它（前者含「usage 超出
 *    已解析目录容量」这条用量侧判据）。
 * 2. 否则退回**共享**判据 `isContextOverflowBody(code + message)` ——
 *    **有些渠道**仍沿用通用码（如 `SERVER` / `INVALID_REQUEST`）只把原因写在文案里，
 *    只认规范码会让这些渠道的溢出在日志里继续隐身。
 *    ⚠️ 2026-10-11（9.16 补）：这里原先只喂宿主 `isContextWindowExceededError`，
 *    于是**网关措辞**（`prompt is too long: N tokens > M maximum`，宿主分类器认不出）
 *    在本兜底网**漏判**。改用共享判据后，与另外三条通道（HTTP 400 / 流内帧 / zcode）
 *    **同一语义、同一判据**。
 *
 * ⚠️ 第 2 条只在第 1 条不成立时执行，且**只用于日志**；将来若上游把所有渠道都归了
 *    规范码，可安全删掉第 2 条（行为不变，只少一层兜底）。
 */
function isContextOverflowFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return true
  const detail = [typeof code === 'string' ? code : '', typeof message === 'string' ? message : '']
    .filter((part) => part.length > 0).join(' ')
  return detail.length > 0 && isContextOverflowBody(detail)
}

/**
 * 定这次上游失败最终该报什么码（手机版补充，2026-10-11）。
 *
 * ## 为什么要在**聚合层**再判一次
 *
 * DSH 的「撞窗口 → 剪工具结果 + 压缩 → 重试」链**只认** `CONTEXT_WINDOW_EXCEEDED`
 * （`dsh-compaction-basic/lib/index.js` 的 `agent/request-error` listener 第一行即本判据）。
 * 而聚合的候选横跨十几个适配器，其中多数把上游的「输入超限」按**通用码**抛出
 * ——HTTP 400 更是被共享层一律映射成 `INVALID_REQUEST`（`openai-compat.ts` 的
 * `httpErrorCode`）⇒ 用户只看到裸错误，且**长会话越过窗口后每轮报废**。
 * 在聚合层补这一次判断，等于让**所有走 aggregate / auto 的模型**同时获得恢复能力，
 * 不必逐个改十三个适配器（各适配器内的同类修正见 `buddy-adapter.ts` /
 * `llm-adapter.ts` / `gemini-adapter.ts` 的 `httpErrorCode`）。
 *
 * ## 只对「泛化码」再判（不覆盖已归好的语义）
 *
 * `AUTH` / `QUOTA_EXCEEDED` / `RATE_LIMIT` / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` 等
 * 都是**已经归好类**的失败，覆盖它们只会丢掉更具体的诊断信息。真正「没归类」的载体
 * 只有两个：`SERVER`（兜底）与 `INVALID_REQUEST`（HTTP 400 的兜底）。
 *
 * ⚠️ 判据复用 {@link isContextOverflowFailure}（宿主规范码 + 宿主措辞分类器），
 * **本文件里没有第二套措辞匹配**（本仓库红线：同一语义不得两套判据）。
 */
function resolveUpstreamCode(upstreamCode: unknown, message: string): string {
  const code = typeof upstreamCode === 'string' && upstreamCode.length > 0 ? upstreamCode : 'SERVER'
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return code
  if (code !== 'SERVER' && code !== 'INVALID_REQUEST') return code
  return isContextOverflowFailure({ code, message }) ? CONTEXT_WINDOW_EXCEEDED_CODE : code
}

/**
 * 造一个「调用方中止」类错误。
 *
 * ⚠️ **必须同时带 `name` 与 `code` 两个判据**（对抗审计实测订正）：
 *
 * 我们抛出的错误会被**外层** DSH 的 `adapterStream` 捕获，再经
 * `adapterFailureChunk(error, signal)` 归类，其判据是：
 *
 * ```js
 * signal?.aborted || failure.code === 'ABORTED' ? { kind: 'aborted' } : { kind: 'error' }
 * ```
 *
 * ⇒ 若只设 `name`（初版就是如此），当 **signal 未被标记**时（上游适配器自行判定
 * 取消、抛了 `code='ABORTED'` 的错误 → 归一化成 `finish/aborted` 帧 → 我们重抛），
 * 外层会把它归成 **`kind: 'error'`** ⇒ 消费者看到「错误」而不是「已中止」，
 * 与「中止是调用方意愿」的语义相反。
 *
 * ⇒ 两个判据都设上：`name` 供本文件与 `aggregate-expiry.ts` 的 `isAbortLike` 识别，
 * `code` 供外层 `adapterFailureChunk` 识别。
 */
function abortError(): Error {
  const error = new Error('aggregate: 请求已中止')
  error.name = 'AbortError'
  ;(error as unknown as { code: string }).code = 'ABORTED'
  return error
}

/**
 * 该错误是否是「调用方中止」类，而不是「这个候选坏了」类。
 *
 * ⚠️ 两者**必须分开**：中止时换候选会让用户在取消后仍继续跑（且最终抛出的
 * 可能是个误导性的上游错误）。判据取四条：
 * - `signal.aborted` —— 最权威（调用方确实取消了）；
 * - `name === 'AbortError'` —— `throwIfAborted` / `timers/promises` 的形态；
 * - `code === 'ABORTED'` —— 某些适配器上报失败时的机器码；
 * - 🔴 `message` 含 `aborted request` / `HTTP_499` / `HTTP 499` —— **上游网关的
 *   499 口径**（nginx「client closed request」＝ 连接在响应完成前被断开）。
 *   实测（2026-10-11，上游会话两次 + 工单 `raccoon-499/01` 取证）：raccoon 网关把
 *   这类断开报成 `provider: client has aborted request HTTP_499` 的 **error 帧**，
 *   三条旧判据全不命中 ⇒ 被归成「本轮运行失败」⇒ 消费者看到误导性的 provider
 *   故障，而真相是「请求没跑完，重发即可」。归 aborted 的语义收益：终端不再
 *   显示「运行失败」，且外层不把它当「候选坏了」去改道（重发是新请求，不是换候选）。
 */
function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name === 'AbortError' || candidate.code === 'ABORTED') return true
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return /aborted request|HTTP_?499/i.test(message)
}

/** 在 `ctx.llm` 上注册聚合路由（幂等）。 */
export function registerAggregateLlm(
  ctx: Context,
  options: AggregateAdapterOptions,
): AggregateAdapter {
  const adapter = new AggregateAdapter(ctx, options)
  registerAdapterIdempotent(
    ctx.llm,
    [AGGREGATE_PROVIDER],
    adapter,
    message => ctx.logger?.warn?.(message),
    // ⚠️ **聚合必须完全不参与「失效模型」机制**（`enabled: false`：不记录、**也不过滤**）
    // —— 真实缺陷（全分支终审 C2 + 审计轮次二补修的残留面）。
    // 本机制是为「**编译期兜底快照**跟不上上游下架」设计的，而聚合层的目录是
    // **动态推导**的（上游下架后下次推导自然消失）⇒ 既不需要记录，也不该被过滤。
    // ① 记录的危害：观察到的是 `aggregate` + **虚拟键**（实测），于是「某一个渠道
    //    没有该 realId」被记成「**整个规范模型**失效」，而它在其余渠道上完全可用；
    //    且恢复入口 `model.clearDead` 的 UI 在设置页 provider 面板里，而客户端
    //    `PROVIDERS` **没有 `aggregate`** ⇒ **没有任何 UI 能恢复**。
    // ② 过滤的危害（补修的那半）：初版只跳过记录、仍保留过滤 ⇒ 若表里**已有**
    //    旧版本写下的 `aggregate` 记录（C2 修复前跑过一次就会有），虚拟模型**仍被
    //    隐藏**且同样无 UI 可恢复。实测探针：预置 `aggregate/m1` 后经真实装配的
    //    `listModels` 只返回 `['auto','m2']`（`m1` 被隐藏）。
    { enabled: false },
  )
  // ⚠️ **注册后主动预热一次目录**（fire-and-forget，不阻塞注册）。
  //
  // 为什么必须预热：`listAllModels()` 被契约要求是**同步**方法，只能读上一次
  // 推导结果；而 `provider.status`（`jet-hub-rpc.ts:3883`）会在**冷缓存**下直接
  // 调它并据条数算 `models.total`，判据是
  // `closed = total > 0 && disabled === total`（同文件 `:3884-3903`）。
  // 冷缓存时 `total` 只有 1（`auto`）⇒ 用户一关掉 `auto`，`disabled === total`
  // 即成立 ⇒ `aggregate` 被**误显示为「已关闭」**（掉进设置页的「已关闭」分组）。
  // 预热后 `this.catalog` 在**有已登录渠道时**非空（`refreshCatalog` 只在被调用时
  // 重推、从不主动清空）⇒ `total` 反映真实条目数，该误判不再发生。
  // ⚠️ 全部渠道都未登录时目录**本就**为空（各家 `listModels` 受门控返回 `[]`），
  // `total` 仍为 1 —— 那种状态下聚合确实无模型可选，`closed` 的判定与事实相符。
  //
  // 成本可控：各家的 `listModels` 内部都有 `providerCatalogVisible` 门控
  //（`buddy-adapter.ts:1303` 等，门控在 `ensureRemoteModels()` **之前**）——
  // 未登录的渠道直接返回空目录、不发网络请求；已登录渠道本就会被模型选择器
  // 触发同一批请求，预热只是提前一次，随后 60 秒内走 `AGGREGATE_CATALOG_TTL_MS`。
  //
  // ⚠️ 必须 `.catch()` 兜住：这是 fire-and-forget，未捕获的 rejection 会变成
  // unhandled rejection（注册失败只是目录晚一点就绪，绝不能反噬注册）。
  void adapter.refreshCatalog().catch((error: unknown) => {
    ctx.logger?.warn?.(`[aggregate] 注册后预热目录失败（不影响可用性）：${String(error)}`)
  })
  return adapter
}
