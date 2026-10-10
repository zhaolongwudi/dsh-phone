import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  ActiveModelPill,
  ACTIVE_ROUTE_POLL_MS,
  PENDING_LABEL,
  ROUTER_PROVIDER_IDS,
  describeActiveRoute,
  describeActiveRouteTitle,
  describeActiveRouteDetails,
} from '../../plugin-src/client/active-model-pill.js'

/**
 * 「在用模型」实时读数胶囊的回归。
 *
 * ⚠️ 为什么是**纯函数 + 源码级接线**断言，而不是渲染测试：
 * `plugin-src/client/active-model-pill.js` 依赖**宿主注入的 `react`**
 *（esbuild 的 external），本仓库 node_modules 里没有 react —— 与
 * `usage-badge-client.spec.ts` / `cline-quota-panel.spec.ts` 处境相同。
 *
 * 本文件守住两件事：
 * ① 文案判据（纯函数，真实现）：路由 provider 要有历史才显示真实目标，
 *    没有历史时显示**占位**而不是编造、也不是什么都不显示；
 * ② 接线：槽位挂在 `conversation.composer.dock`、order 排在官方两枚胶囊之后、
 *    依赖惰性取目录、样式齐备、常量与宿主逐字一致。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * 取某条 CSS 规则的**整块**（选择器必须从行首开始且精确相等）。
 *
 * ⚠️ 不能用 `/\.dim-jh-routePill \{[^}]*\}/` 这种裸写法：它会把
 * `.dim-jh-routePillTop { … }` 与 `.dim-jh-routePillBottom { … }` 也一起匹配到
 * （前缀相同），于是「取第 N 条规则」会拿到**别的**规则 —— 本次实测就因此
 * 假失败了一条（断言 font-size: 10px 时拿到的是合并那条）。故按行首锚定。
 */
const ruleOf = (styles: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped + ' \\{[^}]*\\}', 'm').exec(styles)?.[0] ?? ''
}

const codeOf = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/** 测试用的 provider 展示名（与宿主 `providerLabel` 同形）。 */
const label = (id: string) => ({ aggregate: '聚合（跨渠道）', loomy: 'Loomy（讯飞）' }[id] ?? id)

describe('在用模型胶囊：文案判据（纯函数）', () => {
  it('路由 provider 有历史 → 显示**真实**渠道与模型', () => {
    const text = describeActiveRoute({
      provider: 'aggregate',
      model: 'auto',
      route: { provider: 'loomy', model: 'glm-4.6' },
      providerLabel: label,
    })
    expect(text).toEqual({ top: 'Loomy（讯飞）', bottom: 'glm-4.6' })
    // ⚠️ 虚拟名 'auto' 绝不能出现在读数里（那正是本功能要消除的含糊）。
    expect(JSON.stringify(text)).not.toContain('auto')
  })

  it('jet-hub-auto 同样按真实目标显示', () => {
    expect(describeActiveRoute({
      provider: 'jet-hub-auto',
      model: 'auto',
      route: { provider: 'loomy', model: 'glm-4.6' },
      providerLabel: label,
    })).toEqual({ top: 'Loomy（讯飞）', bottom: 'glm-4.6' })
  })

  it('⚠️⚠️ 路由 provider 无历史 → **占位**，不编造', () => {
    // 反向验证：把这一支改成 `return null`（= 干脆不渲染），本用例即失败。
    // 用户报障过「找不到这个显示」，一个会自己冒出来的占位比静默消失更可确认。
    expect(describeActiveRoute({
      provider: 'aggregate', model: 'auto', route: null, providerLabel: label,
    })).toEqual({ top: '聚合（跨渠道）', bottom: PENDING_LABEL })
  })

  it('⚠️ 半截数据（只有 provider 或只有 model）按无历史处理', () => {
    // 宿主侧两个字段同生同灭（同一个 record 调用写入）；半截数据渲染出来
    // 会更误导（如「在用 · Loomy（讯飞） · undefined」）。
    expect(describeActiveRoute({
      provider: 'aggregate', model: 'auto', route: { provider: 'loomy', model: '' }, providerLabel: label,
    })).toEqual({ top: '聚合（跨渠道）', bottom: PENDING_LABEL })
    expect(describeActiveRoute({
      provider: 'aggregate', model: 'auto', route: { provider: '', model: 'glm-4.6' }, providerLabel: label,
    })).toEqual({ top: '聚合（跨渠道）', bottom: PENDING_LABEL })
  })

  it('非路由 provider → 选中的就是真实模型', () => {
    expect(describeActiveRoute({
      provider: 'loomy', model: 'glm-4.6', route: null, providerLabel: label,
    })).toEqual({ top: 'Loomy（讯飞）', bottom: 'glm-4.6' })
  })

  it('无选中 provider → null（调用方据此不渲染）', () => {
    expect(describeActiveRoute({ provider: undefined, model: undefined, route: null, providerLabel: label })).toBeNull()
    expect(describeActiveRoute({ provider: '', model: 'x', route: null, providerLabel: label })).toBeNull()
  })

  it('非路由 provider 但没有 model → null（不渲染半截读数）', () => {
    expect(describeActiveRoute({ provider: 'loomy', model: undefined, route: null, providerLabel: label })).toBeNull()
  })

  it('缺 providerLabel 时退化为裸 id（不抛）', () => {
    expect(describeActiveRoute({
      provider: 'aggregate', model: 'auto', route: { provider: 'loomy', model: 'glm-4.6' },
    })).toEqual({ top: 'loomy', bottom: 'glm-4.6' })
  })

  it('title 在无 at 时也给得出（不显示 undefined）', () => {
    expect(describeActiveRouteTitle({ route: null })).toBe('当前实际使用的渠道与模型')
    expect(describeActiveRouteTitle({ route: { provider: 'a', model: 'b', at: Number.NaN } })).toBe('当前实际使用的渠道与模型')
    expect(describeActiveRouteTitle({ route: { provider: 'a', model: 'b', at: Date.now() } })).toContain('更新于')
  })
})

describe('在用模型胶囊：常量与宿主逐字一致', () => {
  it('路由白名单 = aggregate + jet-hub-auto', () => {
    expect([...ROUTER_PROVIDER_IDS]).toEqual(['aggregate', 'jet-hub-auto'])
  })

  it('⚠️ 白名单与宿主常量逐字一致（写错只会静默显示虚拟名，不报错）', () => {
    const aggregate = read('src/aggregate-adapter.ts')
    const auto = read('src/auto-adapter.ts')
    expect(aggregate).toMatch(/export const AGGREGATE_PROVIDER = 'aggregate'/)
    expect(auto).toMatch(/export const AUTO_PROVIDER = 'jet-hub-auto'/)
  })

  it('轮询是 5 秒量级（纯内存读，不能沿用 60 秒的余额节奏）', () => {
    expect(ACTIVE_ROUTE_POLL_MS).toBe(5_000)
  })
})

describe('在用模型胶囊：槽位接线', () => {
  const index = codeOf(read('plugin-src/client/index.js'))

  it('注册到 conversation.composer.dock（list 槽 ⇒ 与官方胶囊并存）', () => {
    expect(index).toContain("ctx.slots.inject('conversation.composer.dock'")
    expect(index).toContain("name: 'conversation.composer.dock'")
    expect(index).toContain("id: 'jet-hub-active-model'")
  })

  it('⚠️⚠️ order = 2（排在官方 activity 0 / usage 1 之后 = 最下方一行）', () => {
    const block = index.slice(index.indexOf("id: 'jet-hub-active-model'"))
    expect(block).toMatch(/order:\s*2\b/)
  })

  it('⚠️⚠️ 不得抢 conversation.input.activity（single 槽，已被语音输入占用）', () => {
    expect(index).not.toContain("inject('conversation.input.activity'")
  })

  it('⚠️ 惰性取目录，且 store 与 load 都交出（真机事故 2026-10-02 的两个成因）', () => {
    expect(index).toContain('resolveDirectory: () => {')
    expect(index).toContain('store: directory.store,')
    expect(index).toContain('load: () => directory.load(),')
    // 不能在 inject 期就求值 directoryFor(...) 的成员。
    expect(index).not.toMatch(/resolveDirectory: \(\) => ctx\.modelDirectories\.directoryFor\(sessionId\)\.store/)
  })

  it('RPC 读的是内存端点，且把 provider 传下去', () => {
    expect(index).toContain("rpcCall('router.activeRoute', { provider })")
  })

  it('★ 新端点不可用时，aggregate 回落到旧端点（宿主未重启的中间态）', () => {
    // 客户端 bundle 由 client-hmr 每 500ms 轮询并自动 reload，而宿主只在启动时载入
    // ⇒ 存在「客户端已新、宿主仍旧」的真实窗口（实测出现过）。旧宿主已有
    // aggregate.activeProvider（自 c066b8ea 起就带 model），故聚合可先借它拿真实读数。
    expect(index).toContain("rpcCall('aggregate.activeProvider', {})")
    const wire = index.slice(index.indexOf('readActiveRoute:'));
    // 回落必须只包住新端点调用（try/catch 形态），不能两条无条件都打。
    expect(wire).toContain('try {');
    expect(wire.indexOf('router.activeRoute')).toBeLessThan(wire.indexOf('aggregate.activeProvider'));
  })

  it('★ 回落只对 aggregate 生效（jet-hub-auto 不得借用聚合的读数）', () => {
    const wire = index.slice(index.indexOf('readActiveRoute:'));
    // 非 aggregate 必须重新抛出：否则会把聚合的「上次成功」当成 auto 的
    // 「本次发往」，显示一个**错误的**模型名 —— 比不显示更糟。
    expect(wire).toMatch(/provider !== 'aggregate'[\s\S]{0,40}throw/);
  })

  it('组件真的导出了（接线不是空指针）', () => {
    expect(typeof ActiveModelPill).toBe('function')
  })

  it('样式齐备', () => {
    const styles = read('plugin-src/client/jet-hub-styles.js')
    expect(styles).toContain('.dim-jh-routePill {')
    expect(styles).toContain('.dim-jh-routePillTop')
    expect(styles).toContain('.dim-jh-routePillBottom')
    // ⚠️ STYLES 是模板字符串：注释里出现反引号会提前闭合它（本仓踩过）。
    const start = styles.indexOf('const STYLES = `') + 'const STYLES = `'.length
    expect(styles.slice(start, styles.lastIndexOf('`'))).not.toContain('`')
  })

  it('★ 竖排两行（真机实测：单行会把官方两枚胶囊一起挤掉）', () => {
    // dock 是 display:flex 且**无 flex-wrap** ⇒ 各元素宽度**相加**。
    // 第一版单行「在用 · 渠道 · 模型」把三枚文字胶囊全部截断（实测截图：
    // 20 ... / 74.3... / 在用 · CodeBuddy (）。竖排后宽度从「和」变成
    // 「较大值」（约减半），这是保住官方两枚显示的关键。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    const rule = ruleOf(styles, '.dim-jh-routePill')
    expect(rule).toContain('flex-direction: column')
    // ⚠️ 反过来锁死：容器不得再出现单行 nowrap（那正是撑爆一行的成因）。
    expect(rule).not.toContain('white-space: nowrap')
    // 两行各自省略。
    const rows = ruleOf(styles, '.dim-jh-routePillTop, .dim-jh-routePillBottom')
    expect(rows).toContain('text-overflow: ellipsis')
    expect(rows).toContain('white-space: nowrap')
  })

  it('★ 有宽度上限（不得把官方两枚胶囊挤没）', () => {
    const styles = read('plugin-src/client/jet-hub-styles.js')
    const rule = ruleOf(styles, '.dim-jh-routePill')
    expect(rule).toContain('min-width: 0')
    // 字号必须比正文小（用户明确要求「缩小字号」）。
    const top = ruleOf(styles, '.dim-jh-routePillTop')
    const bottom = ruleOf(styles, '.dim-jh-routePillBottom')
    expect(top).toMatch(/font-size:\s*9px/)
    expect(bottom).toMatch(/font-size:\s*10px/)
  })

  it('★★ 宽度上限只能写在外层（两层都写百分比会乘起来）', () => {
    // ⚠️ 真缺陷：我第一版把 max-width: 32% **同时**写在 .dim-jh-routePillRoot 与
    //    内层 .dim-jh-routePill 上。百分比相对**各自的包含块**解析 ⇒ 内层实际
    //    可用宽度 = 32% × 32% ≈ 视口的 10%，模型名被砍到只剩几个字符，
    //    比不加约束更糟。故：外层有上限、内层必须是 100%。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    const root = ruleOf(styles, '.dim-jh-routePillRoot')
    const inner = ruleOf(styles, '.dim-jh-routePill')
    expect(root).toMatch(/max-width:\s*\d+%/)
    expect(inner).toContain('max-width: 100%')
    // ⚠️ 内层不得再出现**非 100%** 的百分比上限（`100%` 本身就是内层的正确值，
    //    故判据是「除 100% 外没有别的百分比」，写成 `not.toMatch(/\d+%/)`
    //    会连 100% 一起否掉 —— 我第一版就是这么写错的）。
    const percents = (inner.match(/max-width:\s*(\d+)%/g) ?? [])
    expect(percents).toEqual(['max-width: 100%'])
  })

  it('★ 不得使用本仓不存在的 CSS 变量（真机排查过：不存在的变量会静默回落）', () => {
    // 我写过 background: var(--dsw-alias-bg-tertiary, rgba(0,0,0,0.04)) ——
    // 该变量在本仓**不存在**（本仓只有 --dsw-alias-bg-l1 / bg-l2 / bg-layer-*），
    // 于是恒落到那个半透明黑：深色主题上几乎看不见，反而更像「没渲染」。
    const styles = read('plugin-src/client/jet-hub-styles.js')
    const rule = ruleOf(styles, '.dim-jh-routePill')
    expect(rule).not.toContain('--dsw-alias-bg-tertiary')
    // 本规则只允许这一个变量，且它必须是被本文件大量使用的既有变量。
    const used = rule.match(/--dsw-alias-[a-z0-9-]+/g) ?? []
    expect(used).toEqual(['--dsw-alias-label-tertiary'])
  })
})

describe('在用模型胶囊：明细弹层（用户建议，2026-10-10）', () => {
  it('★ 路由 provider 有历史 → 渠道/模型/选择/虚拟模型 四行（+ 时刻）', () => {
    const rows = describeActiveRouteDetails({
      provider: 'aggregate',
      model: 'auto',
      route: { provider: 'loomy', model: 'glm-4.6', at: Date.now() },
      providerLabel: label,
    })
    expect(rows.slice(0, 4)).toEqual([
      { label: '渠道', value: 'Loomy（讯飞）' },
      { label: '模型', value: 'glm-4.6' },
      { label: '选择', value: '聚合（跨渠道）' },
      { label: '虚拟模型', value: 'auto' },
    ])
    // 有 at ⇒ 末行是时刻（格式 HH:MM:SS）。
    expect(rows.length).toBe(5)
    expect(rows[4]?.label).toBe('更新于')
    expect(/^\d{2}:\d{2}:\d{2}$/.test(rows[4]?.value ?? '')).toBe(true)
  })

  it('★ 无历史 → 两行占位（不编造具体值）', () => {
    const rows = describeActiveRouteDetails({
      provider: 'aggregate', model: 'auto', route: null, providerLabel: label,
    })
    expect(rows).toEqual([
      { label: '渠道', value: PENDING_LABEL },
      { label: '模型', value: PENDING_LABEL },
      { label: '选择', value: '聚合（跨渠道）' },
      { label: '虚拟模型', value: 'auto' },
    ])
  })

  it('★ 直连 provider → 不写「选择/虚拟模型」（与渠道同值，写了是重复）', () => {
    const rows = describeActiveRouteDetails({
      provider: 'loomy', model: 'glm-4.6', route: null, providerLabel: label,
    })
    expect(rows).toEqual([
      { label: '渠道', value: 'Loomy（讯飞）' },
      { label: '模型', value: 'glm-4.6' },
    ])
  })

  it('无选中 provider → 空数组（组件本就不渲染）', () => {
    expect(describeActiveRouteDetails({
      provider: undefined, model: undefined, route: null, providerLabel: label,
    })).toEqual([])
  })

  it('★ 旧端点回落路径（at 为 null）不出现「更新于」行', () => {
    const rows = describeActiveRouteDetails({
      provider: 'aggregate', model: 'auto',
      route: { provider: 'zcode', model: 'glm-5.2', at: null }, providerLabel: label,
    })
    expect(rows.some((row: { label: string }) => row.label === '更新于')).toBe(false)
  })
})

describe('在用模型胶囊：React Hook 规则（自查发现的真缺陷）', () => {
  it('★★ 组件的提前 return 必须排在所有 Hook 之后', () => {
    // 我第一版把 `if (text === null) return null` 写在 useState/useRef 之前 ——
    // 于是「有选中模型」与「无选中模型」两种渲染的 **Hook 数不同**，React 会抛
    // `Rendered more hooks than during the previous render`，而它在**会话输入区
    // 的渲染路径**上 ⇒ 整个输入区白屏（远比胶囊不显示严重）。
    const src = read('plugin-src/client/active-model-pill.js')
    const body = src.slice(src.indexOf('export function ActiveModelPill'))
    const lastHook = Math.max(
      body.lastIndexOf('React.useSyncExternalStore'),
      body.lastIndexOf('React.useEffect'),
      body.lastIndexOf('React.useState'),
      body.lastIndexOf('React.useRef'),
      body.lastIndexOf('useAnchoredPosition('),
    )
    const earlyReturn = body.indexOf('if (text === null) return null')
    expect(lastHook).toBeGreaterThan(-1)
    expect(earlyReturn).toBeGreaterThan(-1)
    expect(earlyReturn).toBeGreaterThan(lastHook)
  })

  it('★ 弹层用 createPortal 挂到 body（否则会被输入区的 overflow 裁掉）', () => {
    const src = read('plugin-src/client/active-model-pill.js')
    expect(src).toContain("import { createPortal } from 'react-dom'")
    expect(src).toContain('createPortal(')
    expect(src).toContain('document.body')
  })

  it('★ 弹层测量用 visibility 而非 display（display:none 量到 0 尺寸）', () => {
    const src = read('plugin-src/client/active-model-pill.js')
    const style = /const MEASURE_STYLE = \{[^}]*\}/.exec(src)?.[0] ?? ''
    expect(style).toContain('visibility')
    expect(style).not.toContain('display')
  })

  it('★★ 无 DOM 环境不得抛错（window / document 都要先判存在）', () => {
    // ⚠️ 这是实测抓到的**真缺陷**：弹层的定位 effect 与关闭 effect 都跑在
    //    **渲染提交路径**上，我第一版直接 window.addEventListener /
    //    document.addEventListener —— 在无 DOM 的夹具里抛
    //    ReferenceError: window is not defined。抛在这里不是「弹层不显示」，
    //    而是**整个会话输入区崩掉**（与文件头那两个真机事故同一形态）。
    const src = read('plugin-src/client/active-model-pill.js')
    expect(src).toContain("typeof window === 'undefined'")
    expect(src).toContain("typeof document === 'undefined'")
    // 两个 effect 各自都要有守卫（只加一个仍会在另一条路径上抛）。
    expect((src.match(/typeof (window|document) === 'undefined'/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // 守卫必须排在 addEventListener **之前**（顺序错了等于没加）。
    const winGuard = src.indexOf("typeof window === 'undefined'")
    const winAdd = src.indexOf("window.addEventListener('resize'")
    expect(winGuard).toBeGreaterThan(-1)
    expect(winGuard).toBeLessThan(winAdd)
    const docGuard = src.indexOf("typeof document === 'undefined'")
    const docAdd = src.indexOf("document.addEventListener('keydown'")
    expect(docGuard).toBeGreaterThan(-1)
    expect(docGuard).toBeLessThan(docAdd)
  })
})
