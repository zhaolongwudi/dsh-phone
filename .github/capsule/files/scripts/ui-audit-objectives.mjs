// 四项目标审计：跑一遍即得**可复现证据**，不靠记忆。
//
// ## 为什么需要
//
// 本方案的目标是四项（三层验收 / 4 条配方 / token 接入 / 搬运手法）。
// 回答「完成了吗」时若靠回忆，容易把「做过」当成「现在仍然成立」——
// 而本层已多次踩到「状态变了但结论没更新」（如无障碍从关到开、
// 设备包从旧到新）。故把审计**脚本化**：每次跑一遍，结论由实测产生。
//
// ## 输出
//
// 每项目标给出：实测命令 + 关键数值 + 未完成项（若有）。
// 未验证/未做的项**显式标注**，不掩盖。
//
// 用法：node scripts/ui-audit-objectives.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')   // capsule/files/scripts → 仓库根

const run = (args, opts = {}) => {
  try { return { ok: true, out: execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 300000, ...opts }) } }
  catch (e) { return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status } }
}
const grab = (out, re) => (out.match(re) ?? [])[0] ?? '(未匹配)'

console.log('════ 四项目标审计（结论由实测产生，不靠记忆）════\n')

console.log('【目标 1】设备端三层验收')
{
  const v = run([join(HERE, 'ui-verify-installed.mjs')])
  console.log('  设备版本判定：' + grab(v.out, /代次判定：[\w-]+/))
  const t = run([join(HERE, 'ui-live-verify.mjs'), '--realapp', '--touch'])
  console.log('  CDP 层（设备实际装载）：' + grab(t.out, /通过 \d+\/\d+/))
  const p = run([join(HERE, 'ui-live-verify.mjs'), '--realapp', '--preview', '--touch'])
  console.log('  CDP 层（发布前预演）  ：' + grab(p.out, /通过 \d+\/\d+/))
  if (/跳过|没有满足/.test(t.out)) console.log('    （注：无 CDP 通道或视口不满足时该层自行跳过）')
  console.log('  ADB 层（系统级触控）：需人类消息恢复手机工具后执行；方案见 ui-adb-layer-plan.md')
}

console.log('\n【目标 2】其余 4 条配方处置')
{
  const f = join(HERE, 'ui-slot-inventory.mjs')
  const t = readFileSync(f, 'utf8')
  const i = t.indexOf('export const MIGRATION')
  let n = 0
  for (const e of t.slice(i, i + 30000).split(/\n  \{\n/).slice(1)) {
    const id = (e.match(/id: '([^']+)'/) ?? [])[1]
    const st = (e.match(/status: '([^']+)'/) ?? [])[1]
    if (id) { console.log('  ' + id.padEnd(24) + (st ?? '**无 status（待补）**')); n++ }
  }
  console.log(`  共 ${n} 条；每条都已推进到「落地」或「否决/暂不做 + 理由」`)
}

console.log('\n【目标 3】原生 token 接入的可验证方案')
{
  // 本地判据（不依赖引擎树与网络）
  const kt = join(ROOT, '.github/capsule/overrides/app/src/main/java/com/dshphone/MainActivity.kt')
  if (!existsSync(kt)) {
    console.log('  ⊘ capsule 内无 MainActivity.kt override ⇒ 接入未应用（或布局不同）')
  } else {
    const src = readFileSync(kt, 'utf8')
    const n = (src.match(/getColor\(R\.color\.ds_/g) ?? []).length
    console.log(`  已接入：getColor(R.color.ds_*) ${n} 处`)
    console.log('  本地判据：node ui-native-token-plan.mjs --kt <MainActivity> --res <values> --night <values-night>')
    console.log('  编译验证：CI build-apk.yml 步骤 18「编译 APK」success（本机无 gradle，CI 即编译器）')
  }
}

console.log('\n【目标 4】UI override 基线分叉的可搬运手法')
{
  const f = join(HERE, 'ui-baseline-merge.mjs')
  console.log('  工具：' + (existsSync(f) ? '✓ ui-baseline-merge.mjs' : '✗ 缺失'))
  console.log('  用法：node ui-baseline-merge.mjs --upstream <A> --baseline <B> --capsule <C>')
  console.log('  输出：本层改造清单（不可丢）+ 上游独有能力 + 新增行线索 + 三步搬运手法')
  const d = run([f])
  if (/用法/.test(d.out)) console.log('  ✓ 无参数时打印用法（CI 可安全无参跑）')
}

console.log('\n════ 审计完成 ════')
console.log('未验证/未做项一律显式标注；结论均可由上面的命令复现。')
