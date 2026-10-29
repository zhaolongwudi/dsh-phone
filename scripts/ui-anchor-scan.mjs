// 从一棵 dsh 引擎树里提取「上游 CSS Module 哈希类名 → 所属包」映射。
//
// 为什么要这个：dsh-phone.css 直接锚定上游构建期生成的哈希类名（.pI_x6G_frame
// 之类）。这类名字随上游每次升级重新生成，失效时**完全静默**——页面照常渲染，
// 只是样式不再命中，用户看到的是「界面乱了」，而构建、类型检查、单测全绿。
// 本脚本把这份隐式依赖变成可机检的清单（供 check-ui-anchors.mjs 做门禁）。
//
// 用法：
//   node scripts/ui-anchor-scan.mjs <dsh树根>            打印映射
//   node scripts/ui-anchor-scan.mjs <dsh树根> --json     输出 JSON
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * 上游 CSS Module 哈希形态：`.<5-10位 base64ish前缀>_<camelCase/kebab 类名>`。
 *
 * ⚠️ 类名段**必须含小写字母**。这一条是实测加的：早期版本只要求首字母为字母，
 * 于是 JS 常量被大量误判为哈希 —— 例如 `Number.MAX_SAFE_INTEGER` 匹配成
 * 「前缀 `MAX_SAFE` + 类名 `INTEGER`」；引擎树里这类假阳性有 1306 个
 * （`CORDIS_`/`DEFAULT_`/`BASELINE_`/`SHARED_` 等全大写常量）。
 * 真实 CSS Module 类名是 camelCase 或 kebab（必然含小写），故该约束零误伤：
 * 实测本项目 53+4=57 个锚点全部仍被识别。
 */
export const HASH_RE = /\.[A-Za-z0-9_-]{5,10}_([a-z][a-zA-Z0-9]*|[a-zA-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*)/g

/**
 * 扫描一棵 dsh 引擎树的 node_modules/@deepseek-ai，返回 哈希 → 包集合。
 * @param root dsh 包根（含 node_modules/@deepseek-ai）
 * @returns Map<string, Set<string>> 形如 '.pI_x6G_frame' → {'dsh-client-ui-layout'}
 */
export function scanAnchors(root) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  const out = new Map()
  if (!existsSync(scope)) return out
  for (const pkg of readdirSync(scope)) {
    const lib = join(scope, pkg, 'lib')
    if (!existsSync(lib)) continue
    const walk = dir => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.(js|mjs)$/.test(e.name)) continue
        let text
        try { text = readFileSync(p, 'utf8') } catch { continue }
        for (const m of text.match(HASH_RE) ?? []) {
          if (!out.has(m)) out.set(m, new Set())
          out.get(m).add(pkg)
        }
      }
    }
    walk(lib)
  }
  return out
}

/**
 * 扫出 CSS 里实际引用的哈希类名（含在复合选择器中的）。
 * @param cssText 样式表全文
 * @returns Set<string>
 */
export function referencedHashes(cssText) {
  return new Set(cssText.match(HASH_RE) ?? [])
}

/** 行内入口。 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2]
  if (!root) { console.error('用法：node ui-anchor-scan.mjs <dsh树根> [--json]'); process.exit(2) }
  const map = scanAnchors(root)
  const obj = {}
  for (const [k, v] of [...map].sort()) obj[k] = [...v].sort()
  if (process.argv.includes('--json')) console.log(JSON.stringify(obj, null, 2))
  else { for (const [k, v] of Object.entries(obj)) console.log(k.padEnd(34), [...v].join(', ')) }
  console.error(`\n共 ${map.size} 个哈希类名，来自 ${new Set([...map.values()].flatMap(s => [...s])).size} 个包`)
}
