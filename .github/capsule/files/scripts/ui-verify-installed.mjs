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
      let maps = ''
      try { maps = readFileSync('/proc/' + pid + '/maps', 'utf8') } catch { continue }
      const m = maps.match(/\/data\/app\/[^\s]*\/base\.apk/)
      if (m && existsSync(m[0])) return m[0]
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

// 判定：字节数 + 内容 sha 双判据（只比大小会被"长度凑巧相同"骗过）
if (jsEnt && jsEnt.usize === localJs.length && Buffer.compare(jsEnt.buf, localJs) === 0) {
  result.version = 'capsule'   // 设备上的就是本层成果
} else if (jsEnt && jsEnt.usize === 25521) {
  result.version = 'baseline'  // 已知的旧基线
} else if (jsEnt) {
  result.version = 'other'     // 都不匹配
}

const VERDICT = {
  capsule: ['✅ 设备已装新版（含本层成果）', '可直接做**真实 App 验收**（无需 CDP 注入）'],
  baseline: ['⚠️ 设备仍是旧基线版（无本层成果）', '只能做**注入式验收**（把产物投到运行中的引擎上）'],
  other: ['❓ 设备版本与本层已知的两档都不匹配', '不猜：请确认 APK 来源，或把该版本的 dsh-phone.js 加入基准'],
  unknown: ['❓ 读不到 APK 内的 dsh-phone.js', '检查 APK 路径与读取权限'],
}[result.version]

console.log('设备端 UI 资源版本判定')
console.log('  APK      ' + apk)
console.log('  设备内   dsh-phone.js ' + (jsEnt?.usize ?? '?') + 'B · dsh-phone.css ' + (cssEnt?.usize ?? '?') + 'B')
console.log('  本层产物 dsh-phone.js ' + localJs.length + 'B · dsh-phone.css ' + localCss.length + 'B')
console.log('')
console.log('  ' + VERDICT[0])
console.log('  ⇒ ' + VERDICT[1])

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