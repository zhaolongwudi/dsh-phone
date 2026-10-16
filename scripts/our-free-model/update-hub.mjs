#!/usr/bin/env node
/**
 * 更新 dsh-providers-hub（Jet Hub）到 npm 最新发布版。
 *
 * 上游：https://registry.npmjs.org/dsh-providers-hub  （发布者 weiyou）
 *   同源项目另有一个旧包名 dsh-codearts-auth（同一发布者，早期版本线）。
 *
 * 安装位置（两处逐文件一致，必须同步更新）：
 *   $DSH_HOME/profiles/phone/node_modules/dsh-providers-hub   ← profile 依赖，运行时加载
 *   $TREE/node_modules/dsh-providers-hub                       ← 内核 node_modules 侧的同名副本
 *
 * 三个集成点会在安装前被校验（它们被手机上的其它插件依赖）：
 *   1. RPC 端点名必须是 'jet-hub'  —— our-free-model 渠道页（patch C）按它取数
 *   2. 网关默认端口必须是 8326     —— dsh-phone-account 的 chatgpt 页、dsh-peer 都指向它
 *   3. 渠道页需要的 19 个 RPC 方法必须全部存在
 *
 * 用法：
 *   node update-hub.mjs --check      # 只对比本地版本与 npm 最新版
 *   node update-hub.mjs --apply      # 下载 → 校验 → 备份 → 装到两处 → 验证
 *   node update-hub.mjs --rollback   # 从最近一次备份还原
 *
 * 注意：这本工具装的是 npm 原版。手机上前一份曾带「在用模型胶囊」定制
 * （lib/active-route.js 等），按用户 2026-10-16 的决定不再保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PKG = 'dsh-providers-hub';
const DSH_HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const TREE = process.env.DSH_TREE || '/data/data/com.dshphone/files/tree';
const WORK = '/storage/emulated/0/Download/dsh/ai/_ofm';
const STAMP = path.join(WORK, '.hub-upstream.json');

const TARGETS = [
  path.join(DSH_HOME, 'profiles/phone/node_modules', PKG),
  path.join(TREE, 'node_modules', PKG),
];
const BACKUP_ROOT = path.join(DSH_HOME, 'hub-update-backup');

/** 渠道页依赖的 RPC 方法（缺一个就会出现空卡片或报错）。 */
const REQUIRED_METHODS = [
  'account.create', 'account.delete', 'account.list', 'account.refresh', 'account.test', 'account.update',
  'credits.balances', 'credits.claimAll', 'credits.status',
  'gateway.getEnabled', 'gateway.setEnabled', 'login.poll',
  'model.list', 'model.setAllDisabled', 'model.setDisabled',
  'provider.status', 'usage.autoCheckin', 'usage.tokenLedger', 'usage.tokenLedgerHistory',
];

const mode = process.argv[2] || '--check';
const log = (...a) => console.log(...a);

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(TARGETS[0], 'package.json'), 'utf8')).version; }
  catch { return null; }
}

async function fetchMeta() {
  const r = await fetch(`https://registry.npmjs.org/${PKG}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`registry HTTP ${r.status}`);
  const j = await r.json();
  const latest = j['dist-tags']?.latest;
  const v = j.versions?.[latest];
  if (!latest || !v) throw new Error('registry 未返回 latest 版本');
  return { latest, tarball: v.dist.tarball, integrity: v.dist.integrity, shasum: v.dist.shasum };
}

async function check() {
  const meta = await fetchMeta();
  const cur = localVersion();
  log(`本地已装 : ${cur ?? '（未安装）'}   ${TARGETS[0]}`);
  log(`npm 最新 : ${meta.latest}`);
  log(`tarball  : ${meta.tarball}`);
  log(`integrity: ${meta.integrity}`);
  if (cur === meta.latest) { log('\n已是最新，无需更新。'); return { meta, cur }; }
  log(`\n→ 可更新：${cur ?? '(无)'} → ${meta.latest}`);
  return { meta, cur };
}

/** 下载并核对 registry 声明的 sha512 / sha1。 */
async function download(meta) {
  fs.mkdirSync(path.join(WORK, '_hubcheck'), { recursive: true });
  const tgz = path.join(WORK, '_hubcheck', `${PKG}-${meta.latest}.tgz`);
  const r = await fetch(meta.tarball, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(tgz, buf);

  const sha512 = 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  const ok512 = !meta.integrity || sha512 === meta.integrity;
  const ok1 = !meta.shasum || sha1 === meta.shasum;
  log(`下载完成 ${(buf.length / 1024).toFixed(0)} KB`);
  log(`  sha512 校验: ${meta.integrity ? (ok512 ? '一致' : `不一致！期望 ${meta.integrity}`) : '（registry 未提供）'}`);
  log(`  sha1   校验: ${meta.shasum ? (ok1 ? '一致' : '不一致！') : '（registry 未提供）'}`);
  if (!ok512 || !ok1) throw new Error('包完整性校验失败，拒绝安装');
  return { tgz, bytes: buf.length, sha512 };
}

/**
 * 在目录树里按正则收集匹配（设备自带的 grep 在某些文件上会静默返回空，
 * 因此校验一律用 node 自己读文件）。
 */
function scan(dir, re) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...scan(p, re)); continue; }
    if (!e.name.endsWith('.js')) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(re)) out.push(m[0]);
  }
  return out;
}

/** 解压后校验三个集成点，任一不满足就拒绝安装。 */
function verifyPayload(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.name !== PKG) throw new Error(`包名不符：${pkg.name} ≠ ${PKG}`);

  const endpoints = scan(path.join(dir, 'lib'), /JET_HUB_ENDPOINT = ['"][a-z-]+['"]/g);
  if (!endpoints.some((e) => e.includes("'jet-hub'"))) {
    throw new Error(`集成点 1 失败：RPC 端点不再是 jet-hub（${endpoints.join(', ') || '未找到'}）`);
  }

  const ports = scan(path.join(dir, 'lib/openai-gateway'), /DEFAULT_GATEWAY_PORT = \d+/g);
  if (!ports.some((p) => p.endsWith('8326'))) {
    throw new Error(`集成点 2 失败：网关默认端口不再是 8326（${ports.join(', ') || '未找到'}）`);
  }

  const methods = scan(path.join(dir, 'lib'), /case ['"][a-zA-Z.]+['"]/g);
  const have = new Set(methods.map((l) => l.replace(/^case ['"]|['"]$/g, '')));
  const missing = REQUIRED_METHODS.filter((m) => !have.has(m));
  if (missing.length) throw new Error(`集成点 3 失败：渠道页需要的方法缺失 → ${missing.join(', ')}`);

  log(`集成点校验通过：端点 jet-hub / 端口 8326 / 19 个必需方法齐全（新版共 ${have.size} 个 case 方法）`);
  return pkg;
}

function backup(version) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, `${stamp}-${version ?? 'unknown'}`);
  fs.mkdirSync(dir, { recursive: true });
  const names = ['profile', 'tree'];
  TARGETS.forEach((t, i) => {
    if (!fs.existsSync(t)) return;
    execFileSync('tar', ['czf', path.join(dir, `${names[i]}-${PKG}.tgz`), '-C', path.dirname(t), PKG]);
    log(`  已备份 ${names[i]} → ${names[i]}-${PKG}.tgz`);
  });
  // 账号池、用量账本、签到状态、模型黑名单都在这一个目录里；新版可能迁移 schema，
  // 所以与插件目录一起备份，回滚时一并还原。
  const dataDir = path.join(DSH_HOME, 'jet-hub');
  if (fs.existsSync(dataDir)) {
    execFileSync('tar', ['czf', path.join(dir, 'data-jet-hub.tgz'), '-C', DSH_HOME, 'jet-hub']);
    log('  已备份数据目录 jet-hub → data-jet-hub.tgz（账号池/账本/签到状态）');
  }
  fs.writeFileSync(path.join(dir, 'META.json'), JSON.stringify({ version, at: new Date().toISOString(), targets: TARGETS }, null, 2));
  log(`备份目录：${dir}`);
  return dir;
}

function installFrom(dir) {
  for (const t of TARGETS) {
    const parent = path.dirname(t);
    if (!fs.existsSync(parent)) { log(`  跳过（父目录不存在）${parent}`); continue; }
    const staging = `${t}.staging-${Date.now()}`;
    fs.cpSync(dir, staging, { recursive: true });
    if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
    fs.renameSync(staging, t);
    log(`  已安装 → ${t}`);
  }
}

function rollback() {
  const dirs = fs.existsSync(BACKUP_ROOT)
    ? fs.readdirSync(BACKUP_ROOT).filter((d) => fs.statSync(path.join(BACKUP_ROOT, d)).isDirectory()).sort()
    : [];
  if (!dirs.length) throw new Error(`没有可用备份：${BACKUP_ROOT}`);
  const latest = dirs[dirs.length - 1];
  const dir = path.join(BACKUP_ROOT, latest);
  log(`从备份还原：${dir}`);
  const names = ['profile', 'tree'];
  TARGETS.forEach((t, i) => {
    const tgz = path.join(dir, `${names[i]}-${PKG}.tgz`);
    if (!fs.existsSync(tgz)) { log(`  跳过（无备份）${names[i]}`); return; }
    if (fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
    execFileSync('tar', ['xzf', tgz, '-C', path.dirname(t)]);
    log(`  已还原 ${names[i]}`);
  });
  const dataTgz = path.join(dir, 'data-jet-hub.tgz');
  if (fs.existsSync(dataTgz)) {
    const dataDir = path.join(DSH_HOME, 'jet-hub');
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    execFileSync('tar', ['xzf', dataTgz, '-C', DSH_HOME]);
    log('  已还原数据目录 jet-hub（账号池/账本/签到状态）');
  }
  log('还原完成，重启 DSH 生效。');
}

async function apply() {
  const { meta, cur } = await check();
  if (cur === meta.latest) return;

  log('\n[1/5] 下载并校验…');
  const dl = await download(meta);

  log('\n[2/5] 解压并校验集成点…');
  const stage = path.join(WORK, '_hubcheck', `stage-${meta.latest}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  execFileSync('tar', ['xzf', dl.tgz, '-C', stage]);
  const inner = path.join(stage, 'package');
  if (!fs.existsSync(inner)) throw new Error('解压结果缺少 package/ 目录');
  const pkg = verifyPayload(inner);

  log('\n[3/5] 备份现有安装…');
  backup(cur);

  log('\n[4/5] 安装到两处…');
  installFrom(inner);

  log('\n[5/5] 复核…');
  const now = localVersion();
  if (now !== meta.latest) throw new Error(`安装后版本仍为 ${now}，预期 ${meta.latest}`);
  log(`  两处版本已更新为 ${now}`);

  const stamp = {
    package: PKG,
    registry: `https://registry.npmjs.org/${PKG}`,
    version: meta.latest,
    tarball: meta.tarball,
    integrity: meta.integrity,
    sha512: dl.sha512,
    installedAt: new Date().toISOString(),
    targets: TARGETS,
    note: '本工具安装的是 npm 原版；在用模型胶囊定制（lib/active-route.js）按用户决定不再保留。',
  };
  fs.writeFileSync(STAMP, JSON.stringify(stamp, null, 2));

  log(`\n完成：${cur} → ${now}`);
  log('重启 DSH 应用后生效。回滚：node update-hub.mjs --rollback');
}

if (mode === '--apply') await apply();
else if (mode === '--rollback') rollback();
else await check();