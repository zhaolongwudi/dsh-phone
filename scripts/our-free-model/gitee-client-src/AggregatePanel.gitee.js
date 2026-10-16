function AggregatePanel({ rpcCall }) {
  const [models, setModels] = React.useState(null);
  const [rejections, setRejections] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  /** 每个虚拟模型的展开态（`canonicalId → 用户点过的布尔`）。 */
  const [expanded, setExpanded] = React.useState({});
  /**
   * 排序模式（`'expiry'` / `'manual'`）—— **权威在宿主**。
   *
   * ⚠️ 进入面板时用 `aggregate.catalog` 响应的 `orderMode` 初始化，切换时**先发
   * `aggregate.setOrderMode` 再改本地 state**：先改本地会让落盘失败时面板与宿主分叉，
   * 用户下次打开面板才发现模式变回去了（比报错更难查）。
   * ⚠️ **不得**用「顺序表非空」推导它：用户可以切到手工模式却一条都没拖过
   *（那时两种模式行为相同，但面板该显示「按手工」= 用户选的那个）。
   */
  const [orderMode, setOrderMode] = React.useState('expiry');
  /**
   * 拖动中**尚未落盘**的临时顺序（`canonicalId → 键数组`）。
   *
   * ⚠️ 拖动结果先落在这里、松手后统一提交一次：每次 `dragover` 都发 RPC 会在一次拖动里
   * 打出几十个请求（`commitOrder` 才发）。
   */
  const [pendingOrder, setPendingOrder] = React.useState({});
  /** 落盘 in-flight 闸门（防连点 / 连拖造成竞态：后发的响应先到会覆盖新的顺序）。 */
  const [orderBusy, setOrderBusy] = React.useState({});
  /** 一键「拒绝非临期」的 in-flight 闸门。 */
  const [rejectBusy, setRejectBusy] = React.useState(false);
  /** 按临期排序上次探测的时刻（工具行显示「N 分钟前」；null = 还没探过）。 */
  const [lastProbeAt, setLastProbeAt] = React.useState(null);

  /**
   * 拉取目录。
   *
   * ⚠️ 失败时**保留**旧数据、只把错误放进 notice（不要清空成 null）——
   * 清空会让面板闪成空白，用户以为「聚合坏了」，而真实原因只是一次读取失败。
   *
   * @param {boolean} force - **绕过宿主侧的目录 TTL 缓存**（60 秒）。
   *   ⚠️ 真实缺陷（对抗审计实测证伪）：初版**恒不传 force** ⇒ 「刷新」按钮实际是
   *   「读缓存」，用户在渠道侧新增/关闭模型后点刷新**看不到任何变化**，会以为
   *   聚合坏了。⇒ 挂载时走缓存（`false`），**用户显式点刷新**时传 `true`。
   * @param {{ keepNotice?: boolean }} [options]
   *   `keepNotice: true` ⇒ **成功时不清空 notice**。
   *   ⚠️⚠️ 真实缺陷（用户验收 2026-10-16：「拒绝后给出的提示信息不到 1 秒就消失了
   *   基本不会看清内容」）：调用方先 `setNotice('已把 N 条…恢复为…')`，紧接着
   *   `await load(true)`，而本函数成功分支里那行 `setNotice(null)` **把刚写的提示
   *   清掉了** ⇒ 用户只看到不到 1 秒（甚至看不到）。
   *   ⇒ 凡「先写提示、再刷新」的调用方都必须传 `keepNotice: true`。
   *   ⚠️ 默认（省略）仍是**清空** —— 那是「用户主动点刷新」的既有语义
   *   （刷新后旧的错误提示该消失），不改它以免影响既有行为。
   */
  const load = React.useCallback(async (force = false, options = {}) => {
    setBusy(true);
    try {
      // ⚠️⚠️ **必须传对象而非省略 payload**（真实缺陷，用户报障
      //    「读取聚合目录失败：Error: Invalid Jet Hub management request.」）：
      //    `callManagementRpc` 把 payload 序列化进请求体，而**后端校验要求
      //    payload 键存在**（`jet-hub-rpc.ts` 的
      //    `hasOwnProperty.call(call, 'payload')`）；传 undefined 会被 JSON
      //    序列化**丢弃** ⇒ 后端判为非法请求并回 `Invalid Jet Hub management request.`。
      //    本文件 `backup.export` 处早有同款注释（同一个坑的第二实例）。
      const res = await rpcCall('aggregate.catalog', { force });
      // ⚠️⚠️ **`rpcCall` 成功时返回的是「解包后的值」，不是 `{ok, value}`**
      //    （真实缺陷，第二次报障）：`index.js` 的 rpcCall =
      //    `unwrapRpcResult(callManagementRpc(...))`，而
      //    `unwrapRpcResult` 在 `ok === true` 时返回 `result.value`、
      //    在 `ok === false` 时**抛错**（`throw new Error(error.message)`）。
      //    ⇒ 写 `res.ok === true` 判断**永远为假**（res 是解包后的对象，没有 ok 字段）
      //      ⇒ 界面显示兜底文案「读取聚合目录失败」且**丢掉真实原因**（因为
      //      `res.error.message` 也是 undefined）。这正是用户第二次看到的现象。
      //    ⇒ 正确写法：直接用 `res.models`，错误一律走 `catch` 的 `caught.message`。
      //    既有调用点都是这个形状（如 `model.list` 用 `res.models`、
      //    `backup.export` 用 `res.payload`）。
      const models = res?.models ?? [];
      setModels(models);
      // ⚠️ 排序模式的**权威在宿主**（响应里的 `orderMode`）。缺字段（老宿主）⇒ 临期序。
      setOrderMode(res?.orderMode === 'manual' ? 'manual' : 'expiry');
      // ⚠️⚠️ **必须把宿主返回的 `rejected` 回填进本地拒绝表**（真实缺陷，
      //    对抗审计探针实测证伪）：宿主在每个候选上返回 `rejected: boolean`
      //   （`src/aggregate-adapter.ts` 的 `describeCatalog`），而初版**从不读它** ——
      //    组件读的是本地 `rejections` 状态，其初值是 `{}` 且 `load()` 从不回填。
      //    ⇒ **刷新页面后每条开关都显示「参与轮换」**（即使该候选已被拒绝）：
      //      用户无法通过界面判断自己拒绝过什么；而一点击就会发出一个与宿主
      //      真实状态相反的语义 ⇒ **静默改变轮换行为**。
      //    ⇒ 摊平逻辑在纯函数 `rejectionsFromCatalog` 里（单测环境没有 react），
      //      其三层结构与 `isRejected` 逐层一致（否则回填静默失效）。
      //    ⚠️ 2026-10-15 起该函数**还看 `state`**：`rejected` 的语义已收窄为
      //      「当前不参与轮换」，只有 `state === 'rejected'` 才是用户显式拒绝 ——
      //      否则未接入渠道的「默认不参与」会在面板上被显示成「已拒绝」（用户在撒谎的界面里）。
      setRejections(rejectionsFromCatalog(models));
      // ⚠️ 重拉目录后**丢弃**拖动中的临时顺序：宿主刚下发的 `model.order` 才是权威
      //    （保留临时值会让「刷新」看起来没生效）。
      setPendingOrder({});
      // ⚠️ `keepNotice` 时**保留**调用方刚写的提示（见 options 的注释）。
      if (options.keepNotice !== true) setNotice(null);
    } catch (caught) {
      // ⚠️ `caught.message` 才是服务端给的**真实原因**（如
      //    「聚合 provider 未注册或未提供目录」）—— 不要吞掉它只显示兜底文案。
      setNotice(`读取聚合目录失败：${caught?.message ?? String(caught)}`);
    } finally {
      setBusy(false);
    }
  }, [rpcCall]);

  React.useEffect(() => { void load(); }, [load]);

  /**
   * 切换某条候选的「参与轮换」开关。
   *
   * ⚠️⚠️ **写哪张表由纯函数 `candidateToggleAction` 决定**（"点哪张表"的唯一判据）：
   *    未接入渠道的「不参与」与「拒绝」**同义** ⇒ 关掉它必须写**白名单**（回到默认态），
   *    写拒绝表会留下一批永不起作用的条目、并污染「拒绝非临期」的计数。
   *    **不得**在这里按 `expiryWired` 再分一次支（本仓库「两套同义判据」红线）。
   */
  const onToggleCandidate = React.useCallback(async (model, candidate) => {
    const { rpc, payload } = candidateToggleAction(model.canonicalId, candidate, {
      // ⚠️ 传**回退后**的三态：老宿主（响应无 `state`）下按终端的拒绝表判，
      //    于是只会发出老宿主认识的 `aggregate.setRejected`（它没有 `setAllowed` 端点）。
      state: candidateStateOf(model.canonicalId, candidate, rejections),
    });
    // ⚠️ 乐观更新（仅更**拒绝表**那一半）：先用纯函数算出新表并立刻渲染，再发 RPC。
    //    失败时用服务端状态纠正（见下）—— 否则开关会「点了不动」，用户以为坏了。
    //    ⚠️ 白名单侧的乐观更新**不做**：客户端只回填拒绝表（与既有机制一致），
    //    白名单由随后的 `load(true)` 重新摊平 —— 两边都乐观改会出现两份状态。
    if (rpc === 'aggregate.setRejected') {
      setRejections((prev) => toggleRejection(
        prev, model.canonicalId, candidate.provider, candidate.realId, payload.rejected,
      ));
    }
    try {
      await rpcCall(rpc, payload);
      // ⚠️⚠️ **不要用 `res.aggregateRejections` 直接覆盖本地表**（真实缺陷，对抗审计实测证伪）。
      //
      // `aggregate.setRejected` 返回的是 `pool.listAggregateRejections()` —— 那是
      // **原始存储表**（只含用户逐条写入的 realId），而**轮换实际用的是 `rejectedFor`**：
      // 它还会把「漂移的旧 id」**降级展开**成渠道级拒绝（D4，见 `aggregate-adapter.ts`）。
      //
      // ⇒ 用原始表覆盖会让**开关显示与宿主行为分叉**：降级态下
      //   `isRejected(原始表, 当前 realId) === false` ⇒ 开关显示「参与轮换」，
      //   而宿主**实际仍拒绝**该候选 ⇒ 用户看不出原因也无法自救。
      //
      // ⇒ 改为**重新拉目录**（`aggregate.catalog` 的每个候选都带经 `rejectedFor`
      //   展开后的 `state`），显示与轮换判据**同源**。
      //   ⚠️ `load()` 内部已含 `setRejections(rejectionsFromCatalog(models))`，
      //   故不必在这里再摊平一次。
      // ⚠️ 必须 force = true：load() 默认走宿主侧目录 TTL 缓存（60 秒），
      //    那样拿到的仍是**写之前**的候选表 ⇒ 开关会「点了不动」。
      await load(true, { keepNotice: true });
      // ⚠️ 这里**已经**在 load 之后写了「成功」的语义（`load` 内部会清 notice），
      //    故不传 `keepNotice` —— 本路径没有「先写提示再刷新」的时序问题。
      setNotice(null);
    } catch (caught) {
      // ⚠️ 失败时用服务端状态**纠正**乐观更新（否则界面显示已改、实际没改）。
      setNotice(`保存失败：${caught?.message ?? String(caught)}`);
      // ⚠️ 失败路径**必须** keepNotice（否则 load() 会把刚写的失败原因清掉，
      //    用户看到的是「点了没反应」而不是「保存失败：…」）。
      await load(false, { keepNotice: true });
    }
  }, [rpcCall, load]);

  /**
   * 「按临期排序」的探测结果（`provider → expiry`）；null = 还没探过。
   *
   * ⚠️ 默认**不探测**：临期顺序要逐渠道打一次上游余额请求，而面板一打开就探测
   * 是不可接受的（规格 §8.3 要求 `aggregate.catalog` 零余额查询）。
   * ⇒ 挂载时不探；用户切/点「按临期」才探，且该模式下每 2 分钟自动重探一次。
   *
   * ⚠️ **声明位置在 `onSelectOrderMode` 之前**：那个回调的依赖数组引用了本函数
   *（`const` 的 TDZ 会让「声明在后」在**首次渲染**就抛 `Cannot access before initialization`
   *  —— 而不是等到用户点击时才暴露）。
   */
  const [expiryOrder, setExpiryOrder] = React.useState(null);
  const [expiryBusy, setExpiryBusy] = React.useState(false);
  const onSortByExpiry = React.useCallback(async () => {
    setExpiryBusy(true);
    try {
      // ⚠️ 与 `load` 同款：`rpcCall` 成功返回**解包后的值**（`{ order }`），失败抛错。
      //    不写 `res.ok` 判断（它永远为假，会丢掉真实原因）。
      // ⚠️ `force: true`：**绕过探针自己的 60 秒折算缓存**。用户点「刷新临期顺序」
      //    期待的是真重查；传 false 会让「每 2 分钟自动重探」实际读 60 秒缓存
      //    （用户改了渠道侧配置后要等更久）。
      const res = await rpcCall('aggregate.expiryOrder', { force: true });
      setExpiryOrder(res?.order ?? {});
      setLastProbeAt(Date.now());
      setNotice(null);
    } catch (caught) {
      // ⚠️ 探测失败**不清空**已有顺序，只提示（与 `load` 的失败处理同取向）。
      setNotice(`读取临期顺序失败：${caught?.message ?? String(caught)}`);
    } finally {
      setExpiryBusy(false);
    }
  }, [rpcCall]);

  /**
   * 切换排序模式（顶部 toggle）。
   *
   * ⚠️ **先发 RPC 再改本地 state**：反过来会让落盘失败时面板显示新模式、宿主仍用旧模式
   *（用户下次打开才发现，且中间这段时间「拖了排序不生效」）。
   *
   * ## ⚠️⚠️ 只有切到「按临期」才探测（真实缺陷，用户验收 2026-10-16）
   *
   * 用户原话：「4C 是不覆盖但是有 2 个问题，切换会手工还在查询中等很长时间，
   * **手工排序不用查询吧**？」
   *
   * 根因：本函数原先**无条件** `await onSortByExpiry()` —— 那是**逐渠道上游余额
   * 请求**（十几个 GET），于是切到手工模式也要干等一轮探测。而手工模式的价值恰恰
   * 是「按用户拖的顺序」—— 切过去的那一刻**不需要**任何临期值。
   *
   * ⚠️ 那为什么原来要探？因为手工模式下**没拖过的尾巴**仍按临期排序
   *（`manualRankOf` 对未排过的返回 `undefined` ⇒ 回落临期↓倍率）。但那是
   * **尾部次序的精细度**问题，不是「切模式能不能用」的问题：
   *   - 未探测时 `expiryOf` 返回 `undefined` ⇒ 尾部按**目录序**（与「按渠道名」
   *     那个已删的口径同源）—— 仍然是一个稳定的顺序；
   *   - 用户真正拖过的位次**完全不受影响**（手工位次是严格序，不看临期）。
   * ⇒ 探针留给「按临期」模式（那个模式的存在意义就是它），以及用户**手动**点按钮。
   *   顺带省掉十几个上游请求。
   */
  const onSelectOrderMode = React.useCallback(async (mode) => {
    if (mode === orderMode) {
      // 已经是该模式：再点就是「重新探测」（用户在按临期模式下想刷新顺序）。
      await onSortByExpiry();
      return;
    }
    try {
      const res = await rpcCall('aggregate.setOrderMode', { mode });
      setOrderMode(res?.orderMode === 'manual' ? 'manual' : 'expiry');
      // ⚠️ 这里**刻意清空**（不是 keepNotice）：本路径没有「先写提示再刷新」的时序
      //    问题 —— `setNotice(null)` 在 `load` **之前**，语义是「切模式时丢掉旧提示」。
      //    ⚠️ 我修「提示被清」那个缺陷时曾误给这一处也加了 `keepNotice`，
      //    那会让**上一次操作**的无关提示被保留下来（改成「保留 null」等于没清）。
      setNotice(null);
      await load(true);
      // ⚠️⚠️ **只在切到「按临期」时探测**（见上方长注释）：手工模式不查上游。
      //    切到手工时若已有临期数据（用户从按临期切过来）就继续用，不清空 ——
      //    那能让「未拖过的尾巴」仍按真实临期排，且零额外请求。
      if (mode === 'expiry') await onSortByExpiry();
    } catch (caught) {
      setNotice(`切换排序方式失败：${caught?.message ?? String(caught)}`);
    }
  }, [orderMode, rpcCall, load, onSortByExpiry]);

  /**
   * 「按临期」模式下每 2 分钟自动重探一次（用户 2026-10-15 的追问：
   * 「按临期排序的顺序应该后台定时刷新现在有吗？」—— 答复是**没有**，这里补上）。
   *
   * ⚠️ 三条约束缺一不可：
   *  ① **只在按临期模式**轮询：手工模式的顺序由用户决定，探针只用于给未拖过的尾巴排序，
   *     变了也不会改用户已拖过的位次（轮询纯属浪费上游请求）；
   *  ② **页面隐藏时跳过这一轮**（`document.hidden`）：后台标签页持续打上游是不可接受的；
   *  ③ **卸载时 clearInterval**：面板是设置页的组件，反复进出会叠加定时器
   *    （叠加 N 个 ⇒ 上游请求量 ×N，且只在长时间挂着时才看得出来）。
   * ⚠️ 与手动点击**共用** `expiryBusy` 闸门：并发探测会把上游打爆。
   *
   * ## ⚠️ 2026-10-16：三条判据**搬到纯函数**里（本条原先长期零用例）
   *
   * 用户追问「重探怎么测」时核实：全仓库对这条的断言数为 **0**，因为实现
   * 内联在组件里、单测环境没有 react ⇒ **够不到**。
   * ⇒ 抽到 `aggregate-panel-logic.js` 的 {@link startExpiryReprobe}（挂定时器 +
   * 返回 cleanup）与 {@link shouldReprobeExpiry}（该不该发这一轮）。本处只留接线，
   * **判据全部在那两个纯函数里**（`schedule`/`cancel` 注入 ⇒ 单测能用假定时器真跑
   * 「到点轮询」并断言 cleanup 真的停了定时器）。
   *
   * ⚠️ 接线必须传**真的** `setInterval` / `clearInterval`，且 `isHidden` 传
   * **取值函数**（隐藏状态会在两轮之间变化，传快照会判错）。
   */
  React.useEffect(() => startExpiryReprobe({
    orderMode,
    intervalMs: AGG_EXPIRY_REPROBE_MS,
    isHidden: () => typeof document !== 'undefined' && document.hidden === true,
    probe: () => { void onSortByExpiry(); },
  }), [orderMode, onSortByExpiry]);

  /**
   * 一键「拒绝非临期」：把所有未接入折算渠道的手工打开恢复为「默认不参与」。
   *
   * ⚠️ 文案**分两路**（`cleared === 0` 时不许说「已恢复 N 条」）：空点击是**幂等成功**，
   *    不是错误 —— 用户连点两次看到「没有需要恢复的候选」才是正确的反馈。
   */
  const onRejectNonExpiring = React.useCallback(async () => {
    setRejectBusy(true);
    try {
      const res = await rpcCall('aggregate.rejectNonExpiring', {});
      const cleared = typeof res?.cleared === 'number' ? res.cleared : 0;
      setNotice(cleared === 0
        ? '没有需要恢复的候选：无临期积分的渠道本来就都在「默认不参与」状态。'
        : `已把 ${cleared} 条候选恢复为「默认不参与轮换」。`);
      // ⚠️⚠️ **必须 `keepNotice: true`**（真实缺陷，用户验收 2026-10-16：
      //    「拒绝后给出的提示信息不到 1 秒就消失了基本不会看清内容」）：
      //    上面刚写了提示，而 `load()` 成功分支里的 `setNotice(null)` 会把它清掉。
      await load(true, { keepNotice: true });
    } catch (caught) {
      setNotice(`恢复默认失败：${caught?.message ?? String(caught)}`);
    } finally {
      setRejectBusy(false);
    }
  }, [rpcCall, load]);

  /** 某模型当前生效的顺序数组（临时值优先，缺省用宿主下发的 `order`）。 */
  const orderOf = (model) => pendingOrder[model.canonicalId] ?? model.order ?? [];

  /**
   * 把拖动结果落盘（**整体提交**，见 `pendingOrderFromRoster`）。
   *
   * ⚠️ 用**服务端返回的权威数组**覆盖本地临时顺序（不是本地回声）：
   *    服务端会过滤掉「不再是候选」的脏键并去重，客户端据此校正才不会长期分叉。
   * ⚠️ `orderBusy` 闸门按模型隔离：拖 A 的同时拖 B 不该互相阻塞，但同一个模型
   *    连拖两次必须串行（后发的响应先到会覆盖新的顺序）。
   */
  const commitOrder = React.useCallback(async (model, participating) => {
    if (orderBusy[model.canonicalId] === true) return;
    setOrderBusy((prev) => ({ ...prev, [model.canonicalId]: true }));
    try {
      const order = pendingOrderFromRoster(participating);
      const res = await rpcCall('aggregate.setOrder', { canonicalId: model.canonicalId, order });
      setPendingOrder((prev) => ({ ...prev, [model.canonicalId]: res?.order ?? [] }));
      setNotice(null);
    } catch (caught) {
      setNotice(`保存顺序失败：${caught?.message ?? String(caught)}`);
      // ⚠️ 失败时丢弃临时顺序（回到宿主下发的权威值），否则面板会显示一份
      //    宿主**并不知道**的顺序 —— 那是显示与行为分叉。
      setPendingOrder((prev) => {
        const next = { ...prev };
        delete next[model.canonicalId];
        return next;
      });
    } finally {
      setOrderBusy((prev) => ({ ...prev, [model.canonicalId]: false }));
    }
  }, [orderBusy, rpcCall]);

  /** 拖动中的源键（跨 dragover 传递；只在组件内用，不进 state）。 */
  const dragKeyRef = React.useRef(null);

  const renderCandidate = (model, candidate, options = {}) => {
    const canonicalId = model.canonicalId;
    // ⚠️ 传**回退后**的三态（见 candidateStateOf）：老宿主下也能显示正确的开关文案
    //    与「已拒绝」，而不是让用户看到「状态未知」。
    const resolvedState = { state: candidateStateOf(canonicalId, candidate, rejections) };
    const state = describeCandidateState(candidate, resolvedState);
    // ⚠️ 临期顺序**只在探测过之后**才有值；未探测时按原顺序（渠道名字母序）。
    const expiry = expiryOrder === null ? undefined : expiryOrder[candidate.provider];
    // ⚠️ 未参与的候选整行淡化（与升级前「已拒绝」的视觉一致），但**仍可点**（那是恢复路径）。
    const inactive = candidateStateOf(canonicalId, candidate, rejections) !== 'allowed';
    const draggable = options.draggable === true;
    return React.createElement('div', {
      className: 'dim-jh-aggCandidate'
        + (inactive ? ' dim-jh-aggCandidateRejected' : '')
        + (options.dragOver === true ? ' dim-jh-aggDragOver' : ''),
      key: `${candidate.provider}\u0000${candidate.realId}`,
      // ⚠️ 只有**参与轮换**的候选可拖（见 `rotationRosterOf` 的说明）。
      draggable: draggable,
      onDragStart: draggable
        ? (event) => {
            dragKeyRef.current = candidateKeyOf(candidate);
            // ⚠️⚠️ **必须 `setData`，否则拖拽根本不触发**（真实缺陷，用户验收实测：
            //    「拖动好像是不生效的」）。本仓库另两处拖动（账号卡片、渠道开关）
            //    都有这一行并各自注明「Firefox 不触发拖拽」—— 我第一版漏了它，
            //    于是只在「上下箭头」路径能改序，鼠标拖拽整个失效。
            try { event.dataTransfer.setData('text/plain', candidateKeyOf(candidate)); } catch { /* 忽略 */ }
            if (event?.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move';
          }
        : undefined,
      // ⚠️ `onDragEnd` 必须清引用：拖到无效区域（或按 Esc 取消）时不会有 `drop`，
      //    残留的 `dragKeyRef` 会让**下一次** hover 到别的行时被当成「正在拖」而 preventDefault。
      onDragEnd: draggable ? () => { dragKeyRef.current = null; } : undefined,
      onDragOver: draggable
        ? (event) => {
            if (dragKeyRef.current === null) return;
            // ⚠️ 必须 preventDefault，否则浏览器不允许 drop（与仓库另两处拖动同因）。
            event.preventDefault();
            if (event?.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move';
          }
        : undefined,
      onDrop: draggable
        ? (event) => {
            event.preventDefault();
            const from = dragKeyRef.current;
            dragKeyRef.current = null;
            if (from === null) return;
            // ⚠️ 拖动结果先落**本地临时顺序**（立即重渲染），**紧接着就提交**。
            //
            // ⚠️⚠️ **必须在 `onDrop` 里直接提交**（真实缺陷，用户验收 2026-10-16：
            //    「把 codearts 拉到第一个，关闭设置窗口再打开又跑最后一个了」）。
            //
            // 我原先只在 `onDrop` 里 `setPendingOrder(...)`、把落盘交给一个
            // **「保存顺序」按钮**，于是：拖动**只改了界面**，宿主的
            // `state.json.aggregateOrder` 一个字都没变 ⇒ 关窗再打开（重新 `load`）
            // 就回到宿主的旧顺序 —— 用户看到的正是「白拖了」。
            //
            // ⚠️ 本仓库另两处拖动（账号卡片 `:3555`、渠道开关 `:4746`）都是
            // **松手即提交**（`onDrop` 里直接 `void commit(...)`）⇒ 我那个
            // 「先预览、再点保存」的设计与全站交互不一致，**是本缺陷的根源**。
            // ⇒ 改为同一形态：松手即落盘（一次拖动只发**一个**请求 —— 每次
            //    `dragover` 都发才会打出几十个）。
            const next = moveCandidateTo(orderOf(model), from, options.index);
            setPendingOrder((prev) => ({ ...prev, [canonicalId]: next }));
            // ⚠️ 提交用**拖后顺序对应的候选对象**（`commitOrder` 要参与候选的完整顺序）。
            const byKey = new Map((model.candidates ?? []).map((c) => [candidateKeyOf(c), c]));
            const participatingNext = next
              .map((key) => byKey.get(key))
              .filter((c) => c !== undefined)
            // ⚠️ 补上「顺序表里没出现但确实参与」的候补（与 `commitOrder` 的前置一致）：
            //    漏掉会让服务端把未出现的候选按临期兜底追加 ⇒ 用户刚排好的相对位置被改。
            for (const candidate of model.candidates ?? []) {
              if (candidateStateOf(canonicalId, candidate, rejections) !== 'allowed') continue
              const key = candidateKeyOf(candidate)
              if (!next.includes(key)) participatingNext.push(candidate)
            }
            void commitOrder(model, participatingNext);
          }
        : undefined,
    },
    // ⚠️ 拖动手柄**显式**给出（HTML5 拖动的一个已知可用性坑）：
    //    整行可拖时用户不知道能拖；且手柄能承载 title 说明「拖到哪」。
    draggable
      ? React.createElement('span', {
          className: 'dim-jh-aggDragHandle',
          title: '按住拖动以调整这个模型的候选顺序',
          'aria-hidden': 'true',
        }, '⠿')
      : null,
    React.createElement('span', { className: 'dim-jh-aggCandidateLabel' },
      candidateRowLabel(candidate)),
    // ⚠️ 只有探测过才显示到期提示 —— 否则显示「到期未知」会让用户以为查过了。
    expiry === undefined
      ? null
      : React.createElement('span', {
          className: 'dim-jh-aggCandidateExpiry',
          title: '按临期排序时算出的到期时刻',
        }, expiryLabel(expiry)),
    // ⚠️⚠️ **不再渲染「无临期积分 · 未参与」这段文字**（用户 2026-10-16 验收要求）：
    //    「图1红框中的内容可以不用显示」。未参与的状态由**整行淡化**
    //   （`dim-jh-aggCandidateRejected`）与开关本身的文案表达，行里再挂一遍是冗余。
    //    ⚠️ 开关按钮**保留**它的文案与 title（那是三态的**唯一**出口，
    //    去掉用户就无从知道该点还是不点）。
    // ⚠️ 上移 / 下移按钮**已删除**（用户明确要求：「我们不应该有上下箭头就是应该
    //    鼠标拖动」）。键盘可达性由开关与展开区承担；拖动走 HTML5 drag（已修
    //    `setData` 那一处，见 `onDragStart`）。
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-aggToggle' + (state.pressed ? '' : ' dim-jh-aggToggleOff'),
      // ⚠️ 语义是「**参与**轮换」的正向开关：打开 = 允许用这个渠道（规格 §7.1 的原话）。
      // ⚠️ 文案与 title 来自纯函数（三态 + 「已打开的未接入渠道排在最后」的说明）。
      'aria-pressed': String(state.pressed),
      title: state.title,
      onClick: () => { void onToggleCandidate(model, candidate); },
    }, state.label));
  };

  const renderModel = (model) => {
    const open = expanded[model.canonicalId] === true;
    // ⚠️ 排序模式决定用哪套判据：
    //    - `expiry`：**保持升级前的单列表**（全部候选、按临期或字母序），不动信息架构；
    //    - `manual`：两段式（参与 / 未参与），只有参与段可拖动。
    const manual = orderMode === 'manual';
    const rankMap = manual
      ? new Map(orderOf(model).map((key, index) => [key, index]))
      : null;
    const expiryOf = (provider) => (expiryOrder === null ? undefined : expiryOrder[provider]);
    const { participating, inactive } = rotationRosterOf(model, rankMap, expiryOf, rejections);
    const candidates = manual
      ? participating
      : (expiryOrder === null
          ? model.candidates
          : sortCandidatesByExpiry(model.candidates.map((c) => ({
              ...c, expiry: expiryOrder[c.provider],
            }))));
    const blocker = rotationBlockerOf(model, rejections);
    // ⚠️⚠️ 帽子必须**极短**（用户 2026-10-16 验收：「图1中的无临期积分 默认不参与占太宽了
    //    把模型名字都挤没了，需要缩短提示」）⇒ 一律 ≤ 5 个汉字。
    //    解释性文字全部移进 `title`（hover 才看）—— 帽子只承担「这个模型现在有问题」
    //    这一个信号。用户选定的文案是「无临期全拒」。
    //    ⚠️ `all-rejected` 那一档的**语义与恢复指引不得丢**（规格 §5.2 明文要求
    //    「面板需对候选全被拒给出显式提示」），故 title 里保留完整指引。
    const blockerNode = blocker === 'all-rejected'
      ? React.createElement('span', {
          className: 'dim-jh-aggAllRejected',
          title: '你把该模型的全部候选都关了「参与轮换」——请求会如实报「没有任何可用候选」。'
            + '若想恢复，展开后在子列表里重新打开至少一条。',
        }, '全部被拒')
      : blocker === 'all-default'
        ? React.createElement('span', {
            className: 'dim-jh-aggAllRejected',
            title: '该模型的候选都来自没有临期积分折算的渠道，默认不参与轮换。'
              + '展开后可以逐条手工打开（打开后它们排在所有能算出临期的候选之后）。'
              + '在打开之前，这个模型不会出现在模型选择器里。',
          }, '无临期全拒')
        : blocker === 'mixed'
          ? React.createElement('span', {
              className: 'dim-jh-aggAllRejected',
              title: '候选全部未参与轮换：其中一部分是你拒绝的、一部分是没有临期积分折算'
                + '默认不参与的。展开后可以逐条处理。',
            }, '均未参与')
          : null;
    return React.createElement('div', { className: 'dim-jh-aggModel', key: model.canonicalId },
      React.createElement('button', {
        type: 'button',
        className: 'dim-jh-aggModelHead',
        'aria-expanded': String(open),
        onClick: () => setExpanded((prev) => ({ ...prev, [model.canonicalId]: !open })),
      },
      React.createElement('span', { className: 'dim-jh-aggModelName' },
        model.name || model.canonicalId),
      // ⚠️⚠️ **不再渲染「N 个渠道 · 按渠道名/按临期/按手工」这段 meta**
      //（用户 2026-10-16 验收要求：「图1红框中的内容可以不用显示」）。
      //   当前处于哪种排序模式由**顶部 toggle 的高亮段**表达（那是权威且唯一），
      //   模型头再挂一遍是冗余；「N 个渠道」用户展开就看得见。
      //   ⚠️ 候选**数量**信息并未丢失：展开后「未参与轮换（K）」那一段仍带计数，
      //   而参与数量 = 展开后的可拖行数。
      blockerNode,
      React.createElement('span', { className: 'dim-jh-aggChevron' }, open ? '▾' : '▸')),
      open
        ? React.createElement('div', { className: 'dim-jh-aggCandidates' },
            candidates.map((candidate, index) => renderCandidate(model, candidate, {
              draggable: manual,
              index: index,
              last: index === candidates.length - 1,
            })),
            // ── 未参与段（仅手工模式）──
            // ⚠️ **「保存顺序」按钮已删除**（用户验收 2026-10-16）：拖动现在
            //    **松手即提交**（见 `onDrop`），那个按钮既多余、又会让人以为
            //    「不点就不会保存」（真实缺陷：原先不点就真的不保存 ⇒
            //     关窗再开顺序就丢了）。交互与本仓库另两处拖动统一。
            manual && inactive.length > 0
              ? React.createElement('div', { className: 'dim-jh-aggInactiveSection' },
                  React.createElement('span', { className: 'dim-jh-aggInactiveTitle' },
                    `未参与轮换（${inactive.length}）`),
                  inactive.map((candidate) => renderCandidate(model, candidate)))
              : null)
        : null);
  };

  // ⚠️ 根元素用 `div` 而非 `main`（真实缺陷，对抗审计指出）：
  //    父级 `JetHubPage` 已经是 `<main className="dim-jh-panel" role="tabpanel">`
  //    （见本文件的渲染分流处），内层再写 `<main>` 会产生**嵌套 main** ——
  //    无障碍语义错误（一个文档只应有一个 main landmark）。
  //    ⚠️ 同理不再重复声明 `role="tabpanel"`（那是父级的角色）。
  //    ⚠️ 也不再重复 `.dim-jh-panel` 类（父级已有；重复会让两条规则的 padding/overflow
  //    互相覆盖，样式归属分叉）。
  // ⚠️ 模型列表的排序：用户 2026-10-07 要求**去掉厂商分组标题**（「8 个聚合模型下面
  //    不需要再显示渠道了，因为渠道在每个模型的展开展示参与轮换的子列表中显示了」）
  //    ⇒ 模型平铺，全局按候选渠道数降序。厂商信息仍可在展开后的子列表里逐条看到。
  const sortedModels = sortModelsForPanel(models ?? []);
  // 探测时间的人话（工具行显示「N 分钟前」，让用户知道看到的是多旧的数据）。
  const probedAgoText = lastProbeAt === null ? '' : (() => {
    const minutes = Math.floor((Date.now() - lastProbeAt) / 60_000);
    return minutes < 1 ? '刚刚' : `${minutes} 分钟前`;
  })();
  return React.createElement('div', {
    className: 'dim-jh-aggPanel',
  },
  // ── 说明区 ──
  React.createElement('section', { className: 'dim-jh-aggIntro' },
    React.createElement('h2', { className: 'dim-jh-aggTitle' }, '聚合'),
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '把同一个模型在各渠道的条目聚合成一个名字，请求时按「积分最快作废」自动选渠道。'),
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '三层开关互不影响：关渠道（各渠道自己的面板）、关模型（模型选择器）、'
      + '以及本页子列表里逐条控制某个候选是否参与轮换（只影响这一个模型）。'),
    React.createElement('p', { className: 'dim-jh-aggIntroWarn' },
      '本 provider 无需登录、没有账号池；积分与限流由各渠道自己管理。'),
    // ⚠️ 文案必须**说真话**（2026-10-15 改写）：未接入折算的渠道现在**也出现在目录里**
    //    且可逐条手工打开，故不能再写「不参与轮换（仍可直连使用）」那句 ——
    //    它会让用户以为这里做什么都没用。
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '没有临期积分折算的渠道**默认不参与轮换**（它们现在也出现在目录里，'
      + '展开模型后可以逐条手工打开）。'),
    // ⚠️ 这一句是**必须**的：手工打开的未接入候选与「无临期积分」的已接入候选
    //    都是 `NEVER` ⇒ 它们排在能算出临期的候选**之后**。用户看到「我明明手工打开了
    //    却排在最后」时，若面板从没说过这件事，就会以为是缺陷。
    React.createElement('p', { className: 'dim-jh-aggIntroLine' },
      '「按手工排序」模式下可以拖动候选调整顺序。手工打开的「无临期积分」候选'
      + '排在所有能算出临期的候选之后（两者没有可比较的到期时间），'
      + '这种混合顺序是正常的、不是缺陷。')),
  // ── 工具行 ──
  // ⚠️⚠️ **顺序：按钮在前、计数在后**（用户 2026-10-16 第三次验收：
  //    「43 个聚合模型应该显示在按钮下面」）。
  //    原先计数在最前 ⇒ 它占掉第一行的一个位置。⇒ 现在按钮先排，计数放**最后**
  //    并由 CSS 的 flex-basis: 100% 强制换行 ⇒ 恒定显示在按钮**下面**。
  React.createElement('div', { className: 'dim-jh-aggToolbar' },
    // ⚠️⚠️ 排序模式改成**单个切换按钮**（用户 2026-10-16 验收要求：
    //    「图2的排序按手工还是按临期应该是一个按钮的点击切换（就像解锁永久积分和
    //     锁定永久积分一样）」）。
    //    形态照 `permanentLockCopy` 那个按钮：按钮文字说**当前状态**，点击切到另一种，
    //    变化与代价放 `title`；激活态（按手工）用 `data-kind='primary'` 区分。
    //    ⚠️ 原来的两段式 `dim-jh-aggSegmented` 已删除 —— 两段在窄面板下各占一列，
    //    会把工具行挤成竖排（同一个验收截图里的现象）。
    // ⚠️⚠️ **必须用 `.dim-jh-btn`**（用户 2026-10-16 第二次验收：
    //    「拒绝非临期和切换排序为什么还是没有按按钮样式（图2）显示」）。
    //    根因：我原先给聚合工具栏用的是自造的 `.dim-jh-aggRefresh`（圆角 6px、**无背景色**、
    //    `primary` 只是描边变蓝），而全站按钮的标准类 `.dim-jh-btn` 是
    //    圆角 8px + 有底色 + hover 变蓝 + `primary` = **实心蓝底白字**（图2 那个
    //    「解锁永久积分」正是它）⇒ 两套样式看起来不像同一个 UI。
    //    ⇒ 排序切换与「拒绝非临期」「刷新」全部改用 `.dim-jh-btn`，
    //      激活态沿用 `data-kind='primary'`（与「锁定永久积分」**逐字同一形态**）。
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      'data-kind': orderMode === 'manual' ? 'primary' : undefined,
      disabled: expiryBusy,
      'aria-pressed': String(orderMode === 'manual'),
      title: orderMode === 'manual'
        ? '当前按**你手工拖动的顺序**轮换。点此切回「按临期」——'
          + '临期序每 2 分钟自动重查一次（会打上游请求）；手工序不受影响、仍各自保存。'
        : '当前按**积分最快作废**的顺序轮换（每 2 分钟自动重查一次，会打上游请求）。'
          + '点此切到「按手工」——展开模型后可拖动候选调整顺序，两种顺序分别保存、互不覆盖。',
      onClick: () => { void onSelectOrderMode(orderMode === 'manual' ? 'expiry' : 'manual'); },
    }, expiryBusy
      ? '查询中…'
      : (orderMode === 'manual'
          ? '排序：按手工'
          : `排序：按临期${lastProbeAt !== null ? ` · ${probedAgoText}` : ''}`)),
    // ⚠️ 一键「拒绝非临期」：把未接入折算渠道的手工打开恢复为「默认不参与」。
    //    它**不弹确认**（可逆、且逐条还能再打开）—— 但文案必须区分
    //    「恢复了 N 条」与「本来就没打开」（见 `onRejectNonExpiring`）。
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: rejectBusy,
      title: '把所有没有临期积分折算的渠道恢复为「默认不参与轮换」的初始状态'
        + '（它们仍留在聚合目录里，可随时逐条手工打开；已接入折算的渠道不受影响）',
      onClick: () => { void onRejectNonExpiring(); },
    }, rejectBusy ? '处理中…' : '拒绝非临期'),
    React.createElement('button', {
      type: 'button',
      className: 'dim-jh-btn',
      disabled: busy,
      // ⚠️ **显式刷新必须传 `true`**（绕过宿主侧 60 秒目录缓存）——
      //    否则按钮实际是「读缓存」，用户改了渠道模型后点刷新看不到变化。
      title: '重新读取各渠道的模型目录（绕过 60 秒缓存）',
      onClick: () => { void load(true); },
    }, busy ? '刷新中…' : '刷新'),
    // ⚠️ 计数**放最后**（见工具行开头的注释）：CSS 的 flex-basis: 100% 让它
    //    恒定换行到按钮**下一行**（用户要求「应该显示在按钮下面」）。
    React.createElement('span', { className: 'dim-jh-aggCount' },
      models === null ? '读取中…' : `${models.length} 个聚合模型`)),
  notice !== null
    ? React.createElement('div', { className: 'dim-jh-aggNotice' }, notice)
    : null,
  // ── 空态 ──
  // ⚠️ 文案**不得写死渠道数量**（那类快照必然腐坏，仓库既有教训：接入 accio/officeace
  //    后手抄名单没人回头改，只登那两家的用户会看到「请先登录」这句错话）。
  //    这里继续复用 `AGG_WIRED_CHANNEL_LABELS`（它的集合相等由用例锁死）。
  // ⚠️ 2026-10-15 补上「或手工打开」这条出路：未接入渠道的账号**不会**让模型自动
  //    进轮换，用户若只登录了那几家，看到的仍是空态 —— 必须告诉他第二步做什么。
  models !== null && models.length === 0
    ? React.createElement('div', { className: 'dim-jh-aggEmpty' },
        '当前没有可聚合的模型：请先在至少一个已接入临期折算的渠道'
        + '（' + AGG_WIRED_CHANNEL_LABELS + '）登录账号；'
        + '或者登录其它渠道后，在本页展开模型、把候选逐条手工打开。')
    : null,
  // ── 模型列表（**平铺**，全局按候选渠道数降序；不再有厂商分组标题）──
  sortedModels.map((model) => renderModel(model)),
  // ── 页脚说明 ──
  React.createElement('footer', { className: 'dim-jh-aggFooter' },
    React.createElement('p', null,
      '为什么没有签到 / 重置 / 新建账号按钮：本 provider 不持有账号与积分。'),
    React.createElement('p', null,
      '候选如何得出：字面推导（id / name 双通道）+ 显式映射补丁。'),
    React.createElement('p', null,
      '如何核查：展开任一模型，逐条看渠道与真实 modelId；不同意就关掉那一行。')));
}
