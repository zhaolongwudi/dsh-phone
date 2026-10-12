// 槽位注册审计：扫描本项目各 client bundle 的 slots.register 调用，检查三类
// **静默失效**风险。
//
// ## 为什么要它
//
// 槽位注册是「注册成功即生效、失败则静默」的形态——本项目与参考项目都踩过：
//   - **同 id 冲突**：keyed 槽按 id 精确查表，两个包注册同一 id 时**先到者赢**，
//     后者要么让 slots.inject 抛错、要么被 try/catch 静默吞掉（用户只看到面板消失）。
//     本仓库实测：dsh-phone-qq 与 dsh-peer 都注册 agent-persona-cards 与
//     controlled-plugin-market —— 两者若同时进 profile bundles 就会撞。
//   - **order 冲突**：list 槽按 order 排序，同 order 的呈现顺序不确定（不可复现）。
//   - **槽位名不在引擎里**：注册永不生效（slots.inject 一直等服务）。
//
// ## 用法
//   node scripts/ui-slot-register-audit.mjs                   离线（用登记快照判槽名）
//   node scripts/ui-slot-register-audit.mjs --tree <dsh树根>    在线（用真实引擎槽名单）
//   node scripts/ui-slot-register-audit.mjs --json
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSlots, SNAPSHOT_0_2_1 } from './ui-slot-inventory.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 待审计的 client bundle。
 *
 * `inBundles` 必须是**真实读到的** profile bundles 列表，不是猜的：只有会进
 * bundles 的包才会真正注册，不在 bundles 的包当前完全不生效（本项目实测：
 * dsh-peer 已装进 profile 的 node_modules 却不在 bundles 里，故它的注册无效果）。
 *
 * 生成关系说明：build-agent-cards-client.mjs 把同一份 client-source.js 产出给
 * dsh-peer 与 dsh-phone-qq 两个包，所以这两者**必然同 id** —— 那是生成关系，
 * 不是冲突。真正要拦的是「两个都会进 bundles 的包撞同 id」。
 */
export function loadTargets(root) {
  const bundles = readBundles(root)
  return [
    { pkg: 'dsh-phone-qq', file: 'phone-qq/cards-client.js', inBundles: bundles.has('dsh-phone-qq') },
    { pkg: 'dsh-peer', file: 'peer/agent-cards/client.js', inBundles: bundles.has('dsh-peer') },
    { pkg: 'dsh-phone-qq(src)', file: 'peer/agent-cards/client-source.js', inBundles: false, isSource: true },
  ]
}

/**
 * 读 profile bundles（出厂模板；读不到则回落到本机已装 profile）。
 * @param root 仓库根
 * @returns {Set<string>}
 */
export function readBundles(root) {
  const candidates = [
    join(root, 'home-template/profiles/phone/package.json'),
    '/data/data/com.dshphone/files/dsh-home/profiles/phone/package.json',
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const b = j?.dsh?.profile?.bundles
      if (Array.isArray(b)) return new Set(b)
    } catch { /* 损坏则继续找下一个 */ }
  }
  return new Set()
}

/** 向上探测仓库根（兼容胶囊工作区与 apply 后仓库两种布局）。 */
function findRoot() {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const p of ['', 'files/', 'overrides/']) {
      if (existsSync(join(d, p + 'phone-qq/cards-client.js')) || existsSync(join(d, p + 'peer/agent-cards/client.js'))) {
        return join(d, p)
      }
    }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

/**
 * 从一份 bundle 文本里提取 slots.register 的 {id, name, order}。
 * 循环里的 id 是变量（如 for (const [id,label,...] of [...])），故同时抓数组字面量里的 id。
 * @param text bundle 全文
 * @returns {Array<{id:string,name:string,order:number|null}>}
 */
export function extractRegisters(text) {
  const out = []
  // 形态一：register({ name: 'x', id: 'y', order: N }, ...)
  for (const m of text.matchAll(/register\(\{([^}]*)\}/g)) {
    const body = m[1]
    const name = (body.match(/name:\s*['"]([^'"]+)/) || [])[1] ?? null
    const id = (body.match(/id:\s*['"]([^'"]+)/) || [])[1] ?? null
    const order = Number((body.match(/order:\s*(\d+)/) || [])[1] ?? NaN)
    out.push({ id, name, order: Number.isNaN(order) ? null : order })
  }
  // 形态二：循环注册——register({ name: 'x', id, order, label }, ...) 配 for (const [id,...] of [['a',...]])
  const loopIds = [...text.matchAll(/\[\s*['"]([a-z][a-z0-9-]*)['"]\s*,/g)].map(m => m[1])
  for (const m of text.matchAll(/register\(\{\s*name:\s*['"]([^'"]+)['"]\s*,\s*id,/g)) {
    for (const id of loopIds) out.push({ id, name: m[1], order: null, fromLoop: true })
  }
  return out
}

/**
 * 审计：跨包同 id、同槽同 order、槽名是否有效。
 * @param root 仓库根（含 phone-qq/ 与 peer/）
 * @param tree dsh 引擎树根或 null
 * @returns 结构化结果
 */
export function auditRegisters(root, tree) {
  const slots = tree && existsSync(tree) ? scanSlots(tree) : null
  const known = new Set(slots ? [...slots.keys()] : Object.keys(SNAPSHOT_0_2_1))
  const byId = new Map()   // id → 注册它的包
  const bySlotOrder = new Map() // name+order → 注册者
  const unknownSlot = []
  const scanned = []

  for (const tgt of loadTargets(root)) {
    const p = join(root, tgt.file)
    if (!existsSync(p)) continue
    const regs = extractRegisters(readFileSync(p, 'utf8'))
    scanned.push({ ...tgt, count: regs.length })
    for (const r of regs) {
      if (r.id) {
        if (!byId.has(r.id)) byId.set(r.id, [])
        byId.get(r.id).push({ pkg: tgt.pkg, file: tgt.file, inBundles: tgt.inBundles })
      }
      if (r.name && !known.has(r.name)) unknownSlot.push({ pkg: tgt.pkg, slot: r.name, id: r.id })
      if (r.name && r.order !== null) {
        const k = r.name + '@' + r.order
        if (!bySlotOrder.has(k)) bySlotOrder.set(k, [])
        bySlotOrder.get(k).push({ pkg: tgt.pkg, inBundles: tgt.inBundles, isSource: tgt.isSource === true })
      }
    }
  }

  // 冲突分级：
  //   live = 两个**都在 bundles**的包撞同 id ⇒ 现在就会出问题，必须修
  //   latent = 只有一个是生成关系的产物（或都不在 bundles）⇒ 现状安全，登记备查
  const dupIds = [...byId.entries()]
    .filter(([, v]) => new Set(v.map(x => x.pkg)).size > 1)
    .map(([id, v]) => {
      const pkgs = [...new Set(v.map(x => x.pkg))]
      const livePkgs = [...new Set(v.filter(x => x.inBundles).map(x => x.pkg))]
      return {
        id, by: pkgs,
        live: livePkgs.length > 1,
        // 源文件与产物同 id 属生成关系，单列出来避免误报
        generated: pkgs.includes('dsh-phone-qq(src)'),
      }
    })

  const dupOrders = [...bySlotOrder.entries()]
    .map(([k, v]) => {
      const livePkgs = [...new Set(v.filter(x => x.inBundles).map(x => x.pkg))]
      const allPkgs = [...new Set(v.map(x => x.pkg))]
      return { key: k, by: allPkgs, live: livePkgs.length > 1 }
    })
    .filter(d => d.by.length > 1)

  return { mode: slots ? 'engine' : 'snapshot', root, scanned, dupIds, dupOrders, unknownSlot }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ti = args.indexOf('--tree')
  const tree = ti >= 0 ? args[ti + 1] : null
  if (ti >= 0 && (!tree || !existsSync(tree))) { console.error('--tree 路径不存在：' + (tree ?? '(缺参数)')); process.exit(2) }
  const root = findRoot()
  // 找不到待审计文件时**不判红**：本层的胶囊工作区只放自有文件，而被审计的
  // phone-qq/peer 属上游文件、不在其中；真实仓库（apply 后）里才有。这属
  // 「无输入可审」而非「审计失败」，故显式跳过并说明，不静默通过也不误报。
  if (!root) {
    console.log('槽位注册审计 · 跳过（本布局下无 phone-qq/peer 待审文件）')
    console.log('  说明：被审文件属上游，只在 apply 后的仓库根存在；胶囊工作区不含。')
    process.exit(0)
  }
  const r = auditRegisters(root, tree)

  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)) }
  else {
    console.log('槽位注册审计 · ' + (r.mode === 'engine' ? '引擎树 ' + tree : '登记快照'))
    console.log('  根目录：' + relative(process.cwd(), r.root) || r.root)
    for (const s of r.scanned) {
      const flag = s.inBundles ? '（在 profile bundles）' : '（不在 bundles ⇒ 当前不生效）'
      console.log(`  扫描 ${s.file}：${s.count} 处注册 ${flag}`)
    }
    const live = r.dupIds.filter(d => d.live)
    const latent = r.dupIds.filter(d => !d.live)
    if (live.length) {
      console.log('\n  ✗ 真实冲突（两个都在 bundles 的包撞同 id ⇒ keyed 槽先到者赢、后者静默消失）：')
      for (const d of live) console.log(`    ${d.id}  ← ${d.by.join(' + ')}`)
    } else console.log('\n  ✓ 无真实冲突（在装包之间无同 id）')
    if (latent.length) {
      console.log(`  ! 潜在冲突 ${latent.length} 项（${latent[0].generated ? '源文件与产物同 id，属生成关系' : '相关包当前不在 bundles'}；一旦同时进 bundles 即变成真实冲突）：`)
      console.log('    ' + latent.map(d => d.id).join(', '))
    }
    const liveOrd = r.dupOrders.filter(d => d.live)
    const latentOrd = r.dupOrders.filter(d => !d.live)
    if (liveOrd.length) {
      console.log('  ✗ 真实 order 冲突（在装包之间同槽同 order ⇒ 顺序不可复现）：')
      for (const d of liveOrd) console.log(`    ${d.key}  ← ${d.by.join(' + ')}`)
    } else console.log('  ✓ 无真实 order 冲突')
    if (latentOrd.length) {
      console.log(`  ! 潜在 order 冲突 ${latentOrd.length} 项（同生成关系/未装包）：`)
      console.log('    ' + latentOrd.map(d => d.key).join(', '))
    }
    if (r.unknownSlot.length) {
      console.log('  ✗ 槽名不在当前引擎（注册永不生效）：')
      for (const u of r.unknownSlot) console.log(`    ${u.slot}  ← ${u.pkg} (id=${u.id})`)
    } else console.log('  ✓ 槽名全部有效')
    const bad = r.dupIds.filter(d => d.live).length + r.dupOrders.filter(d => d.live).length + r.unknownSlot.length
    console.log(bad ? `\n✗ ${bad} 项需处理` : '\n✓ 通过')
  }
  const bad = r.dupIds.filter(d => d.live).length + r.dupOrders.filter(d => d.live).length + r.unknownSlot.length
  process.exit(args.includes('--report') ? 0 : (bad === 0 ? 0 : 1))
}
