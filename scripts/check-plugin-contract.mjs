// 跨层类名契约门禁：检查 app 层（dsh-phone.js / dsh-phone.css）依赖的每个
// `.dim-jh-*` 选择器，是否仍由**插件侧**产出、且已在登记表里声明（Issue F-19）。
//
// ## 为什么需要它
//
// 本层有两类自有类名，此前被当成一类：
//   ① `.dsh-phone-*` —— 本层自己 createElement 造、自己消费，改一处只影响自己；
//   ② `.dim-jh-*`    —— 插件（dsh-providers-hub 的 plugin-src/client）产出、
//      **本层 app 层消费**。
//
// 后者是跨层契约，而它此前**没有任何登记**：无版本号、无断言、无测试锁。
// 插件侧改名或删除时，本层选择器静默不命中 —— 页面照常渲染、构建通过、类型检查
// 通过、单测通过，只有人眼可能发现「手机上某个东西不好用了」。F-15（手机窄屏下
// 用量徽标读数整块消失）与 F-16（账号拖拽在触屏完全无效）正是因此长期无人发现：
// 插件侧 CSS 是**桌面口径**，手机可用性完全由本层注入的 DOM 与覆盖样式维持，
// 而这根链条没有任何一处会被构建拦下。
//
// 本门禁把这种静默失效搬到构建期：失效即报红，并点名「哪个类名、属于哪个插件文件、
// 什么语义、本层哪几个文件在消费它」，让维护者拿得到可执行的修复线索。
// 与 check-ui-anchors.mjs 同款做法 —— 那个管**上游哈希**锚点，本脚本管**插件侧**类名。
//
// ## 用法
//   node scripts/check-plugin-contract.mjs                       核查（有问题非零退出）
//   node scripts/check-plugin-contract.mjs --root <胶囊仓根>      显式指定仓根
//   node scripts/check-plugin-contract.mjs --report              只报告，恒零退出
//   node scripts/check-plugin-contract.mjs --json                机读输出
//
// ## 路径解析（三层候选，均支持「只有胶囊仓」与「apply 后的仓库」两种布局）
//   1. `--root <dir>`（显式指定，最高优先）
//   2. 环境变量 `DSH_CAPSULE_ROOT` / `DSH_TREE`（前者为本层仓根，后者为引擎树根）
//   3. 自本脚本向上逐级探测（与前缀 `overrides/`、`files/`、`` 组合）
// ⚠️ 刻意**不**依赖 DSH_TREE：本脚本要在 CI 与「只有胶囊仓」的开发机上都能跑，
//    而 CI 里既没有引擎树、也没有设备路径。这与 ui-tests/paths.mjs 的
//    resolveEngineTree（那里找不到就退回离线模式）是同一取舍。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, basename, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 覆盖/新增两类资产在胶囊工作区里的前缀（与 ui-tests/paths.mjs 一致）。 */
const PREFIXES = ['overrides/', 'files/', '']

const CONTRACT_REL = 'app/src/main/assets/phone-plugin-contract.json'
const APP_ASSETS_REL = 'app/src/main/assets'

/**
 * 自 from 向上逐级、对每个前缀查找第一个存在的路径。
 * @param rel 相对路径
 * @param from 起点目录（默认本脚本所在目录）
 * @returns 绝对路径，找不到返回 null
 */
function locate(rel, from = HERE) {
  let d = from
  for (let i = 0; i < 10; i++) {
    for (const prefix of PREFIXES) {
      const p = join(d, prefix + rel)
      if (existsSync(p)) return p
    }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

/**
 * 由契约表所在目录（…/app/src/main/assets）反推胶囊仓根。
 *
 * 两种布局都要成立：
 *   A「胶囊工作区」 `<capsule>/files/app/src/main/assets/…`   → 仓根 = `<capsule>`
 *   B「apply 之后」  `<repo>/app/src/main/assets/…`            → 仓根 = `<repo>`
 * 故先把 `app/src/main/assets` 四级剥掉，得到「前缀根」；若该根的名字恰是
 * `files` / `overrides`（= 布局 A），仓根再往上取一级。
 * ⚠️ 不能简单写死剥五级：布局 B 下会越界到仓库的**父目录**，于是插件面整个找不到、
 *    门禁静默跳过（假绿）—— 那是比报红更坏的失效形态。
 * @param appAssets 契约表所在目录
 */
function findCapsuleRoot(appAssets) {
  const prefixRoot = dirname(dirname(dirname(dirname(appAssets))))   // … → <capsule>/files 或 <repo>
  const name = basename(prefixRoot)
  return (name === 'files' || name === 'overrides') ? dirname(prefixRoot) : prefixRoot
}

/**
 * 解析门禁需要的全部路径。
 *
 * ⚠️ 契约表与插件源**不在同一前缀下**（表走 files/、插件走 overrides/），
 *    故各自定位，不能按「同一目录下同时找到两者」来探测 —— 那会漏掉真实布局。
 * @param root 显式仓根（可为 null）
 * @returns {{root:string, contract:string, appAssets:string, pluginDirs:Array, app:*}}
 */
export function resolveLayout(root = null) {
  // `--root` 可以指向几个不同位置之一：胶囊仓根（含 overrides/ 与 files/）、
  // 其中任一前缀目录、或 apply 之后的仓库根。逐个候选试，取第一个命中的；
  // 未给 `--root` 时退回「自本脚本向上探测」—— 那是维护期的默认路径。
  const anchors = [HERE]
  if (root) {
    const abs = resolvePath(root)
    anchors.unshift(abs, join(abs, '..'), join(abs, '..', '..'))
  }

  let contract = null
  for (const anchor of anchors) {
    contract = locate(CONTRACT_REL, anchor)
    if (contract) break
  }
  if (!contract) throw new Error(`找不到 ${CONTRACT_REL}（--root=${root ?? '(未给)'}）`)
  const appAssets = dirname(contract)
  const capsuleRoot = findCapsuleRoot(appAssets)

  // ⚠️⚠️ 本仓最容易踩的一处布局陷阱（初版实测踩到，故这里写成显式判据）：
  //   本层资产**不按同一前缀成组**，而是按「覆盖 vs 全新增」分散在两个前缀下 ——
  //     · dsh-phone.js / dsh-phone.css 走 overrides/app/…（覆盖上游同名文件）；
  //     · 契约表走 files/app/…（全新增资产）；
  //     · 插件客户端源码**一半在 files/、一半在 overrides/**（各自对应「上游有没有
  //       同名文件」），只看任一前缀都只拿到一部分（实测 files/ 侧仅 3 个文件）。
  //   ⇒ 插件产出面取**两个前缀的并集**，同名时 overrides 胜出 —— 那正是 apply.sh
  //     的铺开顺序（先 files/ 后 overrides/），故这里的覆盖方向与构建期一致。
  //   初版从契约表位置反推一个「仓根」再拼插件目录，只拿到 files/ 那一半 ⇒
  //   产出面整体塌掉、门禁对每一项都报「契约失效」。假红比漏报更糟：
  //   它会让维护者直接关掉这道门禁。app 层两个文件同样用 locate 各自定位。
  const pluginRel = 'vendor/dsh-providers-hub/plugin-src/client'
  const pluginDirs = ['files', 'overrides', '']
    .map(prefix => ({ prefix: prefix || 'repo', dir: join(capsuleRoot, prefix, pluginRel) }))
    .filter(entry => existsSync(entry.dir))
  if (pluginDirs.length === 0) throw new Error(`找不到插件客户端目录 ${pluginRel}`)

  const appJs = locate('app/src/main/assets/dsh-phone.js', capsuleRoot) ?? null
  const appCss = locate('app/src/main/assets/dsh-phone.css', capsuleRoot) ?? null
  const pluginPkg = locate('vendor/dsh-providers-hub/package.json', capsuleRoot) ?? null

  return { root: capsuleRoot, contract, appAssets, pluginDirs, appJs, appCss, pluginPkg }
}

/**
 * 剥掉注释，只留**可执行/可命中**的文本。
 *
 * ⚠️ 这一步是判据成立的前提：本层的 CSS/JS 注释里大量**引用** .dim-jh-* 类名
 *    （解释某条规则为什么存在），裸文本扫描会把注释当成真实依赖 ——
 *    于是删掉真规则、只留注释，门禁照样绿（本仓库记过的同型事故：
 *    判据自匹配修复注释本身）。
 * @param text 源码
 * @param kind 'css' | 'js'
 */
export function stripComments(text, kind) {
  // 块注释两种语言都有。
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '')
  if (kind === 'js') {
    // 行注释：只在行首（含缩进）时剥，避免误伤 URL 里的 //（'https://…'）。
    out = out.replace(/^[ \t]*\/\/.*$/gm, '')
  }
  return out
}

/** 从一段文本里取出全部 `.dim-jh-*` 类名（**不含**前导点，便于比表）。 */
export function referencedClasses(text) {
  const classes = new Set()
  for (const m of text.matchAll(/\.dim-jh-[A-Za-z0-9_-]+/g)) classes.add(m[0].slice(1))
  return classes
}

/**
 * 插件侧「是否产出该类名」的判据。
 *
 * ⚠️ 判据是**字符串字面量内的出现**，而不是裸词出现：插件源码的注释同样大量
 *    提到这些类名（解释样式为什么这么写），裸词判据会让「插件已删掉该类名、
 *    只剩注释」的情况被误判成「仍产出」—— 那正是本门禁要抓的失效形态。
 *    React 的写法是 `className: 'dim-jh-x'` / `'dim-jh-a dim-jh-b'`，
 *    模板字符串里的 CSS 规则是 `` `.dim-jh-x { … }` `` ⇒ 两者都在引号内。
 * @param code 已剥注释的插件源码
 * @param cls 类名（不含点）
 */
export function producesClass(code, cls) {
  const re = new RegExp(`['"\`][^'"\`\\n]*\\b${cls}\\b[^'"\`\\n]*['"\`]`)
  return re.test(code)
}

/**
 * 执行门禁检查。
 * @param layout resolveLayout() 的返回值（测试可注入）
 * @returns 结构化结果
 */
export function checkPluginContract(layout) {
  const contract = JSON.parse(readFileSync(layout.contract, 'utf8'))
  const declared = contract.classes ?? {}
  const knownGaps = Object.fromEntries(
    Object.entries(contract.knownGaps ?? {}).filter(([k]) => k !== '$comment'))

  // 消费面：app 层两个文件（各自记录，报错时能说「改哪里」）。
  const consumers = [
    { name: 'dsh-phone.js', path: layout.appJs, kind: 'js' },
    { name: 'dsh-phone.css', path: layout.appCss, kind: 'css' },
  ].filter(c => c.path !== null)
  const referenced = new Map()      // cls → Set(消费文件名)
  for (const c of consumers) {
    const text = stripComments(readFileSync(c.path, 'utf8'), c.kind)
    for (const cls of referencedClasses(text)) {
      if (!referenced.has(cls)) referenced.set(cls, new Set())
      referenced.get(cls).add(c.name)
    }
  }

  // 产出面：插件客户端目录下的全部 .js（含承载 CSS 模板的 jet-hub-styles.js）。
  // ⚠️ 取**两个前缀的并集**，同名时 overrides 胜出 —— 那正是 apply.sh 的铺开顺序
  //    （先 `cp -a files/.` 后 `cp -a overrides/.`，后者覆盖前者）。
  const pluginCode = new Map()      // 文件名 → 铺开后的最终源码（已剥注释）
  const pluginOrigin = new Map()    // 文件名 → 来源前缀（报错时能说「在哪一处改」）
  for (const entry of [...layout.pluginDirs].reverse()) {
    for (const f of readdirSync(entry.dir).filter(n => n.endsWith('.js')).sort()) {
      pluginCode.set(f, stripComments(readFileSync(join(entry.dir, f), 'utf8'), 'js'))
      pluginOrigin.set(f, entry.prefix)
    }
  }
  const pluginFiles = [...pluginCode.keys()].sort()
  const producers = new Map()       // cls → Set(插件文件名)
  for (const cls of new Set([...Object.keys(declared), ...referenced.keys()])) {
    const hits = pluginFiles.filter(f => producesClass(pluginCode.get(f), cls))
    if (hits.length > 0) producers.set(cls, new Set(hits))
  }

  const undeclared = []    // 本层用了、但表里没登记 → 漏登记
  const stale = []         // 表里登记了、但本层已不用 → 表里的死条目
  const broken = []        // 已登记、但插件侧不再产出 → 契约失效（本门禁的主目标）
  const gapRevived = []    // knownGaps 里的类名插件侧又产出了 → 该移出该表
  const gapUndeclared = [] // 本层用了、表与 knownGaps 都没有 → 双漏

  for (const [cls, usedBy] of referenced) {
    if (!(cls in declared)) {
      if (cls in knownGaps) continue
      gapUndeclared.push({ cls, usedBy: [...usedBy].join('+') })
    }
  }
  for (const cls of Object.keys(declared)) {
    if (!referenced.has(cls)) { stale.push(cls); continue }
    if (!producers.has(cls)) {
      broken.push({ cls, usedBy: [...referenced.get(cls)].join('+'), ...declared[cls] })
    }
  }
  for (const cls of Object.keys(knownGaps)) {
    if (producers.has(cls)) gapRevived.push({ cls, producers: [...producers.get(cls)].join(',') })
  }

  // 版本漂移：插件包版本与登记值不一致 ⇒ 需复核（改名多发生在插件发版时）。
  let pluginVersion = null
  let versionDrift = null
  if (layout.pluginPkg && existsSync(layout.pluginPkg)) {
    try {
      pluginVersion = JSON.parse(readFileSync(layout.pluginPkg, 'utf8')).version ?? null
      if (pluginVersion !== null && contract.pluginVersion && pluginVersion !== contract.pluginVersion) {
        versionDrift = { declared: contract.pluginVersion, actual: pluginVersion }
      }
    } catch { /* 包描述读不出来不是契约问题，跳过 */ }
  }

  return {
    contract: layout.contract,
    pluginDirs: layout.pluginDirs,
    pluginVersion, versionDrift,
    declaredCount: Object.keys(declared).length,
    referencedCount: referenced.size,
    producerCount: producers.size,
    consumers: consumers.map(c => c.name),
    pluginFiles,
    pluginOrigin: Object.fromEntries(pluginOrigin),
    undeclared: gapUndeclared,
    stale, broken, gapRevived,
  }
}

/** 把结果渲染成人可读报告。 */
export function formatReport(r) {
  const L = []
  L.push('跨层类名契约门禁（Issue F-19）')
  L.push(`  契约表 ${r.contract}`)
  L.push(`  插件产出面 ${r.pluginDirs.length} 处（并集 ${r.pluginFiles.length} 个文件` +
    (r.pluginVersion ? `，包版本 ${r.pluginVersion}` : '') + '）：')
  for (const d of r.pluginDirs) L.push(`    [${d.prefix}] ${d.dir}`)
  L.push(`  app 层消费面 ${r.consumers.join(' + ')}`)
  L.push(`  登记 ${r.declaredCount} 项 · 本层实际引用 ${r.referencedCount} 项 · 插件侧可产出 ${r.producerCount} 项`)
  L.push('')
  if (r.broken.length) {
    L.push(`✗ 契约失效 ${r.broken.length} 项（插件侧已不产出，本层选择器静默不命中）：`)
    for (const b of r.broken) {
      L.push(`    .${String(b.cls).padEnd(26)} [${b.usedBy}] ${b.semantic ?? '-'}`)
      L.push(`        声明产出于 ${b.pluginFile ?? '-'} —— 请到插件侧确认新类名，或改本层选择器`)
    }
  }
  if (r.undeclared.length) {
    L.push(`✗ 未登记 ${r.undeclared.length} 项（本层引用了 .dim-jh-* 但契约表没有它）：`)
    for (const u of r.undeclared) L.push(`    .${String(u.cls).padEnd(26)} [${u.usedBy}]`)
    L.push('    ⇒ 先在 ' + CONTRACT_REL + ' 登记（owner / pluginFile / semantic）再引用')
  }
  if (r.stale.length) {
    L.push(`✗ 死条目 ${r.stale.length} 项（契约表登记了但本层已不引用，应清理）：`)
    for (const s of r.stale) L.push(`    .${s}`)
  }
  if (r.versionDrift) {
    L.push(`! 插件包版本漂移：登记 ${r.versionDrift.declared} → 实际 ${r.versionDrift.actual}`)
    L.push('    改名多发生在插件发版时 —— 请复核本表后更新 pluginVersion')
  }
  if (r.gapRevived.length) {
    L.push(`! knownGaps 里的类名复活 ${r.gapRevived.length} 项（插件侧又开始产出了）：`)
    for (const g of r.gapRevived) L.push(`    .${g.cls}  现在存在于 ${g.producers} ⇒ 应移入 classes`)
  }
  const bad = r.broken.length + r.undeclared.length + r.stale.length
  L.push('')
  L.push(bad === 0
    ? '✓ 通过：app 层依赖的每个 .dim-jh-* 都已登记且插件侧仍产出'
    : `✗ 未通过：${bad} 项需处理`)
  return L.join('\n')
}

/** 命令行入口。 */
function main() {
  const argv = process.argv.slice(2)
  const rootArg = argv.indexOf('--root')
  const root = rootArg >= 0 ? argv[rootArg + 1] : (process.env.DSH_CAPSULE_ROOT ?? null)
  if (rootArg >= 0 && (!root || !existsSync(root))) {
    console.error(`--root 指向的路径不存在：${root ?? '(缺参数)'}`)
    process.exit(2)
  }
  let layout
  try {
    layout = resolveLayout(root)
  } catch (error) {
    // 仓库里没有本层资产（例如 CI 只 checkout 了 vendor 子集）—— 与
    // ui-compat-floor.mjs 同款：跳过而不是报红，否则会在无关环境里假失败。
    console.log(`跨层类名契约门禁 · 跳过（${error.message}）`)
    process.exit(0)
  }
  const r = checkPluginContract(layout)
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else console.log(formatReport(r))
  const bad = r.broken.length + r.undeclared.length + r.stale.length
  process.exit(argv.includes('--report') ? 0 : (bad === 0 ? 0 : 1))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
