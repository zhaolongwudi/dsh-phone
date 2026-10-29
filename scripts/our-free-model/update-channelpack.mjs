#!/usr/bin/env node
/**
 * 从 gitee 上游同步渠道包 → 施加 OFM 适配 → 构建 → 安装。
 *
 * 这是「OFM 自带渠道引擎、不再依赖 Jet Hub」这条路的**唯一入口**。
 * 现状说明见 README.md；每一步为什么这么做，见对应步骤的注释。
 *
 * ## 流程
 *
 *   1. 拉 gitee master 的 src/（fetch-gitee-src.mjs）
 *   2. 补 gitee 用 HTTP 451 屏蔽的文件 —— 从 npm 上游发布版
 *      （dsh-providers-hub）的编译产物里取；上游自己的 index.ts 也引用它
 *   3. 从**当前已装的 OFM** 里带过 channel-fetch.ts（上游没有这个文件）
 *   4. 施加 OFM 的本地适配（patch-channelpack-port.mjs）
 *   5. 用 OFM 的官方构建脚本打包成单文件 pack.js（WASM 版 esbuild）
 *   6. 备份并安装进 OFM 的 vendor/channel-pack/
 *
 * ## 用法
 *
 *   node update-channelpack.mjs --check      # 只报到哪一步、有哪些差集
 *   node update-channelpack.mjs --apply      # 完整同步 + 构建 + 安装
 *   node update-channelpack.mjs --dry-run    # 同步与构建，但不安装
 *
 * 完成后需重启 DSH 应用生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DSH_HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const BUILD = process.env.OFM_BUILD_DIR || '/data/data/com.dshphone/files/ofm-build';
const OFM_DIR = path.join(DSH_HOME, 'profiles/phone/node_modules/dsh-our-free-model');
const CHANNEL_PACK = path.join(OFM_DIR, 'vendor/channel-pack');
const GITEE_SRC = path.join(BUILD, 'gitee-src/src');
const WORK_SRC = path.join(BUILD, 'repo/vendor/channel-pack/src');
const NPM_PKG = 'dsh-providers-hub';
/** gitee 对含 "proxy" 的文件名返回 451（Unavailable For Legal Reasons）。 */
const BLOCKED_FILE = 'opencode-proxy.js';

const mode = process.argv[2] || '--check';
const run = (script, args = []) =>
  execFileSync(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit', cwd: HERE });
const step = (n, t) => console.log(`\n════ [${n}] ${t} ════`);

/** 确认构建前置齐备（WASM esbuild 垫片 + 内联依赖）。 */
function assertBuildEnv() {
  const nm = path.join(BUILD, 'node_modules');
  const need = [
    [path.join(nm, 'esbuild/index.js'), 'esbuild 垫片（指向 esbuild-wasm）'],
    [path.join(nm, 'esbuild-wasm/esbuild.wasm'), 'esbuild-wasm'],
    [path.join(nm, 'jose'), 'jose（内联用）'],
    [path.join(nm, 'undici'), 'undici（内联用）'],
  ];
  const missing = need.filter(([p]) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.error('构建环境不完整：');
    missing.forEach(([, label]) => console.error('  ✗ ' + label));
    console.error(`\n参考 README 第八节搭建 ${BUILD}/node_modules。`);
    process.exit(1);
  }
}

async function main() {
  if (mode === '--check') {
    console.log('渠道包同步链路自检');
    console.log(`  OFM 目录      : ${OFM_DIR} ${fs.existsSync(OFM_DIR) ? '✓' : '✗'}`);
    console.log(`  渠道包目录    : ${CHANNEL_PACK} ${fs.existsSync(CHANNEL_PACK) ? '✓' : '✗'}`);
    console.log(`  当前 pack.js  : ${fs.existsSync(path.join(CHANNEL_PACK, 'pack.js')) ? (fs.statSync(path.join(CHANNEL_PACK, 'pack.js')).size / 1048576).toFixed(2) + ' MiB' : '✗ 缺失'}`);
    console.log(`  构建区        : ${BUILD} ${fs.existsSync(BUILD) ? '✓' : '✗'}`);
    assertBuildEnv();
    console.log('\n上游文件带过来检查（channel-fetch.ts 来自 OFM 现有安装）：');
    console.log(`  ${fs.existsSync(path.join(CHANNEL_PACK, 'src/channel-fetch.ts')) ? '✓ 可带过' : '✗ 现有安装里没有，无法带过'}`);
    console.log('\n下一步：node update-channelpack.mjs --apply');
    return;
  }

  assertBuildEnv();

  step(1, '拉 gitee 上游 src');
  fs.rmSync(path.join(BUILD, 'gitee-src'), { recursive: true, force: true });
  run('fetch-gitee-src.mjs');

  step(2, `补 gitee 屏蔽的文件（${BLOCKED_FILE}）`);
  const npmDir = path.join(BUILD, 'npm-pkg');
  if (!fs.existsSync(path.join(npmDir, 'package/lib', BLOCKED_FILE))) {
    console.log(`  本地没有 ${NPM_PKG} 的发布版，下载中…`);
    execFileSync(process.execPath, ['-e', `
      const fs=require('node:fs');
      (async()=>{
        const r=await fetch('https://registry.npmjs.org/${NPM_PKG}');
        const j=await r.json();
        const v=j['dist-tags'].latest;
        const t=await (await fetch(j.versions[v].dist.tarball)).arrayBuffer();
        fs.writeFileSync('${path.join(BUILD, 'npm-pkg.tgz')}', Buffer.from(t));
        console.log('  已下载 ${NPM_PKG}@'+v);
      })();
    `], { stdio: 'inherit' });
    fs.rmSync(npmDir, { recursive: true, force: true });
    fs.mkdirSync(npmDir, { recursive: true });
    execFileSync('tar', ['xzf', path.join(BUILD, 'npm-pkg.tgz'), '-C', npmDir]);
  }
  console.log(`  ✓ 取自 ${NPM_PKG} 的编译产物`);

  step(3, '组装工作区 src（上游 + 屏蔽文件 + OFM 的适配文件）');
  fs.rmSync(WORK_SRC, { recursive: true, force: true });
  fs.mkdirSync(WORK_SRC, { recursive: true });
  execFileSync('cp', ['-r', GITEE_SRC + '/.', WORK_SRC]);
  execFileSync('cp', [path.join(npmDir, 'package/lib', BLOCKED_FILE), path.join(WORK_SRC, BLOCKED_FILE)]);
  const carry = path.join(CHANNEL_PACK, 'src/channel-fetch.ts');
  if (!fs.existsSync(carry)) {
    console.error(`  ✗ 现有安装里找不到 channel-fetch.ts，无法带过适配文件：${carry}`);
    process.exit(1);
  }
  execFileSync('cp', [carry, path.join(WORK_SRC, 'channel-fetch.ts')]);
  console.log(`  src 文件数：${fs.readdirSync(WORK_SRC).length}（顶层）`);

  step(4, '施加 OFM 本地适配');
  run('patch-channelpack-port.mjs', [WORK_SRC, '--apply']);
  // 胶囊的服务端部分（在用模型实时读数）：active-route.ts + 两处记录 + RPC 端点。
  // 与上一步同一性质 —— 都是「上游没有、OFM 需要」的适配，故一起重放。
  run('patch-capsule-port.mjs', [WORK_SRC, '--apply']);

  step(5, '构建 pack.js');
  execFileSync(process.execPath, ['scripts/build-channel-pack.mjs'], {
    stdio: 'inherit',
    cwd: path.join(BUILD, 'repo'),
  });

  const built = path.join(BUILD, 'repo/vendor/channel-pack/pack.js');
  if (!fs.existsSync(built)) { console.error('  ✗ 构建未产出 pack.js'); process.exit(1); }
  console.log(`  产物：${(fs.statSync(built).size / 1048576).toFixed(2)} MiB`);

  if (mode === '--dry-run') {
    console.log('\n--dry-run：已构建但未安装。');
    return;
  }

  step(6, '安装进 OFM（先备份）');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DSH_HOME, 'channel-pack-backup', stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const oldPack = path.join(CHANNEL_PACK, 'pack.js');
  if (fs.existsSync(oldPack)) {
    execFileSync('cp', [oldPack, path.join(backupDir, 'pack.js')]);
    console.log(`  旧 pack.js 已备份 → ${backupDir}`);
  }
  execFileSync('cp', [built, oldPack]);
  // 源码也同步进安装目录，便于下次带过 channel-fetch.ts 与审计
  const srcDst = path.join(CHANNEL_PACK, 'src');
  fs.rmSync(srcDst, { recursive: true, force: true });
  fs.cpSync(WORK_SRC, srcDst, { recursive: true });
  console.log(`  已安装 pack.js + src/（${fs.readdirSync(srcDst).length} 项）`);

  console.log(`\n完成。重启 DSH 应用后生效。`);
  console.log(`回滚：cp ${path.join(backupDir, 'pack.js')} ${oldPack}`);
}

await main();