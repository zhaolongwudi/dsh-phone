#!/usr/bin/env node
/**
 * 一条命令更新两个插件到各自上游的最新版。
 *
 *   node update-all.mjs            # 检查两边，有更新才动
 *   node update-all.mjs --force    # 强制重装两边
 *
 * 编排（各自内部都有版本对比，没更新就跳过）：
 *   1. update.mjs      Our Free Model ← GitHub，随后重放补丁 A/B/C
 *   2. update-hub.mjs  providers-hub ← npm，含 SHA 校验与集成点校验
 *
 * 两边都完成后重启 DSH 应用生效。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes('--force');
const run = (script, extra = []) =>
  execFileSync(process.execPath, [path.join(HERE, script), ...extra], { stdio: 'inherit', cwd: HERE });

console.log('════ [1/2] Our Free Model（上游 GitHub + 补丁 A/B/C）════');
run('update.mjs', force ? ['--force'] : []);

console.log('\n════ [2/2] providers-hub / Jet Hub（上游 npm）════');
run('update-hub.mjs', ['--apply']);

console.log('\n两边都已对齐各自上游。重启 DSH 应用后生效。');
console.log('任一侧出问题可单独回退：');
console.log('  node install-to-phone.mjs --uninstall   # 摘除 Our Free Model');
console.log('  node update-hub.mjs --rollback          # 还原 Jet Hub 与账号数据');