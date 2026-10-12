// Android 资源校验的判别力测试。
//
// 与 CSS 校验同理：本层新增的 res 文件若格式不对，**gradle 资源编译直接失败**
// （硬阻断，不是静默失效）。本机没有 gradle/java 跑不了 aapt2，故用等价检查
// 提前拦住常见错法 —— 但校验器自身必须有判别力，否则等于没查。
//
// 运行：node scripts/ui-tests/res-validate.test.mjs
import { validateRes } from '../ui-res-validate.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (e ? '  ' + e : ''))) }

const HDR = '<?xml version="1.0" encoding="utf-8"?>\n'
const color = body => HDR + '<resources>\n' + body + '\n</resources>'
const dimen = body => HDR + '<resources>\n' + body + '\n</resources>'

console.log('真问题：必须检出（aapt2 会拒绝的形态）')
check('色值缺 #', !validateRes(color('<color name="a">FF0000</color>'), 'color').ok)
check('色值长度错（#FFF）', !validateRes(color('<color name="a">#FFF</color>'), 'color').ok)
check('色值非法字符', !validateRes(color('<color name="a">#GGGGGG</color>'), 'color').ok)
check('缺 XML 声明', !validateRes('<resources><color name="a">#FF0000</color></resources>', 'color').ok)
check('根元素缺失', !validateRes(HDR + '<color name="a">#FF0000</color>', 'color').ok)
check('标签不配平', !validateRes(HDR + '<resources><color name="a">#FF0000</color>', 'color').ok)
check('裸 & 未转义', !validateRes(color('<!-- A & B --><color name="a">#FF0000</color>'), 'color').ok)
check('无任何条目', !validateRes(color(''), 'color').ok)
check('dimen 缺单位', !validateRes(dimen('<dimen name="s">8</dimen>'), 'dimen').ok)
check('dimen 单位非法（em）', !validateRes(dimen('<dimen name="s">8em</dimen>'), 'dimen').ok)

console.log('误报防线：合法形态必须通过')
check('#RRGGBB', validateRes(color('<color name="a">#FF0000</color>'), 'color').ok)
check('#AARRGGBB', validateRes(color('<color name="a">#80FF0000</color>'), 'color').ok)
check('小写色值', validateRes(color('<color name="a">#ff0000</color>'), 'color').ok)
check('dp / sp / px', validateRes(dimen('<dimen name="a">8dp</dimen><dimen name="b">14sp</dimen><dimen name="c">2px</dimen>'), 'dimen').ok)
check('小数 dp', validateRes(dimen('<dimen name="a">0.5dp</dimen>'), 'dimen').ok)
check('注释含已转义实体', validateRes(color('<!-- A &amp; B --><color name="a">#FF0000</color>'), 'color').ok)

console.log('真实产物：本层新增资源必须通过')
{
  // 向上找仓库根
  let root = HERE
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(root, 'files/app/src/main/res/values/dimens.xml'))) { root = join(root, 'files'); break }
    if (existsSync(join(root, 'app/src/main/res/values/dimens.xml'))) break
    const up = dirname(root); if (up === root) { root = null; break }
    root = up
  }
  const files = [
    ['app/src/main/res/values/ds_colors.xml', 'color'],
    ['app/src/main/res/values-night/ds_colors.xml', 'color'],
    ['app/src/main/res/values/dimens.xml', 'dimen'],
  ]
  if (root) {
    for (const [rel, kind] of files) {
      const p = join(root, rel)
      if (!existsSync(p)) { console.log(`  （跳过 ${rel}：不存在）`); continue }
      const r = validateRes(readFileSync(p, 'utf8'), kind)
      check(rel + ' 合法', r.ok, JSON.stringify(r.problems.concat(r.entries.filter(e => !e.ok))))
    }
    // 深浅色成对
    const d = join(root, 'app/src/main/res/values/ds_colors.xml')
    const n = join(root, 'app/src/main/res/values-night/ds_colors.xml')
    if (existsSync(d) && existsSync(n)) {
      const names = f => new Set([...readFileSync(f, 'utf8').matchAll(/<color name="([^"]+)"/g)].map(m => m[1]))
      const dn = names(d), nn = names(n)
      const miss = [...dn].filter(x => !nn.has(x)).concat([...nn].filter(x => !dn.has(x)))
      check('深浅色资源成对（同名同义）', miss.length === 0, miss.join(', '))
    }
  } else {
    console.log('  （跳过：本布局下未找到资源目录）')
  }
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
