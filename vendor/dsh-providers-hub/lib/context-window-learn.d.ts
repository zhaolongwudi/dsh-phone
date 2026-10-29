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
 * ## 落盘策略（9.22 起；此前是「只记进程内」）
 *
 * 9.11 的决定是**只记进程内、不落盘**：代价是每次重启后重新撞一次墙（而撞墙的
 * 表现是**回答被上游静默截断**），换来的是**不会把一个学错的值永久固化** ——
 * 而「固化错误值」正是 2026-10-11 那次「永远显示 200K」事故的形态
 * （见 `aggregate-adapter.ts` 里 `contextWindowFor` 的记忆化修正）。
 *
 * 9.22 起改为**落盘，但只落有硬证据的值**（见 `context-window-store.ts`）：
 * ① 上游报文里读出来的真实上限；② 截断/超限时实测到的规模。「读不出 ⇒ 减半猜」
 * 的值**仍只留内存**。另有 {@link noteContextWindowSuccess} 作**自愈**：整轮正常
 * 结束时可用当轮实测规模把偏小的值放宽（该值必然 ≤ 真实上限，方向安全）。
 * ⚠️ 落盘还要求值 ≥ {@link DYNAMIC_CONTEXT_WINDOW_FLOOR}（Issue F-55：低于自愈
 * 下界的值一旦落盘就再也放宽不了）。
 * ⇒ 「重启不丢」与「不固化错值」同时成立，且用户**无需手动填任何上限**。
 *
 * ## ⚠️ 有意为之的边界
 *
 * 判据**只认英文**、且只认宿主分类器已经认定的那两族数字形态：**中文超限报文不猜**
 * （设备 42 个会话里没有真实样本可依据，见接力文档 9.10）。中文报文会落到「减半」
 * 兜底路径，照样收敛，只是多撞几次。
 *
 * @module src/context-window-learn.ts
 */
import type { ContextWindowStore } from './context-window-store.js';
/** 拿不到供应商上限时的**起步声明**（用户口径：起步给大，撞墙再收窄）。 */
export declare const DYNAMIC_CONTEXT_WINDOW_START = 1000000;
/**
 * 收窄的**下限**。
 *
 * 兜底路径每次撞墙减半（1M → 500K → 250K → …），没有下限时一次异常报文就能把某个
 * 模型压到荒谬区间。而声明偏小只会让压缩更早发生（不致命），故下限取「小窗口模型」
 * 的量级 32K —— 真实上限低于它的模型在这个生态里极罕见。
 */
export declare const DYNAMIC_CONTEXT_WINDOW_FLOOR = 32768;
/** `provider` + 模型 id → 学习表的键（NUL 分隔，避免 `a/b` 与 `a_b` 这类撞键）。 */
export declare function contextWindowKey(provider: string, model: string): string;
/** 动态声明值：学过用学到的，没学过给起步值。 */
export declare function dynamicContextWindowFor(key: string): number;
/**
 * 已学到的窗口；没学过返回 `undefined`。
 *
 * ⚠️ 与 {@link dynamicContextWindowFor} 的区别就在这个 `undefined`：**zcode 适配器**
 * 要的是「学过就用学到的、没学过才回落目录声明值」，故它读本函数而不是起步值那个。
 */
export declare function learnedContextWindow(key: string): number | undefined;
/**
 * 挂载持久化后端，返回**该次挂载专属的 disposer**（9.22 要点 2）。
 *
 * 挂载时把盘上的值 hydrate 进内存。⚠️ 与内存里已有的值取**更小**的那个：盘上
 * 那份是上一次运行学到的，而「更小」只会让压缩更早发生（**安全方向**）；取大会
 * 让对外声明偏大 ⇒ 更晚压缩、更容易撞墙（用户口径「填小安全、填大危险」）。
 *
 * @param next - 后端实现；传 `undefined` = 卸载（测试隔离用）。
 */
export declare function attachContextWindowStore(next: ContextWindowStore | undefined): () => void;
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
export declare function contextWindowFromFailureText(text: string): number | undefined;
/**
 * 撞墙时调用：**优先记住报文里的真实上限**，读不出就按当前声明值**减半**。
 *
 * 返回收窄后的值（调用方用于日志/诊断）。可重复调用：每次都在上一次的基础上继续收窄。
 */
export declare function rememberContextWindowFailure(key: string, failureText: string): number;
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
export declare function rememberContextWindowCeiling(key: string, observedTokens: number): number | undefined;
/**
 * **成功一轮**后调用：把「实测装得下」的规模记为该键的**下限证据**（9.22 自愈）。
 *
 * ## 它修的是什么
 *
 * 落盘只收硬证据，但硬证据也可能来自**误读**（`contextWindowFromFailureText` 的
 * 第二条形态较宽），或来自收敛途中的中间值 —— 那会把上限**永久**压小，从此每轮
 * 都过早压缩（用户当初正是因此选择不落盘）。
 * ⇒ 只要有一轮**整轮正常结束**、且当轮实测规模**超过**已学值，就证明那个值偏小，
 * 把它放宽到实测值。
 *
 * ## 为什么方向安全
 *
 * 传入值必须来自**真正成功的请求**（调用点 = 流正常结束的提交点），故它必然
 * **≤ 真实上限** ⇒ 放宽到它不会「填大」（不会让声明超过真实窗口）。
 *
 * ⚠️ 因此**不要**拿「历次观测的峰值」（`lastContextTokens` 那种跨轮累积值）来调本
 * 函数：那个值可能来自**别的、窗口更宽的候选**（会话在 1M 候选上长到 90 万后又切到
 * 26 万的候选），用它放宽窄候选就是**填大** —— 正是要避免的方向。
 *
 * @returns 放宽后的值；没放宽（无当前值 / 不比当前值大 / 观测无效）返回 `undefined`。
 */
export declare function noteContextWindowSuccess(key: string, observedTokens: number): number | undefined;
/**
 * 清空**内存**学习表（单测用）。
 *
 * ⚠️ 不碰盘上的文档：盘上那份是「上次运行学到的事实」，清它属于用户级操作
 *（删 `$DSH_HOME/jet-hub/context-windows.json` 即可手动重置）。
 */
export declare function resetLearnedContextWindows(): void;
//# sourceMappingURL=context-window-learn.d.ts.map