// Keep original provider cards and React handlers on narrow screens.
(() => {
  if (window.__dshPhonePresentation) return;
  window.__dshPhonePresentation = true;
  // 手机形态断点：**本层自己的形态阈值**，与 dsh-phone.css 的 @media 必须一致。
  // 原先写死 700px，会在 701-767px 区间出现「本层 JS 已按手机排、但其它消费方没按」
  // 的半态（横屏手机、小尺寸平板）。
  //
  // ⚠️ 2026-10-13 订正：原注释称「对齐上游框架自己的阈值（右栏在 768px 以下转全屏滑入）」，
  //    实测**该依据不成立**：
  //      · 上游布局层的唯一宽度阈值是 SIDEBAR_AUTO_COLLAPSE = **1024**，语义是
  //        「侧栏自动折叠」，不是「手机形态」；
  //      · 上游的 rightbarFullscreen 是 openRightbar(track, fullscreen) 的**入参**，
  //        不按视口宽度自动判断；
  //      · 上游前端 CSS 的 max-width 断点是 170/320/360/480，**没有 767/768**。
  //    故 767 是**本层自定**的形态阈值（取 768-1 以落在常见 768 桌面断点内侧），
  //    与上游无对齐关系。保留该值：它在实测中 JS 与 CSS 两侧行为完全一致（见 §9.18）。
  const MOBILE_FORM_MAX_WIDTH = 767;
  const media = window.matchMedia(`(max-width: ${MOBILE_FORM_MAX_WIDTH}px)`);
  const fileReceivers = new WeakMap();
  // These two same-origin settings documents have a natural-height body.
  // Measure that body, not documentElement.scrollHeight (which is at least
  // the old iframe viewport height and would preserve its empty space).
  const settingsEmbeds = new Map();
  const fitSettingsEmbeds = () => {
    const frames = new Set(document.querySelectorAll('.VOzbGW_options iframe[data-dsh-settings-embed]'));
    for (const [frame, state] of settingsEmbeds) {
      if (media.matches && frames.has(frame)) continue;
      state.disconnect(); frame.removeEventListener('load', state.load);
      frame.style.removeProperty('--dsh-phone-embed-height'); settingsEmbeds.delete(frame);
    }
    if (!media.matches) return;
    for (const frame of frames) {
      let state = settingsEmbeds.get(frame);
      if (!state) {
        state = { disconnect() {}, pending:false };
        state.measure = () => {
          if (!media.matches || !frame.isConnected) return;
          try {
            const doc = frame.contentDocument, body = doc?.body;
            if (!body || !['/agent-cards','/controlled-market','/phone-tools','/hermes-remote','/appearance-center'].includes(new URL(doc.URL).pathname)) return;
            const styles = doc.defaultView.getComputedStyle(body);
            const height = Math.ceil(body.getBoundingClientRect().height + (parseFloat(styles.marginTop) || 0) + (parseFloat(styles.marginBottom) || 0));
            if (height > 0 && frame.style.getPropertyValue('--dsh-phone-embed-height') !== height+'px') frame.style.setProperty('--dsh-phone-embed-height', height+'px');
          } catch { /* A navigated iframe may no longer be same-origin. */ }
        };
        const schedule = () => {
          if (state.pending) return; state.pending = true;
          // WebView pauses animation frames while a popup or another app is
          // in front. Catalog requests still finish there; fit their content
          // in a microtask instead of retaining the loading screen's height.
          Promise.resolve().then(() => { state.pending = false; state.measure(); });
        };
        state.load = () => {
          state.disconnect(); frame.style.removeProperty('--dsh-phone-embed-height');
          try {
            const doc = frame.contentDocument, body = doc?.body;
            if (!body || !['/agent-cards','/controlled-market','/phone-tools','/hermes-remote','/appearance-center'].includes(new URL(doc.URL).pathname)) return;
            const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
            const mutations = new MutationObserver(schedule);
            resize?.observe(body); mutations.observe(body, {childList:true, subtree:true, characterData:true, attributes:true});
            state.disconnect = () => { resize?.disconnect(); mutations.disconnect(); };
            schedule();
          } catch { /* Keep the bounded fallback if this document is unavailable. */ }
        };
        settingsEmbeds.set(frame, state); frame.addEventListener('load', state.load); state.load();
      }
      state.measure();
    }
  };
  document.addEventListener('visibilitychange', fitSettingsEmbeds);
  document.addEventListener('paste', async event => {
    const input = event.target.closest?.('[data-composer-card] [role=textbox],[data-composer-card] textarea');
    const files = Array.from(event.clipboardData?.files || []);
    if (!event.isTrusted || !input || !files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const receive = fileReceivers.get(input.closest('[data-composer-card]'));
    try {
      if (receive) { await receive(files, event.clipboardData.getData('text/plain')); return; }
      const { normalizeChatImage } = await import('/phone-skill-import.js');
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(await normalizeChatImage(file) || file);
      const text = event.clipboardData.getData('text/plain'); if (text) transfer.setData('text/plain', text);
      if (input.isConnected) input.dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:transfer }));
    } catch (error) {
      const notice = input.closest('[data-composer-card]').querySelector('[role=status]');
      if (notice) { notice.style.display = 'block'; notice.textContent = error.message; }
    }
  }, true);
  // ===== 形态标记层（单一真源）=====
  // 上游组件的 CSS Module 类名是构建期哈希（如 .pI_x6G_frame），随上游升级整块
  // 失效且**静默**（页面照常渲染，只是样式不再命中）。本层把「当前是什么形态/
  // 什么状态」发布成稳定的 data-dsh-* 事实，样式只消费这些事实，不再逐块去猜
  // 上游哈希。事实由本文件自己写、自己维护，上游改哈希不影响它们的语义。
  //
  // 发布的事实（消费方见 dsh-phone.css 与 ui-anchors.json）：
  //   html[data-dsh-mobile-form]        窄屏形态（镜像 MOBILE_FORM_MAX_WIDTH）
  //   [data-dsh-frame]                  上游框架根（其右栏带 data-rightbar-col）
  //   html[data-dsh-modal-open]         有页面级模态在场
  //   [data-dsh-rail]                   侧栏（抽屉容器；上游只给哈希类名）
  //   [data-dsh-settings-dialog]        设置面板本体
  //   html[data-dsh-settings-open]      设置面板在场（窄屏下需钉住抽屉）
  // 发布「存在性」属性的容错工具。
  // ⚠️ 不用 toggleAttribute：那是 Chrome 69+ 的 API，本层兼容面没问题，但**上游既有
  //    测试的 document 垫片**（phone-qq/presentation.test.js）只给了 { style }，
  //    没有该方法 ⇒ 本层一调就抛错，把上游测试打红（实测）。改用 has/set/remove
  //    三元组合，对最简垫片也成立；并且整段做容错，垫片缺方法也不影响主流程。
  const syncFlag = (el, name, on) => {
    if (!el) return
    try {
      if (on) { if (el.setAttribute) el.setAttribute(name, '') }
      else { if (el.removeAttribute) el.removeAttribute(name) }
    } catch { /* 极简垫片下静默跳过：事实发布失败不应影响主流程 */ }
  }

  const FRAME_TAG = 'data-dsh-frame';
  const SETTINGS_TAG = 'data-dsh-settings-dialog';
  const RAIL_TAG = 'data-dsh-rail';
  let markedFrame = null, markedDialog = null, markedRail = null;
  // 抽屉「上一轮的打开状态」。adapt() 会被 MutationObserver 高频重入，只有跨调用
  // 记住上一态才能识别**上升沿**（刚被打开），从而只在那一次展开折叠侧栏 ——
  // 否则用户手动折叠侧栏后会被立刻弹回来（见 adapt() 内注释）。
  let drawerWasOpen = false;
  const markForm = () => syncFlag(document.documentElement, 'data-dsh-mobile-form', media.matches);
  const markDom = () => {
    // 框架根：上游只给右栏稳定的 data-rightbar-col，框架根自身没有钩子，
    // 故由右栏反查父元素；框架重挂时重新打标。
    const frame = document.querySelector('[data-rightbar-col]')?.parentElement ?? null;
    if (frame !== markedFrame) { try { markedFrame?.removeAttribute(FRAME_TAG) } catch {} ; markedFrame = frame; try { frame?.setAttribute(FRAME_TAG, '') } catch {} }
    // 侧栏同样打标：上游只给它哈希类名（无语义属性），而本层有 4 条规则锚在它上面。
    // 与框架根同法（只增不减：保留哈希选择器兜底），上游改名后本层照常工作。
    const rail = frame?.querySelector('[data-dsh-rail], .pI_x6G_sidebarCol') ?? null;
    if (rail !== markedRail) { try { markedRail?.removeAttribute(RAIL_TAG) } catch {} ; markedRail = rail; try { rail?.setAttribute(RAIL_TAG, '') } catch {} }
    // 设置面板：上游给它稳定的 data-shortcut-modal="settings"（0.2.1-alpha.1 实测），
    // 比按「含 :scope > nav」猜结构更可靠；保留结构判据作跨版本兜底。
    //
    // ⚠️ 识别刻意**不**受下方的覆盖层过滤影响：设置面板是否渲染在 [data-shell-overlay]
    // 之内是实现细节（当前是 portal 到 body，但上游可改），若把它一并过滤掉，
    // settings-open 会静默地永不发布 —— 那种失效没有报错，只有窄屏下抽屉不被钉住。
    // 故先在文档全体里按稳定标记找设置面板，再单独算「页面级模态」。
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
    const settings = document.querySelector('[data-shortcut-modal="settings"]')
      ?? dialogs.find(d => d.querySelector(':scope > nav') !== null) ?? null;
    if (settings !== markedDialog) { try { markedDialog?.removeAttribute(SETTINGS_TAG) } catch {} ; markedDialog = settings; try { settings?.setAttribute(SETTINGS_TAG, '') } catch {} }
    // 「页面级模态」= 不在框架自有覆盖层里的对话框。框架覆盖层里的浮层（本层自己
    // 的导出结果弹窗、上游的浮层）不是盖住侧栏的模态，不能用来钉抽屉。
    const pageDialogs = dialogs.filter(d => d.closest('[data-shell-overlay]') === null);
    syncFlag(document.documentElement, 'data-dsh-modal-open', pageDialogs.length > 0);
    syncFlag(document.documentElement, 'data-dsh-settings-open', settings !== null);
  };
  const adapt = () => {
    markForm(); markDom();
    // Some WebViews resize only the visual viewport when an IME opens. Keep
    // the chat frame inside that visible area; native insets handle Android's
    // edge-to-edge window. Ignore pinch zoom so it does not reflow the app.
    const viewport = window.visualViewport;
    const height = viewport && Math.abs(viewport.scale - 1) < 0.05
      ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
    if (media.matches && height > 0) document.documentElement.style.setProperty('--dsh-phone-viewport-height', height + 'px');
    else document.documentElement.style.removeProperty('--dsh-phone-viewport-height');
    fitSettingsEmbeds();
    // 框架根：优先读一期发布的 [data-dsh-frame] 事实（adapt 内先跑标记层，此时已就位），
    // 保留哈希作跨版本回退 —— 两者指向同一元素，任一命中即可。
    const frame = document.querySelector('[data-dsh-frame], .pI_x6G_frame'),
      rail = frame?.querySelector('[data-dsh-rail], .pI_x6G_sidebarCol');
    if (frame && rail) {
      // 三期接管判断：槽位组件（DrawerMask）挂载成功后会在 html 上发布
      // data-dsh-mask-mounted 事实。此时本层**让出遮罩职责** —— 不创建本地遮罩，
      // 并把已存在的本地遮罩隐藏（它在 DOM 里仍是可点击区域，会与组件遮罩重叠）。
      //
      // 组件没渲染 ⇒ 事实缺失 ⇒ 本地实现照常工作。两种结果都安全，
      // 这是「不确认槽通道可用就不删本地实现」的落地方式（见 client-source.js 注释）。
      const maskTakenOver = document.documentElement.hasAttribute('data-dsh-mask-mounted');
      const localMask = document.querySelector('.dsh-phone-sidebar-mask');
      if (localMask) localMask.hidden = maskTakenOver;   // 接管后隐藏；未接管保持原状

      let menu = document.querySelector('.dsh-phone-menu');
      if (!menu) {
        menu = document.createElement('button'); menu.className = 'dsh-phone-menu'; menu.type = 'button';
        menu.textContent = '☰ 菜单'; menu.setAttribute('aria-label', '展开菜单'); menu.setAttribute('aria-expanded', 'false');
        rail.id ||= 'dsh-phone-sidebar'; menu.setAttribute('aria-controls', rail.id);
        const mask = document.createElement('button'); mask.className = 'dsh-phone-sidebar-mask'; mask.type = 'button';
        // 若槽位组件已接管，本地遮罩直接保持隐藏（不参与交互）。
        if (maskTakenOver) mask.hidden = true; mask.setAttribute('aria-label', '收起菜单');
        const show = open => {
          // 抽屉开合的唯一真源：html 上的 DOM 事实（槽位组件与后续迁移的控件都读它）。
          syncFlag(document.documentElement, 'data-dsh-drawer-open', open);
          const dialog = document.documentElement.hasAttribute('data-dsh-settings-open');
          rail.inert = !open && !dialog; rail.setAttribute('aria-hidden', String(!open && !dialog));
          menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
        };
        menu.onclick = () => show(!document.documentElement.hasAttribute('data-dsh-drawer-open'));
        mask.onclick = () => show(false);
        rail.addEventListener('click', event => {
          const target = event.target.closest('button,a,.YDXeBa_sessionRow');
          if (target && !target.matches('.hHd-Xa_toggle') && (!target.hasAttribute('aria-expanded') || target.closest('.hHd-Xa_footArea'))) requestAnimationFrame(() => show(false));
        });
        document.addEventListener('keydown', event => { if (media.matches && event.key === 'Escape') show(false); });
        document.body.append(menu, mask);
      }
      const open = media.matches && document.documentElement.hasAttribute('data-dsh-drawer-open');
      const dialog = media.matches && document.documentElement.hasAttribute('data-dsh-settings-open');
      menu.hidden = !media.matches; rail.inert = media.matches && !open && !dialog;
      if (media.matches) rail.setAttribute('aria-hidden', String(!open && !dialog)); else { rail.removeAttribute('aria-hidden'); document.documentElement.removeAttribute('data-dsh-drawer-open'); }

      // ⚠️ 打开抽屉时，必须一并**展开**上游那个处于折叠态的侧栏。
      //
      // 症状（用户报障）：窄屏点「菜单」后，抽屉确实打开了（背景已灰化、图标列出现），
      // 但内容停在**折叠态** —— 左边只有图标条，右边一大片空白，得再点一次侧栏里那个
      // 小图标才出完整菜单。
      //
      // 真因：本层 CSS 把侧栏宽度强制成 min(280px,86vw)，而上游折叠态只渲染 ~56px 的
      // 图标列 ⇒ 容器 280px、内容 56px，差额就是那片空白。
      // 而「展开」这段原先只写在**旧自绘按钮专属**的开合函数里；三期把开关迁进槽位后，
      // 槽位组件只翻转 data-dsh-drawer-open 事实、不碰上游折叠状态 ⇒ 走新开关时
      // 这段永不执行。
      //
      // 修法：挂到「抽屉刚被打开」这个**边沿**上（而非某个按钮的点击），两种开关与
      // 后续任何写入者都自动覆盖 —— 符合本层既有契约（状态只有一个写入者，副作用
      // 按状态统一施加）。
      // 用**上升沿**而非「open && collapsed」持续条件：后者会在用户手动折叠侧栏时
      // 立刻把它弹回来，形成「点了没反应」的新死按钮（同一个坑，不再踩第二次）。
      // 判据用上游成文属性 data-sidebar-collapsed，而非容器的折叠类名
      // （后者是 CSS Module 构建期哈希，随上游改名即失效 —— 且按本仓库约定，
      //   哈希类名不写进注释：写了会被 check-ui-anchors 当成「未登记哈希」而误报）。
      if (open && !drawerWasOpen && frame.hasAttribute('data-sidebar-collapsed')) {
        const railToggle = rail.querySelector('.hHd-Xa_toggle');
        if (railToggle && typeof railToggle.click === 'function') railToggle.click();
      }
      drawerWasOpen = open;

      // 三期：开关若已迁入槽位（header.leading），由**本层**统一同步它的 aria 状态。
      // 为什么不让组件自己同步：开合可来自三处（旧按钮 / 遮罩 / Escape / 槽位按钮），
      // 若每个写入者都各自更新自己的 aria，就会出现「点了遮罩、开关的 aria 没翻」
      // 这类不一致。沿用既有契约——**状态的唯一写入者是形态层**，组件只翻转事实。
      const slotToggle = document.querySelector('.dsh-phone-menu-slot');
      if (slotToggle) {
        // ⚠️ 宽屏下这枚开关原本是**死按钮**（用户报障：「全屏以后，菜单按键完全是
        //    不好使的」）。真因：它的 onClick 只翻转 data-dsh-drawer-open（见
        //    client-source.js 的 DrawerToggle），而上面那行在非窄屏会立即把该属性
        //    清掉（「抽屉」这个概念只存在于窄屏）⇒ 翻转被**当场撤销**，视觉上毫无
        //    反应。设备实测：点击后属性日志为「(无)→有 ×2 →(有)→无 ×2」，确证。
        //    上游在宽屏把侧栏当**常驻列**，并自带 .hHd-Xa_toggle 负责折叠/展开
        //    （设备实测可点、有效）。故宽屏下把这枚按钮**代理**给上游开关，
        //    语义统一为「切换侧栏显隐」——两种宽度下都名副其实，而不是删掉了事。
        // 只在宽屏代理：窄屏必须走 data-dsh-drawer-open 事实通道，不能被劫持。
        // 捕获阶段 + stopPropagation：免得槽位组件的 onClick 再翻一次属性
        // （宽屏下那次翻转纯属噪声，且违背「状态只有一个写入者」的契约）。
        if (!media.matches && !slotToggle.__dshWideProxy) {
          slotToggle.__dshWideProxy = true;
          slotToggle.addEventListener('click', event => {
            if (media.matches) return;
            event.stopPropagation();
            const railToggle = rail.querySelector('.hHd-Xa_toggle');
            if (railToggle && typeof railToggle.click === 'function') railToggle.click();
          }, true);
        }
        // aria 必须如实描述**当前**行为：窄屏管抽屉、宽屏管侧栏显隐。
        // 若沿用旧的「只按 open 判断」，宽屏下会恒为「展开菜单」——侧栏明明是展开的，
        // 屏幕阅读器读到的却是「展开」，等于说谎。
        const slotExpanded = media.matches ? open : !frame.hasAttribute('data-sidebar-collapsed');
        slotToggle.setAttribute('aria-expanded', String(slotExpanded));
        slotToggle.setAttribute('aria-label', media.matches
          ? (slotExpanded ? '收起菜单' : '展开菜单')
          : (slotExpanded ? '收起侧边栏' : '展开侧边栏'));
      }
    }
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const tools = card.querySelector('.uV2eYG_tools'), input = card.querySelector('textarea,[role=textbox][contenteditable]');
      if (!tools || !input || tools.querySelector('.dsh-phone-feed')) return;
      const button = document.createElement('button'), picker = document.createElement('input');
      button.type = 'button'; button.className = 'dsh-phone-feed'; button.textContent = '投喂技能';
      button.title = '选择技能 ZIP、Markdown 或 TXT，自动导入共享技能';
      button.style.cssText = 'border:0;border-radius:8px;padding:4px 7px;background:#eaf2ff;color:#2563eb;font:12px system-ui;white-space:nowrap';
      picker.type = 'file'; picker.className = 'dsh-phone-skill-picker'; picker.accept = '.zip,.md,.txt,application/zip,application/x-zip-compressed,text/plain,text/markdown'; picker.hidden = true;
      const notice = document.createElement('small'); notice.setAttribute('role', 'status');
      notice.style.cssText = 'display:none;padding:4px 14px;color:#2563eb;overflow-wrap:anywhere';
      card.append(notice); tools.append(button, picker);
      const uploadButton = document.createElement('button'), uploadPicker = document.createElement('input');
      uploadButton.type = 'button'; uploadButton.className = 'dsh-phone-upload'; uploadButton.textContent = '上传';
      uploadButton.title = '选择图片或待分析文件'; uploadButton.setAttribute('aria-label', '上传图片或文件');
      uploadButton.style.cssText = button.style.cssText;
      uploadPicker.type = 'file'; uploadPicker.multiple = true; uploadPicker.hidden = true; uploadPicker.className = 'dsh-phone-upload-picker';
      uploadPicker.accept = ''; // Ordinary attachments accept every file type.
      tools.insertBefore(uploadButton, button); tools.append(uploadPicker);
      const imagePicker = document.createElement('input'), fileButton = document.createElement('button');
      imagePicker.type = 'file'; imagePicker.accept = 'image/png,image/jpeg,image/webp,image/gif'; imagePicker.multiple = true; imagePicker.hidden = true;
      imagePicker.className = 'dsh-phone-image-picker'; tools.append(imagePicker);
      const imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'dsh-phone-image-upload'; imageButton.textContent = '上传图片';
      imageButton.title = '从相册选择图片，可一次选择多张'; imageButton.hidden = true; tools.append(imageButton);
      fileButton.type = 'button'; fileButton.className = 'dsh-phone-document-upload'; fileButton.textContent = '上传文件';
      fileButton.title = '选择待分析文件，不会安装技能或人设卡'; fileButton.hidden = true; tools.append(fileButton);
      button.hidden = true;
      const appendDraft = text => {
        if (input instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(input, input.value ? input.value + '\n\n' + text : text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Feed Lexical's normal paste path, preserving reference chips and draft persistence.
          input.focus();
          const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const clipboard = new DataTransfer(); clipboard.setData('text/plain', (input.textContent ? '\n\n' : '') + text);
          input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
        }
      };
      const closeUploadMenu = () => {
        if (card.querySelector('.dsh-phone-upload-actions')) input.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true, cancelable:true }));
      };
      const selectFile = picker => {
        if (input.disabled || input.readOnly) { notice.style.display = 'block'; notice.textContent = '请先选择工作区，并等当前任务结束后上传。'; return; }
        closeUploadMenu(); picker.click();
      };
      uploadButton.onclick = event => { event.stopPropagation(); card.querySelector('.uV2eYG_add')?.click(); };
      imageButton.onclick = event => { event.stopPropagation(); selectFile(imagePicker); };
      fileButton.onclick = event => { event.stopPropagation(); selectFile(uploadPicker); };
      // A pending ordinary-file upload must not submit the existing draft.
      card.addEventListener('click', event => {
        if (card.dataset.dshFileUploadPending && event.target.closest?.('[data-composer-send]')) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      card.addEventListener('keydown', event => {
        if (card.dataset.dshFileUploadPending && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
      const importSkillFile = async file => {
        const { prepareSkillFile, importPreparedSkill, skillImportDraft } = await import('/phone-skill-import.js');
        const rpc = async (action, extra = {}) => {
          const response = await fetch('/phone-import/manage', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { action, ...extra } }) });
          const result = (await response.json()).result;
          if (!response.ok || !result?.ok) throw Error(result?.error?.message || '导入失败，请稍后重试');
          return result.value;
        };
        const upload = async file => {
          const response = await fetch('/phone-packs/upload', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file });
          const result = await response.json();
          if (!response.ok || !result.ok) throw Error(result.error || '技能包无法读取');
          return result;
        };
        const prepared = await prepareSkillFile(file, { rpc, upload });
        if (prepared.replacesExisting && !prepared.alreadyInstalled && !confirm('已有同名技能，是否用这份文档更新？')) return '已取消，原技能保留。';
        const result = await importPreparedSkill(prepared, { rpc });
        if (input.isConnected && !input.disabled && !input.readOnly) appendDraft(skillImportDraft(prepared, ''));
        return result.message;
      };
      const receiveFiles = async picker => {
        const files = Array.from(picker.files); if (!files.length) return;
        if (card.dataset.dshFileUploadPending) {
          notice.style.display = 'block'; notice.textContent = '正在上传文件，请完成后再选择其他文件。'; picker.value = ''; return;
        }
        uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = true; card.dataset.dshFileUploadPending = 'true'; notice.style.display = 'block'; notice.textContent = '正在读取文件…';
        try {
          const { prepareChatFiles, uploadChatDocuments, chatDocumentReferences } = await import('/phone-skill-import.js');
          const prepared = await prepareChatFiles(files);
          if (!input.isConnected || input.disabled || input.readOnly) throw Error('会话状态已变化，请等任务结束后重新上传');
          const documents = await uploadChatDocuments(prepared.documents, { upload: async file => {
            notice.textContent = `正在上传 ${file.name}…`;
            let response;try { response = await fetch('/phone-chat-files/upload', { method:'POST', headers:{ 'content-type':'application/octet-stream', 'x-dsh-file-name':encodeURIComponent(file.name) }, body:file }); }
            catch { throw Error('文件上传中断，请重新选择；云端文件请先下载到手机'); }
            const result = await response.json();if (!response.ok || !result.ok) throw Error(result.error || '文件未上传完成');return result.file;
          } });
          if (!input.isConnected || input.disabled || input.readOnly) throw Error('会话状态已变化，文件尚未加入草稿，请重新选择');
          const imported = [];
          for (const file of prepared.skillFiles) imported.push(await importSkillFile(file));
          if (documents.length) {
            const detail = { references: chatDocumentReferences(documents), accepted: false };
            card.dispatchEvent(new CustomEvent('dsh:insert-file-references', { detail }));
            if (!detail.accepted) throw Error('文件已上传，输入框尚未就绪；请保留当前草稿并重新选择附件。');
          }
          if (prepared.images.length) {
            const transfer = new DataTransfer(); prepared.images.forEach(file => transfer.items.add(file));
            input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
          }
          notice.textContent = [...imported, prepared.images.length ? '图片已加入草稿，可预览或移除；请选支持看图的模型后发送。' : documents.length ? '附件已保存，可点击文件查看；写下分析要求后发送。' : ''].filter(Boolean).join(' ');
          input.focus();
        } catch (error) { notice.textContent = error.message; }
        finally { delete card.dataset.dshFileUploadPending; uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = false; picker.value = ''; }
      };
      uploadPicker.onchange = () => receiveFiles(uploadPicker);
      imagePicker.onchange = () => receiveFiles(imagePicker);
      fileReceivers.set(card, async (files, text = '') => {
        if (text) appendDraft(text);
        await receiveFiles({ files, value:'' });
      });
      // The native picker emits a path-only file reference. Route its bytes
      // through the same intake as the labeled upload entry.
      card.addEventListener('change', event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'file'
          || [picker, uploadPicker, imagePicker].includes(target) || !target.files?.length) return;
        event.stopImmediatePropagation();
        void receiveFiles(target);
      }, true);
      card.addEventListener('drop', event => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void receiveFiles({ files, value:'' });
      }, true);
      button.onclick = event => { event.stopPropagation(); selectFile(picker); };
      picker.onchange = async () => {
        const file = picker.files[0]; if (!file) return;
        uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = true;
        notice.style.display = 'block'; notice.textContent = '正在读取并导入技能…';
        try { notice.textContent = await importSkillFile(file); input.focus(); }
        catch (error) { notice.textContent = error.message; }
        finally { uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = false; picker.value = ''; }
      };
    });
    // Both the labeled upload entry and the native + entry open the same menu.
    // Leave native workspace references and command handlers intact.
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const menu = card.querySelector('[data-trigger-menu]'), list = menu?.querySelector('[role=listbox]');
      if (!list || menu.querySelector('.dsh-phone-upload-actions') || !list.querySelector('._3e4SsG_itemAlias')?.textContent.includes('file')) return;
      const actions = document.createElement('div'); actions.className = 'dsh-phone-upload-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '上传');
      for (const [selector, label, hint] of [['.dsh-phone-image-upload', '上传图片', '相册 · 可选多张'], ['.dsh-phone-document-upload', '上传分析文件', '任意文件 · APK、文档、压缩包等'], ['.dsh-phone-feed', '导入技能', '安装技能 ZIP 或方法文档']]) {
        const target = card.querySelector(selector), action = document.createElement('button'); action.type = 'button'; action.disabled = target.disabled;
        const title = document.createElement('strong'), description = document.createElement('small'); title.textContent = label; description.textContent = hint;
        action.append(title, description); action.onmousedown = event => { event.preventDefault(); event.stopPropagation(); }; action.onclick = event => { event.stopPropagation(); target.click(); }; actions.append(action);
      }
      menu.insertBefore(actions, list);
    });
    document.querySelectorAll('.wSkVaW_headerUtilities button').forEach(button => {
      if (!/session log|会话日志/i.test(button.textContent)) return;
      button.classList.add('dsh-phone-log-button');
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.textContent.trim());
      if (!button.title) button.title = button.textContent.trim();
    });
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const tools = card.querySelector('.uV2eYG_tools');
      if (!tools) return;
      let more = card.querySelector('.dsh-phone-composer-more');
      if (media.matches && !more) {
        more = document.createElement('details'); more.className = 'dsh-phone-composer-more';
        const summary = document.createElement('summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label', '会员用量');
        const options = document.createElement('div'); options.className = 'dsh-phone-composer-options';
        more.append(summary, options); tools.append(more);
      }
      if (!media.matches && more) { const notice = more.querySelector('.dsh-phone-chatgpt-plan'); if (notice) card.append(notice); more.remove(); }
    });
    if (window.__dshPeerRemote && !document.querySelector('.dsh-peer-badge')) {
      const badge = document.createElement('a'); badge.className = 'dsh-peer-badge';
      badge.textContent = '电脑 · ' + (window.__dshPeerName || '家里的电脑'); badge.title = badge.textContent + '，任务在电脑执行；点击返回手机';
      badge.href = 'http://127.0.0.1:3080/'; document.body.append(badge); document.body.classList.add('dsh-peer-remote');
    }
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const usingPlan = card.querySelector('._7KE1Ra_trigger')?.title.includes(' · ChatGPT 会员');
      let notice = card.querySelector('.dsh-phone-chatgpt-plan');
      if (!usingPlan) { notice?.remove(); return; }
      if (notice) { const target = media.matches ? card.querySelector('.dsh-phone-composer-options') || card : card; if (notice.parentElement !== target) target.append(notice); return; }
      notice = document.createElement('small'); notice.className = 'dsh-phone-chatgpt-plan';
      notice.style.cssText = 'display:block;padding:4px 14px;color:#626b78';
      const usage = document.createElement('a'); usage.href = 'https://chatgpt.com/settings/usage'; usage.textContent = '管理用量';
      usage.style.cssText = 'color:#2563eb;margin-left:10px';
      notice.append(document.createTextNode('正在使用你的 ChatGPT 会员方案'), usage);
      (media.matches ? card.querySelector('.dsh-phone-composer-options') || card : card).append(notice);
    });
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const more = card.querySelector('.dsh-phone-composer-more');
      if (more) more.hidden = !card.querySelector('.dsh-phone-chatgpt-plan');
    });
    document.querySelectorAll('._7KE1Ra_root').forEach(root => {
      if (!media.matches) { ['left','width','height'].forEach(key=>root.style.removeProperty('--dsh-phone-model-'+key)); return; }
      const menu = root.querySelector('._7KE1Ra_menu'); if (!menu) return;
      const anchor = root.closest('[data-composer-card]') || root.parentElement;
      const bounds = anchor.getBoundingClientRect(), trigger = root.getBoundingClientRect();
      const viewport = window.visualViewport;
      const start = viewport?.offsetLeft || 0, width = viewport?.width || window.innerWidth;
      const left = Math.max(start+12, bounds.left+8), right = Math.min(start+width-12, bounds.right-8);
      root.style.setProperty('--dsh-phone-model-left', (left-trigger.left)+'px');
      root.style.setProperty('--dsh-phone-model-width', Math.max(160,right-left)+'px');
      root.style.setProperty('--dsh-phone-model-height', Math.max(120,Math.min(480,trigger.top-(viewport?.offsetTop||0)-20))+'px');
    });
    // Jet Hub's right-aligned quota panel crosses the left edge when its
    // trigger sits beside the upload button. Fit it to the visible composer.
    // ⚠️ Issue F-19：下面这段（以及本文件与 dsh-phone.css 里全部 .dim-jh-* 选择器）
    // 依赖的是**插件侧产出**的类名（dsh-codearts-auth 的 plugin-src/client）。
    // 这类跨层依赖已显式登记在 app/src/main/assets/phone-plugin-contract.json，
    // 由 scripts/check-plugin-contract.mjs 做构建期门禁 —— 插件侧改名/删除会报红，
    // 而不是像 F-15/F-16 那样静默失效。**新增任何 .dim-jh-* 依赖时先登记再引用。**
    document.querySelectorAll('.dim-jh-badge,.dsh-phone-composer-more').forEach(root => {
      const prefix = '--dsh-phone-popover-';
      if (!media.matches) { ['left','width','height'].forEach(key => root.style.removeProperty(prefix+key)); return; }
      const viewport = window.visualViewport, start = viewport?.offsetLeft || 0, width = viewport?.width || window.innerWidth;
      const trigger = root.getBoundingClientRect(), card = root.closest('[data-composer-card]');
      const bounds = card?.getBoundingClientRect() || { left: start, right: start+width };
      const first = Math.max(start+12, bounds.left+8), last = Math.min(start+width-12, bounds.right-8);
      const panelWidth = Math.max(0, Math.min(root.matches('.dim-jh-badge') ? 360 : 270, last-first));
      const left = Math.max(first, Math.min(trigger.right-panelWidth, last-panelWidth));
      root.style.setProperty(prefix+'left', (left-trigger.left)+'px');
      root.style.setProperty(prefix+'width', panelWidth+'px');
      root.style.setProperty(prefix+'height', Math.max(80, Math.min(480, trigger.top-(viewport?.offsetTop || 0)-16))+'px');
    });
    document.querySelectorAll('.dim-jh-layout').forEach(layout => {
      const rail = layout.querySelector('.dim-jh-rail');
      if (!rail) return;
      let header = layout.querySelector('.dsh-phone-provider');
      if (!media.matches) { header?.remove(); layout.classList.remove('dsh-phone-choosing'); return; }
      const selected = rail.querySelector('.dim-jh-provider[aria-selected="true"]');
      if (!header) {
        header = document.createElement('div'); header.className = 'dsh-phone-provider';
        const title = document.createElement('span'); title.className = 'dsh-phone-selected';
        const toggle = document.createElement('button'); toggle.className = 'dim-jh-btn'; toggle.type = 'button';
        toggle.addEventListener('click', () => {
          layout.classList.toggle('dsh-phone-choosing');
          toggle.setAttribute('aria-expanded', String(layout.classList.contains('dsh-phone-choosing')));
          toggle.textContent = layout.classList.contains('dsh-phone-choosing') ? '返回账号' : '选择供应商';
        });
        header.append(title, toggle); layout.insertBefore(header, rail);
        rail.addEventListener('click', event => {
          if (!event.target.closest('.dim-jh-provider')) return;
          layout.classList.remove('dsh-phone-choosing'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '选择供应商';
        });
        layout.classList.add('dsh-phone-choosing'); toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = '返回账号';
      }
      const label = selected?.querySelector('.dim-jh-providerLabel strong')?.textContent || '供应商账号';
      if (header.dataset.selected !== label) {
        const title = header.querySelector('.dsh-phone-selected'); title.replaceChildren();
        const icon = selected?.querySelector('.dim-jh-providerIcon'); if (icon) title.append(icon.cloneNode(true));
        title.append(document.createTextNode(label)); header.dataset.selected = label;
      }
    });
  };
  let pending = false;
  const queue = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; adapt(); }); };
  // 观察根节点而非 body：设置面板与模态可能以 portal 形式挂在 body 之外，
  // 且开关常表现为属性变化（aria-modal / data-shortcut-modal），故一并纳入过滤。
  new MutationObserver(queue).observe(document.documentElement, {
    childList:true, subtree:true, attributes:true,
    // data-dsh-drawer-open 必须纳入观察：三期之后**槽位组件**也会写它
    // （点遮罩关闭），若 adapt() 不重跑，rail.inert / aria-hidden /
    // menu[aria-expanded] 会与视觉状态错位（实测分析得出）。
    attributeFilter:['aria-selected','title','aria-modal','data-shortcut-modal','data-dsh-drawer-open'] });
  media.addEventListener('change', queue); window.addEventListener('resize',queue); document.addEventListener('focusin',queue);
  window.visualViewport?.addEventListener('resize',queue); window.visualViewport?.addEventListener('scroll',queue); adapt();
})();
