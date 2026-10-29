import type { CodeArtsCredential } from './types.js';
/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export declare const OPENGW_GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config";
/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export declare const SNAP_MODEL_BUILTIN_URL = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin";
/** 定时刷新远端模型列表的间隔（2 小时）。 */
export declare const MODEL_REFRESH_INTERVAL_MS: number;
export interface RemoteModel {
    id: string;
    name: string;
    /**
     * 消耗倍率的**展示串**（如 `0.7x`）；取不到时为 `undefined`。
     *
     * ⚠️ 为什么存**展示串**而不是数值（2026-10-21）：
     * 上游 `/v1/model/builtin` 的 `credit[]` 同时给了两个数 ——
     * `ratio`（`0.05`）与 `ratio_display`（`0.7x`），而**主界面显示的是后者**，
     * 两者**不是同一个量纲**（`GLM-5.2` ratio=0.05 却显示 0.7x；
     * `deepseek-v4.1-flash` 同样 ratio=0.05 却显示 0.18x）。
     * ⇒ 存数值再去拼 `x{n}` 会**编造出一个上游没显示过的倍率**（本仓红线：
     *   绝不臆造上游未下发的数）。故直接取 `ratio_display`，取不到就不显示。
     */
    rateLabel?: string;
}
/**
 * 一次远端目录拉取的**完整性**结果（issue IKJVTF，审计 I3）。
 *
 * ## 为什么需要它
 *
 * CodeArts 的目录来自**两个独立端点**（`opengw gateway/config` 给 benefit 模型、
 * `snap-access /v1/model/builtin` 给常规模型），而两处的失败路径都是
 * `fetchSignedGet` **静默返回 `undefined`**。于是「一个成功、一个失败」时
 * `models.length > 0` ⇒ 适配器判成「已拿到目录」⇒ **永久缓存**（
 * `if (this.remoteModels !== undefined) return` 短路）⇒ 残缺目录固化，
 * 只有重启 DSH 才能恢复（与 Cline 的缺陷② 完全同构）。
 *
 * ⇒ 取数函数必须**显式**回报「每个来源到底成功没有」，适配器据此决定
 * 「只展示（`got`）」还是「也永久缓存（`complete`）」。
 */
export interface RemoteCatalogOutcome {
    /** 各来源的成败（`gateway` / `builtin`），供适配器判完整性。 */
    gatewayOk: boolean;
    builtinOk: boolean;
}
/** 两个来源是否**都**取到了。 */
export declare function isRemoteCatalogComplete(outcome: RemoteCatalogOutcome): boolean;
/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 *
 * ⚠️⚠️ **2026-10-27 修订：本函数不再是「暴露给用户的那个 id」的裁剪刀。**
 *
 * 实测（IDE 内核日志 `kernel-codeartsdoer-incognito-2026-10-27T220300`）：
 * `/v1/model/builtin` **同时**下发两个**独立**条目 ——
 *
 * ```
 * {"model_id":"deepseek-v4.1-flash",      "model_name":"DeepSeek-V4.1-Flash",      ...}
 * {"model_id":"deepseek-v4.1-flash-1017", "model_name":"DeepSeek-V4.1-Flash-1017", ...}
 * ```
 *
 * 两者 `model_type` 都是 `admin`、`context` 都是 `1048576`，是**上游并存的旧版与新版**。
 * 修前 `parseModelInfo` 拿本函数的**产物**做 `seen` 去重键 ⇒ 带版本号的那条被静默吞掉
 * ⇒ 用户报障「IDE 里已更新到 1017，我们的列表没更新」（虽然不是没拉到远端，
 * 而是拉到后被自己去重吃掉）。
 *
 * ⇒ 现在 `parseModelInfo` 用**原始 `model_id`** 做去重键与对外 id，
 * 本函数只保留两处**内部**用途：
 * 1. gateway 分支判断「该 id 是否带日期后缀」（决定是否记为 benefit，见下方注释）；
 * 2. `model_name` 缺失时给一个不含版本号的兜底 id。
 *
 * ⚠️ 若将来发现某个带后缀的 id 在 chat 端点**不可用**，处置方式是在
 * `parseModelInfo` 里**显式跳过**那一条（并登记实测），**不要**退回「统一裁剪」——
 * 那会把上游有意并存的版本再次合并掉。
 */
export declare function normalizeModelId(id: string): string;
/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * 同时把 gateway/config 下发的 benefit 模型 id 集合写入独立缓存
 * （见 {@link saveBenefitCache}），供 chat 请求判定是否带 `maas_type: benefit`。
 */
export declare function fetchCodeArtsRemoteModels(credential: CodeArtsCredential, fetcher?: typeof fetch, 
/**
 * 各来源成败的**出参**（issue IKJVTF，审计 I3）。
 *
 * ⚠️ 用出参而非改返回值：本函数的既有调用方与 10 条单测都按「返回数组」用，
 * 改形状会波及它们；而完整性只对**适配器**有意义（它决定要不要永久缓存）。
 * 不传即不关心完整性，行为逐字节不变。
 */
outcome?: RemoteCatalogOutcome, 
/**
 * 「现在」的时刻（毫秒）—— **只为倍率选时段**用。
 *
 * ⚠️ 加它是因为倍率**随时间变**（`deepseek-v4.1-flash` 错峰档 21:00–次日 7:59
 * 显示 0.09x，其余时段 0.18x）。单测必须能注入时刻，否则「是否落在错峰窗口」
 * 这条逻辑无法被确定性覆盖。缺省 `Date.now()` ⇒ 生产行为不变。
 */
nowMs?: number): Promise<RemoteModel[]>;
/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export declare function saveModelsCache(models: RemoteModel[]): void;
/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export declare function loadModelsCache(): RemoteModel[] | undefined;
/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export declare function availableCodeArtsModels(): RemoteModel[] | undefined;
/** 设置内存缓存（由 service 拉取成功后调用）。 */
export declare function setMemoryCache(models: RemoteModel[] | undefined): void;
/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略 —— 判定只会退回「未确认」。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export declare function saveBenefitCache(ids: readonly string[]): void;
/**
 * 加载缓存文件中的 benefit 模型 id 集合。
 *
 * ## 三种状态必须可分（2026-10-27 审计 P1 修）
 *
 * | 磁盘状态 | 返回 | 含义 | ⇒ 是否带 `maas_type` |
 * |---|---|---|---|
 * | 文件不存在 / 解析失败 | `undefined` | **未确认** | 不带（靠自愈补头） |
 * | 文件是 `[]` | `[]` | **确认无** benefit 模型 | 不带（且**不**再尝试领取） |
 * | 文件是 `["glm-5.3-flash"]` | 数组 | 确认有这些 | 命中才带 |
 *
 * ⚠️⚠️ 修前把「空数组」与「读不到」**都**返回 `undefined` ⇒
 * `saveBenefitCache([])` 写下的「确认无」在下次启动时又退化成「未确认」，
 * 于是 `models.ts` 那侧修好的「空集合可落盘」被这里**抵消**（配套改动，缺一不可）。
 */
export declare function loadBenefitCache(): string[] | undefined;
/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export declare function setBenefitMemoryCache(ids: string[] | undefined): void;
/**
 * 该模型的 benefit（免费额度）身份**由远端集合确认**。
 *
 * ## 为什么只有一个判据、没有静态兜底表
 *
 * 早期用一张写死的兜底表（2026-09-23 对齐 deveco-code-rust）推断 benefit 身份，
 * 但那张表**不会随后端演进更新**，两次都成了缺陷根源：
 *
 * - 表过时 ⇒ 首次请求恒带 `maas_type: benefit`，而后端已把 `deepseek-v4.1-flash`
 *   改按常规 `0.18x` 模型下发 ⇒ 每次首条消息都报
 *   `InferHub.4004.200 benefit not found`（2026-10-25 修，见 `e611a61`）。
 * - 表与远端集合谁优先 ⇒ 同一语义两套判据；后端再改一次就又错一遍。
 *
 * 2026-10-26 本机复测（真实账号直连 `chat/completions`）：
 * `deepseek-v4.1-flash` 不带该头**出流正常**、带上即 `4004.200`；
 * `glm-5.3-flash` 不带该头 `002002009.404`、属**只按 benefit 通道注册**。
 * 两者形态相反，恰好证明「按名字/按历史表猜」不可行。
 *
 * ⇒ 权威来源只剩 `opengw gateway/config` 的 `result.models`
 * （见 {@link fetchCodeArtsRemoteModels}）；后端千变万化的情况由 `stream()` 的
 * **双向自愈**兜住：404 未注册 ⇒ 补头重试一次，4004.200 ⇒ 先领福利、再去头重试
 * 一次。因此**没有静态表也不会卡死新模型**，只是首次多一轮往返。
 */
export declare function isCodeArtsBenefitModelKnown(model: string): boolean;
//# sourceMappingURL=models.d.ts.map