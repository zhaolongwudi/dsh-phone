/** 路由 provider → 最近一次实际发往的真实目标。 */
export class ActiveRouteRegistry {
    byRouter = new Map();
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
    record(routerProvider, provider, model, at = Date.now()) {
        this.byRouter.set(routerProvider, { provider, model, at });
    }
    /** 读最近一次真实目标；无历史时 `null`（调用方据此**不渲染**）。 */
    read(routerProvider) {
        return this.byRouter.get(routerProvider) ?? null;
    }
    /** 清空（测试用）。 */
    clear() {
        this.byRouter.clear();
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
export const activeRoutes = new ActiveRouteRegistry();
//# sourceMappingURL=active-route.js.map