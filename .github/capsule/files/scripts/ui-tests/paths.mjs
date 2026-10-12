// UI 测试共用的路径解析：让同一份测试在两种布局下都能找到**真实**产物。
//
// ## 两种布局
// A「胶囊工作区」（本层维护期）：
//     .github/capsule/overrides/app/src/main/assets/dsh-phone.{js,css}   ← 上游文件的覆盖
//     .github/capsule/files/app/src/main/assets/ui-anchors.json          ← 全新增资产
//     .github/capsule/files/scripts/ui-tests/*.mjs                       ← 本测试
//   ⚠️ 关键：CSS 与映射表**不在同一前缀下**（overrides vs files）。早期版本按
//   「同一目录同时找到两者」来探测，会漏掉这个真实布局；若恰好存在一份陈旧
//   副本（例如手工铺开的 app/），还会优先命中副本 → 测试对着旧文件假绿。
//   故这里对每个文件**各自**按候选路径查找。
// B「apply.sh 后的仓库」（CI 与最终交付）：两者都已落到仓库根 app/…。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS_REL = 'app/src/main/assets/dsh-phone.css'
const MAP_REL = 'app/src/main/assets/ui-anchors.json'
const JS_REL = 'app/src/main/assets/dsh-phone.js'

/** 覆盖类资产在胶囊工作区里的前缀（上游文件走 overrides/）。 */
const PREFIXES = ['overrides/', 'files/', '']

/** 本文件所在目录。 */
export const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 自 HERE 向上逐级、对每个前缀查找第一个存在的文件。
 * @param rels 候选相对路径（按优先级）
 * @returns {{path: string, prefix: string}|null}
 */
function locate(rels) {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const rel of rels) {
      for (const prefix of PREFIXES) {
        const p = join(d, prefix + rel)
        if (existsSync(p)) return { path: p, prefix }
      }
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

/**
 * 解析 CSS 与映射表（**各自**定位，以兼容 overrides/files 分离的真实布局）。
 * @returns {{root: string, css: string, map: string, layout: string}}
 */
/** 三期：客户端插件源与生成产物的相对路径。 */
export const PLUGIN_RELS = {
  source: 'peer/agent-cards/client-source.js',
  qqBundle: 'phone-qq/cards-client.js',
  peerBundle: 'peer/agent-cards/client.js',
}

/**
 * 解析一个客户端插件文件（源或产物）。
 * 复用同一套 overrides/files/repo 前缀逻辑：本层覆盖走 overrides/，
 * apply 之后落在仓库根。
 * @param key PLUGIN_RELS 的键
 * @returns {string|null} 绝对路径，找不到返回 null
 */
export function resolvePlugin(key) {
  const rel = PLUGIN_RELS[key]
  if (!rel) throw new Error('未知插件键: ' + key)
  const hit = locate([rel])
  return hit ? hit.path : null
}

export function resolveAssets() {
  const css = locate([CSS_REL])
  const map = locate([MAP_REL])
  if (!css) throw new Error(`找不到 ${CSS_REL}（自 ${HERE} 向上探测 10 级，前缀 ${PREFIXES.join('/')}）`)
  if (!map) throw new Error(`找不到 ${MAP_REL}（自 ${HERE} 向上探测 10 级，前缀 ${PREFIXES.join('/')}）`)
  return {
    root: dirname(dirname(css.path)),
    css: css.path, map: map.path,
    layout: `${css.prefix || 'repo'}+${map.prefix || 'repo'}`,
  }
}

/**
 * 定位 dsh-phone.js 交付产物。
 * @returns {string} 绝对路径
 */
export function resolvePhoneJs() {
  const hit = locate([JS_REL])
  if (!hit) throw new Error(`找不到 ${JS_REL}（自 ${HERE} 向上探测 10 级）`)
  return hit.path
}

/**
 * dsh 引擎树根（门禁在线校验用）。找不到则返回 null → 走离线模式。
 * @returns {string|null}
 */
export function resolveEngineTree() {
  const candidates = [
    process.env.DSH_TREE,
    '/data/data/com.dshphone/files/tree',
    '/data/user/0/com.dshphone/files/tree',
  ].filter(Boolean)
  return candidates.find(p => existsSync(join(p, 'node_modules', '@deepseek-ai'))) ?? null
}
