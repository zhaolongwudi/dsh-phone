// 部署态校验：从**正在运行的引擎**取实际下发的前端产物，核对我们依赖的上游哈希
// 是否在真实服务面上存在。
//
// 为什么需要它（与 scripts/check-ui-anchors.mjs 的分工）：
//   - 静态树扫描（check-ui-anchors.mjs --tree）看的是 node_modules 里的源码树，
//     证明「上游源码里有这个类名」；
//   - 本脚本看的是引擎 HTTP 实际吐给 WebView 的 bundle，证明「用户设备上真的
//     会收到这个类名」——中间可能隔着打包/裁剪/版本覆盖（本仓库正是 overlays
//     覆盖上游产物的形态），两者不一致时以本脚本为准。
//
// 用法：node scripts/ui-anchor-live-probe.mjs [--url <引擎地址>] [--json]
// 未给 --url 时自动从 dsh 控制台日志里取带 token 的地址（不打印 token）。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { referencedHashes } from './ui-anchor-scan.mjs'
import { resolveAssets } from './ui-tests/paths.mjs'

/**
 * 找引擎地址（含 token）。只回传地址，**绝不打印 token**。
 * 来源按可靠性排序：
 *   1) /proc 命令行——dsh web 启动时 token 就在 argv 里，最权威（实测日志里的
 *      已被脱敏机制改写成 token=[redacted]，故日志不可靠）。
 *   2) DSH_WEB_URL 环境变量。
 *   3) 控制台日志（仅当未被脱敏时可用）。
 */
function urlFromSources() {
  if (process.env.DSH_WEB_URL) return process.env.DSH_WEB_URL
  const re = /https?:\/\/127\.0\.0\.1:3080\/?\?token=[A-Za-z0-9_.-]+/
  try {
    for (const pid of readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
      try {
        const cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ')
        const m = cmd.match(re)
        if (m) return m[0]
      } catch { /* 进程可能在读取间隙退出 */ }
    }
  } catch { /* /proc 不可读则跳过 */ }
  for (const p of ['/data/data/com.dshphone/files/dsh-console.log', '/data/user/0/com.dshphone/files/dsh-console.log']) {
    if (!existsSync(p)) continue
    const m = readFileSync(p, 'utf8').match(re)
    if (m) return m[0]
  }
  return null
}

/**
 * 抓取引擎下发的全部脚本内容。
 * @param base 带 token 的引擎地址
 * @returns {{html: string, scripts: Map<string,string>}}
 */
async function fetchServed(base) {
  const home = await fetch(base)
  if (!home.ok) throw new Error(`首页 HTTP ${home.status}`)
  const html = await home.text()
  const origin = new URL(base).origin
  // token 要透传给后续同源请求，否则会被判未认证
  const token = new URL(base).searchParams.get('token')
  const q = token ? `?token=${encodeURIComponent(token)}` : ''
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m => m[1])
  const scripts = new Map()
  for (const ref of [...new Set(refs)]) {
    try {
      const abs = ref.startsWith('http') ? ref : new URL(ref, origin).href
      const r = await fetch(abs.includes('?') ? abs : abs + q)
      if (r.ok) scripts.set(ref, await r.text())
    } catch { /* 单个脚本取不到不致命，如实计入覆盖率 */ }
  }
  return { html, scripts }
}

const args = process.argv.slice(2)
const urlArg = args.indexOf('--url')
const base = urlArg >= 0 ? args[urlArg + 1] : urlFromSources()
if (!base) {
  console.error('找不到引擎地址：请传 --url <带 token 的地址>，或确认引擎在运行。')
  process.exit(2)
}

const { css } = resolveAssets()
const wanted = [...referencedHashes(readFileSync(css, 'utf8'))].sort()

let served
try { served = await fetchServed(base) } catch (e) {
  console.error('抓取引擎失败：' + e.message)
  process.exit(2)
}

const all = served.html + '\n' + [...served.scripts.values()].join('\n')
const hit = wanted.filter(h => all.includes(h))
const miss = wanted.filter(h => !all.includes(h))

const result = {
  url: base.replace(/token=[^&]*/, 'token=***'),
  fetchedScripts: served.scripts.size,
  bytes: all.length,
  anchors: wanted.length, hit: hit.length, miss,
}

if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`部署态校验 · ${result.url}`)
  console.log(`  取到脚本 ${result.fetchedScripts} 个 / ${result.bytes} 字节`)
  console.log(`  依赖锚点 ${result.anchors} 个：命中 ${result.hit}，未命中 ${result.miss.length}`)
  if (miss.length) {
    console.log('  ✗ 未在服务面出现（可能被覆盖层改写或裁剪）：')
    for (const m of miss) console.log('    ' + m)
  } else console.log('  ✓ 全部锚点在引擎实际下发的产物中存在')
  console.log('  注：仅证明「类名存在于下发内容」，不代表当前视口下样式已命中。')
}
process.exit(miss.length === 0 ? 0 : 1)
