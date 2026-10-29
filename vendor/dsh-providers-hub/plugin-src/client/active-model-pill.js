/**
 * 「在用模型」实时读数胶囊 —— 挂在输入区最下方（`conversation.composer.dock`）。
 *
 * ## 它解决什么
 *
 * 路由型 provider（`aggregate` 聚合·跨渠道、`jet-hub-auto` Auto·临期优先·整池）
 * 在模型选择器里只显示一个**虚拟**名字。用户看不到「这一次到底发给了哪个渠道、
 * 哪个真实模型」—— 这正是本胶囊要回答的问题。
 *
 * ## ⚠️ 与用量徽标（`usage-badge.js`）的分工
 *
 * | 组件 | 槽位 | 回答的问题 |
 * |---|---|---|
 * | 用量徽标 | `conversation.input.right` | 这个渠道**还剩多少**额度 |
 * | 本胶囊 | `conversation.composer.dock` | 现在**在用**哪个渠道、哪个模型 |
 *
 * 两者都依赖同一个目录快照（当前选中的 provider/model），但语义不同：徽标要的是
 * 「余额该读谁」，本胶囊要的是「请求发给了谁」。**不要合并**。
 *
 * ## ⚠️ 为什么门控放在渲染前而不是宿主侧
 *
 * 这里拿不到「宿主记录里有没有历史」的同步值（那是 RPC，异步），所以：
 * 路由型 provider 在**还没有历史**时显示占位文案（`在用 · 等待首次请求`）而不是
 * 直接不渲染 —— 用户报障「找不到这个显示」过，一个会自己冒出来的占位比
 * 「什么都不显示」更容易让人确认功能是活的。
 *
 * ## ⚠️ 与徽标同款的两个坑（都已由本文件的写法规避）
 *
 * 1. **目录必须惰性解析**（`resolveDirectory()` 是函数）：`directoryFor(sessionId)`
 *    在槽位 inject 期求值会让桌面版抛 `cannot get property "remote.session"
 *    without inject`，而那个异常发生在**会话输入区的同步渲染路径**上，会让模型
 *    选择器整个点不动 —— 远比「胶囊不显示」严重。见 `usage-badge.js` 的详细记录。
 * 2. **必须自己调 `load()`**：目录 store 初值是 `{ current: null, status: 'idle' }`，
 *    不 load 就永远拿不到 `current`，胶囊会恒显示「无选中模型」而不渲染。
 */

import * as React from 'react';
import { createPortal } from 'react-dom';

/**
 * 轮询节奏：5 秒。
 *
 * ⚠️ 宿主端点 `router.activeRoute` 是**纯内存读**（零网络、零余额查询），成本可忽略；
 * 而它决定的是「现在在用谁」—— 用户发完消息后若最多要等 60 秒才更新，观感就是
 * 「这个显示坏了」。故与徽标那条 `ACTIVE_PROVIDER_POLL_MS` 取同一量级
 *（两者都是内存读，与 60 秒的**余额**轮询是两回事）。
 */
export const ACTIVE_ROUTE_POLL_MS = 5_000;

/**
 * 路由型 provider（模型选择器里显示虚拟名，真实目标只能由宿主记录提供）。
 *
 * ⚠️ 与宿主的 `AGGREGATE_PROVIDER` / `AUTO_PROVIDER` **必须逐字一致**。
 * 写错的表现是胶囊恒显示虚拟名，而不是报错（有单测钉住）。
 */
export const ROUTER_PROVIDER_IDS = Object.freeze(['aggregate', 'jet-hub-auto']);

/**
 * 目录解析失败后的重试退避（毫秒）。
 *
 * 与用量徽标同一序列、同一理由：桌面版宿主可能在槽位挂载之后才补齐
 * `remote.session` 注入，解析失败不等于永远不可用。共 4 次、约 4.5 秒。
 */
const RESOLVE_RETRY_DELAYS = [300, 700, 1500, 2000];
/** 显式退避用尽后的**常驻重试**间隔（毫秒）。见 tryResolve 内的长注释。 */
const PERSISTENT_RETRY_MS = 5_000;

/** 无历史时的占位文案（路由型 provider）。 */
export const PENDING_LABEL = '等待首次请求';

/** 弹层与视口边缘的最小间距（与官方 stat 弹层的 PANEL_MARGIN 同值）。 */
const PANEL_MARGIN = 12;

/** 弹层与触发元素之间的间距（与官方 PANEL_GAP 同值）。 */
const PANEL_GAP = 8;

/**
 * 未定位时的面板样式：**不可见但仍参与布局**。
 *
 * ⚠️ 用 `visibility: hidden` 而**不是** `display: none`：后者会让元素不参与布局，
 * `getBoundingClientRect()` 量到 0×0 ⇒ 夹紧计算全部按 0 算，面板会跳到屏幕角落。
 * （与官方 stat 弹层的 MEASURE_STYLE 同一取向。）
 */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

/**
 * 触发元素锚定的弹层定位（**自己实现**，不引 `@deepseek-ai/dsh-client-ui-primitives`）。
 *
 * ## 为什么不复用官方的 `useAnchoredPosition`
 *
 * 它在 `@deepseek-ai/dsh-client-ui-primitives` 里，而本插件的
 * `dsh.client.inject` 只声明了 connection / ui-settings / ui-model-selection
 * （见 `package.json`）—— 直接 import 一个**未声明**的 client 包会在加载期抛
 * 「cannot get property … without inject」，那正是本仓库踩过的形态。
 * 为一条读数去扩 inject 面不划算；弹层只需要「在触发元素上方、贴边夹紧」。
 *
 * ⚠️ `open === false` 时返回 `null`（调用方用 `pos ?? MEASURE_STYLE`）。
 * ⚠️ 测量必须在**渲染后**（`useLayoutEffect`）做，否则拿到的是未布局的 0 尺寸。
 */
function useAnchoredPosition(anchorRef, panelRef, open) {
  const [pos, setPos] = React.useState(null);
  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    /**
     * ⚠️⚠️ 必须判 `typeof window === 'undefined'`。
     *
     * 这个 effect 跑在**渲染提交路径**上，一旦抛错就不是「弹层不显示」而是
     * 「整个会话输入区崩掉」（与文件头那两个真机事故同一形态）。
     * 宿主是浏览器时 `window` 必然存在，但本仓库的单测/SSR 夹具没有 ——
     * 实测在无 DOM 的夹具里直接抛 `ReferenceError: window is not defined`。
     * ⇒ 没有 window 就整体跳过定位（弹层用 MEASURE_STYLE 保持不可见，
     * 不会出现「面板停在左上角挡着输入区」的中间态）。
     */
    if (typeof window === 'undefined') return undefined;
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      // ⚠️ 面板首帧是 visibility:hidden 但**已布局**（MEASURE_STYLE），
      //    故这里量得到真实宽高 —— 若用 display:none 会量到 0。
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 水平：与触发元素中心对齐，再夹进视口。
      let left = a.left + a.width / 2 - p.width / 2;
      left = Math.max(PANEL_MARGIN, Math.min(left, vw - p.width - PANEL_MARGIN));
      // 垂直：优先放**上方**（输入区在最底部，下方没有空间）。
      let top = a.top - p.height - PANEL_GAP;
      if (top < PANEL_MARGIN) top = Math.min(a.bottom + PANEL_GAP, vh - p.height - PANEL_MARGIN);
      setPos({ left: `${Math.round(left)}px`, top: `${Math.round(Math.max(PANEL_MARGIN, top))}px` });
    };
    place();
    // ⚠️ 旋转屏幕 / 软键盘弹起都会改变视口，必须重算（手机上尤其常见）。
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, panelRef]);
  return pos;
}

/**
 * 纯函数：把「选中的 provider/model」+「宿主记录的真实路由」拼成**两行**读数。
 *
 * ## 为什么是两行（真机实测后改的，2026-10-10）
 *
 * 第一版是一行 `在用 · 渠道 · 模型`。真机上它把输入区最下方那一行撑爆了：dock 是
 * `display:flex` 且**没有 flex-wrap**，四个元素（官方 activity / usage / 本胶囊 /
 * 右侧的上下文表）共处一行 ⇒ 长度是**相加**的，三枚文字胶囊**全部**被省略号截断
 * （实测截图：`20 ...` / `74.3...` / `在用 · CodeBuddy (`）。
 *
 * 竖排两行后，本胶囊的宽度从「渠道 + 模型」的**和**变成两者的**较大值**，
 * 约为原来的一半 —— 这是在不删信息的前提下最有效的腾地方方式。
 *
 * ## 内容口径（用户 2026-10-10 明确要求：上面供应商、下面模型名）
 *
 * | 情形 | 上行 | 下行 |
 * |---|---|---|
 * | 路由 provider + 有历史 | **真实**渠道 | **真实**模型 |
 * | 路由 provider + 无历史 | 选中的虚拟渠道 | `等待首次请求` |
 * | 非路由 provider | 选中渠道 | 选中模型 |
 *
 * ⚠️ 无历史时上行给的是**虚拟**渠道名（`聚合（跨渠道）`）而不是留空：留空会让胶囊
 * 变成只有一个「等待首次请求」的孤行，用户看不出它在等谁。下行那句占位正是它的注解。
 *
 * @param options.provider 目录快照里的当前 provider（可能为空）。
 * @param options.model 目录快照里的当前 model（虚拟名）。
 * @param options.route 宿主记录的真实路由（`{provider, model}` 或 null）。
 * @param options.providerLabel provider id → 展示名（注入的函数）。
 * @returns `{ top, bottom }`；**无选中模型时返回 `null`**（调用方据此不渲染）。
 */
export function describeActiveRoute({ provider, model, route, providerLabel }) {
  // 没有选中模型（新会话尚未选择 / 已寻址的 subagent 会话）→ 不渲染。
  if (typeof provider !== 'string' || provider.length === 0) return null;
  const label = typeof providerLabel === 'function' ? providerLabel : (id) => id;
  if (ROUTER_PROVIDER_IDS.includes(provider)) {
    const realProvider = route?.provider;
    const realModel = route?.model;
    // ⚠️ 两个字段都要是**非空字符串**才算有历史：宿主侧它们同生同灭
    //    （同一个 record 调用写入），半截数据不该渲染（宁可显示占位）。
    if (typeof realProvider === 'string' && realProvider.length > 0
      && typeof realModel === 'string' && realModel.length > 0) {
      return { top: label(realProvider), bottom: realModel };
    }
    return { top: label(provider), bottom: PENDING_LABEL };
  }
  // 非路由型：选中的就是真实模型（模型选择器里已显示，这里给出同源的两行读数）。
  if (typeof model !== 'string' || model.length === 0) return null;
  return { top: label(provider), bottom: model };
}

/** 悬停/无障碍用的完整说明（含记录时刻，便于判断读数是否新鲜）。 */
export function describeActiveRouteTitle({ route }) {
  const at = route?.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return '当前实际使用的渠道与模型';
  const time = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `当前实际使用的渠道与模型（更新于 ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}）`;
}

/**
 * 纯函数：弹层里逐行展示的「当前实际使用」明细。
 *
 * ## 为什么要有弹层（用户 2026-10-10 建议）
 *
 * 输入区最下方那一行在手机上是**四个元素挤一行**（dock 是 `display:flex`、
 * 无 `flex-wrap`），本胶囊无论怎么压缩都会占掉官方两枚统计胶囊的宽度。
 * 把**完整**读数放进按需展开的弹层后，胶囊本体只需两行短文本（渠道 / 模型），
 * 而「时刻」「虚拟名」这类次要但有用的信息仍有地方可看。
 *
 * ⚠️ 这里返回的是**数据**而不是渲染好的节点：文案判据要能被单测直接断言
 * （本仓库的单测不渲染组件）。渲染由组件负责。
 *
 * @returns 若干 `{ label, value }`；**无选中模型时返回空数组**（调用方本就不渲染）。
 */
export function describeActiveRouteDetails({ provider, model, route, providerLabel }) {
  if (typeof provider !== 'string' || provider.length === 0) return [];
  const label = typeof providerLabel === 'function' ? providerLabel : (id) => id;
  const rows = [];
  const isRouter = ROUTER_PROVIDER_IDS.includes(provider);
  const realProvider = route?.provider;
  const realModel = route?.model;
  const hasReal = typeof realProvider === 'string' && realProvider.length > 0
    && typeof realModel === 'string' && realModel.length > 0;

  if (isRouter && hasReal) {
    rows.push({ label: '渠道', value: label(realProvider) });
    rows.push({ label: '模型', value: realModel });
  } else if (isRouter) {
    rows.push({ label: '渠道', value: PENDING_LABEL });
    rows.push({ label: '模型', value: PENDING_LABEL });
  } else {
    rows.push({ label: '渠道', value: label(provider) });
    rows.push({ label: '模型', value: typeof model === 'string' && model.length > 0 ? model : '—' });
  }

  // 路由型才补这两行：直连时「选中的虚拟名」与「渠道」是同一个值，写了是重复。
  if (isRouter) {
    rows.push({ label: '选择', value: label(provider) });
    if (typeof model === 'string' && model.length > 0) rows.push({ label: '虚拟模型', value: model });
  }

  // 时刻只在新端点提供时才有（旧端点回落路径给的是 null）。
  const at = route?.at;
  if (typeof at === 'number' && Number.isFinite(at)) {
    const time = new Date(at);
    const pad = (value) => String(value).padStart(2, '0');
    rows.push({
      label: '更新于',
      value: `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`,
    });
  }
  return rows;
}

/**
 * 胶囊本体。
 *
 * @param props.resolveDirectory 惰性取目录（`{ store, load }`），宿主注入。
 * @param props.readActiveRoute `(provider) => Promise<{provider, model, at}>`，宿主注入。
 * @param props.providerLabel provider id → 展示名，宿主注入。
 */
export function ActiveModelPill(props) {
  const resolveDirectory = props.resolveDirectory;
  const readActiveRoute = props.readActiveRoute;
  const providerLabel = props.providerLabel;

  const [directory, setDirectory] = React.useState(null);
  // ⚠️ 「已解析就不再重跑」：宿主若每次渲染都重建 inject 返回对象，
  //    `resolveDirectory` 的函数身份就会变 → effect 反复重启 → 重试计时器被
  //    无限清除、永远解析不出来（比不重试还糟）。与用量徽标同一处事故、同一修法。
  const resolvedRef = React.useRef(false);
  const [route, setRoute] = React.useState(null);

  React.useEffect(() => {
    if (typeof resolveDirectory !== 'function') return undefined;
    if (resolvedRef.current) return undefined;
    let alive = true;
    const timers = [];
    let attempt = 0;
    // 「退避用尽」的 warn 只发一次（组件生命周期内）。
    let gaveUpWarned = false;
    const tryResolve = () => {
      if (!alive || resolvedRef.current) return;
      let resolved = null;
      try {
        resolved = resolveDirectory();
      } catch {
        // 失败不在此处上报 —— 重试全用尽时统一 warn 一次（避免刷屏）。
        resolved = null;
      }
      if (!alive) return;
      if (resolved !== null && resolved !== undefined && resolved.store !== undefined) {
        resolvedRef.current = true;
        setDirectory(resolved.store);
        // ⚠️ 必须自己调 load()，见文件头的坑 2。
        if (typeof resolved.load === 'function') {
          Promise.resolve(resolved.load()).catch(() => {
            // 目录 load 失败只让本胶囊降级（不渲染），不影响会话输入区。
          });
        }
        return;
      }
      attempt += 1;
      if (attempt >= RESOLVE_RETRY_DELAYS.length) {
        // ⚠️⚠️ **不再「安静放弃」**（与用量徽标同一缺陷、同一修复，2026-10-11）：
        // 对话开始的流式期 RPC 拥塞会让 4.5 秒显式退避全部失败 ⇒ 胶囊整块消失
        // 且直到组件重挂载都不回来（用户报障「正式开始调用的时候，胶囊又没有了」）。
        // ⇒ 退化为每 5 秒的常驻低频重试（纯内存读，成本可忽略），成功即恢复。
        if (!gaveUpWarned) {
          gaveUpWarned = true;
          console.warn('[jet-hub pill] 目录解析显式退避用尽，转常驻低频重试（每 5s）');
        }
        timers.push(setTimeout(tryResolve, PERSISTENT_RETRY_MS));
        return;
      }
      timers.push(setTimeout(tryResolve, RESOLVE_RETRY_DELAYS[attempt - 1]));
    };
    tryResolve();
    return () => {
      alive = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [resolveDirectory]);

  // ⚠️ 三个回调都包 try/catch：`resolveDirectory()` 求值成功**不等于**
  //    `subscribe` / `getSnapshot` 不抛（惰性 getter 的真正求值可能推迟到订阅时）。
  //    抛出会打崩宿主渲染树（表现为模型选择器点不动），故只安静降级。
  const safe = (fn) => () => {
    try {
      return directory ? fn(directory) : undefined;
    } catch {
      return undefined;
    }
  };
  const state = React.useSyncExternalStore(
    (onChange) => {
      if (!directory) return () => {};
      try {
        return directory.subscribe(onChange);
      } catch {
        return () => {};
      }
    },
    safe((d) => d.getSnapshot()),
    safe((d) => d.getSnapshot()),
  );

  const provider = state?.current?.provider;
  const model = state?.current?.model;
  const isRouter = typeof provider === 'string' && ROUTER_PROVIDER_IDS.includes(provider);

  /**
   * 取「本次实际发往的目标」并**周期性重试**。
   *
   * ⚠️ 定时器**常驻**、不能「取到值就停」（与徽标同一条教训）：路由层换了候选之后
   * 宿主记录会变，而只有重新取数才拿得到新值；停了就永远停在第一次那个值上。
   *
   * ⚠️ 失败**安静降级**（清空读数 → 显示占位）：这是可选装饰，为它弹错会让
   * 会话输入区出现无意义的错误（与徽标同一取向）。
   */
  React.useEffect(() => {
    if (!isRouter || typeof readActiveRoute !== 'function') return undefined;
    let alive = true;
    let timer = null;
    const refresh = () => {
      Promise.resolve()
        .then(() => readActiveRoute(provider))
        .then((value) => {
          if (!alive) return;
          setRoute(value && typeof value.provider === 'string' ? value : null);
        })
        .catch(() => {
          if (alive) setRoute(null);
        });
    };
    refresh();
    timer = setInterval(refresh, ACTIVE_ROUTE_POLL_MS);
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
    };
    // ⚠️ 依赖 `provider`：切换模型后要立刻重取（不等下一个 5 秒）。
  }, [isRouter, provider, readActiveRoute]);

  const text = describeActiveRoute({ provider, model, route, providerLabel });

  /**
   * 弹层开关（点一下胶囊展开完整读数）。
   *
   * ⚠️⚠️ **这些 Hook 必须全部排在 `text === null` 的提前返回之前**（React 的
   * 规则：每次渲染的 Hook 数量与顺序必须一致）。我第一版把 `if (text === null)
   * return null` 写在它们上面 —— 于是「有选中模型」与「无选中模型」两种渲染的
   * Hook 数不同，React 会在切换会话时抛
   * `Rendered more hooks than during the previous render`，
   * 而那个异常发生在**会话输入区的渲染路径**上 ⇒ 整个输入区白屏。
   * ⇒ 现在把唯一的提前返回放到文件末尾（所有 Hook 之后）。
   */
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const pos = useAnchoredPosition(rootRef, panelRef, open);

  // Escape / 点击外部关闭（与官方 stat 弹层同语义；手机上点外部是最自然的关法）。
  React.useEffect(() => {
    if (!open) return undefined;
    // ⚠️ 同 `useAnchoredPosition`：这个 effect 也在渲染提交路径上，无 DOM 的夹具
    //    里 `document` 未定义会直接抛 ⇒ 打崩整个输入区。故先判存在性。
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event) => {
      const target = event.target;
      if (target instanceof Node
        && rootRef.current?.contains(target) !== true
        && panelRef.current?.contains(target) !== true) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  // ⚠️ 目录或宿主读数一变就收起弹层：否则弹层里会停着一个**过期**的模型名，
  //    而它看起来与实时读数一样权威 —— 比不显示更误导。
  React.useEffect(() => {
    setOpen(false);
  }, [provider, model, route?.provider, route?.model]);

  const rows = describeActiveRouteDetails({ provider, model, route, providerLabel });

  // ⚠️ **唯一的提前返回，必须在所有 Hook 之后**（见上面那段注释：Hook 顺序）。
  if (text === null) return null;

  return React.createElement(
    'span',
    { ref: rootRef, className: 'dim-jh-routePillRoot', 'data-jet-hub-active-model': true },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dim-jh-routePill',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': describeActiveRouteTitle({ route }),
        title: describeActiveRouteTitle({ route }),
        onClick: () => setOpen(!open),
      },
      // 两行竖排：上行渠道、下行模型。
      //
      // ⚠️ 不渲染「在用」前缀 —— 第一版那个前缀加上「 · 」分隔符在窄屏上占掉
      // 一大截宽度，而槽位本身（输入区最下方）已足以说明这是「当前」状态。
      React.createElement('span', { className: 'dim-jh-routePillTop' }, text.top),
      React.createElement('span', { className: 'dim-jh-routePillBottom' }, text.bottom),
    ),
    open && typeof document !== 'undefined' && createPortal(
      React.createElement(
        'div',
        {
          ref: panelRef,
          className: 'dim-jh-routePanel',
          role: 'dialog',
          'aria-label': '当前实际使用的渠道与模型',
          style: pos ?? MEASURE_STYLE,
        },
        React.createElement('div', { className: 'dim-jh-routePanelTitle' }, '当前实际使用'),
        React.createElement(
          'dl',
          { className: 'dim-jh-routePanelRows' },
          ...rows.flatMap((row) => [
            React.createElement('dt', { key: `${row.label}-k` }, row.label),
            React.createElement('dd', { key: `${row.label}-v` }, row.value),
          ]),
        ),
      ),
      document.body,
    ),
  );
}
