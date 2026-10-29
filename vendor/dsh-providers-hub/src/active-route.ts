/**
 * 「本次实际发往的真实目标」进程内读数 —— 供客户端实时显示**当前真正在用的模型**。
 *
 * ## 它解决什么
 *
 * 路由型 provider（`aggregate` 的 `auto` / 规范模型、`jet-hub-auto` 的 `auto`）在模型
 * 选择器里只显示一个**虚拟**名字，用户看不到「这一次到底发给了哪个渠道、哪个模型」。
 * 本表在**每次转发开始时**记下真实目标，客户端据此渲染一行实时读数。
 *
 * ## ⚠️⚠️ 与 `activeProviderByModel` 的语义差别（**不要合并**）
 *
 * | 表 | 写入时机 | 用途 |
 * |---|---|---|
 * | `activeProviderByModel`（聚合适配器内私有） | **只在整轮跑完**（成功） | 用量徽标显示「该看哪个渠道的余额」 |
 * | 本表 | **转发一开始** | 显示「现在正在用什么」 |
 *
 * 前者必须成功才写：显示一个刚刚失败、已无额度的渠道会让徽标读数指向错的账号
 *（规格 §6.3 P3 的「只在成功时写」，那里有完整事故记录）。
 * 后者必须在**开始**就写：它回答的是「此刻在用什么」，等整轮跑完才更新就失去了
 * 「实时」的意义（长回答可能要几十秒，用户在整个过程中都看不到）。
 *
 * ⇒ 两者判据不同、**不可互相推导**，刻意分开存放。
 *
 * ## ⚠️ 纯内存、进程内
 *
 * 插件重启即清空 ⇒ 客户端「无历史 ⇒ 不渲染」。**不落盘**：这是展示用的瞬时状态，
 * 写盘只会带来无谓的 IO 与陈旧值（重启后显示一个早已不用的模型，反而误导）。
 */
export interface ActiveRoute {
  /** 真实渠道 id（实际发往的 provider）。 */
  provider: string
  /** 该渠道下的真实 modelId（转发时用的那个，**不是**虚拟键）。 */
  model: string
  /** 记录时刻（毫秒时间戳），供客户端判断新鲜度。 */
  at: number
}

/** 路由 provider → 最近一次实际发往的真实目标。 */
export class ActiveRouteRegistry {
  private readonly byRouter = new Map<string, ActiveRoute>()

  /**
   * 记录一次「刚发出的转发」。
   *
   * ⚠️ 覆盖写同一路由键的旧值 —— 「当前在用」天然只关心最后一次，
   * 不需要保留历史（要历史应去会话记录里查，不在这里堆）。
   *
   * @param routerProvider 路由 provider id（`aggregate` / `jet-hub-auto`）。
   * @param provider 真实渠道 id。
   * @param model 真实 modelId。
   * @param at 记录时刻（测试可注入，生产不传）。
   */
  record(routerProvider: string, provider: string, model: string, at = Date.now()): void {
    this.byRouter.set(routerProvider, { provider, model, at })
  }

  /** 读最近一次真实目标；无历史时 `null`（调用方据此**不渲染**）。 */
  read(routerProvider: string): ActiveRoute | null {
    return this.byRouter.get(routerProvider) ?? null
  }

  /** 清空（测试用）。 */
  clear(): void {
    this.byRouter.clear()
  }
}

/**
 * 进程内共享实例。
 *
 * ## ⚠️ 为什么用模块级单例，而不是装配层注入
 *
 * 三处要访问它：聚合适配器、自动适配器、RPC 层。而：
 * ① `registerJetHubRpc` 是**位置传参**且历史上已因少传/插队**错位 6 次**的敏感接口
 *   （见那里的形参注释），为一个展示用读数再加一个形参不划算；
 * ② `jet-hub-auto` 的适配器是在 `registerJetHubRpc` **之后**才创建的
 *   （`registerAutoLlm` 排在 RPC 注册后面），装配层注入反而要动注册顺序 ——
 *   而那个顺序本身有「聚合必须早于 modelAdapters」的既有约束。
 *
 * 本表是**纯展示用瞬时状态**（无凭据、无副作用），做成单例不会造成隐藏耦合。
 */
export const activeRoutes = new ActiveRouteRegistry()
