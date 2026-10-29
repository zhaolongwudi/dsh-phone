/**
 * 「拿不到供应商上限」的模型的**已学窗口上限**持久化文档（9.22 要点 2）。
 *
 * ## 为什么要有它（用户口径 2026-10-12）
 *
 * 用户要「切换模型时插件**自动就知道**它能装多少，而且**不用我手动填表**」。
 * 学习器（`context-window-learn.ts`）本来就能学到，但它**只记在进程内** ⇒ 每次
 * 重启 DSH 都要重新撞一次墙 —— 而撞墙的表现是**回答被上游静默截断**，正是用户
 * 2026-10-12 报障的形态。落盘把「出了事再学」变成「重启后仍然知道」，**零手动**。
 *
 * ## ⚠️ 与 9.11「不落盘」决定的关系：有意推翻，但只推翻一半
 *
 * `context-window-learn.ts` 模块头写着「只记忆在进程内（用户选择，不落盘）」，
 * 理由是防「把学错的值永久固化」（2026-10-11「永远显示 200K」事故的形态）。
 * 本文件**只持久化有硬证据的值**：
 * - 上游失败报文里**读出来的真实上限**（`maximum context length is …`）；
 * - **截断/超限时实测到的规模**（下界证据：那一轮真的装到了这么多）。
 *
 * 「报文读不出 ⇒ 按当前值**减半**猜」那种值**仍然只留内存**（见
 * `rememberContextWindowFailure` 的回落分支）：它没有证据、方向可能过小，
 * 落盘就等于固化一个可能错的值。
 *
 * ## 自愈（让「固化错值」不会发生）
 *
 * 硬证据也可能来自**误读**。故 `noteContextWindowSuccess` 在**整轮正常结束**后，
 * 用**本轮**实测规模把偏小的值放宽 —— 该值来自真正成功的请求，必然 ≤ 真实上限，
 * 方向安全（不会「填大」）。见该函数的注释。
 *
 * ## 形态与取舍
 *
 * - **独立文档** `context-windows.json`（**不进** `state.json`）：与
 *   `token-ledger-store.ts` / `permanent-lock-store.ts` 同因 —— `state.json` 被
 *   另一条工作区的旧代码**整体重写**时会静默抹掉它不认识的键。
 * - **直接原子写**（tmp + rename），**不设防抖**：写入只发生在撞墙/截断/自愈时
 *   （低频），与账本的「每笔请求都写」不同 —— 那里才需要防抖。
 * - **读取只做一次**（构造时 hydrate），之后 `load()` 是纯内存读。
 * - 落盘失败**只记日志**：本数据是优化，不能反噬推理。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 独立文档的文件名（与 `state.json` 同目录）。 */
export declare const CONTEXT_WINDOW_FILE = "context-windows.json";
/** 已学窗口的持久化后端（同步读、同步原子写）。 */
export interface ContextWindowStore {
    /** 读回已落盘的表 —— **纯内存读，不碰磁盘**（磁盘只在构造时读一次）。 */
    load(): Map<string, number>;
    /** 记下一个**有硬证据**的值并落盘；越界值被忽略。 */
    remember(key: string, window: number): void;
    /** 立即落盘（dispose / 测试用）。 */
    flush(): void;
}
/**
 * 创建持久化后端。
 *
 * home 解析与账号池 / 账本**同一个函数**（`resolveJetHubHome`），保证文档落在
 * 同一目录 —— 否则会出现「账号池在 A 处、窗口表在 B 处」的分裂。
 */
export declare function createContextWindowStore(ctx: Context): ContextWindowStore;
//# sourceMappingURL=context-window-store.d.ts.map