#!/usr/bin/env node
/**
 * 把 dsh-our-free-model 安装进手机版 DSH 的 phone profile。
 *
 * 用法：
 *   node install-to-phone.mjs --dry-run     # 只检查，不写任何文件
 *   node install-to-phone.mjs --install     # 备份 → 拷贝 → 改 profile → 校验
 *   node install-to-phone.mjs --uninstall   # 从 profile 摘除并恢复备份
 *   node install-to-phone.mjs --status      # 当前安装状态
 *
 * 只改两处：profiles/phone/node_modules/dsh-our-free-model（新增目录）
 *          profiles/phone/package.json（dependencies + dsh.profile.bundles）
 * 每次写 package.json 前先备份为 package.json.bak-<时间戳>。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DSH_HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const PROFILE = path.join(DSH_HOME, 'profiles', 'phone');
const PKG_JSON = path.join(PROFILE, 'package.json');
const TARGET = path.join(PROFILE, 'node_modules', 'dsh-our-free-model');
const SOURCE = process.env.OFM_SOURCE || '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const DSH_BIN = '/data/data/com.dshphone/files/tree/node_modules/@deepseek-ai/dsh/lib/bin.js';
const NODE = process.execPath;
const PKG_NAME = 'dsh-our-free-model';
const ENTRY_ID = 'our-free-model';

const mode = process.argv[2] || '--status';
const log = (...a) => console.log(...a);

/** 覆盖/删除前的护栏：目标必须确实位于 phone profile 之内。 */
function assertInsideProfile(p) {
  const rel = path.relative(PROFILE, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`拒绝操作 profile 之外的路径: ${p}`);
}

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
}

function upstreamStamp() {
  try { return JSON.parse(fs.readFileSync(path.join(SOURCE, '.ofm-upstream.json'), 'utf8')); }
  catch { return null; }
}

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version; }
  catch { return null; }
}

function status() {
  const stamp = upstreamStamp();
  const vers = installedVersion();
  const registered = fs.existsSync(PKG_JSON) && readPkg().dsh.profile.bundles.includes(PKG_NAME);
  const dep = fs.existsSync(PKG_JSON) && !!readPkg().dependencies?.[PKG_NAME];
  log(`profile         : ${PROFILE}`);
  log(`本地上游副本     : ${SOURCE}`);
  log(`  上游版本/提交  : ${stamp ? `${stamp.version} @ ${stamp.commit.slice(0, 8)} (${stamp.date})` : '未取到 .ofm-upstream.json'}`);
  log(`profile 已安装   : ${vers ? `是，version=${vers}` : '否'}`);
  log(`bundle 已登记    : ${registered ? '是' : '否'}`);
  log(`dependencies 登记: ${dep ? '是' : '否'}`);
  if (vers && stamp && vers !== stamp.version) log(`→ 有更新：已装 ${vers} → 上游 ${stamp.version}`);
  return { stamp, vers, registered, dep };
}

function verifyProfile() {
  // 用真实内核跑 --dump-config，确认只有一条 our-free-model 且 profile 可解析
  const out = execFileSync(NODE, [DSH_BIN, '--profile', 'phone', '--dump-config'], {
    env: { ...process.env, DSH_HOME }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const hits = out.split('\n').filter((l) => l.includes(`id: ${ENTRY_ID}`)).length;
  log(`dump-config 中 ${ENTRY_ID} 条目数: ${hits}（应为 1）`);
  if (hits !== 1) throw new Error(`bundle 组合不正确：期望 1 条，实际 ${hits} 条`);
  return true;
}

function install() {
  const s = status();
  if (!fs.existsSync(SOURCE)) throw new Error(`本地上游副本不存在: ${SOURCE}`);
  if (!fs.existsSync(PKG_JSON)) throw new Error(`profile 不存在: ${PKG_JSON}`);

  // 1) 备份 profile 清单
  const stampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${PKG_JSON}.bak-${stampStr}`;
  fs.copyFileSync(PKG_JSON, backup);
  log(`已备份 profile 清单 → ${path.basename(backup)}`);

  // 2) 覆盖插件目录（旧目录先改名留档）
  assertInsideProfile(TARGET);
  if (fs.existsSync(TARGET)) {
    const old = `${TARGET}.bak-${stampStr}`;
    fs.renameSync(TARGET, old);
    log(`旧版本留档 → ${path.basename(old)}`);
  }
  fs.cpSync(SOURCE, TARGET, { recursive: true });
  fs.rmSync(path.join(TARGET, '.ofm-upstream.json'), { force: true });
  const files = fs.readdirSync(TARGET).length;
  log(`已拷贝插件 → ${TARGET}（顶层 ${files} 项）`);

  // 3) 登记进 profile
  const pkg = readPkg();
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[PKG_NAME] = `file:./node_modules/${PKG_NAME}`;
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME);
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');
  log(`已登记 dependencies[${PKG_NAME}] 与 bundles`);

  // 4) 校验
  verifyProfile();
  log(`\n安装完成：v${installedVersion()}`);
  log('注意：正在运行的 dsh web 不会自动加载它，需要重启 DSH 应用后生效。');
}

function uninstall() {
  const pkg = readPkg();
  delete pkg.dependencies?.[PKG_NAME];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
  const backup = `${PKG_JSON}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(PKG_JSON, backup);
  fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');
  log(`已从 profile 摘除（清单备份 ${path.basename(backup)}）`);
  if (fs.existsSync(TARGET)) {
    assertInsideProfile(TARGET);
    fs.rmSync(TARGET, { recursive: true, force: true });
    log('已删除插件目录。插件数据在 DSH_HOME/our-free-model，如需彻底清理可另行删除。');
  }
  verifyProfile();
}

switch (mode) {
  case '--dry-run':
    status();
    log('\n(演练模式，未写入任何文件)');
    break;
  case '--install':
    install();
    break;
  case '--uninstall':
    uninstall();
    break;
  case '--status':
    status();
    break;
  default:
    log('用法: --dry-run | --install | --uninstall | --status');
    process.exitCode = 2;
}