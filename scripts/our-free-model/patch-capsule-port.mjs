#!/usr/bin/env node
/**
 * 把「在用模型」胶囊的服务端部分移植进渠道包源码（capsule adapter patch）。
 *
 * ## 胶囊是什么
 *
 * 输入区最下方一行实时读数：显示**本次请求实际发往的渠道与模型**。路由型 provider
 * （`aggregate` / `jet-hub-auto`）在模型选择器里只显示一个**虚拟**名字，用户看不到
 * 真实目标 —— 胶囊回答的正是这个。
 *
 * 原实现见 `/data/data/com.dshphone/files/tmp/capsule-repo/`（它基于 0.2.0-rc.3）。
 * 本脚本把它的**服务端**部分移植到 gitee 上游最新版上；客户端部分在
 * `patch-phone-port.mjs` 的补丁 E。
 *
 * ## 服务端要什么
 *
 * 1. `active-route.ts`（新文件，零依赖）—— 进程内读数表 `activeRoutes`；
 * 2. 两个路由适配器在**转发一开始**写它；
 * 3. 一个 RPC 端点 `router.activeRoute` 供客户端读。
 *
 * ## ⚠️ 为什么不能复用已有的 `aggregate.activeProvider`
 *
 * 那条**只在整轮跑完且成功时**写（它服务于**余额徽标**：显示一个刚失败、已无额度的
 * 渠道会误导）。而胶囊回答的是「**此刻正在用什么**」—— 长回答要几十秒，等跑完才更新
 * 就失去了实时性。两条判据相反，刻意分开（详见 `active-route.ts` 模块头）。
 *
 * 用法：
 *   node patch-capsule-port.mjs <src目录> --check
 *   node patch-capsule-port.mjs <src目录> --apply
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = 'capsule';

/** 需要放进渠道包 src 的文件：源文件 → 目标文件名。 */
export const CARRY_FILES = [
  {
    name: 'active-route.ts',
    from: '/data/data/com.dshphone/files/tmp/capsule-repo/files/vendor/dsh-codearts-auth/src/active-route.ts',
    note: '进程内读数表（零依赖，从胶囊仓库原样带过）',
  },
];

const IMPORT_LINE = `import { activeRoutes } from './active-route.js'`;

/** 针对渠道包源码的改动。mark 唯一（幂等判据）；find 必须恰好出现一次。 */
const EDITS = [
  {
    file: 'aggregate-adapter.ts',
    name: '聚合适配器：加 import',
    mark: `${SITE}: agg-import`,
    find: `import { WIRED_EXPIRY_PROVIDERS } from './aggregate-expiry.js'`,
    replace: `import { WIRED_EXPIRY_PROVIDERS } from './aggregate-expiry.js'
${IMPORT_LINE} // ${SITE}: agg-import`,
  },
  {
    file: 'aggregate-adapter.ts',
    name: '聚合适配器：转发开始即记录',
    mark: `${SITE}: agg-record`,
    find: `        let pendingProvider: string | undefined`,
    replace: `        let pendingProvider: string | undefined
        // ${SITE}: agg-record —— 在「转发一开始」就记下真实目标（供输入区实时读数）。
        // 与下面 activeProviderByModel 的「只在整轮跑完才写」**判据相反**，这是刻意的：
        // 那张表回答「该看哪个渠道的余额」（写失败候选会误导），本表回答「此刻正在
        // 用什么」（等跑完再写就失去实时性）。每次尝试都覆盖写 —— 失败切换后读数
        // 跟着变，正是「实时」应有的行为。
        activeRoutes.record(AGGREGATE_PROVIDER, target.provider, target.realId)`,
  },
  {
    file: 'auto-adapter.ts',
    name: '自动适配器：加 import',
    mark: `${SITE}: auto-import`,
    find: `import { createExpiryProbe } from './aggregate-expiry.js'`,
    replace: `import { createExpiryProbe } from './aggregate-expiry.js'
${IMPORT_LINE} // ${SITE}: auto-import`,
  },
  {
    file: 'auto-adapter.ts',
    name: '自动适配器：转发开始即记录',
    mark: `${SITE}: auto-record`,
    find: `    this.lastDispatch = {`,
    replace: `    // ${SITE}: auto-record —— 与 lastDispatch 同一时刻写入，供输入区实时读数。
    activeRoutes.record(AUTO_PROVIDER, target.provider, target.model)
    this.lastDispatch = {`,
  },
  {
    file: 'jet-hub-rpc.ts',
    name: 'RPC：加 import',
    mark: `${SITE}: rpc-import`,
    find: `import { createAutoCheckin, createAutoCheckinStore } from './auto-checkin.js'`,
    replace: `import { createAutoCheckin, createAutoCheckinStore } from './auto-checkin.js'
${IMPORT_LINE} // ${SITE}: rpc-import`,
  },
  {
    file: 'jet-hub-rpc.ts',
    name: 'RPC：router.activeRoute 端点',
    mark: `${SITE}: rpc-endpoint`,
    find: `      case 'aggregate.activeProvider': {`,
    replace: `      case 'router.activeRoute': {
        // ${SITE}: rpc-endpoint —— 路由型 provider「**此刻正在用的**真实渠道与模型」。
        //
        // 与 aggregate.activeProvider 的分工（**不要合并成一个端点**）：
        //   aggregate.activeProvider → 上次实际**成功**的渠道，整轮跑完才写（供余额徽标）
        //   本条                     → **本次正在发往**的目标，转发一开始就写（供实时读数）
        // 两者在「请求进行中」必然不同，这是规格如此，不是缺陷。
        //
        // ⚠️ 纯内存读、零网络：客户端按 5 秒轮询它，不能有任何网络成本。
        // ⚠️ 无历史时回 null 而不是报错：胶囊是**可选装饰**，为它报错会让会话输入区
        //    出现无意义的错误（与 aggregate.activeProvider 的安静降级同取向）。
        const asked = (payload as { provider?: unknown } | undefined)?.provider
        const key = typeof asked === 'string' && asked.length > 0 ? asked : 'aggregate'
        const route = activeRoutes.read(key)
        if (route === null) {
          return { ok: true, value: { provider: null, model: null, at: null } }
        }
        return {
          ok: true,
          value: { provider: route.provider, model: route.model, at: route.at },
        }
      }

      case 'aggregate.activeProvider': {`,
  },
];

const target = process.argv[2];
const mode = process.argv[3] || '--check';
if (target === undefined) {
  console.error('用法: node patch-capsule-port.mjs <渠道包 src 目录> [--check|--apply]');
  process.exit(1);
}

const stateOf = (src, edit) => {
  if (src.includes(edit.mark)) return 'marked';
  const n = src.split(edit.find).length - 1;
  if (n === 1) return 'todo';
  if (n === 0) return 'anchor-gone';
  return `ambiguous(${n})`;
};
const tagOf = (s) => (s === 'todo' ? '待施加' : s === 'marked' ? '已施加' : `✗ ${s}`);

if (mode === '--check') {
  let bad = 0;
  console.log(`目标：${target}`);
  for (const e of EDITS) {
    const p = path.join(target, e.file);
    if (!fs.existsSync(p)) { console.log(`  ✗ 缺失文件  ${e.file}`); bad += 1; continue; }
    const s = stateOf(fs.readFileSync(p, 'utf8'), e);
    if (s !== 'todo' && s !== 'marked') bad += 1;
    console.log(`  ${tagOf(s).padEnd(14)} ${e.name}`);
  }
  console.log('\n需要放入的文件：');
  for (const c of CARRY_FILES) {
    const dst = path.join(target, c.name);
    const hasDst = fs.existsSync(dst);
    const hasSrc = fs.existsSync(c.from);
    console.log(`  ${hasDst ? '已在' : hasSrc ? '可从胶囊仓库带入' : '✗ 缺源文件'}  ${c.name}（${c.note}）`);
    if (!hasDst && !hasSrc) bad += 1;
  }
  process.exit(bad > 0 ? 1 : 0);
}

let changed = 0;
// 1) 先放入携带文件（若尚未放入）
for (const c of CARRY_FILES) {
  const dst = path.join(target, c.name);
  if (fs.existsSync(dst)) { console.log(`已在，跳过  ${c.name}`); continue; }
  if (!fs.existsSync(c.from)) {
    console.error(`✗ 缺少源文件：${c.from}`);
    process.exit(1);
  }
  fs.copyFileSync(c.from, dst);
  changed += 1;
  console.log(`已放入  ${c.name}（${c.note}）`);
}

// 2) 施加改动
for (const e of EDITS) {
  const p = path.join(target, e.file);
  if (!fs.existsSync(p)) { console.error(`✗ 缺少文件 ${e.file}`); process.exit(1); }
  const src = fs.readFileSync(p, 'utf8');
  const s = stateOf(src, e);
  if (s === 'marked') { console.log(`已施加，跳过  ${e.name}`); continue; }
  if (s !== 'todo') {
    console.error(`✗ ${e.name}：锚点状态为 ${s}，拒绝改动（上游结构可能已变）`);
    process.exit(1);
  }
  fs.writeFileSync(p, src.replace(e.find, e.replace));
  changed += 1;
  console.log(`已施加  ${e.name}`);
}
console.log(`\n完成：改动 ${changed} 处 → ${target}`);