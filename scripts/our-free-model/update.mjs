#!/usr/bin/env node
/**
 * 一键跟进上游：拉取 Ebony-Vinyl/dsh-our-free-model 的最新提交 → 覆盖本地副本 → 装进 phone profile。
 *
 *   node update.mjs              # 检查上游有无更新，有则安装
 *   node update.mjs --force      # 无论版本号是否变化都重装
 *   node update.mjs --check      # 只对比版本/提交，不下载不安装
 *
 * 装完需重启 DSH 应用才生效。回退：node install-to-phone.mjs --uninstall
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = 'Ebony-Vinyl/dsh-our-free-model';
const args = process.argv.slice(2);
const run = (script, extra = []) => execFileSync(process.execPath, [path.join(HERE, script), ...extra], { stdio: 'inherit', cwd: HERE });

const stampPath = path.join(HERE, 'dsh-our-free-model', '.ofm-upstream.json');
const local = (() => { try { return JSON.parse(fs.readFileSync(stampPath, 'utf8')); } catch { return null; } })();

const head = await (await fetch(`https://api.github.com/repos/${REPO}/commits/main`, { headers: { 'User-Agent': 'dsh-ofm-port' } })).json();
console.log(`上游 main : ${head.sha.slice(0, 8)}  ${head.commit.author.date}  ${head.commit.message.split('\n')[0]}`);
console.log(`本地副本 : ${local ? `${local.version} @ ${local.commit.slice(0, 8)}  ${local.date}` : '尚未拉取'}`);

if (args.includes('--check')) {
  const same = local && local.commit === head.sha;
  console.log(same ? '\n已是最新，无需更新。' : '\n有更新可用。');
  process.exit(0);
}
if (local && local.commit === head.sha && !args.includes('--force')) {
  console.log('\n本地副本已是最新提交；如需强制重装请加 --force。');
  process.exit(0);
}

console.log('\n[1/3] 拉取上游发布文件…');
run('fetch-release.mjs');
console.log('\n[2/3] 重放手机版移植补丁（禁用重复的渠道包 + 锁 managed 自升级）…');
run('patch-phone-port.mjs', ['--apply']);
console.log('\n[3/3] 安装进 phone profile…');
run('install-to-phone.mjs', ['--install']);
console.log('\n完成。重启 DSH 应用后生效。');