/**
 * Jet Hub 管理页面客户端插件。
 *
 * 注册两处：
 * 1. `settings.section` —— Jet Hub 设置页面；
 * 2. `conversation.input.right`（list 槽，会话作用域）—— 模型选择器旁的
 *    **用量徽标**（订阅优先 / 积分兜底，点击展开明细）。
 *
 * ## ⚠⚠️ 刻意**不**注册 `settings.models.provider-card`（Gitee issue IKJLHQ）
 *
 * 那个 keyed 槽的 `key` 语义**不是**自由命名空间，而是「这张卡片的
 * `settingsNs`」：官方渲染时按 `entryKey = row.entry.settingsNs` 精确查表
 * （`dsh-client-ui-settings-models/lib/client.js`）：
 *
 * ```js
 * renderSlot('settings.models.provider-card', { provider: row.entry, ... }, { entryKey: row.entry.settingsNs })
 * // 渲染侧：entriesOfSlot(slot).find(e => e.options.key === entryKey) —— 每 key 只渲染一个 winner
 * ```
 *
 * 后果是**同一个 `settingsNs` 上的第三方扩展互斥**：
 * - `SlotCore.register` 对「同 key + 同 priority」的第二个注册者**直接抛错**
 *   （`keyed slot "…" already has an entry for key "…"`）；
 * - `entriesOfSlot` 按 **ledger（注册）顺序**取每个 cell 的首个 live 条目，
 *   **`priority` 不参与排序** —— 换 priority 只能免掉那次抛错，仍然只有一个 winner；
 * - 谁 bundle 先到谁赢，后到的那方要么抛错（未捕获时 `slots.inject` 会 `stop()`
 *   并 `queueMicrotask(throw)`）、要么被 try/catch 静默吞掉而**无声消失**。
 *
 * 本插件曾以 `key: 'llm-pi-ai'` 注册 ZCode 卡片，于是与同样扩展 pi-ai 家族的
 * `@linxin666/dsh-client-ui-model-capabilities`（它的 `PI_AI_SETTINGS_NAMESPACE`
 * 注释就写着「the card slot's key」）**互斥**：两插件共存时，谁先到谁渲染，
 * 另一方的模型能力编辑面板**静默消失**（用户报障 IKJLHQ）。
 *
 * ⚠️ **换独立 key（`llm-pi-ai-zcode` 之类）并不能共存，只会让 ZCode 卡片自己消失** ——
 * 官方是按 `entryKey` 精确 `find`，换个 key 直接落空。而 zcode 本来就没有自己的
 * 适配器家族：`dsh-llm-pi-ai` 把**所有** route 目录行的 `settingsNs` 统一设成
 * `llm-pi-ai`，用户手工加的 `zcode` route 也一样。
 *
 * ⇒ 结论：ZCode 账号管理**只在 Jet Hub 设置页**（本页功能完整）。别为了「就近操作」
 * 把这个槽抢回来 —— 那等于让所有装了第三方 pi-ai 扩展的用户失去他们的面板。
 */

export const name = 'jet-hub-client'
/**
 * ⚠️ `modelDirectories` 是徽标**唯一**的信息来源（当前选中的渠道）。
 *
 * 它由 `@deepseek-ai/dsh-client-ui-model-selection` 提供，故 `package.json` 的
 * `dsh.client.inject` 必须声明该包 —— 声明的作用是让那个包的 bundle **先于**
 * 本插件的 bundle 到达（见 `dsh-client-modules` 的 `arriveGraphRow`）。
 * 未声明时本插件可能先被物化，`inject` 便会一直等服务，徽标不出现（不影响
 * 设置页与其余功能）。
 *
 * ## ⚠️ `remote.session`（2026-10-02 真机事故 → 2026-10-03 rc.8 适配）
 *
 * 曾按 0.1.2-rc.1 的 `dsh-client-ui-model-selection` 对齐声明了
 * `sessions` / `remote` / `remote.session`：旧版该包的 `directoryFor` 会读
 * `this.ctx.remote.session`，不声明就在 desktop 上静默失败。
 *
 * rc.8 已**删除** `remote.session` 服务（model-selection 包里已无任何引用），
 * 本插件多声明会让 cordis 逐插件校验永远等不到服务，整个 bundle 卡在
 * `pending (waiting for service: remote.session)`，Web UI 报
 * 「Failed to load plugins」。⇒ rc.8 起只声明 `sessions`，若将来降级回
 * 0.1.2-rc.1 时代的宿主，再把这三个名字加回来。
 */
export const inject = ['slots', 'connection', 'modelDirectories', 'sessions']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
import { JET_HUB_RPC_CHANNEL, JetHubPage, providerLabel } from './jet-hub.js'
import { startCarrierContribution } from './zcode-carrier.js'
import { UsageBadge } from './usage-badge.js'
import { ActiveModelPill } from './active-model-pill.js'
import { createChatGptCall } from './chatgpt-plan-rpc.js'

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }
  const chatGptCall = createChatGptCall(ctx.connection)

  /**
   * zcode 内部 captcha 载体的贡献循环（二期 Task 4）。
   *
   * ⚠ **web 版零动作**：`plugin-src/client/zcode-carrier.js` 第一件事就是判
   * `globalThis.dshDesktop`（协议版本 1 才有 `browser` 租约桥）—— 拿不到就整体 return，
   * 不查 demand、不建 `<webview>`、连日志都不打。所以这条 effect 在 web 版里是个空壳，
   * 「桌面版才有内部载体」这条不变式靠它自己守住，改判据前请先看那个文件的规则 1。
   *
   * 返回值是**停止函数**，交给 `ctx.effect` 的清理路径：插件卸载/热替换时必须停掉心跳
   * 并归还 webview 租约，否则留下一个没人收的离屏 guest（`release` 没调 ⇒ 主进程侧泄漏）。
   */
  ctx.effect(() => startCarrierContribution({ rpcCall }), 'jet-hub: zcode 内部载体贡献循环')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jet-hub',
    order: 50,
    label: () => 'Jet Hub',
    inject: () => ({ rpcCall, chatGptCall }),
  }, JetHubPage))

  /**
   * 模型选择器旁的**用量徽标**（`conversation.input.right`）。
   *
   * ## 槽位契约
   *
   * 该槽是 **list + 会话作用域**（`dsh-client-ui-conversation` 声明），渲染位置
   * 是 composer 的 `standardControls` 里、`conversation.input.model` **之前**，
   * 故徽标天然落在模型选择器左侧。
   * `inject` 回调收到 `sessionId`，用它取**该会话**的模型目录。
   *
   * ## ⚠️ 为什么是 `inject`（惰性）而不是在 `apply` 里直接注册
   *
   * `ctx.modelDirectories.directoryFor(sessionId)` 需要会话 id，而它只在槽位
   * 渲染时才知道；`inject` 回调正是"每个会话渲染时求值一次"的钩子。
   * 目录按会话惰性解析、随会话 dispose，故这里**不缓存** directory 对象。
   *
   * ## ⚠️ 只在选中本插件渠道时才可能渲染
   *
   * 组件内部第一件事就是判 `supportsCreditBalance(provider)`（能力表，12 个
   * 渠道），非本插件渠道直接 `return null` —— 既不渲染也不发请求。门控放在
   * 组件里而不是这里：这里拿不到"当前选中的 provider"（它在目录快照里，
   * 会随时间变化，必须由组件订阅）。
   */
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'jet-hub-usage',
    order: 100,
    inject: (sessionId) => ({
      // ⚠️⚠️ **必须惰性取目录，不能在 inject 里取**（真机事故 2026-10-02）。
      //
      // 原写法 `directory: ctx.modelDirectories.directoryFor(sessionId).store`
      // 有两个问题：
      // 1. `directoryFor` 是**惰性 getter** —— 写 `directoryFor(sessionId).store`
      //    里的 `.store` 才触发求值，而求值发生在**槽位 inject 期**（即会话
      //    输入区渲染的同步路径上）。桌面版此时它内部要访问未注入的
      //    `remote.session`，直接抛 `cannot get property "remote.session"
      //    without inject`（Web 版不走那条分支，故只在 desktop 复现）。
      // 2. 该异常发生在渲染关键路径上，**会让整个会话输入区渲染中断** ——
      //    表现为模型选择器点不动（用户报障），远不止「徽标不显示」。
      //
      // ⇒ 改为交出一个**取值函数** `resolveDirectory()`，由组件在自己的
      // effect 里调用：失败被组件自身的 try/catch 兜住，影响面收敛到
      // 「徽标不显示」，绝不影响模型选择器。
      //
      // ⚠️⚠️ **必须同时交出 `store` 与 `load`（真机事故 2026-10-02 的真正根因）
      //
      // 读 `dsh-client-ui-model-selection` 的 `ModelDirectory` 源码得到两个事实：
      //   ① 它的**公开方法是 `load()` / `syncInputs()`，没有 `getSnapshot()` /
      //      `subscribe()`** —— 那两个在 `this.store` 上。我第一版只交出实例，
      //      组件调 `directory.getSnapshot()` 得到 `undefined` → TypeError →
      //      被 safe() 吞掉 → `provider` 恒为空 → **徽标永不显示**。
      //   ② `store` 的初值是 `{ current: null, status: 'idle' }`，**只有
      //      `await load()` 之后** `syncInputs()` 才把真实 `current` 填进去。
      //      徽标自己不发模型目录请求（`usage.badge` 按 provider 查），
      //      所以必须由它调 `load()`，否则 `current` 永远是 null。
      //
      // 两者缺一不可：只给 store 不 load → current 为 null；
      // 只给实例不 load 也不 store → getSnapshot 不存在。
      resolveDirectory: () => {
        const directory = ctx.modelDirectories.directoryFor(sessionId);
        return {
          store: directory.store,
          load: () => directory.load(),
        };
      },
      providerLabel,
      readBadge: (provider, options) => rpcCall('usage.badge', { provider, ...options }),
      /**
       * 聚合 provider「上次**实际**转发成功的渠道」（P3）。
       *
       * ⚠️ 宿主侧该端点是**纯内存读**（零网络零余额查询）—— 徽标在**门控阶段**
       * 就要用它把 `aggregate` 重定向成真实渠道，而门控是同步渲染路径。
       * ⚠️ 返回 `{ provider: null }` 表示无历史 ⇒ 徽标**不渲染**。
       */
      readActiveProvider: (canonicalId) =>
        rpcCall('aggregate.activeProvider', canonicalId === undefined ? {} : { canonicalId }),
      // ⚠️ **这里曾有一个 `readExpiryOrder` prop，已删除**（真实死代码，审计实测指出）：
      //    它在 `c12b3ab` 上就已**零消费者** —— `AggregatePanel` 自己直接
      //    `rpcCall('aggregate.expiryOrder', {})`（`jet-hub.js`），从不经过本 prop。
      //    本仓库把死代码视为缺陷（会让人以为「面板是通过 prop 取数的」而找错地方）。
      //    ⚠️ 端点本身仍在（`aggregate.expiryOrder`）—— 删的只是这个没人用的转发 prop。
      writePreference: (preference) => rpcCall('usage.badgePreference', { preference }),
      // 自动签到开关（全局一个，不分渠道）：宿主在「打开」时会立刻跑一轮。
      setAutoCheckin: (enabled) => rpcCall('usage.autoCheckin', { enabled }),
      // 关闭那行**常驻**的自动签到状态文字（只关当前这一轮，下一轮会重新出现）。
      dismissAutoCheckin: () => rpcCall('usage.autoCheckin', { dismiss: true }),
      // 一键领取：每日签到 + （buddy / workbuddy 的）成长中心任务。
      //
      // ⚠️ runTasks 缺省**必须为 false** —— 同一个方法也是「每日首次启动自动签到」
      // 的执行体（宿主 auto-checkin 的 claim 回调）。成长一轮单账号 90～270s、
      // 全串行，默认开启等于每次开机自动打几十个上游请求。
      // budgetMs 缺省由宿主取 10 分钟；传 0 或负数表示不限时。
      claimCredits: (provider, runTasks, budgetMs) =>
        rpcCall('credits.claimAll', { provider, runTasks, budgetMs }),
    }),
  }, UsageBadge))

  /**
   * 输入区**最下方**的「在用模型」实时读数（`conversation.composer.dock`）。
   *
   * ## 它补齐了什么（2026-10-10）
   *
   * 宿主侧早已记录「实际发往的真实渠道 + 真实模型」（`aggregate.activeProvider`
   * 的 `model` 字段 / 本端点的 `router.activeRoute`），聚合徽标也已经把模型后缀
   * 拼进了胶囊 —— 但那些都在**模型选择器旁**，且 `jet-hub-auto` 完全没有读数。
   * 本组件在输入区最下方补一枚独立读数，覆盖两家路由 provider。
   *
   * ## 槽位选择
   *
   * 该槽是 **list + 会话作用域**，官方在该处按 order 注入两枚统计胶囊
   * （`activity` = 轮/步 · tok/s，order 0；`usage` = token 总量 · 缓存命中，order 1）。
   * 本插件用 order 2 **追加**在它们之后 ⇒ 三枚胶囊同处一行，无需覆盖上游
   * `dsh-client-ui-chat`（那是本仓库刻意避免的做法：覆盖上游包会把对方的
   * 后续修复一起冻住）。
   *
   * ## ⚠️ 为什么必须惰性取目录 + 同时交出 store 与 load
   *
   * 与上面的用量徽标同因（真机事故 2026-10-02）：`directoryFor(sessionId)` 在
   * 槽位 inject 期求值会让桌面版抛 `cannot get property "remote.session"
   * without inject`，而该异常发生在会话输入区的同步渲染路径上 ⇒ 模型选择器整个
   * 点不动。故只交出**取值函数**，由组件在自己的 effect 里调用。
   * 且 store 初值为 `{ current: null, status: 'idle' }`，组件必须自己调 `load()`
   * 才能拿到真实 `current` —— 两者缺一不可。
   */
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'jet-hub-active-model',
    // ⚠️ 2 = 排在官方 activity(0) / usage(1) 之后（= 最下方一行）。
    order: 2,
    inject: (sessionId) => ({
      resolveDirectory: () => {
        const directory = ctx.modelDirectories.directoryFor(sessionId);
        return {
          store: directory.store,
          load: () => directory.load(),
        };
      },
      providerLabel,
      /**
       * 取「本次实际发往的真实目标」。
       *
       * ⚠️ 宿主端点是**纯内存读**（零网络零余额查询），组件按 5 秒轮询它 ——
       * 见 `active-model-pill.js` 的 ACTIVE_ROUTE_POLL_MS 注释。
       *
       * ## ⚠️⚠️ 为什么要有 `aggregate.activeProvider` 这条回落
       *
       * `router.activeRoute` 是**新端点**，而宿主代码**只在 DSH 启动时载入**
       * （不热重载）。于是存在一个真实的中间态：**客户端 bundle 已更新、宿主还是旧的**
       * —— 浏览器侧由 `dsh-client-hmr` 每 500ms 轮询 bundle 并自动 reload，而宿主侧
       * 必须重启。旧宿主虽然没有新端点，但**已经有** `aggregate.activeProvider`
       * （它自 c066b8ea 起就返回 `{ provider, model }`，模型后缀那批改动就靠它）。
       * ⇒ 聚合这条路径完全可以先借用旧端点拿到真实读数，**不必等重启**。
       *
       * `jet-hub-auto` 没有对应的旧端点 ⇒ 它只能等重启，此时组件显示占位文案
       * （不是不渲染）。
       *
       * ⚠️ 回落**只在**新端点抛错时走（`unknown method` / 未注册）；新端点一旦可用
       * 就以它为准，避免两个数据源的判据分叉（新端点按**发起**时刻写，旧端点按
       * **成功**时刻写，两者在请求进行中必然不同，见 `active-route.ts` 的对照表）。
       */
      readActiveRoute: async (provider) => {
        try {
          return await rpcCall('router.activeRoute', { provider });
        } catch (error) {
          // 只有「端点不存在」才回落；其它错误（如未注册适配器）原样交给组件降级。
          if (provider !== 'aggregate') throw error;
          const fallback = await rpcCall('aggregate.activeProvider', {});
          return fallback === null || typeof fallback !== 'object'
            ? null
            : { provider: fallback.provider ?? null, model: fallback.model ?? null, at: null };
        }
      },
    }),
  }, ActiveModelPill))
}
