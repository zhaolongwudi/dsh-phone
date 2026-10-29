// 模块表契约的判别力测试。
//
// 为什么重要：三期配方写的槽位组件（DrawerMask 等）依赖 `react` hooks 与
// `ctx.slots`。这些依赖**只能**从壳侧静态模块表（seed）解析——表里没有就解析失败，
// 而失败形态是「组件静默不渲染」，不是报错。故必须把表当契约守住：
// 上游移除条目时在构建期报红，而不是等设备上发现面板没出来。
//
// 运行：node scripts/ui-tests/module-seed.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_SEED, checkSeed, scanSeed } from '../ui-module-seed.mjs'
import { resolveEngineTree } from './paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name + (extra ? '  ' + extra : '')))
}

const TREE = resolveEngineTree()

/** 造一棵最小引擎树，其 dist 里放指定的模块表。 */
function fakeTree(moduleBody) {
  const d = mkdtempSync(join(tmpdir(), 'seed-'))
  const assets = join(d, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
  mkdirSync(assets, { recursive: true })
  // 模拟压缩产物：调用点在文件尾，定义在别处（与真实产物同形）
  const js = [
    'function xx(){return{type:"blockquote"}}',            // 干扰项：先出现的 return{}
    `function lM(){return{${moduleBody}}}`,
    'const boot=()=>{create({staticModules:lM()})}',
  ].join('\n')
  writeFileSync(join(assets, 'index-test.js'), js)
  return d
}

console.log('基线：真实引擎树上的模块表')
if (!TREE) {
  console.log('  （跳过：本机无引擎树；离线层由 apply.sh 的 --check 覆盖）')
} else {
  const r = checkSeed(TREE)
  check('定位到静态模块表', r.found, String(r.source))
  check('表非空', r.keys.length > 0, String(r.keys.length))
  check('三期必需条目齐全', r.missing.length === 0, r.missing.join(', '))
  check('含 react（有状态组件的前提）', r.keys.includes('react'))
}

console.log('反例 1：干扰项在前 → 必须靠 staticModules 调用点定位，不能误抓第一个 return{}')
{
  const d = fakeTree('react:1,"@deepseek-ai/dsh-client-ui-slots":2')
  const r = scanSeed(d)
  check('未误抓 markdown AST（keys 不含 type）', !r.keys.includes('type'), JSON.stringify(r.keys))
  check('抓到 react', r.keys.includes('react'))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 2：上游移除 react → 必须判缺')
{
  const d = fakeTree('"@deepseek-ai/dsh-client-ui-slots":2,"@deepseek-ai/cordis":3')
  const r = checkSeed(d)
  check('检出缺 react', r.missing.includes('react'), JSON.stringify(r.missing))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 3：必需条目全集缺失 → missing 应覆盖全部必需项')
{
  const d = fakeTree('"some-unrelated-pkg":1')
  const r = checkSeed(d)
  check('missing 覆盖全部必需项',
    Object.keys(REQUIRED_SEED).every(k => r.missing.includes(k)),
    JSON.stringify(r.missing))
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 4：产物缺 dist → 不得抛异常，应如实报「未找到」')
{
  const d = mkdtempSync(join(tmpdir(), 'seed-'))
  const r = scanSeed(d)
  check('无 dist 时返回空表', r.keys.length === 0 && r.source === null)
  rmSync(d, { recursive: true, force: true })
}

console.log('反例 5：完全没有模块表特征的对象 → 不应被当表')
{
  const d = mkdtempSync(join(tmpdir(), 'seed-'))
  const assets = join(d, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'x.js'), 'function f(){return{a:1,b:2}} const q=()=>f()')
  const r = scanSeed(d)
  check('未把无关对象当模块表', r.keys.length === 0, JSON.stringify(r.keys))
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n结果：${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
