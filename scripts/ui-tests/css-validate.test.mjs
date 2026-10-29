// CSS 结构校验的判别力测试。
//
// 为什么必须双向验证：本轮对 dsh-phone.css 做了多轮**机械替换**（正则批量改选择器），
// 花括号配平只说明括号成对，**证明不了结构合法**。校验器本身也出过错 ——
// 最初漏了「逗号开头的空选择器」与「空规则体」两类（判别力只有 4/6），
// 补齐后 8/8。故测试同时断言「真问题能检出」与「正常 CSS 不误报」。
//
// 运行：node scripts/ui-tests/css-validate.test.mjs
import { validateCss } from '../ui-css-validate.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { resolveAssets } from './paths.mjs'

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }
const bad = r => r.unclosedComment || r.unbalanced.brace || r.unbalanced.paren || r.unbalanced.bracket
  || r.badDeclarations.length > 0 || r.emptySelectors.length > 0

console.log('真问题：必须检出')
check('注释未闭合', bad(validateCss('.a{color:red} /* 未闭合')))
check('花括号不配平', bad(validateCss('.a{color:red')))
check('圆括号不配平', bad(validateCss('.a{color:rgb(1,2,3}')))
check('方括号不配平', bad(validateCss('.a[href{color:red}')))
check('声明体混入非声明', bad(validateCss('.a{color:red; 这是混入的文字}')))
check('值被截断', bad(validateCss('.a{color:}')))
check('逗号开头的空选择器', bad(validateCss(',.a{color:red}')))
check('连续逗号的空选择器', bad(validateCss('.a,,.b{color:red}')))
check('空规则体', bad(validateCss('.a{}')))

console.log('误报防线：正常 CSS 必须通过')
check('单条规则', !bad(validateCss('.a{color:red}')))
check('多条 + media', !bad(validateCss('@media (max-width:767px){.a{color:red}.b{margin:0}}')))
check('属性选择器', !bad(validateCss('[data-x="y"]{color:red}')))
check('!important 与自定义属性', !bad(validateCss('.a{--v:1px;top:var(--v,0)!important}')))
check('注释内含花括号（不应参与配平）', !bad(validateCss('/* { } */ .a{color:red}')))
check('多属性值含冒号（如 url）', !bad(validateCss('.a{background:url(http://x/y.png)}')))

console.log('hash 兜底：属性优先替换不得把原 hash 选择器删掉')
{
  // 本方案对 CSS 的替换一律是「属性优先 + 保留 hash」的**超集**形态。
  // 若某处把 hash 删了，语义就从超集退化为替换 —— 上游一旦没发布该属性，
  // 整条规则失效。这类改动在 diff 里极不显眼，故用机器守住。
  const lost = css => validateCss(css).lostFallback.length
  check('检出：属性替换丢了 hash 兜底', lost('[data-dsh-frame]{height:100%}') === 1)
  check('不误报：保留 hash 兜底', lost('[data-dsh-frame],.pI_x6G_frame{height:100%}') === 0)
  check('不误报：纯自有元素（末段 .dsh-phone-*）',
    lost('html[data-dsh-modal-open] .dsh-phone-menu{display:none}') === 0)
  check('不误报：上游属性 + hash 并列',
    lost('html[data-dsh-settings-open] [data-dsh-rail],html[data-dsh-settings-open] .pI_x6G_sidebarCol{x:1}') === 0)
}

console.log('真实产物：本层 CSS 必须通过')
{
  const a = resolveAssets()
  if (a?.css && existsSync(a.css)) {
    const r = validateCss(readFileSync(a.css, 'utf8'))
    check('dsh-phone.css 结构合法', !bad(r), JSON.stringify(r).slice(0, 160))
  } else {
    console.log('  （跳过：本布局下未找到 dsh-phone.css）')
  }
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
