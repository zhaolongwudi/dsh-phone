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
 * **完整**引擎树的探针（Issue F-30）。
 *
 * 为什么不用「有 `@deepseek-ai/` 目录」当判据：`vendor/dsh-codearts-auth/node_modules`
 * 里也有 `@deepseek-ai/*`（devDeps 的 dsh-credentials 等），但它**不含 UI 包** ——
 * 认它会把这几个套件打成**假红**。故只认「UI 引擎树」：`dsh-client-ui-slots`
 *（槽位契约/端到端链路）与 `dsh-web-frontend/dist/assets`（静态模块表）。
 *
 * ⚠️ 2026-10-17：这**同一套**探针现在也用于**候选路径**（见 `resolveEngineTree`）。
 *    原先候选只判「有 `node_modules/@deepseek-ai`」，而设备树实测**有 302 个
 *    @deepseek-ai 包却缺 `dsh-client-ui-slots`** ⇒ 函数返回该树、套件随后
 *    `require('@deepseek-ai/dsh-client-ui-slots')` **当场崩**（而不是按约定跳过）。
 *    设备上维护期跑测试因此必红，且报错指向模块缺失、不指向判据。
 */
const ENGINE_TREE_PROBES = [
  'node_modules/@deepseek-ai/dsh-client-ui-slots',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets',
]

/** 某候选是否**完整**（缺哪项也一并给出，便于诊断）。 */
function probeCandidate(p) {
  const missing = ENGINE_TREE_PROBES.filter(rel => !existsSync(join(p, rel)))
  return { ok: missing.length === 0, missing }
}

/** 自 HERE 向上、按仓库两种布局（仓库根 / `runtime/`）找**完整**引擎树；找不到返回 null。 */
function locateLocalEngineTree() {
  let d = HERE
  for (let i = 0; i < 12; i++) {
    for (const prefix of ['', 'runtime/']) {
      const p = join(d, prefix)
      if (ENGINE_TREE_PROBES.every(rel => existsSync(join(p, rel)))) return p
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

/**
 * 显式声明「本环境没有引擎树」的哨兵值（Issue F-30）。
 *
 * ⚠️ 为什么需要它：两个设备路径在**手机上恒存在**，故「跳过」这条分支
 * （以及它配套的 `DSH_REQUIRE_ENGINE_TREE` 硬失败分支）在设备上**无法用 `DSH_TREE`
 * 复现** —— `DSH_TREE` 只是候选里的第一项，后面两项照样命中。既然这条分支要进
 * `ci-compat.test.mjs` 的清单（「无引擎树时不得崩」），它就必须是**可复现**的。
 * 故：`DSH_TREE=__none__` = 「本次运行没有引擎树」（维护期模拟 CI / 反向验证用）。
 */
const NO_TREE_SENTINEL = '__none__'

/**
 * 缺树时的**硬要求**开关（Issue F-30）。
 *
 * 默认关：本仓库 CI（`.github/workflows/typecheck.yml`）只装 vendor 依赖、**没有**
 * UI 包，故那批最强套件只能跳过；而 `ui-tests/ci-compat.test.mjs` 明确要求
 * 「无引擎树时不得异常退出」⇒ 默认必须保留「跳过」。需要把「跳过」升级成**失败**的
 * 环境（例如给 CI 补上 runtime 依赖后）只要 `DSH_REQUIRE_ENGINE_TREE=1`。
 */
function engineTreeRequired() {
  const raw = process.env.DSH_REQUIRE_ENGINE_TREE
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim())
}

/** 已经报过一次「缺树」（每个进程只刷一遍，避免刷屏）。 */
let missingTreeWarned = false

/** 默认候选引擎树根：显式 `DSH_TREE` 优先，其次两个设备路径。 */
function defaultEngineTreeCandidates() {
  const fromEnv = process.env.DSH_TREE
  // 哨兵：显式声明「本次没有引擎树」⇒ 不再回落到设备路径（见上方常量说明）。
  if (fromEnv === NO_TREE_SENTINEL) return []
  return [
    fromEnv,
    '/data/data/com.dshphone/files/tree',
    '/data/user/0/com.dshphone/files/tree',
  ].filter(Boolean)
}

/**
 * dsh 引擎树根（门禁在线校验用）。找不到则返回 null → 走离线模式。
 *
 * ⚠️⚠️ **「找不到」必须响亮**（Issue F-30）：本函数原先只返回 `null`，而各套件一律
 * 「跳过并说明」，于是 6 个**最强**验证（slot-core-contract / slot-chain-e2e /
 * plugin-bundle-load / ui-module-seed / ui-live-verify / ui-verify-installed）在 CI 上
 * **全部 exit 0** —— 门禁写着「最强验证」，实际什么都没验，绿灯看不出这一点。
 * 现在的三层处置（同时保住 ci-compat 的「不得崩溃」约定）：
 * 1. 候选补上**本仓库内**的引擎树（仓库根 `node_modules/`、`runtime/node_modules/`，
 *    自本文件向上逐级找）—— 环境里真装了 UI 包时，最强验证**真的跑起来**，
 *    而不是继续跳过；
 * 2. 仍找不到时打一条 GitHub 注解（`::warning::`，CI 里一眼可见）说明「跳过 ≠ 通过」；
 * 3. 若 `DSH_REQUIRE_ENGINE_TREE=1`（声明「本环境必须在线校验」），**直接抛错**
 *    （非零退出）—— 那种环境里缺树是配置错误，不该静默变成 exit 0。
 *
 * @param {string[]} [candidates] 显式候选根（默认 = `DSH_TREE` → 两个设备路径）。
 *   **供测试注入**（与 `allAccountsRateLimitedForModel` 的 `now` 同款）：传 `[]` 即
 *   「只在本仓库内找」，用于验证上面第 1–3 条分支。
 * @returns {string|null} 引擎树根；未找到且未要求硬失败时为 null
 */
export function resolveEngineTree(candidates = defaultEngineTreeCandidates()) {
  // ⚠️ 判据用**完整性探针**，不是「有 @deepseek-ai 目录」—— 后者会把「有引擎但缺 UI 包」
  //    的树（设备树实测如此：302 个 @deepseek-ai 包但无 dsh-client-ui-slots）认作可用，
  //    套件随后 require 该包**当场崩**，而不是走「缺树 → 跳过」的既定分支。
  const rejected = []
  for (const p of candidates) {
    const { ok, missing } = probeCandidate(p)
    if (ok) return p
    rejected.push(`${p}（缺 ${missing.join('、')}）`)
  }
  const local = locateLocalEngineTree()
  if (local !== null) return local
  const reason = '未找到 dsh 引擎树'
    + `（候选：${candidates.length > 0 ? rejected.join(' / ') : '（未指定）'}`
    + '，以及本仓库内的 node_modules/ 与 runtime/node_modules/）'
  if (engineTreeRequired()) {
    throw new Error(`${reason}；DSH_REQUIRE_ENGINE_TREE=1（Issue F-30）：本环境要求在线校验，缺树即失败 —— 请先装 UI 依赖（cd runtime && pnpm install --frozen-lockfile），或用 DSH_TREE 指向引擎树。`)
  }
  if (!missingTreeWarned) {
    missingTreeWarned = true
    // GitHub Actions 会把它渲染成 warning 注解（CI 页面上可见）。
    console.log(`::warning::${reason}；依赖引擎树的断言将**跳过**（跳过 ≠ 通过，Issue F-30）。`)
  }
  return null
}
