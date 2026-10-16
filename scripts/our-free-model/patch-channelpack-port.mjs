#!/usr/bin/env node
/**
 * 把 Our Free Model 的本地适配施加到渠道包上游源码上（phone-port adapter patch）。
 *
 * ## 为什么需要
 *
 * `vendor/channel-pack` 是 gitee 上游（iJetLi/deepseek-harness-codearts）的拷贝，
 * 但 OFM 对它有**两处本地适配**，上游没有：
 *
 *   1. **网络出口（outlet）**：OFM 的渠道请求要走本插件自己的 egress（代理/指纹），
 *      故上游直接用 fetch 的地方要改成注入 `createChannelFetch()` 的 fetch。
 *      上游**没有** `channel-fetch.ts` 这个文件，它由本脚本从 OFM 侧带过来。
 *   2. **`disableOpencode` 开关**：OFM 自带独立的匿名免费车道，挂载渠道包时
 *      要关掉上游那条重复的 OpenCode 账号接入（含它的匿名通道自动创建）。
 *
 * ## 上游自带、无需移植的部分（已核对）
 *
 * `suppressAutoSettingsPage` / `registerProviderSettings` / `closeAllProxyDispatchers` /
 * `opencodeProxy` —— 上游 index.ts 与 settings-compat.ts 都有同名同签名的实现。
 *
 * ## 幂等
 *
 * 每条改动带**各自的**标记（`mark`）。⚠️ 不能共用一个统一标记：第一条改动一旦
 * 写入，统一标记就会让后续每条都误判成「已存在」而跳过 —— 这是本脚本初版的
 * 真实缺陷（已修）。
 *
 * 用法：
 *   node patch-channelpack-port.mjs <src目录> --check
 *   node patch-channelpack-port.mjs <src目录> --apply
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = 'phone-port adapter';

/** 针对 index.ts 的改动：mark 唯一（幂等判据）；find 必须在源码里恰好出现一次。 */
const EDITS = [
  {
    name: 'import（带过 channel-fetch）',
    mark: `${SITE}: import`,
    find: `import { closeAllProxyDispatchers } from './opencode-proxy.js'`,
    replace: `import { closeAllProxyDispatchers } from './opencode-proxy.js'
// ${SITE}: import —— 本插件的网络出口（见 patch-channelpack-port.mjs）
import { createChannelFetch, type ChannelOutlet } from './channel-fetch.js'`,
  },
  {
    name: 'apply 签名 + 网络层',
    mark: `${SITE}: apply`,
    find: `export function apply(ctx: Context): void {
  // 本插件自带 Jet Hub 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单`,
    replace: `export function apply(ctx: Context, config: { disableOpencode?: boolean; outlet?: ChannelOutlet } = {}): void {
  // ${SITE}: apply —— 渠道请求统一走本插件的出口（代理选择、逐请求 dispatcher），
  // 且不修改宿主全局 fetch。上游没有这一层，故由本适配注入。
  const network = createChannelFetch({ outlet: config.outlet })
  ctx.effect(() => () => { void network.close() })
  // 本插件自带 Jet Hub 设置页，关闭 0.1.7 起由 Config schema 反渲染的自动表单`,
  },
  {
    name: 'cline 注入 fetcher',
    mark: `${SITE}: cline`,
    find: `const cline = new ClineAuth(ctx)`,
    replace: `const cline = new ClineAuth(ctx, { fetcher: network.fetch }) /* ${SITE}: cline */`,
  },
  {
    name: 'gemini 注入 fetchImpl',
    mark: `${SITE}: gemini`,
    find: `const gemini = new GeminiAuth(ctx)`,
    replace: `const gemini = new GeminiAuth(ctx, { fetchImpl: network.fetch }) /* ${SITE}: gemini */`,
  },
  {
    name: 'opencode 段：声明提升 + 开关',
    mark: `${SITE}: opencode-open`,
    find: `  const opencodeUA = lazyOpencodeUserAgent()
  const opencodeAdapter = registerOpencodeLlm(ctx, {`,
    replace: `  // ${SITE}: opencode-open —— OFM 自带匿名免费车道，此处可整段关闭重复接入
  let opencodeAdapter: ReturnType<typeof registerOpencodeLlm> | undefined
  if (config.disableOpencode !== true) {
  const opencodeUA = lazyOpencodeUserAgent()
  opencodeAdapter = registerOpencodeLlm(ctx, {`,
  },
  {
    name: 'opencode 段：闭合',
    mark: `${SITE}: opencode-close`,
    find: `  refreshOpencodeCapabilities(() => { broadcastCatalogChanged(ctx) })`,
    replace: `  refreshOpencodeCapabilities(() => { broadcastCatalogChanged(ctx) })
  } // ${SITE}: opencode-close`,
  },
];

/** 需要从 OFM 侧带过来的文件（上游没有）。 */
const CARRY_FILES = ['channel-fetch.ts'];

/**
 * 针对**带过来的文件**的改动。
 * 上游把 `createProxyDispatcher` 重构成了 `buildProxyDispatcher`（多了 LRU 缓存，
 * 签名不变）。带过来的 channel-fetch.ts 引用旧名，这里用 import 别名对齐，
 * 从而不必改它的调用点。
 */
const CARRY_EDITS = [
  {
    file: 'channel-fetch.ts',
    name: 'channel-fetch：代理 API 改名对齐',
    mark: `${SITE}: proxy-api`,
    find: `import { createProxyDispatcher } from './opencode-proxy.js'`,
    replace: `import { buildProxyDispatcher as createProxyDispatcher } from './opencode-proxy.js' // ${SITE}: proxy-api`,
  },
];

const target = process.argv[2];
const mode = process.argv[3] || '--check';
if (target === undefined) {
  console.error('用法: node patch-channelpack-port.mjs <src目录> [--check|--apply]');
  process.exit(1);
}
const indexPath = path.join(target, 'index.ts');
if (!fs.existsSync(indexPath)) {
  console.error(`找不到 ${indexPath}`);
  process.exit(1);
}

/** 已施加 ⇔ 该条**自己的**标记在源码里。 */
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
  const src = fs.readFileSync(indexPath, 'utf8');
  console.log(`目标：${indexPath}`);
  for (const e of EDITS) {
    const s = stateOf(src, e);
    if (s !== 'todo' && s !== 'marked') bad += 1;
    console.log(`  ${tagOf(s).padEnd(14)} ${e.name}`);
  }
  console.log('\n带过来的文件与针对性改动：');
  for (const f of CARRY_FILES) {
    const p = path.join(target, f);
    if (!fs.existsSync(p)) { console.log(`  ✗ 缺失  ${f}`); bad += 1; continue; }
    console.log(`  已在  ${f}`);
    for (const e of CARRY_EDITS.filter((x) => x.file === f)) {
      const s = stateOf(fs.readFileSync(p, 'utf8'), e);
      if (s !== 'todo' && s !== 'marked') bad += 1;
      console.log(`    ${tagOf(s).padEnd(12)} ${e.name}`);
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}

let changed = 0;
let src = fs.readFileSync(indexPath, 'utf8');
for (const e of EDITS) {
  const s = stateOf(src, e);
  if (s === 'marked') { console.log(`已施加，跳过  ${e.name}`); continue; }
  if (s !== 'todo') {
    console.error(`✗ ${e.name}：锚点状态为 ${s}，拒绝改动（上游结构可能已变）`);
    process.exit(1);
  }
  src = src.replace(e.find, e.replace);
  changed += 1;
  console.log(`已施加  ${e.name}`);
}
if (changed > 0) fs.writeFileSync(indexPath, src);

let carryChanged = 0;
for (const e of CARRY_EDITS) {
  const p = path.join(target, e.file);
  if (!fs.existsSync(p)) { console.error(`✗ 缺少待改文件 ${e.file}`); process.exit(1); }
  const s = fs.readFileSync(p, 'utf8');
  const st = stateOf(s, e);
  if (st === 'marked') { console.log(`已施加，跳过  ${e.name}`); continue; }
  if (st !== 'todo') {
    console.error(`✗ ${e.name}：锚点状态为 ${st}，拒绝改动`);
    process.exit(1);
  }
  fs.writeFileSync(p, s.replace(e.find, e.replace));
  carryChanged += 1;
  console.log(`已施加  ${e.name}`);
}

console.log(`\n完成：index.ts 改动 ${changed} 处，带入文件改动 ${carryChanged} 处 → ${target}`);