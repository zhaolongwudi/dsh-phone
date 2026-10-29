#!/usr/bin/env node
/**
 * 插件清单 peer 版本门禁（构建期离线自检）。
 *
 * ## 防的是什么
 *
 * 2026-10-14 引擎 alpha.1→alpha.2 升级事故：`vendor/dsh-providers-hub/package.json` 的
 * `peerDependencies` 仍精确钉 `0.2.1-alpha.1`，被引擎的精确版本门禁判「不兼容」，
 * **静默跳过整个 profile bundle**（启动日志仅一行）。设备上 Jet Hub 整块消失，
 * 而构建、类型检查、单测**全绿** —— 因为门禁只在**运行期**生效。
 *
 * ## 为什么是「扫描」而不是「逐条列举」
 *
 * 逐条列举只能防住已经踩过的那一个包。成因是普遍的：**任何**会被引擎当插件加载的包，
 * 只要 `@deepseek-ai/dsh*` 的 peer 钉了精确旧版，就会撞同一条门禁。
 * 故本脚本扫 `runtime/package.json` 的全部 `file:` 依赖（= `build-assets.py` 打进 APK
 * 的插件集合），对每个清单跑**同一条判定**。
 *
 * ## 判定权威从哪来
 *
 * 优先用**引擎自己的** `evaluatePluginCompatibility`（`dsh-app-boot` 的导出）——
 * 复用真判据，不自己实现 semver，避免「验证手段本身不可信」。
 * CI 环境没有引擎树时降级为等价的内联判定（semver + includePrerelease），
 * 并在输出里**显式标注**用的是哪条路径。
 *
 * ## 用法
 *
 *   node scripts/check-plugin-peers.mjs                     # 用 runtime/ 的清单（构建期）
 *   node scripts/check-plugin-peers.mjs --tree <dsh树根>     # 另外校验设备树上的实际值
 *   node scripts/check-plugin-peers.mjs --self-test          # 反向验证本脚本有判别力
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TREE = arg('--tree', process.env.DSH_TREE || '');
const SELF_TEST = args.includes('--self-test');

const root = process.cwd();
const RUNTIME_PKG = path.join(root, 'runtime/package.json');
if (!fs.existsSync(RUNTIME_PKG)) {
  console.error(`::error::找不到 ${path.relative(root, RUNTIME_PKG)}`);
  process.exit(1);
}

// ── 判定权威：优先用引擎自身的判据 ───────────────────────────────────────────
let engineJudge = null;
let judgeSource = '';
const CANDIDATE_ROOTS = [
  TREE && path.join(TREE, 'node_modules'),
  path.join(root, 'runtime/node_modules'),
  path.join(root, 'node_modules'),
].filter(Boolean);
for (const nm of CANDIDATE_ROOTS) {
  const bootDir = path.join(nm, '@deepseek-ai/dsh-app-boot');
  if (!fs.existsSync(path.join(bootDir, 'package.json'))) continue;
  try {
    const req = createRequire(path.join(bootDir, 'package.json'));
    const bootPath = req.resolve('@deepseek-ai/dsh-app-boot');
    const mod = await import(`file://${bootPath}`);
    if (typeof mod.evaluatePluginCompatibility === 'function') {
      engineJudge = mod;
      judgeSource = `引擎自身判据（${path.relative(root, bootDir) || bootDir}）`;
      break;
    }
  } catch { /* 继续尝试下一个候选 */ }
}

// 降级：内联等价判定（与 app-boot 的 evaluatePluginCompatibility 同一逻辑）。
// ⚠️ semver 的取用顺序是关键：**仓库自带的 pnpm 里就带一份 semver**
//    （`runtime/tools/pnpm/dist/node_modules/semver`，随仓库提交、无需 install），
//    故 CI 在 `pnpm install` **之前** 跑本脚本也能拿到真 semver。
//    绝不能用「精确串比对」兜底：那会把 noema 的 `^0.2.1-alpha.1` 误判成失配
//    ⇒ 构建期**假红**（本项目反复记录的「验证手段本身不可信」）。
const semver = (() => {
  const req = createRequire(path.join(root, 'package.json'));
  const candidates = [
    path.join(root, 'runtime/tools/pnpm/dist/node_modules/semver'), // 仓库自带，永远在
    path.join(root, 'runtime/node_modules/semver'),
    path.join(root, 'node_modules/semver'),
    'semver',
  ];
  for (const c of candidates) {
    try { const m = req(c); if (typeof m?.satisfies === 'function') return m; } catch { /* 下一个 */ }
  }
  return null;
})();

function inlineJudge(manifest, runtimeVersion) {
  const peers = {};
  for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range;
    let ok = false;
    try { ok = requirement.trim() !== '' && semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }); }
    catch { ok = false; }
    if (!ok) peers[name] = range;
  }
  return Object.keys(peers).length ? { peers } : undefined;
}

// 判据不可用时**显式报错退出**，而不是退化成会假红的串比对。
if (!engineJudge && semver === null) {
  console.error('::error::插件 peer 判据不可用：既没有引擎树（dsh-app-boot），也找不到 semver');
  console.error('  （期望仓库自带 runtime/tools/pnpm/dist/node_modules/semver 存在）');
  console.error('  这是**判据缺失**，不是插件不兼容——请修复判据来源，勿忽略本条。');
  process.exit(2);
}

// ── 收集待检插件：runtime/package.json 的 file: 依赖 ─────────────────────────
const runtimePkg = JSON.parse(fs.readFileSync(RUNTIME_PKG, 'utf8'));
const runtimeVersion = String(runtimePkg.dependencies?.['@deepseek-ai/dsh'] || '').trim();
if (!runtimeVersion) {
  console.error('::error::runtime/package.json 未声明 @deepseek-ai/dsh 版本');
  process.exit(1);
}
const plugins = Object.entries(runtimePkg.dependencies || {})
  .filter(([, v]) => String(v).startsWith('file:'))
  .map(([name, v]) => ({
    name,
    dir: path.resolve(path.dirname(RUNTIME_PKG), String(v).replace(/^file:/, '')),
  }));

// ── 判定 ─────────────────────────────────────────────────────────────────────
function judge(manifest, label) {
  if (engineJudge) {
    try { return engineJudge.evaluatePluginCompatibility(manifest, {}, runtimeVersion); }
    catch (e) { return { peers: { '<判据抛错>': e.message } }; }
  }
  return inlineJudge(manifest, runtimeVersion);
}

const failures = [];
const checked = [];
for (const { name, dir } of plugins) {
  const mf = path.join(dir, 'package.json');
  if (!fs.existsSync(mf)) { checked.push({ name, skip: '无清单' }); continue; }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); }
  catch (e) { failures.push({ name, reason: `清单不是合法 JSON：${e.message}` }); continue; }
  const issue = judge(manifest, name);
  if (issue !== undefined) {
    failures.push({ name, version: manifest.version, peers: issue.peers });
  }
  checked.push({ name, version: manifest.version, ok: issue === undefined });
}

// ── 自检模式：构造一个坏清单，确认判据真的会红 ───────────────────────────────
if (SELF_TEST) {
  const bad = { name: 'x', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': '0.0.0-nope' } };
  const issue = judge(bad, 'self-test');
  const caught = issue !== undefined;
  console.log(`自检：坏清单是否被判不兼容 = ${caught ? '是（判据有效）' : '否（判据失效！）'}`);
  const good = { name: 'x', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': runtimeVersion } };
  const okGood = judge(good, 'self-test') === undefined;
  console.log(`自检：正确清单是否被判兼容 = ${okGood ? '是' : '否（假红！）'}`);
  process.exit(caught && okGood ? 0 : 1);
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
console.log(`插件 peer 门禁 · 引擎运行时 ${runtimeVersion}`);
console.log(`判定来源：${judgeSource || '内联等价判定（本环境无引擎树）'}`);
console.log(`受检插件：${checked.length} 个（来自 runtime/package.json 的 file: 依赖）`);

// --tree 时额外核对设备/引擎树上的**实际生效值**（胶囊覆盖是否真的铺到了）
let treeMismatch = 0;
if (TREE) {
  for (const { name } of checked) {
    const treeMf = path.join(TREE, 'node_modules', name, 'package.json');
    if (!fs.existsSync(treeMf)) continue;
    let m; try { m = JSON.parse(fs.readFileSync(treeMf, 'utf8')); } catch { continue; }
    const issue = judge(m, name);
    if (issue !== undefined) {
      treeMismatch++;
      console.log(`  ✗ 引擎树 ${name}@${m.version} 仍不兼容：${JSON.stringify(issue.peers)}`);
    }
  }
  if (treeMismatch === 0) console.log(`  ✓ 引擎树上的同名插件全部兼容（${TREE}）`);
}

if (failures.length || treeMismatch) {
  for (const f of failures) {
    console.error(`::error::插件 ${f.name}${f.version ? '@' + f.version : ''} 与引擎 ${runtimeVersion} 不兼容` +
      `（peerDependencies ${JSON.stringify(f.peers)}）—— 会被引擎静默跳过，设备上该插件整块消失` +
      `${f.reason ? '：' + f.reason : ''}`);
  }
  console.error(`\n✗ 失败：${failures.length + treeMismatch} 个插件会被引擎跳过。`);
  console.error('  修复：为对应包新增 .github/capsule/overrides/vendor/<包名>/package.json，');
  console.error(`        把 peerDependencies 里的 @deepseek-ai/dsh* 同步到 ${runtimeVersion}。`);
  process.exit(1);
}
console.log(`\n✓ 通过：全部插件与引擎 ${runtimeVersion} 兼容，不会被静默跳过。`);
