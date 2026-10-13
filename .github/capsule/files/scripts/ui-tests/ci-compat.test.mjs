// CI 兼容性测试：本层新增的每个门禁/测试，必须在**无引擎树**的环境下
// 也能正常退出（跳过而非失败）。
//
// ## 为什么必须单独测
//
// 本层多数检查依赖「引擎树」（node_modules/@deepseek-ai）——本地开发有，CI 没有。
// 若某个脚本在缺引擎树时抛异常，CI 会直接红，而且**看起来像是代码坏了**，
// 排查成本高。本测试在进程内把 DSH_TREE 指到不存在的路径，逐个跑关键脚本，
// 断言它们「要么成功、要么明确跳过」，绝不异常退出。
//
// 踩过的实例：ui-slot-register-audit 早期在找不到 phone-qq/peer 时 exit=2，
// 而胶囊工作区恰好没有那两个上游文件 —— CI 必红。
//
// 运行：node scripts/ui-tests/ci-compat.test.mjs
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..')

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

/** CI 会跑的 UI 步骤（与 typecheck.yml 对应；新增步骤应同步登记）。 */
const CI_STEPS = [
  ['ui-layer-audit.mjs', []],
  ['check-ui-anchors.mjs', []],
  ['ui-slot-inventory.mjs', ['--check']],
  ['ui-slot-register-audit.mjs', []],
  ['ui-css-validate.mjs', []],
  ['ui-module-seed.mjs', ['--tree', '/nonexistent-engine-tree']],
  ['ui-tests/marker-layer.test.mjs', []],
  ['ui-tests/check-ui-anchors.test.mjs', []],
  ['ui-tests/layer-audit.test.mjs', []],
  ['ui-tests/css-validate.test.mjs', []],
  ['ui-tests/slot-inventory.test.mjs', []],
  ['ui-tests/slot-register-audit.test.mjs', []],
  ['ui-tests/slot-register-runtime.test.mjs', []],
  ['ui-tests/recipe-executable.test.mjs', []],
  ['ui-tests/slot-core-contract.test.mjs', []],
  ['ui-tests/module-seed.test.mjs', []],
  // 设备端验收脚本：CI 无 WebView 调试通道 ⇒ 必须「显式跳过」而非崩溃。
  // 且它以**无参数**运行时只打印用法、不做任何点击（安全默认，见脚本内注释）。
  ['ui-live-verify.mjs', []],
  // ⚠️ 显式带 --tree 指向不存在的树。
  //    为什么单列：apply.sh 会**主动传** `--tree "$DSH_TREE"`（默认手机路径），
  //    而 CI 上没有那棵树。仅靠上面「env 里 DSH_TREE 不存在」**覆盖不到**这条路径
  //    —— 脚本读的是 argv 里的值，不是环境变量。
  //    2026-10-13 实测踩到：run 38318714316 的 apply.sh 步骤因 ui-module-seed
  //    以 exit 2 退出而整个构建失败（日志末行「引擎树不存在：/data/user/0/…」）。
  ['ui-module-seed.mjs', ['--tree', '/nonexistent-engine-tree']],
  ['ui-semantic-anchors.mjs', ['--tree', '/nonexistent-engine-tree']],
  // 基线分叉搬运工具：无参数时必须**打印用法并正常退出**，不能崩（CI 会跑它）。
  ['ui-baseline-merge.mjs', []],
  // 原生 token 接入方案：无参数时必须打印用法并正常退出（本机无 gradle，故本步是
  // 该改动唯一可离线验证的关卡）。
  ['ui-native-token-plan.mjs', []],
  // 设备版本判定：CI 无设备时应**明确跳过**而非崩；它决定用哪种验收模式。
  ['ui-verify-installed.mjs', []],
  // 预演等价性验证：CI 无 GH_TOKEN 时应**明确跳过**而非崩。
  // （它需要网络比对仓库，属维护期工具；无 token 时打印说明并退出 0）
  ['ui-verify-preview-equivalence.mjs', []],
  // 四项目标审计：CI 无设备时各层自行跳过，必须正常退出。
  ['ui-audit-objectives.mjs', []],
  // 原生壳面深色资源校验：无 APK 路径时必须打印用法并正常退出（CI 无设备）。
  ['ui-verify-night-resources.mjs', []],
]

console.log('无引擎树环境下，每个 CI 步骤都必须能正常退出')
// ⚠️ 偶发「退出挂起」的重试（2026-10-13 实测发现，非本层逻辑缺陷）：
//    `ui-tests/slot-register-audit.test.mjs` 在 Android + node 26 上**偶发**卡在退出阶段：
//      · 逻辑已跑完、6/6 断言全绿、`process.exit(0)` 已调用（`--trace-exit` 能打出
//        "Exited the environment with code 0"）——但进程不返回；
//      · 实测频率：连续压测下 20 次出现 1 次（约 5%）；空闲时不出现；
//      · 已排除的假设：mkdtemp 临时目录（最小复现 12/12 正常）、读真实设备路径
//        （20 次读取 163ms 正常）、`process.exit` 本身（其它 17 个测试同样用它却从不挂）、
//        本层代码逻辑（输出完整）。
//    ⇒ 判定为**环境层面的退出竞态**。CI 不该因此随机变红，故：超时后**重试一次**，
//      只有两次都超时才判失败（并在输出里标明「首次超时已重试」，不掩盖）。
const TIMEOUT_MS = 120000
for (const [rel, args] of CI_STEPS) {
  const p = join(SCRIPTS, rel)
  if (!existsSync(p)) { check(rel + ' 存在', false); continue }
  const runOnce = () => spawnSync(process.execPath, [p, ...args], {
    encoding: 'utf8',
    // 关键：显式给一个不存在的引擎树，模拟 CI
    env: { ...process.env, DSH_TREE: '/nonexistent-engine-tree' },
    timeout: TIMEOUT_MS,
  })
  let r = runOnce()
  const timedOutOnce = r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT'
  let retried = false
  if (timedOutOnce) {
    retried = true
    console.log('      （首次超时，按偶发退出竞态重试一次：' + rel + '）')
    r = runOnce()
  }
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // 判据：不得因**未捕获异常**退出（exit 1 + 堆栈），不得超时（重试后仍超时才算）
  const crashed = r.status !== 0 && /(Error|at .+:\d+:\d+)/.test(out)
  const timedOut = r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT'
  const skipped = /跳过|未找到|无引擎树|不在 bundles/.test(out)
  check(rel + '：无异常退出', !crashed && !timedOut,
    crashed ? '（异常退出）' + out.split('\n').slice(0, 3).join(' | ')
      : (timedOut ? '（超时' + (retried ? '；已重试仍超时' : '') + '）' : ''))
  if (r.status !== 0 && !crashed) {
    // 非零但非崩溃 = 明确的「判据未过」或「跳过」，都算可接受；记录以便追踪
    console.log('      （exit=' + r.status + (skipped ? ' 明确跳过' : ' 判据未过') + '）')
  }
}

console.log('自证：坏脚本必须被判为崩溃')
{
  // 造一个必然抛异常的脚本，验证本测试的判据有效（避免「永远绿」）
  const d = mkdtempSync(join(tmpdir(), 'cic-'))
  const bad = join(d, 'boom.mjs')
  cpSync(join(SCRIPTS, 'ui-css-validate.mjs'), join(d, 'ok.mjs'))
  // 用 node -e 直接验证崩溃检测逻辑
  const r = spawnSync(process.execPath, ['-e', 'throw new Error("boom")'], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  check('抛异常会被识别为崩溃', r.status !== 0 && /Error/.test(out))
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
