// 上游语义锚点清单：找出「本层 CSS 依赖的 hash 类」有哪些可以改用**稳定的语义属性**。
//
// ## 为什么值得单做一个工具
//
// 本层 dsh-phone.css 锚了 52 个上游 CSS Module 哈希类名，它们随上游打包改名即
// **静默失效**。但上游同时发布了若干**语义属性**（data-* ），与哈希类写在同一
// React 元素上，语义稳定、不随打包改名。凡两者同元素的，都可以「属性优先 + hash
// 兜底」——既降脆弱面，又因保留兜底而不引入回归。
//
// 之前是靠人工逐个 grep 发现（已替换 5 组：frame / rail / composer-card /
// composer-send / 会话头三件套）。本工具把它变成常规检查：列出**尚未替换**的候选项。
//
// ## 用法
//   node scripts/ui-semantic-anchors.mjs --tree <dsh树根>       列出候选项
//   node scripts/ui-semantic-anchors.mjs --tree <树> --json
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 解析某包 client.js 里的「模块 CSS 映射表」：语义名 → 真实 hash 类名。
 * 实测形态：`X_module_css_default = { "accessory": "uV2eYG_accessory", … }`
 * 有了它才能**精确**把 hash 与属性配对，而不是靠短名模糊匹配（那会误报）。
 * @param text 包内 client.js 全文
 * @returns {Map<string,string>} 语义名 → "前缀_hashName"
 */
export function parseModuleCssMaps(text) {
  const out = new Map()
  for (const m of text.matchAll(/([A-Za-z0-9_$]+_module_css_default)\s*=\s*\{([^}]{0,4000})\}/g)) {
    for (const e of m[2].matchAll(/"([^"]+)":\s*"([^"]+)"/g)) {
      // 只收真正的 hash 形态（前缀_hashName）
      if (/^[A-Za-z0-9_-]{5,10}_[a-zA-Z]/.test(e[2])) out.set(e[1], e[2])
    }
  }
  return out
}

/**
 * 提取某包 client.js 里「同一 jsx 元素上并存的 hash 类名 + 语义属性」。
 * 用模块 CSS 映射表把 `X_module_css_default.hashA` 解析成真实 hash 类名。
 * @param root 引擎树根
 * @param pkg 包名
 * @returns {Array<{classes:string[], attrs:string[]}>}
 */
export function findCoLocated(root, pkg) {
  const f = join(root, 'node_modules', '@deepseek-ai', pkg, 'lib', 'client.js')
  let text
  try { text = readFileSync(f, 'utf8') } catch { return [] }
  const maps = parseModuleCssMaps(text)
  const out = []
  // 同一对象字面量内同时出现 className 与 data-*（两种先后顺序都覆盖）
  const pats = [
    /\{\s*className:\s*[^,}]{0,240}?,\s*((?:"data-[a-z-]+":[^,}]+,\s*)+)[^}]{0,240}?\}/g,
    /\{\s*((?:"data-[a-z-]+":[^,}]+,\s*)+)className:\s*[^,}]{0,240}?[^}]{0,240}?\}/g,
  ]
  for (const re of pats) {
    for (const m of text.matchAll(re)) {
      const attrs = [...m[0].matchAll(/"(data-[a-z-]+)":\s*(?:"([^"]*)"|true)/g)]
        .map(x => x[1] + (x[2] !== undefined && x[2] !== '' ? '=' + x[2] : ''))
      // 用映射表把 default.xxx 解析成真实 hash；解析不到的丢弃（避免靠短名猜）
      const classes = [...m[0].matchAll(/default\.([A-Za-z0-9_$]+)/g)]
        .map(x => maps.get(x[1])).filter(Boolean)
      if (attrs.length && classes.length) out.push({ classes: [...new Set(classes)], attrs: [...new Set(attrs)] })
    }
  }
  return out
}

/**
 * 列出「本层仍在用 hash、但上游同元素有语义属性」的候选项。
 * @param root 引擎树根
 * @param cssText 本层 CSS 全文
 * @returns {Array<{pkg:string, classes:string[], attrs:string[]}>}
 */
export function candidates(root, cssText) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  let pkgs
  try { pkgs = readdirSync(scope) } catch { return [] }
  const out = []
  for (const pkg of pkgs) {
    for (const co of findCoLocated(root, pkg)) {
      // 该 hash 类：本层 CSS 里是否还在「裸用」（未与属性并列）
      const stillBare = co.classes.filter(c => {
        const usesAttr = co.attrs.some(a => cssText.includes('[' + a + ']'))
        // c 已是完整 hash 类名（如 `uV2eYG_card`）；CSS 里写作 `.uV2eYG_card`
        return cssText.includes('.' + c) && !usesAttr
      })
      if (stillBare.length) out.push({ pkg, classes: stillBare, attrs: co.attrs })
    }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const ti = args.indexOf('--tree')
  const tree = ti >= 0 ? args[ti + 1] : (process.env.DSH_TREE || '/data/user/0/com.dshphone/files/tree')
  // 本步是**信息性清单**（apply.sh 里恒 `|| true`），故缺树时明确跳过（exit 0），
  // 不用 exit 2 —— 那是「硬失败」语义，会让调用方误以为门禁拦住了构建。
  // 与 ui-module-seed 同一处修正（2026-10-13 CI 实测踩到）。
  if (!existsSync(tree)) {
    console.log('上游语义锚点清单：跳过（本环境无引擎树：' + tree + '）')
    console.log('  说明：本步信息性、不阻断；只在维护期（有引擎树）时打印候选。')
    process.exit(0)
  }
  const locate = rel => {
    let d = HERE
    for (let i = 0; i < 10; i++) {
      for (const p of ['overrides/', 'files/', '']) {
        const f = join(d, p + rel)
        if (existsSync(f)) return f
      }
      const up = dirname(d); if (up === d) break; d = up
    }
    return null
  }
  const cssPath = locate('app/src/main/assets/dsh-phone.css')
  if (!cssPath) { console.log('上游语义锚点清单 · 跳过（本布局下未找到 dsh-phone.css）'); process.exit(0) }
  const css = readFileSync(cssPath, 'utf8')
  const r = candidates(tree, css)
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    console.log('上游语义锚点：可替代 hash 的候选项')
    if (!r.length) console.log('  （无 —— 本层已用到的 hash 均已配对语义属性，或上游无对应属性）')
    for (const c of r) {
      console.log(`  ${c.pkg}`)
      console.log('    hash: ' + c.classes.join(', '))
      console.log('    可用属性: ' + c.attrs.join(', '))
    }
  }
  // 纯信息性：不因有候选项而失败（替换是渐进的可选工作）
  process.exit(0)
}
