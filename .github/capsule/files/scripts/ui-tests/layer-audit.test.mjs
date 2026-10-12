// 图层健康检查的判别力测试。
//
// 这个检查器的价值全在**判据是否立对**：一路开发中它先误报了 5 个 class、
// 2 个死 CSS、3 个变量（全是「创建标记 / 外部契约 / 拼接设置」被误当问题），
// 修正后才只剩真问题。故本测试对「真问题能检出」与「三类误报不出现」双向断言——
// 只测前者会留下误报，只测后者会让检查器退化成永远绿。
//
// 运行：node scripts/ui-tests/layer-audit.test.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditLayer } from '../ui-layer-audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

/** 造一对临时 css/js 跑审计。 */
function run(cssText, jsText) {
  const d = mkdtempSync(join(tmpdir(), 'layer-'))
  const css = join(d, 'a.css'), js = join(d, 'a.js')
  writeFileSync(css, cssText); writeFileSync(js, jsText)
  const r = auditLayer(css, js)
  rmSync(d, { recursive: true, force: true })
  return r
}

console.log('真问题：三类都必须检出')
check('状态类无 CSS 消费者 → 检出',
  run('.dsh-phone-x{}', "document.body.classList.toggle('dsh-phone-ghost', true)").deadState.includes('dsh-phone-ghost'))
check('死 CSS → 检出',
  run('.dsh-phone-deadrule{color:red}', '').deadCss.includes('dsh-phone-deadrule'))
check('未定义变量 → 检出',
  run('.x{top:var(--dsh-phone-nope,0)}', '').undefinedVars.includes('--dsh-phone-nope'))

console.log('误报防线：三类豁免都必须生效（否则检查器会被噪声淹没而弃用）')
check('创建标记（className 赋值）不算状态类',
  run('', "el.className = 'dsh-phone-marker'").deadState.length === 0,
  JSON.stringify(run('', "el.className = 'dsh-phone-marker'").deadState))
check('外部契约 dim-jh-* 不算死 CSS',
  run('.dim-jh-x{color:red}', '').deadCss.length === 0)
check('外部契约 dsh-phone-noema* 不算死 CSS',
  run('.dsh-phone-noema pre{max-width:100%}', '').deadCss.length === 0)
check('拼接设置的变量不算未定义',
  run('.x{left:var(--dsh-phone-pop-left)}',
    "const p = '--dsh-phone-pop-'; el.style.setProperty(p + 'left', '1px')").undefinedVars.length === 0)

console.log('插件来源：客户端插件写的类不算死 CSS')
{
  // 实测踩过：三期遮罩的 .dsh-phone-mask 由**客户端插件**（client-source.js）
  // 产出的 DOM 使用，而审计最初只读 dsh-phone.js ⇒ 被误判成死 CSS。
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const d = mkdtempSync(join(tmpdir(), 'la-'))
  const css = join(d, 'a.css'), js = join(d, 'a.js')
  writeFileSync(css, '.dsh-phone-onlyplugin{color:red}')
  writeFileSync(js, 'void 0;')
  check('无插件来源时报死 CSS（判据有效）',
    auditLayer(css, js, []).deadCss.length === 1)
  check('插件写了该类时不报（不误报有效规则）',
    auditLayer(css, js, ["x.className = 'dsh-phone-onlyplugin'"]).deadCss.length === 0)
  check('插件来源不参与状态类判定（无副作用）',
    auditLayer(css, js, ["x.classList.toggle('dsh-phone-onlyplugin')"]).deadState.length === 0)
}

console.log('边界')
check('空文件不报错', (() => { const r = run('', ''); return r.deadState.length + r.deadCss.length + r.undefinedVars.length === 0 })())
check('选择器锚点不算死 CSS（JS 查询用，非样式钩子）',
  run('', "document.querySelector('.dsh-phone-only-js')").deadCss.length === 0)
check('CSS 注释里的类名不被当规则',
  run('/* .dsh-phone-commented{color:red} */ .ok{}', '').deadCss.length === 0)

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
