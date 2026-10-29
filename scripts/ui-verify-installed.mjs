// 「装新包后」一键验收：自动识别设备上跑的 UI 资源版本，再决定验什么、怎么验。
//
// ## 为什么需要它
//
// 本层此前的验收都靠**手工拼装环境**（用 CDP 把产物注入运行中的引擎）。那是因为
// 设备上装的是旧包。一旦装上含本层成果的新包，验收应当变成「跑一条命令」——
// 并且**先证明装的是新版**，否则后面验的是旧代码（这类假绿本方案遇到过多次）。
//
// ## 它做什么
//
// ① **版本判定**：从设备 APK 直接读 assets/dsh-phone.js 的字节数，与本地 capsule
//    版比对，判定设备处于哪一档：
//      · 「旧版」= 25521B（基线，无本层成果）→ 只能做注入式验收
//      · 「新版」= 与本地 capsule 版一致 → 可做**真实 App 验收**（无需注入）
//      · 「未知」= 都不匹配 → 报出来，不猜
// ② 按判定选择验收路径，并把**判定依据**一并打印（可复现）。
//
// 用法：
//   node ui-verify-installed.mjs                 # 只判定版本（只读）
//   node ui-verify-installed.mjs --run           # 判定 + 跑对应验收
//   node ui-verify-installed.mjs --json
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = args.includes('--run')
const AS_JSON = args.includes('--json')

/** 本地 capsule 的 UI 产物（新版的判定基准）。 */
const CAPSULE_RELS = ['overrides/app/src/main/assets/dsh-phone.js', 'overrides/app/src/main/assets/dsh-phone.css']
function findCapsule() {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const p of ['', 'files/', 'overrides/']) {
      const probe = join(d, p + CAPSULE_RELS[0])
      if (existsSync(probe)) return join(d, p.replace(/overrides\/$/, '')) // 回到 capsule 根
    }
    // 直接找 capsule 根
    if (existsSync(join(d, '.github/capsule', CAPSULE_RELS[0]))) return join(d, '.github/capsule')
    const parent = dirname(d); if (parent === d) break; d = parent
  }
  return null
}

/** 从 APK（zip）中读出某个 assets 条目的字节数。 */
function apkAssetSize(apk, want) {
  const fd = openSync(apk, 'r')
  try {
    const size = statSync(apk).size
    const tailLen = Math.min(66000, size)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) return null
    const cdCount = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16)
    const cd = Buffer.alloc(cdSize)
    readSync(fd, cd, 0, cdSize, cdOff)
    let p = 0
    for (let i = 0; i < cdCount; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24)
      const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32)
      const lho = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8')
      if (name === want) {
        // 需要真内容才能算 sha/字节；这里返回压缩信息供上层决定是否解压
        const lh = Buffer.alloc(30); readSync(fd, lh, 0, 30, lho)
        const lnlen = lh.readUInt16LE(26), lelen = lh.readUInt16LE(28)
        const data = Buffer.alloc(csize)
        readSync(fd, data, 0, csize, lho + 30 + lnlen + lelen)
        return { usize, method, buf: method === 0 ? data : zlib.inflateRawSync(data) }
      }
      p += 46 + nlen + elen + clen
    }
    return null
  } finally { closeSync(fd) }
}

/** 找设备上已安装的 com.dshphone APK 路径（只读）。 */
function findInstalledApk() {
  const direct = arg('--apk')
  // 显式指定的路径：存在就用；不存在则**明确报出并跳过**，而不是在 openSync 里崩
  // （实测踩到：--apk 指向不存在路径时抛 ENOENT，看起来像脚本坏了）。
  if (direct) {
    if (existsSync(direct)) return direct
    console.log('设备端版本判定：跳过（--apk 指定的路径不存在：' + direct + '）')
    return null
  }
  // ⚠️ 实测：本进程**不能列举** /data/app（Permission denied），但**能直接读**
  //    已知路径下的 base.apk。故以「候选路径 + 存在性检查」为主，枚举只作兜底。
  const candidates = []
  if (process.env.DSH_APK) candidates.push(process.env.DSH_APK)
  if (process.env.DSH_APK_DIR) candidates.push(join(process.env.DSH_APK_DIR, 'base.apk'))
  // 历史路径（换包后随机后缀可能变，故仅作首选尝试）
  candidates.push('/data/app/~~MxGx2UJdBFSVh2eId0mSgg==/com.dshphone-HdqCbPn0fp8QKyUWH-IK3Q==/base.apk')
  for (const p of candidates) if (p && existsSync(p)) return p
  // ③ **实测可行的自动发现**：从运行中进程的 /proc/<pid>/maps 里读 base.apk 路径。
  //    为什么走这条路：本机 /data/app 不可列举（Permission denied），且 APK 目录名含
  //    随机后缀（换包即变）—— 硬编码路径一次安装就失效（本轮实测踩到：
  //    旧路径 `~~MxGx2UJdBFSVh2eId0mSgg==` 在装新版后消失）。
  //    /proc 可读，App 进程的 maps 里必然有它自己的 base.apk。
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      // ⚠️ 必须**先确认该进程就是 com.dshphone**，再读它的 maps。
      //    实测踩到：不校验时命中的是**别的 App**（本轮读到 my.maya.android「多闪」的
      //    base.apk）—— 因为同一 UID 下多个 App 的 /proc 都可读，而遍历顺序不定。
      //    后果很隐蔽：脚本会「读到一个 APK」并据此判定版本，判的是**别的 App**。
      let cmdline = ''
      try { cmdline = readFileSync('/proc/' + pid + '/cmdline', 'utf8') } catch { continue }
      if (!cmdline.includes('com.dshphone')) continue
      let maps = ''
      try { maps = readFileSync('/proc/' + pid + '/maps', 'utf8') } catch { continue }
      // 在该进程的 maps 里找 **com.dshphone 自己的** base.apk（进程可能同时映射别的包）
      const all = maps.match(/\/data\/app\/[^\s]*\/base\.apk/g) ?? []
      const own = all.find(p => p.includes('com.dshphone'))
      if (own && existsSync(own)) return own
    }
  } catch { /* /proc 不可读 */ }

  // 兜底：尝试枚举（本机不可用，但别的环境可能可以）
  try {
    for (const outer of readdirSync('/data/app')) {
      const dir = join('/data/app', outer)
      let inner = []
      try { inner = readdirSync(dir) } catch { continue }
      for (const i of inner) {
        if (!i.startsWith('com.dshphone-')) continue
        const p = join(dir, i, 'base.apk')
        if (existsSync(p)) return p
      }
    }
  } catch { /* /data/app 不可列举 */ }
  return null
}

const capsule = findCapsule()
if (!capsule) { console.error('未找到 capsule 目录（含 overrides/app/src/main/assets/dsh-phone.js）'); process.exit(2) }
const localJs = readFileSync(join(capsule, CAPSULE_RELS[0]))
const localCss = readFileSync(join(capsule, CAPSULE_RELS[1]))

const apk = findInstalledApk()
// ⚠️ 找不到 APK 时**明确跳过（exit 0）**，不 exit 2。
//    契约：本层所有设备相关脚本在 CI（无设备）下必须「跳过而非崩」——
//    见 scripts/ui-tests/ci-compat.test.mjs。exit 2 是「硬失败」语义，会让 CI 误以为
//    门禁拦住了一次真问题（此前 ui-module-seed 就栽在这个区别上）。
if (!apk) {
  // 仅在**未显式指定**时解释原因（显式指定但不存在的情况上面已报过，避免打两遍）。
  if (!arg('--apk')) {
    console.log('设备端版本判定：跳过（未找到已安装的 com.dshphone APK —— 非设备环境，CI 属预期）')
    console.log('  说明：本步只在真机维护期可用；可用 --apk <路径> 或 DSH_APK 环境变量显式指定。')
  }
  process.exit(0)
}

const jsEnt = apkAssetSize(apk, 'assets/dsh-phone.js')
const cssEnt = apkAssetSize(apk, 'assets/dsh-phone.css')

const result = {
  apk,
  installed: { js: jsEnt?.usize ?? null, css: cssEnt?.usize ?? null },
  capsule: { js: localJs.length, css: localCss.length },
  version: 'unknown',
}

// 判定：**JS 与 CSS 各自**比字节 + 内容 sha。
//   ⚠️ 此前只看 JS —— 于是「JS 一致但 CSS 落后」会被报成「已装新版（含本层成果）」，
//      而实际设备跑的是**较旧**的一版（实测踩到：设备 JS 32988 与产物一致，
//      但 CSS 19156 ≠ 产物 19190 ⇒ 属「有本层成果但不是最新」）。
//      这种状态最危险：验收会通过，但验的不是将要发布的那份。
// ── 语义指纹：不依赖字节，回答「设备是第几代本层版本」──────────────────────
//  为什么加：本层产物一改（哪怕只改注释），字节比对就会落到「都不匹配」，
//  而设备上那份可能**含本层成果、只是旧了一代**。语义指纹能把这种情况说清楚。
const jsText = jsEnt?.buf ? jsEnt.buf.toString('utf8') : ''
const cssText = cssEnt?.buf ? cssEnt.buf.toString('utf8') : ''
// ⚠️ 每条指纹必须查**它真正的载体**，不能混起来查 —— 实测踩到过：
//    「开关文本」原查 jsText+cssText，而 CSS 里也有 `☰ 菜单`（写规格时的注释），
//    于是设备 CSS 一含该串就误判「有修复」，而设备真实 slotText 是空。
// 载体归属：js=形态层 / css=样式 / bundle=槽位组件（在 dsh-tree.tar 内，本步读不到）
const FEATURES = [
  ['一期·形态标记层', /data-dsh-mobile-form/, 'js'],
  ['一期·断点常量', /MOBILE_FORM_MAX_WIDTH\s*=\s*767/, 'js'],
  ['三期·遮罩接管', /data-dsh-mask-mounted/, 'js'],
  // ⚠️ 该事实由**槽位组件**（cards-client.js 的 DrawerToggle）发布，不在 dsh-phone.js 里。
  //    实测：设备 APK 内 dsh-phone.js 搜该串 = 0 次，但 WebView 实测 toggleMounted = true。
  //    标 false 会**低估**设备能力 ⇒ 改为 bundle（本步不判）。
  ['三期·开关接管', /data-dsh-toggle-mounted/, 'bundle'],
  ['三期·开关类名', /dsh-phone-menu-slot/, 'css'],
  ['修复·最小宽度', /min-width:\s*44px/, 'css'],
  // 开关文本住在**槽位组件**（cards-client.js → dsh-tree.tar），不在 APK assets 里。
  // 故本步**不判**该指纹，显式标 null 而不是拿 CSS 注释冒充。
  ['修复·开关文本', /☰ 菜单/, 'bundle'],
]
result.features = {}
result.featuresNote = {}
for (const [name, re, where] of FEATURES) {
  if (where === 'bundle') {
    result.features[name] = null
    result.featuresNote[name] = '住在槽位组件（dsh-tree.tar 内），APK assets 读不到 ⇒ 本步不判'
    continue
  }
  const hay = where === 'css' ? cssText : jsText
  result.features[name] = re.test(hay)
}
// 只统计**可判**的指纹（null 表示本步读不到，不参与代次判定）
const judged = Object.values(result.features).filter(v => v !== null)
const hasAny = judged.some(Boolean)
const hasAll = judged.every(Boolean)
result.generation = hasAll ? 'current' : (hasAny ? 'older-capsule' : 'pre-capsule')

const jsSame = !!(jsEnt && jsEnt.usize === localJs.length && Buffer.compare(jsEnt.buf, localJs) === 0)
const cssSame = !!(cssEnt && cssEnt.usize === localCss.length && Buffer.compare(cssEnt.buf, localCss) === 0)
result.match = { js: jsSame, css: cssSame }

if (jsSame && cssSame) {
  result.version = 'capsule'      // 与产物**完全**一致
} else if (jsSame || cssSame) {
  result.version = 'stale'        // 部分一致 ⇒ 有成果但不是最新（须明确报出）
} else if (jsEnt && jsEnt.usize === 25521) {
  result.version = 'baseline'     // 已知旧基线
} else if (result.generation === 'older-capsule') {
  // 含本层能力标记但字节不同 ⇒ 是**较旧的一代本层版本**（不是"不认识"）
  result.version = 'older-capsule'
} else if (jsEnt) {
  result.version = 'other'        // 真的都不匹配
}

const VERDICT = {
  capsule: ['✅ 设备已装**与产物完全一致**的版本', '可直接做**真实 App 验收**（无需 CDP 注入）'],
  stale: ['⚠️ 设备版本**落后于当前产物**（部分文件一致）',
    '仍可做真实 App 验收，但**验的不是将要发布的那份** ⇒ 建议先重装最新包再验收'],
  baseline: ['⚠️ 设备仍是旧基线版（无本层成果）', '只能做**注入式验收**（把产物投到运行中的引擎上）'],
  'older-capsule': ['⚠️ 设备是**较旧的一代本层版本**（含本层能力，但字节与当前产物不同）',
    '仍可做真实 App 验收，但验的是旧一代 ⇒ 建议重装最新包；可用 --preview 验新包'],
  other: ['❓ 设备版本与本层已知的各档都不匹配（连本层能力标记都没有）', '不猜：请确认 APK 来源，或把该版本的 dsh-phone.js 加入基准'],
  unknown: ['❓ 读不到 APK 内的 dsh-phone.js', '检查 APK 路径与读取权限'],
}[result.version]

console.log('设备端 UI 资源版本判定')
console.log('  APK      ' + apk)
// 逐文件列出「设备内 / 产物 / 是否一致」——只报一个总判定会掩盖「部分落后」。
const row = (label, ent, local) => {
  const size = ent?.usize ?? '?'
  const same = ent && ent.usize === local.length && Buffer.compare(ent.buf, local) === 0
  return `  ${label.padEnd(16)} 设备 ${String(size).padStart(6)}B · 产物 ${String(local.length).padStart(6)}B · ${same ? '一致' : '**不一致**'}`
}
console.log(row('dsh-phone.js', jsEnt, localJs))
console.log(row('dsh-phone.css', cssEnt, localCss))
console.log('')
console.log('  本层能力指纹（设备内实际含有的）：')
for (const [name, ok] of Object.entries(result.features)) {
  const mark = ok === null ? '⊘' : (ok ? '✓' : '—')
  const note = ok === null && result.featuresNote?.[name] ? '（' + result.featuresNote[name] + '）' : ''
  console.log('    ' + mark + ' ' + name + note)
}
console.log('  ⇒ 代次判定：' + result.generation)
console.log('')
console.log('  ' + VERDICT[0])
console.log('  ⇒ ' + VERDICT[1])

// ── 交叉校验：APK 判定 vs WebView 实测（含污染检测）──────────────────────
//  为什么需要：APK 读的是**文件**（权威），WebView 读的是**运行时**（可能被注入污染）。
//  两者若不一致，必须说清哪一侧可信。
//  实测案例：APK 说「旧一代」，WebView 说「有 ☰ 菜单」—— 后者是注入污染，
//  硬重载后与 APK 一致。
//
//  ⚠️ 实现方式：**复用 ui-live-verify.mjs**（它自带完整 CDP 客户端与硬重载逻辑），
//     以子进程调用并解析其指纹输出。不在此处重复实现 CDP —— 那会引入
//     「两个 CDP 实现行为不一致」的新风险（本方案已多次踩到同类问题）。
if (args.includes('--cross-check')) {
  console.log('\n── 交叉校验：WebView 实测（由 ui-live-verify 执行，含硬重载清污染）──')
  try {
    const { spawnSync } = await import('node:child_process')
    const runner = join(HERE, 'ui-live-verify.mjs')
    if (!existsSync(runner)) {
      console.log('  ⊘ 未找到 ui-live-verify.mjs ⇒ 跳过')
    } else {
      const r = spawnSync(process.execPath, [runner, '--realapp', '--snapshot'], {
        encoding: 'utf8', timeout: 90000,
        env: { ...process.env, DSH_TREE: process.env.DSH_TREE || '' },
      })
      const out = (r.stdout ?? '') + (r.stderr ?? '')
      // 从输出里抓「设备实测指纹」那一行（ui-live-verify 的 --realapp 会打印）
      const m = out.match(/设备实测指纹：(\{[^}]*\})/)
      if (m) {
        const fp = JSON.parse(m[1])
        console.log('  WebView 实测：' + JSON.stringify(fp))
        const wvFixed = fp.hasMinWidth44 === true
        const apkFixed = result.features?.['修复·最小宽度'] === true
        console.log('  APK 判定含「修复·最小宽度」：' + apkFixed)
        console.log('  WebView 实测含 min-width:44px：' + wvFixed)
        console.log('  ' + (wvFixed === apkFixed
          ? '✓ 两侧一致'
          : '⚠️ 两侧不一致 ⇒ **以 APK 判定为准**（读文件，不受注入影响）'))
      } else {
        console.log('  ⊘ 未能从 ui-live-verify 输出解析指纹（可能无 CDP 通道，CI 属预期）')
        if (/跳过/.test(out)) console.log('     其输出含「跳过」⇒ 环境无设备，属预期')
      }
    }
  } catch (e) {
    console.log('  ⊘ 交叉校验跳过：' + String(e && e.message || e).slice(0, 90))
  }
}

if (AS_JSON) console.log('\n' + JSON.stringify(result, null, 2))

if (RUN) {
  console.log('\n── 按判定执行验收 ──')
  const runner = join(HERE, 'ui-live-verify.mjs')
  if (!existsSync(runner)) { console.log('  ✗ 未找到 ' + runner); process.exit(2) }
  // 两个档位都用同一条验收（它按**实际事实**判断，不假设版本）：
  //   · capsule 档：设备上就是新版，验收直接测真实 App
  //   · baseline 档：先由外部注入产物，再验收（见 .scratch 的 verify-*.mjs）
  try {
    const out = execFileSync(process.execPath, [runner, '--run'], { encoding: 'utf8', timeout: 180000 })
    console.log(out)
  } catch (e) {
    console.log((e.stdout ?? '') + (e.stderr ?? ''))
    console.log('  验收未全部通过（exit=' + (e.status ?? '?') + '）')
    process.exit(1)
  }
} else {
  console.log('\n（只做了版本判定。加 --run 执行验收。）')
}

process.exit(result.version === 'unknown' ? 2 : 0)