// 胶囊「产物 ↔ 源码」一致性门禁（Issue F-68）。
//
// ## 为什么需要它
//
// 胶囊里有一个文件是**提交进仓库的 tsc 编译产物**，而它的源码也在同一棵胶囊里：
//
//     files/vendor/dsh-codearts-auth/lib/active-route.js     ← 产物（被判为"源"提交）
//     files/vendor/dsh-codearts-auth/lib/active-route.d.ts   ← 产物
//     files/vendor/dsh-codearts-auth/lib/active-route.{js,d.ts}.map
//     files/vendor/dsh-codearts-auth/src/active-route.ts     ← 源码
//
// 为什么这份产物必须随胶囊走（而不是由 `rebuild-vendor.sh` 重建）：`active-route.ts`
// 是**全新增**模块（上游没有），而 `apply.sh` 只铺源码；`lib/` 是构建期由 tsc 从
// `src/` 全量重建的 —— 但**纯净构建**（`.github/capsule/DISABLED`）会跳过重建、
// 直接使用**仓库提交的** `lib/`，那时这份产物就是唯一实现。若它与源码漂移，
// 纯净构建会拿到一个**与源码不一致**的运行时（改了源码却没同步产物 ⇒ 静默的两种行为）。
//
// ## 本门禁做什么
//
// 用**与 `vendor/dsh-codearts-auth/tsconfig.json` 同一组 emit 选项**把
// `src/active-route.ts` 转译一遍，与提交的 `lib/active-route.js` / `.d.ts` 逐行比对：
// 不一致即非零退出并打印差异（含行号），一致则打印 ✓。
//
// ⚠️ 忽略 `//# sourceMappingURL=…` 注释差异（转译器与 tsc 对它的写法/存在与否
//    取决于调用方式，与"代码是否一致"无关）。
//
// ## 用法
//
//   export PATH=/data/data/com.dshphone/files/bin:$PATH
//   node scripts/check-capsule-artifacts.mjs          # 校验（不一致 → exit 1）
//   node scripts/check-capsule-artifacts.mjs --quiet  # 只打印结论行
//
// 不一致时的修法：`cd vendor/dsh-codearts-auth && pnpm run build`（重建 lib/），
// 再把新产物同步回 `files/vendor/dsh-codearts-auth/lib/`。
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const QUIET = process.argv.includes('--quiet')

/**
 * 受检产物表：源码 → 它必须与哪两份提交产物逐行一致。
 *
 * ⚠️ 新增「提交了 tsc 产物」的模块时**必须登记**在本表（否则门禁对它一无所知 ——
 *    那正是本 issue 要防的形态）。
 */
const ARTIFACTS = [
  {
    src: 'vendor/dsh-codearts-auth/src/active-route.ts',
    js: 'vendor/dsh-codearts-auth/lib/active-route.js',
    dts: 'vendor/dsh-codearts-auth/lib/active-route.d.ts',
  },
]

/**
 * emit 选项：**镜像** `vendor/dsh-codearts-auth/tsconfig.json`（target / declaration* / …）。
 *
 * ⚠️ 这里刻意硬编码而不是去读 tsconfig：胶囊工作区布局下（`files/vendor/...`）
 * 上游的 tsconfig 并不在胶囊里。上游若改了 tsconfig 的 emit 选项，本门禁会**报红**
 * —— 那正是"产物需要重新生成"的信号（届时同步本常量与 `lib/` 产物）。
 *
 * ⚠️⚠️ **`module` 刻意写 ES2022 而不是 tsconfig 里的 NodeNext**（实测结论）：
 * NodeNext 要看**最近的 `package.json` 的 `"type"`** 才能定 ESM/CJS，而胶囊布局下
 * `files/vendor/dsh-codearts-auth/` **没有 package.json**（上游那个不在胶囊里）
 * ⇒ NodeNext 退化成 CJS 输出（`Object.defineProperty(exports, …)`），与提交的 ESM
 * 产物处处不同 ⇒ 门禁假红。本文件是纯 ESM（只有 `export`、无 `import`），在该包
 * `"type": "module"` 的真实上下文下，ES2022 与 NodeNext 的产出**逐字节相同**
 * （program 实测：.js 与 .d.ts 都逐行一致）。
 */
const COMPILER_OPTIONS = {
  target: 'ES2023',
  module: 'ES2022',
  moduleResolution: 'Bundler',
  lib: ['ES2023'],
  strict: true,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  outDir: 'lib',
  rootDir: 'src',
  skipLibCheck: true,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  types: ['node'],
}

/** 自 HERE 向上、按 overrides/files/仓库根三种前缀定位一个胶囊内文件。 */
function locate(rel) {
  let d = HERE
  for (let i = 0; i < 10; i++) {
    for (const prefix of ['overrides/', 'files/', '']) {
      const p = join(d, prefix + rel)
      if (existsSync(p)) return p
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return null
}

/**
 * 定位 typescript（不依赖脚本所在目录能否 `import 'typescript'`）。
 *
 * 候选顺序：显式 `DSH_TS` → `DSH_TREE`（引擎树）→ 设备树固定路径 →
 * 产物所属包的 `node_modules`（CI 里 `vendor/dsh-codearts-auth` 自己装了 devDeps）
 * → 自 HERE 向上的 `node_modules`。
 */
function resolveTypeScript(packageRoot) {
  const candidates = [
    process.env.DSH_TS,
    process.env.DSH_TREE ? join(process.env.DSH_TREE, 'node_modules/typescript') : undefined,
    '/data/data/com.dshphone/files/tree/node_modules/typescript',
    packageRoot ? join(packageRoot, 'node_modules/typescript') : undefined,
  ].filter(Boolean)
  let d = HERE
  for (let i = 0; i < 10; i++) {
    candidates.push(join(d, 'node_modules/typescript'))
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  const hit = candidates.find(p => existsSync(join(p, 'lib/typescript.js')))
  if (hit === undefined) return null
  return { path: hit, ts: require(join(hit, 'lib/typescript.js')) }
}

/**
 * 用真实 tsc program 把一份源码 emit 到内存。
 *
 * ⚠️ 用 program 而不是 `transpileModule`：后者拿不到包上下文（最近的 `package.json`
 * 里 `"type": "module"`），`module: NodeNext` 会退化成 **CommonJS** 输出 —— 与提交的
 * ESM 产物处处不同（实测：整份文件都判不一致）；而 `transpileDeclaration` 对含私有
 * 字段的类会报诊断。program 复刻的正是 `pnpm run build` 那条路径。
 *
 * ⚠️ **不落盘**：自定义 `writeFile` 只把文本收进 Map，门禁绝不修改工作区。
 *
 * @returns {Map<string, string>} 产物文件名（basename）→ 文本
 */
function emitToMemory(ts, srcPath) {
  const options = ts.convertCompilerOptionsFromJson(COMPILER_OPTIONS, HERE).options
  const out = new Map()
  const host = ts.createCompilerHost(options, true)
  host.writeFile = (fileName, text) => {
    out.set(fileName.replace(/\\/g, '/').split('/').pop(), text)
  }
  const program = ts.createProgram({ rootNames: [srcPath], options, host })
  program.emit()
  return out
}

/** 去掉 sourceMappingURL 注释、行尾空白与 BOM/CRLF —— 只比"代码本身"。 */
function normalize(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

/**
 * 逐行比对，返回前若干处差异（供报告）。
 * @returns {{line:number, expected:string, actual:string}[]}
 */
function diffLines(expectedText, actualText, limit = 20) {
  const expected = normalize(expectedText).split('\n')
  const actual = normalize(actualText).split('\n')
  const out = []
  const max = Math.max(expected.length, actual.length)
  for (let i = 0; i < max && out.length < limit; i++) {
    const e = expected[i]
    const a = actual[i]
    if (e === a) continue
    out.push({ line: i + 1, expected: e ?? '（无此行）', actual: a ?? '（无此行）' })
  }
  return out
}

function reportDiff(label, rel, diffs) {
  console.log(`  ✗ ${label} 与源码不一致：${rel}`)
  console.log(`      差异（前 ${diffs.length} 处；「生成」= 由 src 现场 emit，「提交」= 仓库里的产物）`)
  for (const d of diffs) {
    console.log(`      L${d.line}  生成: ${d.expected}`)
    console.log(`      L${d.line}  提交: ${d.actual}`)
  }
}

let fail = 0
console.log('胶囊产物一致性门禁（Issue F-68）：src 现场 emit ↔ 仓库提交的 tsc 产物')

const first = locate(ARTIFACTS[0].src)
if (first === null) {
  console.log('  ✗ 找不到受检源码（本布局下缺 vendor/dsh-codearts-auth/src）—— 门禁无法判定')
  process.exit(1)
}
const packageRoot = dirname(dirname(first)) // …/dsh-codearts-auth
const tsHit = resolveTypeScript(packageRoot)
if (tsHit === null) {
  console.log('  ✗ 找不到 typescript（试过 DSH_TS / DSH_TREE / 设备树 / 包的 node_modules）')
  console.log('      用法：export PATH=/data/data/com.dshphone/files/bin:$PATH（设备树 TS 在 $DSH_TREE/node_modules/typescript）')
  process.exit(1)
}
if (!QUIET) console.log(`  emit 用 typescript ${tsHit.ts.version}（${tsHit.path}）`)

for (const artifact of ARTIFACTS) {
  const srcPath = locate(artifact.src)
  const jsPath = locate(artifact.js)
  const dtsPath = locate(artifact.dts)
  if (srcPath === null || jsPath === null || dtsPath === null) {
    console.log(`  ✗ ${artifact.src}：源码或产物缺失（src=${srcPath} js=${jsPath} dts=${dtsPath}）`)
    fail++
    continue
  }
  const jsName = artifact.js.slice(artifact.js.lastIndexOf('/') + 1)
  const dtsName = artifact.dts.slice(artifact.dts.lastIndexOf('/') + 1)
  // 现场 emit 到内存（绝不写盘），再逐份比对。
  const emitted = emitToMemory(tsHit.ts, srcPath)

  // ① .js：与 tsc 产物逐行一致（忽略 sourceMappingURL 注释）。
  const jsEmit = emitted.get(jsName)
  if (jsEmit === undefined) {
    console.log(`  ✗ 现场 emit 没有产出 ${jsName}（受检源码或编译选项有问题）`)
    fail++
  } else {
    const jsDiffs = diffLines(jsEmit, readFileSync(jsPath, 'utf8'))
    if (jsDiffs.length > 0) {
      fail++
      reportDiff('.js', artifact.js, jsDiffs)
    } else if (!QUIET) {
      console.log(`  ✓ ${artifact.js} 与 ${artifact.src} 逐行一致`)
    }
  }

  // ② .d.ts：同一份 program 的声明产出（`declaration: true`）。
  const dtsEmit = emitted.get(dtsName)
  if (dtsEmit === undefined) {
    console.log(`  ✗ 现场 emit 没有产出 ${dtsName}（受检源码或编译选项有问题）`)
    fail++
  } else {
    const dtsDiffs = diffLines(dtsEmit, readFileSync(dtsPath, 'utf8'))
    if (dtsDiffs.length > 0) {
      fail++
      reportDiff('.d.ts', artifact.dts, dtsDiffs)
    } else if (!QUIET) {
      console.log(`  ✓ ${artifact.dts} 与 ${artifact.src} 逐行一致`)
    }
  }
}

if (fail > 0) {
  console.log('')
  console.log(`✗ ${fail} 项产物与源码不一致（Issue F-68）：` +
    '请重建产物（cd vendor/dsh-codearts-auth && pnpm run build）并同步回 files/vendor/dsh-codearts-auth/lib/')
  process.exit(1)
}
console.log('')
console.log('✓ 全部提交产物与源码一致')
