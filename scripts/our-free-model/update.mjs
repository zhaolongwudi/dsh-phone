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

console.log('\n[1/7] 拉取上游发布文件…');
run('fetch-release.mjs');
console.log('\n[2/7] 重放手机版移植补丁（禁用重复的渠道包 + 锁 managed 自升级）…');
run('patch-phone-port.mjs', ['--apply']);
// ⚠️ 顺序是**有约束的**：F 的锚点 `function apply(ctx) {` 由 phone-port 的 C 改写；
//    G 也依赖同一锚点，故必须排在 F 之后；H 改的是 F/G 都不碰的聚合面板纯函数，
//    但它在 F 的 IIFE 里（`isRejected` 那一层），所以同样排在 F 之后。
console.log('\n[3/7] 重放「用量徽标」补丁 F …');
run('patch-badge-port.mjs', ['--apply']);
// ⚠️ J 改的正是 F 注入的那段徽标读数（`readActiveProvider`）⇒ 必须排在 F 之后。
console.log('\n[3.5/7] 重放「徽标读数双端点回退」补丁 J …');
run('patch-badge-fallback.mjs', ['--apply']);
console.log('\n[4/7] 重放「老 Jet Hub 设置页」补丁 G …');
run('patch-jet-hub-ui.mjs', ['--apply']);
console.log('\n[5/7] 重放「聚合候选三态」补丁 H …');
run('patch-aggregate-toggle.mjs', ['--apply']);
// ⚠️ I **必须排在 H 之后**：I 把 H 改的那两块（纯函数 + AggregatePanel）整块换成
//    gitee 排序版，而 gitee 版**已包含** H 的全部三态语义（含 `expiryWired === false`
//    分支）。⇒ 打完 I 后 H 的标记消失是**正常**的：H 的自检会把这种状态识别为
//    「已被补丁 I 取代」并跳过，不再报锚点错。
console.log('\n[6/7] 重放「聚合排序/拖动」补丁 I …');
run('patch-aggregate-ordering.mjs', ['--apply']);
console.log('\n[7/7] 安装进 phone profile…');
run('install-to-phone.mjs', ['--install']);
console.log('\n完成。重启 DSH 应用后生效。');