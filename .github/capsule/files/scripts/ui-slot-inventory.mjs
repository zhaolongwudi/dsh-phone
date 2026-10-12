// 槽位清单与迁移映射（方案 B 三期的"挑"依据）。
//
// ## 为什么先要这个
//
// 三期的目标是把「用 JS/CSS 硬塞进上游 DOM」的控件，改成「走槽位注册自己的组件」。
// 但槽位名是上游契约，**不同版本会增删**（本项目实测：settings.dev.item 在
// 0.2.1-alpha.1 上不存在，参考项目却是按它写的）。盲改会得到一个「注册了但永不
// 渲染」的静默失效——比不改更糟。
//
// 故本脚本从**当前引擎树**里提取真实存在的槽位名，与需迁移的 DOM 锚点对照，
// 产出可执行的迁移映射（哪一块能迁、迁到哪个槽、哪个槽当前不存在）。
//
// ## 用法
//   node scripts/ui-slot-inventory.mjs --tree <dsh树根>
//   node scripts/ui-slot-inventory.mjs --tree <dsh树根> --json
//   node scripts/ui-slot-inventory.mjs --tree <dsh树根> --check   只校验迁移表的槽是否都在（CI 用）
//
// 无 --tree 时走 --check 模式（只校验迁移表里的槽名与已登记的引擎版本快照一致）。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 槽位名形态：`域.名` 或 `域.名.子名`（如 conversation.header.leading）。 */
export const SLOT_RE = /'(shell|conversation|settings|sidebar|main)\.[a-zA-Z.]*'/g

/**
 * 从引擎树提取全部槽位名（按声明它的包分组）。
 * @param root dsh 引擎树根
 * @returns {Map<string, Set<string>>} 槽位名 → 声明它的包集合
 */
export function scanSlots(root) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  const out = new Map()
  if (!existsSync(scope)) return out
  for (const pkg of readdirSafe(scope)) {
    const lib = join(scope, pkg, 'lib')
    if (!existsSync(lib)) continue
    for (const file of walkJs(lib)) {
      let text
      try { text = readFileSync(file, 'utf8') } catch { continue }
      for (const m of text.matchAll(SLOT_RE)) {
        const name = m[0].slice(1, -1)
        if (!out.has(name)) out.set(name, new Set())
        out.get(name).add(pkg)
      }
    }
  }
  return out
}

/** 目录列举的安全包装：不可读时返回空数组而非抛出。 */
function readdirSafe(d, opts) { try { return readdirSync(d, opts) } catch { return [] } }

/** 递归列出目录下的 .js（不含 .map/.d.ts）。 */
function* walkJs(dir) {
  let entries
  entries = readdirSafe(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkJs(p)
    else if (/\.(js|mjs)$/.test(e.name)) yield p
  }
}

/**
 * 槽位的 host 包（**渲染方**，与「谁往里注册」区分）。
 * 实测：renderSlot('shell.overlay') 在 dsh-client-ui-layout，
 * renderSlot('conversation.header.leading') 在 dsh-client-ui-conversation。
 * 注册方的 dsh.client.inject 必须声明 host 包，否则 bundle 可能先于 host 物化，
 * slots.inject 会一直等服务、组件静默不出现（本项目 0.2.1-alpha.1 实测）。
 */
/**
 * 各目标槽的 kind —— **登记快照**（引擎树不可用时的回退）。
 *
 * ⚠️ 权威来源是 `scanSlotKinds(引擎树)`（自动提取，共 83 个槽位）。
 * 本快照仅在两处使用：① 无引擎树的 CI 环境；② 与自动提取结果**交叉核对**
 * （不一致即说明快照过期或上游改了契约，门禁会报红）。
 *
 * 原始说明：用真实源码查明 —— 上游在 children 表里以
 * `"槽名": { kind: "list"|"single"|"keyed", scope: "..." }` 声明）。
 *
 * **契约差异会直接决定配方代码对不对**：
 *   - `list`：`options.id` **必填**（缺失即 throw），按 id 去重（同 id 同优先级也 throw）
 *   - `single`：同优先级只能有一个注册（后者 throw）；id 非必填
 *   - `keyed`：另有 `options.key` 必填
 * 实测来源：dsh-client-ui-slots/lib/index.js 的 register 分支。
 */
export const SLOT_KIND = {
  'shell.overlay': 'list',
  'conversation.header.leading': 'single',
  'conversation.input.left': 'list',
  'conversation.input.plan': 'single',
  'settings.section': 'list',
}

export const SLOT_HOST = {
  'shell.overlay': 'dsh-client-ui-layout',
  'conversation.header.leading': 'dsh-client-ui-conversation',
  'conversation.input.left': 'dsh-client-ui-conversation',
  'conversation.input.plan': 'dsh-client-ui-conversation',
  'settings.section': 'dsh-client-ui-settings-general',
}

/** 注册方 client bundle 的位置与它们的 inject 声明来源。 */
export const REGISTERERS = [
  { pkg: 'dsh-phone-qq', manifest: 'phone-qq/package.json' },
  { pkg: 'dsh-peer', manifest: 'peer/package.json' },
]

/**
 * 从引擎树自动提取槽位声明拓扑。
 *
 * 上游在各客户端包的 client.js 里以
 *  `"槽名": { kind: "list"|"single"|"keyed"|"chain", scope: "..." }`
 * 声明槽位（实测 0.2.1-alpha.1 共 83 个）。**kind 决定注册参数契约**
 * （list 必带 id / keyed 必带 key / single 同优先级唯一），是三期配方
 * 正确性的直接依据。自动提取而非手工登记：上游改契约即自动反映。
 *
 * @param root dsh 引擎树根
 * @returns {Map<string, {kind:string, pkgs:Set<string>}>}
 */
export function scanSlotKinds(root) {
  const out = new Map()
  if (!root) return out
  const scope = join(root, 'node_modules', '@deepseek-ai')
  let pkgs
  try { pkgs = readdirSync(scope) } catch { return out }
  for (const pkg of pkgs) {
    let text
    try { text = readFileSync(join(scope, pkg, 'lib', 'client.js'), 'utf8') } catch { continue }
    for (const m of text.matchAll(/"([a-z][a-zA-Z.]*\.[a-zA-Z.]+)"\s*:\s*\{\s*kind:\s*"(\w+)"/g)) {
      if (!out.has(m[1])) out.set(m[1], { kind: m[2], pkgs: new Set() })
      out.get(m[1]).pkgs.add(pkg)
    }
  }
  return out
}

/** 三期的迁移候选：当前 DOM 锚点 → 目标槽位。 */
export const MIGRATION = [
  {
    id: 'drawer-toggle',
    current: 'JS 创建 <button class="dsh-phone-menu"> + CSS position:fixed',
    target: 'conversation.header.leading',
    why: '上游 header 自带 leading 座位（本项目 CSS 目前把它 display:none 让位给自绘按钮）；迁入后可去掉 .wSkVaW_headerLeading 的 display:none 与 .dsh-phone-menu 的 fixed 定位，是**真正能减少哈希依赖**的一项（另见 mask 项对收益类型的说明）',
    risk: '中高：既改布局上下文，目标槽 conversation.header.leading 在本项目也无先例。',
    recipe: {
          "file": "peer/agent-cards/client-source.js",
          "code": [
                "// 抽屉开关：迁入上游 header 的 leading 座位（本项目 CSS 目前把它 display:none 让位）",
                "function DrawerToggle({ toggleSidebar }) {",
                "  return h('button', { type: 'button', className: 'dsh-phone-menu',",
                "    'aria-label': '展开菜单', onClick: toggleSidebar }, '☰')",
                "}",
                "ctx.slots.inject('conversation.header.leading', () => ctx.slots.register(",
                "  { name: 'conversation.header.leading', id: 'dsh-drawer-toggle', order: 10 }, DrawerToggle))"
          ],
          "wiring": [
                "删除 dsh-phone.css 里 .wSkVaW_headerLeading{display:none!important}（腾位给真开关）",
                "删除 .dsh-phone-menu 的 position:fixed 定位（改由 header 流式布局承载）",
                "dsh-phone.js 不再自建按钮，只保留开合状态与 Escape 收起"
          ],
          "verify": [
                "代码层：--check + 判别力测试",
                "CDP 层：断言开关位于 [data-dsh-frame] 的 header 内、且 aria-expanded 随开合翻转",
                "ADB 层：竖屏/横屏各点一次，确认不被标题遮挡"
          ]
    },
  },
  {
    id: 'drawer-mask',
    current: 'JS 创建 <button class="dsh-phone-sidebar-mask"> + CSS',
    target: 'shell.overlay',
    why: '上游框架自有覆盖层座位，语义就是「盖在框架上的浮层」。收益是**架构一致性**（不再往 body 末尾塞浮层、开合状态走显式契约），而非减少上游哈希依赖 —— 实测遮罩规则只用自有 class，真正锚哈希的是抽屉容器本身（.pI_x6G_sidebarCol/.hHd-Xa_root）。若要减哈希，应先做 drawer-toggle/抽屉容器那一项。',
    risk: '中：组件最简单（纯遮罩无布局参与），但槽通道未验证 —— shell.overlay 在本项目无先例（现有注册只落在 settings.section）。风险 = 组件复杂度 × 通道验证度，故不能按组件复杂度评为低。',
    recipe: {
          "prerequisite": "已实测确认壳侧静态模块表提供 react / react-dom / react/jsx-runtime / cordis / ui-slots / ui-primitives / ui-dockkit（脚本 scripts/ui-module-seed.mjs 可复核）。故槽位组件可写成**真正的 React 函数组件**（useState/useEffect），不必退回静态 element；factory 形态为 CJS：window.__ModuleLoader__.load({ id, factory: (require) => ({ inject, apply }) })。",
          "file": "peer/agent-cards/client-source.js（或 phone-qq 的对应源；改后由 build-assets.py 重建）",
          "code": [
                "// 遮罩：注册到上游 shell.overlay 座位（框架自有覆盖层）而不是 body 末尾。",
                "// 组件可写成真 React（模块表已确认提供 react），故用 hooks 订阅共享状态。",
                "const React = require('react')",
                "function DrawerMask() {",
                "  // 抽屉开合的唯一真源 = html[data-dsh-drawer-open]（一期的 DOM 事实）；",
                "  // 本组件只读它，不持有自己的开关状态 —— 避免双状态源。",
                "  const [open, setOpen] = React.useState(() =>",
                "    document.documentElement.hasAttribute('data-dsh-drawer-open'))",
                "  React.useEffect(() => {",
                "    const sync = () => setOpen(document.documentElement.hasAttribute('data-dsh-drawer-open'))",
                "    const mo = new MutationObserver(sync)",
                "    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dsh-drawer-open'] })",
                "    return () => mo.disconnect()",
                "  }, [])",
                "  if (!open) return null",
                "  return React.createElement('div', {",
                "    className: 'dsh-phone-mask', 'data-dsh-mobile-form': '',",
                "    onClick: () => document.documentElement.removeAttribute('data-dsh-drawer-open'),",
                "  })",
                "}",
                "ctx.slots.inject('shell.overlay', () => ctx.slots.register(",
                "  { name: 'shell.overlay', id: 'dsh-drawer-mask', order: 10 }, DrawerMask))"
          ],
          "wiring": [
                "⚠️ 前置未解：槽位组件与 dsh-phone.js 分属不同模块（后者是 evaluateJavascript 注入的 IIFE，前者是 __ModuleLoader__ 装载的 bundle），没有共享作用域。",
                "现状实证：show() 一次同时改 body class、rail.inert、rail[aria-hidden]、menu[aria-expanded]，还可能在展开时点击 .hHd-Xa_toggle —— 状态机只有一个，拆成两处必然不一致。",
                "可行通道（三选一，须先定型）：① 抽屉开合改用一期同构的 DOM 事实承载（如 html[data-dsh-drawer-open]），两模块都读写该属性；② 槽位组件只做纯呈现（读 [data-dsh-mobile-form] 与上游 [data-sidebar-collapsed]），开合动作仍留 dsh-phone.js；③ CustomEvent 单向通知。",
                "推荐 ①：与一期标记层同构（事实即接口），不引入新事件协议。",
                "dsh-phone.js 删除 mask 创建与 .dsh-phone-menu-open 驱动的遮罩 CSS 后，开合状态的唯一真源必须只剩一处（否则又回到双状态源）。"
          ],
          "verify": [
                "代码层：本清单 --check + slot-inventory.test.mjs（槽名有效）",
                "CDP 层：窄屏点开抽屉，断言遮罩在场且点击后收起",
                "ADB 层：真机点击抽屉外区域，确认收起且不误触底层"
          ]
    },
  },
  {
    id: 'composer-upload',
    current: 'JS 注入 <button class="dsh-phone-upload"> 到 .uV2eYG_tools（依赖哈希）',
    target: 'conversation.input.left',
    why: '输入区左侧座位，语义相符；摆脱 .uV2eYG_tools 哈希',
    risk: '高：上传链路与 DOM 位置强耦合（可能断链），且 conversation.input.left 无通道先例。双重不确定，建议最后做。',
    recipe: {
          "file": "peer/agent-cards/client-source.js",
          "code": [
                "// ⚠️ 高风险：上传链路（隐藏 input / DataTransfer / 草稿注入）与 DOM 位置强耦合。",
                "// 迁移前必须先确认：槽位组件内能否拿到 composer 的 input 引用与 draft 写入面。",
                "// 若拿不到，本项应放弃迁移（保留现有 .uV2eYG_tools 注入 + 锚点门禁兜底）。",
                "const React = require('react')",
                "function UploadButton() {",
                "  // 上传的真身仍是隐藏 input + DataTransfer 注入草稿；本组件只提供入口。",
                "  // ⚠️ 草稿写入面需经上游 composer 的公开通道获取 —— 这是本候选的前置阻塞，",
                "  //    未解决前不应合并本组件（否则按钮点了无效，比不改更糟）。",
                "  const pick = () => {",
                "    const el = document.querySelector('.dsh-phone-upload-picker')",
                "    if (el) el.click()",
                "  }",
                "  return React.createElement('button', { type: 'button', className: 'dsh-phone-upload', onClick: pick }, '上传')",
                "}",
                "ctx.slots.inject('conversation.input.left', () => ctx.slots.register(",
                "  { name: 'conversation.input.left', id: 'dsh-upload', order: 20 }, UploadButton))"
          ],
          "wiring": [
                "input 引用获取方式需重做（现依赖 card.querySelector(\"textarea,[role=textbox]\")）",
                "DataTransfer 粘贴路径不受位置影响，可保留"
          ],
          "verify": [
                "三层之外还需专项：上传图片/文件/技能 ZIP 三条链路各跑一次端到端"
          ]
    },
  },
  {
    id: 'model-picker-notice',
    current: 'JS 注入 <small class="dsh-phone-chatgpt-plan"> 到 [data-composer-card]',
    target: 'conversation.input.left',
    why: '**换座位**：原目标 conversation.input.plan 是 single 槽且被核心包 dsh-client-ui-plan 以 priority 0 独占 —— 实测 single 槽只渲染 priority 最低者，挂 1 上去永不显示。故改挂可共存的 list 槽 input.left。',
    risk: '中：input.left 是 list 槽（可与上游并存，无占位冲突），但同样无通道先例，需设备确认渲染时机与 composer 重挂行为。',
    recipe: {
          "file": "peer/agent-cards/client-source.js",
          "code": [
                "// 计划提示：挂在 conversation.input.left（list 槽）。",
                "// ⚠️ 不用 conversation.input.plan：那是 single 槽且被核心包以 priority 0 独占，",
                "//    实测只渲染 priority 最低者 ⇒ 挂上去永不显示（详见本项 why 字段）。",
                "const React = require('react')",
                "function PlanNotice() {",
                "  // ⚠️ 显示条件原来读 ._7KE1Ra_trigger 的 title（含「· ChatGPT 会员」）—— 那是",
                "  //    上游哈希，迁入后必须改读模型信息源（否则又引入一处哈希依赖）。",
                "  //    前置未解决前本组件应返回 null，不显示错误信息。",
                "  return null",
                "}",
                "ctx.slots.inject('conversation.input.left', () => ctx.slots.register(",
                "  // ⚠️ 该槽是 single，已被上游 dsh-client-ui-plan 以 priority=0 占用。实测结论：",
                "  //    · single 槽的可见性 = priority 最低者（entriesOfSlot 只返回那一条）",
                "  //    · 上游占用者是**核心包**，不会缺席 ⇒ 挂 priority:1 上去**永不渲染**（死代码）",
                "  //    ⇒ 本配方**不建议照抄**。要让内容出现在输入区，只有两条路：",
                "  //       ① 改上游 dsh-client-ui-plan（动 vendor，代价与风险都高）",
                "  //       ② 换座位：用 conversation.input.left（list 槽，可与他人共存）——下面即 ②。",
                "  { name: 'conversation.input.left', id: 'dsh-plan-notice', order: 10 }, PlanNotice))"
          ],
          "wiring": [
                "当前显示条件读自 ._7KE1Ra_trigger 的 title（含「· ChatGPT 会员」）——迁入后需改为读模型信息源，不可再锚哈希",
                "删除 dsh-phone.js 里 notice 的创建/迁移逻辑与 .dsh-phone-chatgpt-plan 的定位 CSS"
          ],
          "verify": [
                "CDP：选中会员模型时断言行在场；切回普通模型断言移除"
          ]
    },
  },
  {
    id: 'settings-dev-section',
    current: '（参考项目用 settings.dev.item；本引擎无此槽）',
    target: 'settings.section',
    why: '本项目已有 6 个 settings.section 注册且实测生效，沿用同一座位即可',
    risk: '低（唯一真正低的一项）：settings.section 是本项目唯一验证过的槽（6 处注册在跑），通道风险为零，只剩组件本身。',
    recipe: {
          "file": "peer/agent-cards/client-source.js",
          "code": [
                "// 本项目已有 8 处 settings.section 注册且实测生效，沿用同一座位（本引擎无 settings.dev.item）。",
                        "// ⚠️ 已占用的 id / order（照抄前先核对，避免功能重复）：",
                        "//   agent-persona-cards 25 · controlled-plugin-market 45 · chat-history 27",
                        "//   memory-isolation 26 · mcp-manager 43 · workflow-hub 40 · plugin-center 44 · appearance 20",
                        "//   hermes-remote 42 · phone-cloud-tools 43（后两者由 phone-qq 变体注册）",
                        "// ⇒ 可用 order 建议 30-39 或 46+；src 不要复用 /phone-tools（已被 phone-cloud-tools 占用）。",
                        "//   若要加开发者选项，应挂**新页面路由**，而非复用既有入口。",
                "ctx.slots.inject('settings.section', () => ctx.slots.register(",
                "  { name: 'settings.section', id: 'dsh-dev-options', order: 30, label: '开发者选项' },",
                "  () => h('iframe', { src: '/dev-options', 'data-dsh-settings-embed': '', style: { width: '100%', height: 'min(72dvh,760px)', border: 0 } })))"
          ],
          "wiring": [
                "与既有 8 处同型；order 取 30-39 或 46+，且 src 必须是新页面路由（详见代码注释里的占用清单）"
          ],
          "verify": [
                "CDP：设置页出现该分区；ADB：点击可打开"
          ]
    },
  },
]

/**
 * 校验迁移表：每条的目标槽在当前引擎树上是否存在。
 * @param tree 引擎树根（可为 null → 用登记快照判定）
 * @param snapshot 已登记的槽位快照（无引擎树时用）
 * @returns {{ok: Array, missing: Array}}
 */
/**
 * 校验注册方的 inject 声明是否覆盖各迁移目标槽的 host 包。
 * @param root 仓库根（含 phone-qq/ 与 peer/），可为 null
 * @returns {{checked:boolean, rows:Array<{id:string,target:string,host:string,ok:boolean,inject:string[]}>}}
 */
export function checkInjectCoverage(root) {
  if (!root) return { checked: false, rows: [] }
  const rows = []
  for (const r of REGISTERERS) {
    let inject = null
    try {
      const j = JSON.parse(readFileSync(join(root, r.manifest), 'utf8'))
      inject = j?.dsh?.client?.inject ?? null
    } catch { /* 清单缺失 → 该注册方本环境不可查 */ }
    if (!Array.isArray(inject)) continue
    for (const m of MIGRATION) {
      const host = SLOT_HOST[m.target]
      if (!host) continue
      rows.push({ pkg: r.pkg, id: m.id, target: m.target, host, ok: inject.includes(host), inject })
    }
  }
  return { checked: rows.length > 0, rows }
}

/**
 * 扫本项目实际分发的 client bundle，得出「已在跑的槽位」集合。
 * 这是**通道验证度**的事实来源：集合内的槽有真实先例（注册→渲染链路走通），
 * 不在其中的属未验证通道 —— 迁到那里时即使组件再简单，也可能整体不渲染。
 * @param root 仓库根（含 phone-qq/ 与 peer/），可为 null
 * @returns {Set<string>} 已注册的槽位名
 */
export function precedentSlots(root) {
  const out = new Set()
  if (!root) return out
  for (const rel of ['phone-qq/cards-client.js', 'peer/agent-cards/client.js']) {
    let text
    try { text = readFileSync(join(root, rel), 'utf8') } catch { continue }
    for (const m of text.matchAll(/register\(\{[^}]*name:\s*['"]([^'"]+)['"]/g)) out.add(m[1])
  }
  return out
}

/**
 * 找引擎树里**已注册**到指定槽位的上游条目及其 priority。
 *
 * 为什么关键（实测得出）：`register` 的冲突判据是 **priority（默认 0）**：
 *   - `single` 槽：同 priority 只能有一个 —— 第二个直接 throw
 *   - `list`/`keyed` 槽：同 id/key **且同 priority** 才冲突
 * 故迁到 `single` 槽前必须先知道上游占了哪个 priority，否则注册即崩。
 * 实测：`conversation.input.plan` 已被 `dsh-client-ui-plan` 以 priority=0 占用。
 *
 * @param root dsh 引擎树根
 * @returns {Map<string, Array<{pkg:string, priority:number, id:string|null}>>}
 */
export function scanSlotOccupants(root) {
  const out = new Map()
  if (!root) return out
  const scope = join(root, 'node_modules', '@deepseek-ai')
  let pkgs
  try { pkgs = readdirSync(scope) } catch { return out }
  for (const pkg of pkgs) {
    let text
    try { text = readFileSync(join(scope, pkg, 'lib', 'client.js'), 'utf8') } catch { continue }
    // 形态：register({ name: "槽", … })；参数体可能含嵌套花括号（inject: () => ({…})），
    // 故必须**括号配平地**取到匹配的 `})`，不能用 [^{}] 截断（实测因此漏报一整个包）。
    for (let i = text.indexOf('register({'); i !== -1; i = text.indexOf('register({', i + 1)) {
      let depth = 0, end = -1
      for (let j = i + 'register('.length; j < text.length; j++) {
        const c = text[j]
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) { end = j; break } }
      }
      if (end < 0) continue
      const b = text.slice(i, end + 1)
      if (b.length > 4000) continue          // 明显不是注册调用（防误抓大对象）
      const name = (b.match(/name:\s*["']([^"']+)["']/) || [])[1]
      if (!name) continue
      const pri = Number((b.match(/priority:\s*(-?\d+)/) || [])[1] ?? 0)
      const id = (b.match(/id:\s*["']([^"']+)["']/) || [])[1] ?? null
      if (!out.has(name)) out.set(name, [])
      out.get(name).push({ pkg, priority: pri, id })
    }
  }
  return out
}

export function checkMigration(tree, snapshot = {}) {
  const slots = tree && existsSync(tree) ? scanSlots(tree) : null
  const known = new Set(Object.keys(snapshot))
  const ok = [], missing = []
  for (const m of MIGRATION) {
    const present = slots ? slots.has(m.target) : known.has(m.target)
    const declaredBy = slots?.get(m.target)
    ;(present ? ok : missing).push({ ...m, declaredBy: declaredBy ? [...declaredBy] : [] })
  }
  return { ok, missing }
}

/** 已登记的槽位快照（引擎 0.2.1-alpha.1 实测）。无引擎树时作为判据基线。 */
export const SNAPSHOT_0_2_1 = {
  'shell.overlay': 'dsh-client-ui-layout',
  'shell.leading': 'dsh-client-ui-layout',
  'shell.bottom': 'dsh-client-ui-layout',
  'conversation.header.leading': 'dsh-client-ui-conversation',
  'conversation.header': 'dsh-client-ui-conversation',
  'conversation.input.left': 'dsh-client-ui-conversation',
  'conversation.input.plan': 'dsh-client-ui-conversation',
  'conversation.input.right': 'dsh-client-ui-conversation',
  'conversation.composer.dock': 'dsh-client-ui-conversation',
  'conversation.composer.bar': 'dsh-client-ui-conversation',
  'conversation.session.header.utilities': 'dsh-client-ui-conversation',
  'conversation.session.header.corner': 'dsh-client-ui-conversation',
  'settings.section': 'dsh-client-ui-settings-general',
  'settings.general.item': 'dsh-client-ui-settings-general',
  'settings.plugins.tab': 'dsh-client-ui-settings-general',
  'sidebar.right.pane.tab': 'dsh-client-ui-sidebar-right',
  'sidebar.right.pane.tab.title': 'dsh-client-ui-sidebar-right',
  'sidebar.right.tab.menu.item': 'dsh-client-ui-sidebar-right',
  // 明确不存在（参考项目按 0.2.0-rc.2 写过，本引擎已无）：
  // 'settings.dev.item' —— 迁移时改用 settings.section
}

/** 向上探测仓库根（含 phone-qq/ 或 peer/）。 */
function findRepoRoot() {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const p of ['', '../', '../../']) {
      const c = join(d, p)
      if (existsSync(join(c, 'phone-qq/package.json')) || existsSync(join(c, 'peer/package.json'))) return c
    }
    const up = dirname(d); if (up === d) break; d = up
  }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ti = args.indexOf('--tree')
  const tree = ti >= 0 ? args[ti + 1] : null
  if (ti >= 0 && (!tree || !existsSync(tree))) {
    console.error(`--tree 指向的路径不存在：${tree ?? '(缺参数)'}`)
    process.exit(2)
  }
  const slots = tree ? scanSlots(tree) : null
  const ri = args.indexOf('--recipe')
  if (ri >= 0) {
    const id = args[ri + 1]
    const all = MIGRATION.find(m => m.id === id)
    if (!all) {
      console.error('未知候选：' + id + '\n可用：' + MIGRATION.map(m => m.id).join(', '))
      process.exit(2)
    }
    const present = slots ? slots.has(all.target) : all.target in SNAPSHOT_0_2_1
    console.log('三期迁移配方 · ' + all.id)
    console.log('  目标槽：' + all.target + '  ' + (present ? '（当前引擎有效）' : '（⚠️ 当前引擎不存在）'))
    console.log('  现状：' + all.current)
    console.log('  理由：' + all.why)
    console.log('  风险：' + all.risk)
    if (all.recipe.prerequisite) console.log('  前置事实：' + all.recipe.prerequisite)
    console.log('  改动文件：' + all.recipe.file)
    console.log('  注册代码：')
    for (const l of all.recipe.code) console.log('    ' + l)
    console.log('  接线点：')
    for (const l of all.recipe.wiring) console.log('    - ' + l)
    console.log('  验证：')
    for (const l of all.recipe.verify) console.log('    - ' + l)
    process.exit(present ? 0 : 1)
  }
  const { ok, missing } = checkMigration(tree, SNAPSHOT_0_2_1)

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      mode: slots ? 'engine' : 'snapshot',
      totalSlots: slots ? slots.size : Object.keys(SNAPSHOT_0_2_1).length,
      migratedOk: ok.map(o => ({ id: o.id, target: o.target })),
      missing: missing.map(m => ({ id: m.id, target: m.target })),
    }, null, 2))
  } else {
    console.log(`槽位清单 · ${slots ? '引擎树 ' + tree : '登记快照（未给 --tree）'}`)
    console.log(`  引擎共 ${slots ? slots.size : Object.keys(SNAPSHOT_0_2_1).length} 个槽位`)
    if (!args.includes('--check')) {
      console.log('\n  主要槽位（本项目可能用到）：')
      const src = slots ?? new Map(Object.entries(SNAPSHOT_0_2_1).map(([k, v]) => [k, new Set([v])]))
      for (const n of [...src.keys()].sort()) {
        if (/^(conversation\.(header|input|composer)|shell\.|settings\.|sidebar\.right)/.test(n)) {
          console.log(`    ${n}`)
        }
      }
    }
    console.log('\n  三期迁移表校验：')
    for (const o of ok) console.log(`    ✓ ${o.id.padEnd(22)} → ${o.target}`)
    for (const m of missing) console.log(`    ✗ ${m.id.padEnd(22)} → ${m.target}（该槽在当前引擎不存在）`)
    const rootPath = findRepoRoot()
    const prec = precedentSlots(rootPath)
    if (prec.size > 0) {
      console.log('\n  通道验证度（本项目已在跑的槽位 = 有先例）：')
      console.log('    已有先例：' + [...prec].sort().join(', '))
      const unverified = [...new Set(MIGRATION.map(m => m.target))].filter(x => !prec.has(x))
      console.log('    无先例的迁移目标：' + (unverified.length ? unverified.join(', ') : '（全部有先例）'))
      const kindsLive = tree ? scanSlotKinds(tree) : null
      if (kindsLive && kindsLive.size > 0) {
        // 交叉核对：既有 kind 也有 host（后者取自声明包集合）
        const hostDrift = MIGRATION.filter(m => {
          const live = kindsLive.get(m.target)
          return live && SLOT_HOST[m.target] && !live.pkgs.has(SLOT_HOST[m.target])
        })
        if (hostDrift.length) {
          console.log('    ✗ 登记 host 与引擎声明包不一致：')
          for (const d of hostDrift) console.log('      ' + d.target + ' 快照=' + SLOT_HOST[d.target] + ' 引擎=' + [...kindsLive.get(d.target).pkgs].join('/'))
        } else {
          console.log('    ✓ 登记 host 与引擎声明包一致')
        }
        const drift = MIGRATION.filter(m => {
          const live = kindsLive.get(m.target)
          return live && SLOT_KIND[m.target] && live.kind !== SLOT_KIND[m.target]
        })
        console.log('    槽位声明自动提取：' + kindsLive.size + ' 个（引擎树权威来源）')
        if (drift.length) {
          console.log('    ✗ 登记快照与引擎树不一致（快照过期或上游改了契约）：')
          for (const d of drift) console.log('      ' + d.target + ' 快照=' + SLOT_KIND[d.target] + ' 引擎=' + kindsLive.get(d.target).kind)
        } else {
          console.log('    ✓ 登记快照与引擎树一致（交叉核对通过）')
        }
      }
      if (tree) {
        const occ = scanSlotOccupants(tree)
        const hits = MIGRATION.map(m => ({ m, o: occ.get(m.target) ?? [] })).filter(x => x.o.length > 0)
        console.log('    上游已占用的目标槽（决定 priority 取值）：')
        if (!hits.length) console.log('      （无 —— 全部目标槽未被上游注册）')
        for (const { m, o } of hits) {
          const kind = SLOT_KIND[m.target] ?? '?'
          console.log('      ' + m.target.padEnd(30) + kind.padEnd(8) + o.map(x => x.pkg + '(priority ' + x.priority + ')').join(', '))
          if (kind === 'single') console.log('        ⚠️ single 槽：我方必须用**不同于 ' + o.map(x => x.priority).join('/') + '** 的 priority，否则注册 throw')
        }
      }
      console.log('    各目标槽 kind（决定注册参数）：')
      for (const m of MIGRATION) {
        const k = SLOT_KIND[m.target] ?? '?'
        const need = k === 'list' || k === 'keyed' ? '必须带 id' + (k === 'keyed' ? ' 与 key' : '') : '同优先级只能一个'
        console.log('      ' + m.target.padEnd(30) + k.padEnd(8) + need)
      }
      if (unverified.length) {
        console.log('    ⚠️ 无先例的槽，注册→渲染链路在本项目**未被验证过**；')
        console.log('       风险 = 组件复杂度 × 通道验证度，评估时不可只看组件复杂度。')
      }
    }
    const cov = checkInjectCoverage(rootPath)
    if (cov.checked) {
      console.log('\n  注册方 inject 覆盖（缺 host 声明 = 组件静默不出现）：')
      for (const row of cov.rows) {
        console.log(`    ${row.ok ? '✓' : '✗'} ${row.pkg.padEnd(13)} → ${row.target.padEnd(30)} 需声明 ${row.host}`)
      }
      const miss = cov.rows.filter(r => !r.ok).length
      if (miss) {
        console.log(`    ⚠️ ${miss} 处 host 包未出现在注册方的 inject 声明里。`)
        console.log('       ⚠️ 已用真实 SlotCore 实测：register 的第一步就查槽位是否声明，')
        console.log('          未声明时**直接 throw**：')
        console.log('            slot "X" is not declared (a parent entry\'s children table')
        console.log('            must declare it)')
        console.log('       ⇒ 结论修正：inject 影响到达顺序，但「host 未声明该槽」是**硬失败**，')
        console.log('         不是时序竞态。故迁到无先例的槽之前，必须先确认该槽会被声明。')
        console.log('       佐证：本项目现有 6 处 settings.section 注册正常工作，说明该槽的')
        console.log('         host（ui-settings-general）确实声明了它（settings.section 有先例）。')
      }
    }
    const bad = missing.length
    console.log(bad ? `\n✗ ${bad} 条迁移目标不可用` : '\n✓ 全部迁移目标槽存在')
    process.exit(bad === 0 ? 0 : 1)
  }
}
