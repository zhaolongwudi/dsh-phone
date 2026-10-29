/**
 * 华为云 CodeArts 积分（「每日签到得积分」活动）。
 *
 * ## 为什么与另外两个积分实现都不共用协议
 *
 * | provider    | 认证方式                    | 签到流程                          |
 * |-------------|-----------------------------|-----------------------------------|
 * | `buddy`     | Bearer + 腾讯系归属头        | 两步（状态 + 领取）                |
 * | `lobsterai` | 纯 Bearer，无签名            | 三步（slot + context + check_in）  |
 * | `codearts`  | **SDK-HMAC-SHA256 签名**     | **三步（账户类型 + 活动 + 领取+确认）** |
 *
 * 华为云这套与前两者没有一处共用，故独立成文件；但**复用 `credits.ts` 的
 * `ClaimOutcome` / `CreditBalance` / `CreditPackage` 类型**，使
 * `computeClaimSummary` 与 Jet Hub 的结果摘要 UI、`CreditBalanceRow`
 * 组件一行都不用改。
 *
 * ## 协议来源（逆向自本机安装的码道 IDE，非猜测）
 *
 * `C:\Program Files\CodeArts Agent\resources\app\out\main.js:54259`
 * 与 `out\vs\workbench\workbench.desktop.main.js:375626`（`ActivityWelfarePane`）：
 *
 * ```
 * 账户/套餐  GET  {snapEngineUrl}/snap-manager/v1/statistics/plugin
 * 活动列表   GET  {snapEngineUrl}/v1/ops/delivery?channel=IDE
 * 领取       POST {snapEngineUrl}/v1/ops/claim   { campaignId, channel: 'IDE' }
 * 领取确认   POST {snapEngineUrl}/v1/ops/confirm { campaignId }
 * ```
 *
 * `snapEngineUrl` 取自 IDE 的 `product.json`，值为
 * `https://snap-access.cn-north-4.myhuaweicloud.com` —— **与本仓库
 * `src/models.ts` 已在使用的 `SNAP_MODEL_BUILTIN_URL` 同域**。
 *
 * ## 认证：签名，不是 Cookie（关键结论）
 *
 * 官方文档给出的网页版路径（`https://codearts.huaweicloud.com/portal/...`）
 * 走的是 portal BFF，**依赖浏览器会话 Cookie**：实测不带 Cookie 时无论是否
 * 携带 AK/SK 签名，都返回 IAM 登录跳转 HTML（HTTP 200 + `text/html`）。
 * 因此插件**不能**复用那条路径 —— 它没有可用的浏览器会话。
 *
 * 而 IDE 直连的 snap-access 端点接受 **`SDK-HMAC-SHA256` 签名**
 * （IDE 的 `signer.js`：`ALGORITHM = "SDK-HMAC-SHA256"`、头 `X-Security-Token`），
 * 与 `src/sign.ts` 的实现逐字一致。故本模块走签名路径，凭据就是现有的
 * `CodeArtsCredential`（AK/SK/security_token），无需任何新登录流程。
 *
 * ## 账户类型检测（活动范围的前置条件）
 *
 * 活动文档明确「活动参与者：已经升级到**积分计费模式**的用户」。
 * `statistics/plugin` 的响应里 `package.is_credit_package === true`
 * 即表示积分账户（IDE 前端正是用它决定渲染「积分版」还是「Token 版」布局，
 * 见 `accountInfoPane.js` 的 `accountInfo.isCreditPackage`）。
 *
 * 因此领取前**必须先判账户类型**：Token 计费账户不在活动范围内，
 * 直接尝试领取只会拿到一个语义模糊的错误。
 *
 * ## 幂等
 *
 * 与 CodeBuddy 靠服务端业务码、LobsterAI 靠客户端 `idempotencyKey` 都不同：
 * 这里靠**活动列表的 `claimable` / `status`** 预检。IDE 的实现同样如此
 * （按钮在 `status` 属于已领取态时被 `disabled`）。领取后若服务端要求
 * 确认（响应 `id !== null`），再补一次 `confirm` —— 这一步是 IDE 的行为，
 * 漏掉会让积分停在「待确认」而不入账。
 */
import type { CodeArtsCredential } from './types.js';
import type { ClaimOutcome, CreditBalance } from './credits.js';
/**
 * snap-access 网关基址。
 *
 * 与 `src/models.ts` 的 `SNAP_MODEL_BUILTIN_URL` 同域 —— 该端点已在本仓库
 * 稳定使用，故此处沿用同一 host，不另立常量来源。
 *
 * 注：IDE 的 `PackageInfoService.getFallbackUrls` 还实现了 `.com` → `.cn`
 * 的域名回退。本实现**刻意不照搬**：该回退分支无法在本机实测（`snap-access
 * .cn-north-4.myhuaweicloud.cn` 的可达性与响应形态均未验证），引入一条未验证
 * 的请求路径只会让失败原因更难定位。若将来确认 `.cn` 域名必要，再补不迟。
 */
export declare const CODEARTS_SNAP_ENGINE_URL = "https://snap-access.cn-north-4.myhuaweicloud.com";
/** 账户/套餐信息端点 —— 积分账户检测的唯一真相源。 */
export declare const CODEARTS_PACKAGE_INFO_PATH = "/snap-manager/v1/statistics/plugin";
/** 活动列表端点。 */
export declare const CODEARTS_OPS_DELIVERY_PATH = "/v1/ops/delivery";
/** 领取端点。 */
export declare const CODEARTS_OPS_CLAIM_PATH = "/v1/ops/claim";
/** 领取确认端点。 */
export declare const CODEARTS_OPS_CONFIRM_PATH = "/v1/ops/confirm";
/**
 * 限时福利领取的完整 URL（幂等；成功判据 `error_code === '0000'`）。
 *
 * ⚠️ 导出供单测匹配「这一次 fetch 是领取、不是聊天」—— 三条既有用例的替身
 * fetch 是按 URL 分流计数的，不认这个地址就会把领取误计成一次 chat 请求。
 * 网关配置端点（`/api/v1/gateway/config`）已在 `src/models.ts` 实现，此处不重复。
 */
export declare const CODEARTS_BENEFIT_CLAIM_URL = "https://opengw.developer.huaweicloud.com/api/v1/benefit/claim";
/** 渠道标识：声明请求来自 IDE 形态（对齐 IDE 的 `channel=IDE`）。 */
export declare const CODEARTS_OPS_CHANNEL = "IDE";
/**
 * 「每日签到得积分」在活动列表里的 `type` 取值。
 *
 * IDE 的 `ActivityWelfarePane.TYPE_ORDER` 把活动分为四类，其中 `USER_LOGIN`
 * 即「每日登录领取」；`INVITE_USER` / `NEW_USER_REGISTER` / `STUDENT_CERTIFIED`
 * 是邀请、新人、学生认证，**不属于**每日签到，不能混领。
 */
export declare const CODEARTS_DAILY_LOGIN_TYPE = "USER_LOGIN";
/** 账户/套餐信息（`statistics/plugin` 解析结果）。 */
export interface CodeArtsAccountInfo {
    /**
     * 是否为**积分计费账户**（活动文档所说的「已升级到积分计费模式」）。
     *
     * 这是能否领取积分的前置条件。为 false 时是 Token 计费账户，
     * 不在「每日签到得积分」活动范围内。
     */
    isCreditPackage: boolean;
    /** 是否为旧的 Token 计费账户（`package.is_token_package`）。 */
    isTokenPackage: boolean;
    /** 套餐规格码（如 `codearts.agent.enterprise.ultimate_pro`）。 */
    specCode: string;
    /** 套餐展示名（优先中文名）。 */
    packageName: string;
    /** 套餐状态（`package.status`）。 */
    packageStatus: string;
    /**
     * 积分余额；非积分账户或无 credit metric 时为 `undefined`。
     *
     * 与 `total` 为 0 严格区分：`undefined` 表示「这个账户没有积分口径」，
     * 而 `{ total: 0 }` 表示「有积分口径但当前为 0」。
     */
    credit?: CreditBalance;
}
/** 活动列表中的一项（只保留签到所需字段）。 */
export interface CodeArtsOpsActivity {
    /**
     * 活动 ID，领取时回传。
     *
     * ⚠️ **服务端下发的是数字**（实测 `campaignId = 1`），不是字符串。
     * 早期实现用只接受字符串的 `readString` 解析，结果恒为空串，
     * 领取被判为 `failed`「活动缺少 campaignId，无法领取」
     * —— 用户看到「1 个失败」而积分实际没领到。
     */
    campaignId: string;
    /** 活动类型（如 `USER_LOGIN`）。 */
    type: string;
    /** 活动标题。 */
    title: string;
    /** 当前是否可领取 —— 领取判定的权威依据。 */
    claimable: boolean;
    /** 活动状态（如 `ENTRY` / `CLAIMED`）；不可领取时可能为 null。 */
    status: string;
    /**
     * 该活动可领积分。
     *
     * 字段名是 **`benefitAmount`**（实测 1000），不是 `amount`。
     * 早期实现读 `amount` 而服务端不返回该字段，导致回退成 0。
     */
    amount: number;
}
/**
 * 查询账户/套餐信息 —— 含**积分账户检测**。
 *
 * 返回 `null` 表示查询失败（网络/签名/结构问题），与「查到了但非积分账户」
 * （返回 `isCreditPackage: false` 的对象）严格区分：前者要用户排查网络或
 * 重新登录，后者是正常的账户类型差异。
 *
 * 需要**失败原因**时用 {@link fetchCodeArtsAccountInfoDetailed}。
 */
export declare function fetchCodeArtsAccountInfo(credential: CodeArtsCredential, fetcher?: typeof fetch): Promise<CodeArtsAccountInfo | null>;
/**
 * {@link fetchCodeArtsAccountInfo} 的带原因版本。
 *
 * 失败分支**必须带 `code`**：上层（`credits.claimAll` / `credits.balances`）要靠
 * 早期这里只留 `message`，调用方拿到的是被压平的字符串，只能靠匹配文案猜 ——
 * 这正是用户报障「账户信息查询失败：HTTP 401：APIG.0301 …」时无法自愈的原因。
 * 网络异常/无法解析等非 HTTP 失败沿用 `-1`（与 {@link SnapResult} 同口径）。
 *
 * ⚠️⚠️ **`code` 目前是「仅供 UI / 诊断透出」的载荷，没有任何自愈消费者**
 * （2026-10-27 对抗审计核实）。
 *
 * 旧注释曾写「它判断这次失败是不是 401/403，进而触发本机快照自愈并重试一次」——
 * **不实**：全仓读这个字段的调用点只取 `.ok` / `.info` / `.message`
 * （`src/aggregate-expiry.ts`、`src/provider-credits.ts:380-381`）；
 * 真正的凭据自愈是**端点入口**的 `healExpiredAccounts(accounts)`
 * （`src/jet-hub-rpc.ts:2714`），按账号 `expiresAt` 判定，**与返回值无关**。
 *
 * ⇒ 保留字段（诊断有用）但改准注释；若将来真要「按 401 触发自愈」，
 *   必须**新接**一条消费者并补行为用例，别以为它已经接上了。
 */
export type CodeArtsAccountInfoResult = {
    ok: true;
    info: CodeArtsAccountInfo;
} | {
    ok: false;
    code: number;
    message: string;
};
/**
 * 查询账户/套餐信息，失败时**保留底层原因**。
 *
 * 为什么需要带原因的版本：领取流程里「账户信息查询失败」可能源于网络超时、
 * 签名错误或凭据过期，把它们统一压成一句笼统文案，会让用户与排查者都拿不到
 * 线索（本仓库在 `credits.ts` / `lobsterai-credits.ts` 都刻意保留原始错误消息）。
 */
export declare function fetchCodeArtsAccountInfoDetailed(credential: CodeArtsCredential, fetcher?: typeof fetch): Promise<CodeArtsAccountInfoResult>;
/**
 * 查询活动列表。
 *
 * 返回 `null` 表示查询失败；返回数组（可能为空）表示查询成功。
 * 与 `credits.ts` 的取舍一致：把「查不到」与「没有活动」分开，
 * 否则网络故障会显示成「活动未开启」，把用户引向错误的排查方向。
 *
 * 需要**失败原因**时用 {@link fetchCodeArtsOpsActivitiesDetailed}。
 */
export declare function fetchCodeArtsOpsActivities(credential: CodeArtsCredential, fetcher?: typeof fetch): Promise<CodeArtsOpsActivity[] | null>;
/**
 * {@link fetchCodeArtsOpsActivities} 的带原因版本。
 *
 * 与 {@link CodeArtsAccountInfoResult} 同口径：失败分支带 `code`，
 * 让上层能区分「凭据过期（401/403，可自愈）」与「网络/解析故障（不可自愈）」。
 */
export type CodeArtsActivitiesResult = {
    ok: true;
    activities: CodeArtsOpsActivity[];
} | {
    ok: false;
    code: number;
    message: string;
};
/** 查询活动列表，失败时保留底层原因。 */
export declare function fetchCodeArtsOpsActivitiesDetailed(credential: CodeArtsCredential, fetcher?: typeof fetch): Promise<CodeArtsActivitiesResult>;
/** 在活动列表里找「每日签到」那一项；没有则返回 undefined。 */
export declare function findDailyCheckinActivity(activities: readonly CodeArtsOpsActivity[]): CodeArtsOpsActivity | undefined;
/**
 * 执行每日签到领取（完整流程）。
 *
 * 步骤与判定顺序（每一步都对应一个**对用户含义不同**的结果）：
 *
 * 1. 查账户类型 —— 查询失败 → `failed`；
 * 2. 查活动列表 —— 查询失败 → `failed`；
 * 3. **以活动列表为准**：无 `USER_LOGIN` 活动 / 不可领取时，才用账户类型给出
 *    `inactive` 的说明文案（非积分账户 → 「不在积分活动范围」，否则 → 「未找到
 *    每日签到活动」）；活动可领取 → **直接领**（不看 `isCreditPackage`）；
 * 4. 活动不可领取且状态属已领取态 → `already-claimed`；其余不可领取 → `inactive`；
 * 5. `POST /v1/ops/claim` —— 失败 → `failed`（业务码 `40001` 例外，见下）；
 * 6. 响应 `id !== null` 时补 `POST /v1/ops/confirm`（漏掉会让积分停在待确认）；
 * 7. 成功 → `claimed`。
 *
 * ⚠️ **为什么不再用 `isCreditPackage` 当门禁**（2026-10-08 实测，第三重根因）：
 * 体验版账号（`spec_code=codearts.agent.trial`、`is_credit_package=false`、
 * `is_token_package=true`）的 `statistics/plugin` 里**没有**任何积分 metric，
 * 但同一凭据下 `GET /v1/ops/delivery` 明确返回 `USER_LOGIN` 活动且
 * `claimable:true`，`POST /v1/ops/claim` 实测 **HTTP 200 并真发 1000 积分**
 * （`status:"CLAIMED"`、`totalAmount:1000`）。旧的 `!isCreditPackage ⇒ inactive`
 * 提前返回是**假阴性**：凭据修好了也永远显示「Token 计费账户，不在积分活动范围」，
 * 用户永远看不到「签到成功」。故改为「活动列表说了算」——服务端给了可领取的
 * 每日签到活动就领，账户类型只用来**修饰不可领取时的文案**。
 *
 * 注意第 4 步是主要的幂等保护：本协议没有幂等键，预检不能省。此外服务端在
 * 重复领取时回业务码 `40001`（「尚未到达权益刷新时间，暂时无法领取」，实测），
 * 该码必须如实判为 `already-claimed` 而不是 `failed` —— 否则用户重复点击会看到
 * 一个并不存在的故障。
 */
export declare function claimCodeArtsDailyCheckin(credential: CodeArtsCredential, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 领取限时福利（opengw `POST /api/v1/benefit/claim`，幂等；成功判据 `error_code === '0000'`）。
 *
 * ## 为什么需要它（对标实测）
 *
 * HITZY2002/codearts2api 的 README（原文核实）：「限时福利模型**必须先领取才能调用**：
 * 未领取时上游一律返回 `InferHub.4004.200 benefit not found`（实测）。领取是幂等
 * 操作，官方客户端打开模型菜单时也会调用」。它默认开启 `benefit_auto_claim`，
 * 其 `ClaimBenefit` 即本函数所复刻的报文。
 *
 * ## 与每日签到积分是两条独立协议，别混
 *
 * | 领取什么 | host | 路径 | 请求体 | 成功判据 |
 * |---|---|---|---|---|
 * | 每日签到积分 | snap-access | `/v1/ops/claim` | `{campaignId, channel}` | 信封 `code`（`40001` = 今天已领） |
 * | **限时福利额度** | **opengw** | `/api/v1/benefit/claim` | **`{}`** | **`error_code === '0000'`** |
 *
 * ⚠️ `X-Language` 必须**签名之后**追加 —— 进 canonical request 会验签失败
 * （与 {@link SNAP_EXTRA_HEADERS} 注释记录的是同一族坑，实测于 snap 路径）。
 * ⚠️ 网络/解析/非 2xx 一律归 `failed` 而不抛错：调用方（`llm-adapter.ts` 的
 * benefit 分支）只关心「领到了没有」，领不到就退回原有的去头降级。
 */
export declare function claimCodeArtsBenefit(credential: CodeArtsCredential, fetcher?: typeof fetch, 
/**
 * ⚠️ **必须接调用方的 signal**（2026-10-27 审计修）。
 *
 * 修前本函数自带一个 30 秒的 `AbortSignal.timeout`，与 `options.signal`
 * **完全无关** ⇒ 用户按下「停止」后，这条**写请求**仍会继续跑到超时
 * （最多再等 30 秒），而适配器里其它 await（`delay(…, options.signal)`）都是可中断的。
 */
options?: {
    signal?: AbortSignal;
}): Promise<'success' | 'failed'>;
//# sourceMappingURL=codearts-credits.d.ts.map