/**
 * 各 provider 的**积分能力实现表** —— `ProviderRuntime.credits` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`credits.balances` 是一个 **441 行**的 `case`，里面 11 段
 * `if (req.provider === X.id)` 各自重复同一套编排（逐账号 resolve 凭据 →
 * 调用本家的余额原语 → 拼 `{accountId, nickname, balance, error}`）。
 * 那些分支里**没有一行是协议逻辑** —— 协议早已封装在各家 `fetch*Balance` 内，
 * RPC 层看到的只是「选哪个函数」（设计文档 §3.5 的边界）。
 *
 * 本文件把「选哪个函数」抽成数据；编排仍留在既有的共享骨架
 *（`collectCreditBalances` / `collectCreditsStatus`）里，**一行不重写**。
 *
 * ## ⚠️ 哪些渠道**不在这里**（形态与骨架根本不匹配，刻意保留特例）
 *
 * | 渠道 | 为什么不进表 |
 * |---|---|
 * | `opencode` | 它的「余额」是**本地派生的通道可用性**（读账号池的 `modelRateLimits`），**零网络请求**。套进 `fetchBalance(credential, …)` 形状会逼它去发一个不存在的上游请求。 |
 * | `qoder` / `qodercn` | `fetchQoderCreditBalance` 只吃 `QoderCredential`、且 product 来自同族注册表；旧实现因此**没有**走 `collectCreditBalances` 的 `(credential, product)` 泛型。 |
 *
 * 这两段留在 `jet-hub-rpc.ts` 的 `credits.balances` 里、**先于查表短路**，
 * 并有各自的行为用例锁死（见 `credits-runtime-parity.spec.ts` 的
 * 「特例的优先级」）。强行套骨架会丢语义 —— 那是本仓库反复记录的缺陷形态。
 *
 * ## ⚠️ 为什么有些渠道用 `fetchBalanceDetailed` 而不是 `fetchBalance`
 *
 * `fetchBalance` 的 `null` 由共享骨架统一翻译成「余额查询失败」。但有几家的
 * 失败原因**必须区分**（用户会按原因决定去重新登录、还是去充值、还是什么
 * 都不用做）：
 *
 * - `codearts`：三态 —— 「Token 计费账户」/「非积分计费账户」/「未返回积分数据」；
 * - `gemini`：「尚未授权 Google 账号」与「查询失败」是两回事；
 * - `zcode`：「企业版不下发额度数字」不是故障；
 * - `cline` / `loomy` / `raccoon`：协议原语自己带**具体**原因
 *  （含 HTTP 状态码与错误体摘要），压成笼统一句会丢掉唯一有用的线索。
 * - `accio`：三条失败路径的**用户动作完全不同**（未登录 / 一般查询失败 /
 *   响应里没有余额字段），而 `fetchAccioBalanceDetailed` 自己给得出这三句。
 *
 * 故这些渠道给 `fetchBalanceDetailed`，文案由实现自己负责。
 * **绝不允许把「查不到」写成 0**（0 是「已用光」的语义）。
 *
 * ## ⚠️ 为什么是**工厂**而不是常量表
 *
 * `loomy` / `raccoon` / `zcode` 的余额查询走**各自 auth 实例上的方法**
 *（`fetchCreditBalance` / `fetchBalanceFor`），因为那些实例可能带注入的
 * `fetchImpl`（测试替身 / 代理）。重构前 RPC 就是这么调的，这里原样保留。
 * 未传实例时回退到自由函数 + 全局 `fetch` —— 与 `index.ts` 的实际构造
 *（三者都没传 `fetchImpl`）逐字等价，故生产行为不变。
 */
import { type ZcodeBalanceResult } from './zcode-upstream.js';
import { type ClaimOutcome, type CreditBalance } from './credits.js';
import type { ProviderCredits } from './provider-runtime.js';
import type { LoomyCredential } from './loomy.js';
import type { RaccoonCredential } from './raccoon.js';
import type { ZcodeCredential } from './zcode.js';
/**
 * 三家「余额查询挂在 auth 实例上」的渠道所需的最小接口。
 *
 * ⚠️ **结构化类型而不是 `LoomyAuth` / `RaccoonAuth` / `ZcodeAuth`**：
 * 本模块只需这三个方法，导入三个 auth 类会把 `@deepseek-ai/cordis` 与
 * 一整套登录流程拖进依赖图 —— 而它只被 `index.ts`（已经持有实例）与
 * 单测使用。结构化类型同时让单测可以传**只带一个方法的替身**。
 */
export interface ProviderCreditsDeps {
    /** Loomy auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly loomy?: {
        fetchCreditBalance(credential: LoomyCredential): Promise<CreditBalance | null>;
        /** 一键签到：触发每日额度（`POST /points/first-login`）。 */
        claimDailyQuota(credential: LoomyCredential): Promise<ClaimOutcome>;
    };
    /** Raccoon auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly raccoon?: {
        fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null>;
    };
    /** ZCode auth 实例（省略时回退到自由函数 + 全局 fetch）。 */
    readonly zcode?: {
        fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined>;
    };
    /**
     * LobsterAI 的**客户端版本号**解析器。
     *
     * ⚠️ 必须**惰性**调用（`() => lobsterai.resolveClientVersion()`），不能注册时
     * 先 await 一个字符串：该值由远端更新接口解析（带 TTL 缓存），把它固化成闭包
     * 里的常量会让「缓存过期后拿到新版本」失效 —— 而它是签到接口的**必填** query 参数。
     */
    readonly lobsteraiClientVersion?: () => Promise<string>;
    /**
     * MiniMax **国际站**绕地理分流用的 `X-Forwarded-For` 值（issue IKMEVG）。
     *
     * ⚠️ 必须**惰性**读（`() => pool.minimaxXff()`），不能注册时固化成字符串：
     * 用户随时可能在面板里改这个设置，固化会让「改了却不生效」变成静默失效。
     *
     * ⚠️ 省略等价于「不附头」（与修复前行为逐字节一致）。**只对
     * `minimaxintl` 生效** —— 判据在 `minimaxHeadersFor` 里按 product id 分流。
     */
    readonly minimaxXff?: () => string | undefined;
    /**
     * Gemini 的**按账号 fetcher**（Gitee issue IKLTZ2）。
     *
     * ⚠️ Gemini 的配额端点（`retrieveQuotaSummary`）在墙外，而积分行是**用户
     * 点一下就等**的主路径：不接代理时它恒报「配额查询网络失败：fetch failed」，
     * 且**零线索**指向代理。
     *
     * ⚠️ 与其余各家同理，必须**惰性**调用（按 `accountId` 现取），不能在注册时
     * 固化成一份 fetcher —— 账号可能随时在面板里改代理。
     */
    readonly geminiFetchFor?: (accountId: string) => typeof fetch;
    /**
     * MiniMax **国际站**的按账号 fetcher（PR !145 审计 P0 修法）。
     *
     * ## ⚠️⚠️ 为什么必须有它（真实缺陷，本 PR 自己声称要修却没修）
     *
     * PR !145 的提交说明与 `index.ts` 注释都写「登录 / 续期 / 目录 / 身份 / 推理 /
     * **积分**六条链路都走 `minimaxIntlFetchForAccount`」，但本文件（三个积分入口
     * 的所在处）**一行都没改** —— 三个原语的第二参仍是 `undefined`（⇒ 默认参数
     * = 全局 `fetch`）。而 `agent.minimax.io` 按出口 IP 国别分流，大陆出口直连
     * 恒 307 到中国站，中国站不认国际站 token ⇒ 401。
     *
     * ⇒ **用户配好代理后，对话能用了，积分行却仍报「余额查询失败」、一键签到仍
     * 失败** —— 症状与 issue IKMEVG 逐字相同，只是从「全部链路」缩到「积分」这一面。
     *
     * ⚠️ 与 {@link geminiFetchFor} **刻意分成两个字段**：两家语义与主机都不同
     *（Gemini 是「墙外连不上」，国际站是「连得上却被分流」），共用会让
     *「清掉一家的代理」连带清掉另一家的出口配置。
     *
     * ⚠️ 同样必须**惰性**调用（按 `accountId` 现取）：账号可能随时在面板里改代理。
     */
    readonly minimaxIntlFetchFor?: (accountId: string) => typeof fetch;
}
/**
 * 把 ZCode 的额度桶映射成 `CreditBalance`。
 *
 * ⚠️ **逐桶映射，不是只取第一个桶**（真实缺陷）：旧实现只取
 * `result.planName`（= `buckets[0]?.showName`）拼**一个**包 —— 多桶账号的
 * 其余额度被**静默丢掉**，而 `result.remaining` / `total` 却是**全桶汇总**，
 * 于是那一个包的数字比它自己的 `totalUnits` 还大，自相矛盾。
 * 实测本机账号只回一个桶，但**不能按「只有一个桶」来写** —— 那正是把缺陷
 * 固化成契约。
 *
 * ## 空桶的兜底
 *
 * 上游可能一个桶都不给。此时**不能**返回空 `packages`（前端会显示成
 * 「没有额度」而不是「查不到」），故给一个具名占位包，让 UI 至少能显示
 * 「0 / 0」并带上 `result.planName`。
 */
export declare function buildZcodeBalance(result: ZcodeBalanceResult): CreditBalance;
/**
 * 构造「id → 积分能力」的表。
 *
 * ⚠️ **只覆盖余额查得到资源包的渠道**。`opencode` 与 `qoder` 系刻意缺席
 *（见文件头），`aggregate` 没有自己的账号与余额。
 */
export declare function createProviderCredits(deps?: ProviderCreditsDeps): Readonly<Record<string, ProviderCredits>>;
/**
 * 按 provider id 从表里取实现。
 *
 * ⚠️ 用 `Object.hasOwn` 而非 `in`：`in` 会命中原型链上的键（如 `constructor`），
 * 把 `req.provider` 为怪值时误判成「有该 provider」——
 * 与 `jet-hub-rpc.ts` 的 `authOf` 同因。
 */
export declare function creditsOf(table: Readonly<Record<string, ProviderCredits>>, provider: string): ProviderCredits | undefined;
//# sourceMappingURL=provider-credits.d.ts.map