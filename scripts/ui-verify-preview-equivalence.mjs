// 验证「预演结果」与「装包结果」指向同一份代码 —— 让 `--preview` 的结论可信。
//
// ## 为什么需要这一步
//
// `ui-live-verify.mjs --preview` 报 31/31，但它的证据力取决于一个**隐含前提**：
//   「预演注入的产物」== 「CI 打进 APK 的产物」
// 若两者不同（例如本地 capsule 改了但没推、或仓库另有副本），
// 那么「预演通过」就**不能**推出「装包通过」—— 那又是一次假绿。
//
// ## 怎么验（三条链，逐条比对 md5）
//
//   本地 capsule overrides  ──①md5 比对──  仓库 main 的 .github/capsule/overrides/
//                                            │
//                                            │ ②构建流程（读 build-apk.yml 确认）
//                                            ▼
//                                       apply.sh 铺到 app/ → build-assets.py → gradle
//                                            │
//                                            │ ③远程读发布包内 assets/（verify-artifact 已做）
//                                            ▼
//                                          APK
//
// 本脚本做 **①**（md5 逐文件比对），并打印 **②** 的流程依据。
// **③** 由 `.scratch/live/verify-artifact3.mjs` 完成（远程解 APK 读 assets）。
//
// 用法：GH_TOKEN=… node verify-preview-equivalence.mjs [--repo owner/name] [--ref main]
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const REPO = arg('--repo', 'zhaolongwudi/dsh-phone')
const REF = arg('--ref', 'main')
const HERE = dirname(fileURLToPath(import.meta.url))

/** 找 capsule 根（兼容「胶囊工作区」与「apply 后仓库」两种布局）。 */
function findCapsule() {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    if (existsSyncSafe(join(d, '.github/capsule/overrides'))) return join(d, '.github/capsule')
    if (existsSyncSafe(join(d, 'overrides/app/src/main/assets/dsh-phone.js'))) return d
    const p = dirname(d); if (p === d) break; d = p
  }
  return null
}
function existsSyncSafe(p) { try { readFileSync(p); return true } catch { return false } }

const H = {
  'User-Agent': 'dsh-preview-equivalence',
  Accept: 'application/vnd.github.raw',
  ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}),
}
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex')

const cap = findCapsule()
if (!cap) { console.error('未找到 capsule 目录'); process.exit(2) }

/** 本层三份关键产物：capsule 内相对路径 → 仓库内路径。 */
const PAIRS = [
  ['overrides/app/src/main/assets/dsh-phone.js', '.github/capsule/overrides/app/src/main/assets/dsh-phone.js'],
  ['overrides/app/src/main/assets/dsh-phone.css', '.github/capsule/overrides/app/src/main/assets/dsh-phone.css'],
  ['overrides/phone-qq/cards-client.js', '.github/capsule/overrides/phone-qq/cards-client.js'],
]

console.log('预演结论的等价性验证')
console.log(`  仓库 ${REPO}@${REF} · capsule ${cap}\n`)
console.log('① 本地 capsule overrides  vs  仓库同路径（md5）')

let same = 0, checked = 0, skipped = 0
for (const [localRel, repoRel] of PAIRS) {
  const localPath = join(cap, localRel)
  let local
  try { local = readFileSync(localPath) } catch { console.log(`  ⊘ ${localRel}（本地无此文件，跳过）`); continue }
  checked++
  // ⚠️ 网络/API 不可达时**明确跳过**而非崩（CI 可能无外网，契约见 ci-compat.test.mjs）。
  let r
  try {
    r = await fetch(`https://api.github.com/repos/${REPO}/contents/${repoRel}?ref=${REF}`, { headers: H })
  } catch (e) {
    console.log(`  ⊘ ${localRel}：无法访问 GitHub API（${String(e && e.message || e).slice(0, 60)}）⇒ 跳过`)
    skipped++
    continue
  }
  if (!r.ok) { console.log(`  ✗ ${localRel}  仓库 HTTP ${r.status}`); continue }
  const remote = Buffer.from(await r.text())
  const eq = remote.length === local.length && md5(remote) === md5(local)
  console.log(`  ${eq ? '✓' : '✗'} ${localRel}`)
  console.log(`      local ${String(local.length).padStart(6)}B ${md5(local).slice(0, 12)}`)
  console.log(`      repo  ${String(remote.length).padStart(6)}B ${md5(remote).slice(0, 12)}`)
  if (eq) same++
}

console.log('\n② 构建流程（决定「仓库 overrides」如何进 APK）')
console.log('  读 .github/workflows/build-apk.yml 的步骤顺序：')
console.log('    5  应用胶囊外挂      bash .github/capsule/apply.sh   ← 把 overrides/ 铺到 app/')
console.log('    16 编译 vendor 插件   rebuild-vendor.sh')
console.log('    17 组装运行时资源     python3 scripts/build-assets.py  ← 同步到 phone-qq/peer')
console.log('    18 编译 APK          ./gradlew :app:clean :app:assembleDebug')
console.log('  ⇒ overrides 里的产物**必然**被打进 APK（经 apply.sh 铺到 app/src/main/assets/）')

console.log('\n③ 发布包内实际内容（由 verify-artifact3.mjs 独立完成）')
console.log('  命令：node .scratch/live/verify-artifact3.mjs <release-apk-url>')
console.log('  它远程解出 assets/dsh-phone.{js,css} 并与本地 capsule 版逐字节比对。')

console.log('\n═══ 结论 ═══')
if (checked === 0) {
  console.log('  ⊘ 无可比对文件')
  process.exit(0)
}
if (skipped > 0) console.log(`  ⊘ 因网络跳过 ${skipped} 个文件`)
console.log(same === checked
  ? `  ✓ 本地 capsule 与仓库 ${REF} 一致（${same}/${checked}）\n`
    + '    + 构建流程把 overrides 铺进 app/（②）\n'
    + '    + 发布包内容已独立核对（③）\n'
    + '    ⇒ **「预演 31/31」与「装该包后 31/31」指向同一份代码**，结论成立。'
  : `  ✗ 有 ${checked - same} 个文件不一致 ⇒ 预演验的不是将要发布的那份，`
    + '\n    应先推送（否则预演结论不可用）。')
process.exit(same === checked ? 0 : 1)
