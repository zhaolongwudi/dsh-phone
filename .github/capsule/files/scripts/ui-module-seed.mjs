// 客户端模块表（seed）契约校验：三期槽位组件能用哪些依赖。
//
// ## 背景与它解决的问题
//
// 三期的做法是把「用 JS/CSS 硬塞进上游 DOM」的控件改成「走槽位注册自己的组件」。
// 但组件能写成什么样，取决于**加载器给 factory 传什么**。实测壳侧协议是 CJS 形态：
//
//   window.__ModuleLoader__.load({ id, factory: (require) => ({ inject, apply }) })
//
// 其中 `require` 只能解析**静态模块表**（seed）里的东西——不在表里的一律解析失败。
// 因此「三期能否写有状态组件（useState/useEffect/事件绑定）」完全由这张表决定，
// 而不是由我们的代码风格决定。
//
// 实测 0.2.1-alpha.1 的表：react、react/jsx-runtime、react-dom、react-dom/client、
// cordis、client-store、client-ui-slots、client-ui-primitives、client-ui-dockkit。
// ⇒ 可以写真正的 React 函数组件（参考项目的 MobileChrome/SidebarToggle 正是如此）。
//
// 本脚本把这张表变成可机检契约：上游若移除我们依赖的条目，三期配方会在构建期
// 报红，而不是等组件在设备上静默不渲染。
//
// ## 用法
//   node scripts/ui-module-seed.mjs --tree <dsh树根>      校验（缺条目则非零退出）
//   node scripts/ui-module-seed.mjs --tree <dsh树根> --list  列出全部条目
//   node scripts/ui-module-seed.mjs --json
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 三期（及未来迁移）必需的表条目。缺任一条即无法按预期写组件。 */
export const REQUIRED_SEED = {
  react: '函数组件与 hooks（useState/useEffect/useRef）',
  'react/jsx-runtime': 'JSX 运行时（若用 JSX 编译产物）',
  'react-dom': 'ReactDOM（portal 等）',
  '@deepseek-ai/dsh-client-ui-slots': '槽位注册 API（ctx.slots）本体',
  '@deepseek-ai/cordis': '插件服务框架（inject/生命周期）',
}

/**
 * 从引擎树里提取静态模块表（seed）的键。
 *
 * 表在 boot 时以 `staticModules: lM()` 形态传入客户端模块系统，实现在前端产物里。
 * 源码态下 `dsh-client-modules` 只消费 `options.staticModules`，故此处在
 * 前端 dist 中定位那个返回对象字面量的函数——它是表的**唯一真源**。
 *
 * @param root dsh 引擎树根
 * @returns {{keys: string[], source: string|null}}
 */
export function scanSeed(root) {
  const dist = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  if (!existsSync(dist)) return { keys: [], source: null }
  for (const f of readdirSync(dist)) {
    if (!/\.js$/.test(f)) continue
    let text
    try { text = readFileSync(join(dist, f), 'utf8') } catch { continue }
    // 可靠路径：先找 `staticModules:<fn>()` 调用点拿到函数名，再读该函数的
    // `return{...}` 字面量。不靠「扫第一个 return{}」——压缩产物里那种形态遍地都是，
    // 早先版本正是因此误抓了 markdown AST 的定义。
    const use = text.match(/staticModules:\s*([A-Za-z0-9_$]+)\(\)/)
    if (!use) continue
    const fn = use[1]
    const def = text.indexOf('function ' + fn + '(){return{')
    if (def < 0) continue
    const close = text.indexOf('}}', def)
    if (close < 0) continue
    const body = text.slice(def + ('function ' + fn + '(){return{').length, close)
    const keys = [...body.matchAll(/(?:^|,)\s*("([^"]+)"|'([^']+)'|([A-Za-z0-9_$@/.+-]+))\s*:/g)]
      .map(x => x[2] ?? x[3] ?? x[4])
      .filter(Boolean)
    if (keys.some(k => /^(react|@deepseek-ai\/)/.test(k))) {
      return { keys: [...new Set(keys)].sort(), source: f }
    }
  }
  return { keys: [], source: null }
}

/**
 * 校验必需条目是否存在。
 * @param root 引擎树根
 * @returns {{found:boolean, keys:string[], missing:string[], source:string|null}}
 */
export function checkSeed(root) {
  const { keys, source } = scanSeed(root)
  const missing = Object.keys(REQUIRED_SEED).filter(k => !keys.includes(k))
  return { found: keys.length > 0, keys, missing, source }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ti = args.indexOf('--tree')
  const tree = ti >= 0 ? args[ti + 1] : '/data/data/com.dshphone/files/tree'
  if (!existsSync(tree)) { console.error('引擎树不存在：' + tree); process.exit(2) }
  const r = checkSeed(tree)

  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else if (args.includes('--list')) {
    console.log(`静态模块表（${r.source ?? '未找到'}）共 ${r.keys.length} 项：`)
    for (const k of r.keys) console.log('  ' + k)
  } else {
    console.log('客户端模块表契约（三期槽位组件可用依赖）')
    console.log(`  来源：${r.source ?? '未找到'}  共 ${r.keys.length} 项`)
    if (!r.found) {
      console.log('  ✗ 未能定位静态模块表（上游可能改了产物结构）')
      process.exit(1)
    }
    for (const [k, why] of Object.entries(REQUIRED_SEED)) {
      console.log((r.keys.includes(k) ? '  ✓ ' : '  ✗ ') + k.padEnd(38) + why)
    }
    console.log(r.missing.length ? `\n✗ 缺 ${r.missing.length} 项，三期配方需重新评估` : '\n✓ 三期所需条目齐全')
    process.exit(r.missing.length === 0 ? 0 : 1)
  }
}
