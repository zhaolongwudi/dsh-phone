#!/usr/bin/env node
/**
 * 把「在用模型」胶囊的**客户端**部分移植进 Our Free Model 的 client.js（补丁 E）。
 *
 * 服务端部分见 `patch-capsule-port.mjs`（改渠道包源码）。
 *
 * ## 胶囊是什么
 *
 * 输入区最下方一行实时读数：本次请求**实际发往**的渠道与模型。路由型 provider
 * （`aggregate` / `jet-hub-auto`）在模型选择器里只显示虚拟名，用户看不到真实目标。
 *
 * ## 三处改动
 *
 *   E1. `inject` 增补依赖（slots 已在；补 connection / modelDirectories / sessions /
 *       remote / remote.session —— 后四者是 `ctx.modelDirectories.directoryFor()`
 *       的内部依赖，缺失会在**输入区渲染路径**上抛错，不只影响胶囊）。
 *   E2. 并入组件源码：读胶囊仓库的 `active-model-pill.js`，把它的 ESM 头尾
 *       （`import * as React`、`import { createPortal }`、`export`）改写成
 *       ModuleLoader 内的普通声明 —— OFM 的 client.js 是手写 bundle，`React`
 *       与 `ReactDOM` 已在作用域内，无需再导入。
 *   E3. 注册槽位 `conversation.composer.dock`（官方 activity/usage 两枚胶囊也在
 *       这个槽位，order 0/1；本胶囊取 order 2）。
 *
 * ## ⚠️ 注入必须**惰性**
 *
 * `ctx.modelDirectories.directoryFor(sessionId)` 内部要访问 `remote.session`。
 * 若在槽位 `inject` 期就求值，桌面版会抛 `cannot get property "remote.session"
 * without inject` —— 而它发生在**会话输入区渲染的同步路径**上，后果是**模型选择器
 * 整个点不动**，远不止「胶囊不显示」（真机事故 2026-10-02）。故交出的是取值函数
 * `resolveDirectory()`，由组件在自己的 effect 里调用并自行 try/catch。
 *
 * 用法：
 *   node patch-capsule-client.mjs --check
 *   node patch-capsule-client.mjs --apply
 *   node patch-capsule-client.mjs --revert
 */
import fs from 'node:fs';
import path from 'node:path';

/** 本脚本所在目录（`_ofm/`）—— 固化素材放在它下面，避免依赖会被清理的 /tmp。 */
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const INSTALLED = path.join(HOME, 'profiles/phone/node_modules/dsh-our-free-model');
const PLUGIN_DIRS = [LOCAL, INSTALLED];

/**
 * 胶囊仓库里的组件源码（ESM）。
 *
 * ⚠️ 候选路径列表，**按序取第一个存在的**（2026-10-16 修）：原先只认
 * `/tmp/capsule-repo/...`，而那是**会被系统清理的临时目录** —— 一旦被清，
 * 本补丁就再也跑不起来（而它是补丁 E 的唯一来源）。
 * 现在优先取**工作区里固化的那份**（`_ofm/capsule-src/`，与 /tmp 原件逐字节相同，
 * sha256 已核对），/tmp 退为兜底。
 */
const PILL_SRC = [
  path.join(HERE, 'capsule-src/client/active-model-pill.js'),
  '/data/data/com.dshphone/files/tmp/capsule-repo/files/vendor/dsh-providers-hub/plugin-src/client/active-model-pill.js',
].find((p) => fs.existsSync(p));

const E_MARK_INJECT = 'patch E: inject';
const E_MARK_PILL = 'patch E: pill';
const E_MARK_SLOT = 'patch E: slot';

/** E1：inject 增补依赖。 */
const INJECT_FROM = `const inject = ['slots', 'locale']`;
const INJECT_TO = `// patch E: inject —— 补上胶囊需要的服务。
// connection: 调渠道包的 router.activeRoute（走 /api/jet-hub，与渠道页同一通道）
// modelDirectories + sessions/remote/remote.session: ctx.modelDirectories.directoryFor()
// 的内部依赖，缺了会在输入区渲染路径上抛错（不只影响胶囊）。
const inject = ['slots', 'locale', 'connection', 'modelDirectories', 'sessions', 'remote', 'remote.session']`;

/** E3：槽位注册（插在 apply 里的槽位注册区）。 */
const SLOT_ANCHOR = `      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({`;

const SLOT_TO = `      // ── patch E: slot ─────────────────────────────────────────────────────
      // 「在用模型」胶囊：输入区最下方显示本次请求实际发往的渠道与模型。
      // 与官方 activity/usage 两枚胶囊同槽位（它们 order 0/1，本胶囊 2）。
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'our-free-model-active-model',
        order: 2,
        locale: NS,
        inject: (sessionId) => ({
          // ⚠️⚠️ 必须惰性取目录：在 inject 期求值会让**整个输入区**渲染中断
          //（真机事故 2026-10-02，详见文件头）。失败由组件自身 try/catch 兜住。
          resolveDirectory: () => {
            const directory = ctx.modelDirectories.directoryFor(sessionId)
            return { store: directory.store, load: () => directory.load() }
          },
          // ⚠️ 纯内存读、零网络（服务端如此），故可按 5 秒轮询。失败安静降级为
          //    无读数（胶囊显示占位），不弹错 —— 它是可选装饰。
          readActiveRoute: async (provider) => {
            const connection = ctx.connection
            if (connection?.rpc?.call === undefined) return null
            const result = await connection.rpc.call('/api', 'jet-hub', {
              method: 'router.activeRoute',
              payload: { provider },
            })
            return result?.ok === true ? result.value : null
          },
          providerLabel: (id) => CHANNEL_LABELS[id] ?? id,
        }),
      }, ActiveModelPill))
      // ─────────────────────────────────────────────────────────────────────

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({`;

/** E2：把胶囊组件源码改写成 ModuleLoader 内的普通声明。 */
function pillSource() {
  if (!fs.existsSync(PILL_SRC)) throw new Error(`找不到胶囊组件源码：${PILL_SRC}`);
  let src = fs.readFileSync(PILL_SRC, 'utf8');
  src = src.replace(/^import \* as React from 'react';\s*$/m, '');
  src = src.replace(/^import \{ createPortal \} from 'react-dom';\s*$/m, '');
  // createPortal 在 ModuleLoader 里从 ReactDOM 取（React 本身已在作用域）。
  src = src.replace(/\bcreatePortal\(/g, 'ReactDOM.createPortal(');
  src = src.replace(/^export (function|const|class) /gm, '$1 ');
  return `    // ── patch E: pill ─────────────────────────────────────────────────────
    // 「在用模型」胶囊组件。源码来自胶囊仓库（见 patch-capsule-client.mjs 文件头），
    // 此处已把 ESM 头尾改写成 ModuleLoader 内的普通声明：React / ReactDOM / h
    // 都在本模块作用域内，无需再导入。
    // 渠道 id → 展示名（胶囊的上行文案）。
    const CHANNEL_LABELS = Object.freeze(Object.fromEntries(
      CHANNEL_PROVIDERS.map(row => [row.id, row.name]),
    ))
${src}
    // ─────────────────────────────────────────────────────────────────────
`;
}

const PILL_ANCHOR = `    function apply(ctx) {`;

const E_MARKS = [E_MARK_INJECT, E_MARK_PILL, E_MARK_SLOT];
const targets = () => PLUGIN_DIRS.map((d) => path.join(d, 'client.js'));

const mode = process.argv[2] || '--check';

function stateOf(src) {
  return {
    inject: src.includes(E_MARK_INJECT),
    pill: src.includes(E_MARK_PILL),
    slot: src.includes(E_MARK_SLOT),
  };
}

if (mode === '--check') {
  const pill = pillSource();
  console.log(`胶囊组件源码：${PILL_SRC}`);
  console.log(`  改写后 ${pill.length} 字符`);
  for (const f of targets()) {
    if (!fs.existsSync(f)) { console.log(`缺失  ${f}`); continue; }
    const s = stateOf(fs.readFileSync(f, 'utf8'));
    const all = s.inject && s.pill && s.slot;
    console.log(`${all ? '已打补丁' : '未打补丁'}  E(inject=${s.inject} pill=${s.pill} slot=${s.slot})  ${f}`);
  }
  process.exit(0);
}

if (mode === '--revert') {
  for (const f of targets()) {
    const bak = `${f}.pre-patch-e`;
    if (!fs.existsSync(bak)) { console.log(`无备份，跳过  ${f}`); continue; }
    fs.copyFileSync(bak, f);
    console.log(`已还原  ${f}`);
  }
  process.exit(0);
}

const pill = pillSource();
let changed = 0;
for (const f of targets()) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
  let src = fs.readFileSync(f, 'utf8');
  const st = stateOf(src);
  if (st.inject && st.pill && st.slot) { console.log(`补丁 E 已在，跳过  ${f}`); continue; }
  if (!fs.existsSync(`${f}.pre-patch-e`)) fs.copyFileSync(f, `${f}.pre-patch-e`);

  // E1
  if (!st.inject) {
    const n = src.split(INJECT_FROM).length - 1;
    if (n !== 1) throw new Error(`${f}: E1 锚点命中 ${n} 次（应为 1）—— 上游结构可能已变`);
    src = src.replace(INJECT_FROM, INJECT_TO);
  }
  // E2：插在 apply 之前（组件是模块级声明）
  if (!st.pill) {
    const n = src.split(PILL_ANCHOR).length - 1;
    if (n !== 1) throw new Error(`${f}: E2 锚点命中 ${n} 次（应为 1）—— 上游结构可能已变`);
    src = src.replace(PILL_ANCHOR, `${pill}\n${PILL_ANCHOR}`);
  }
  // E3：插在 settings.onboarding 注册之前
  if (!st.slot) {
    const n = src.split(SLOT_ANCHOR).length - 1;
    if (n !== 1) throw new Error(`${f}: E3 锚点命中 ${n} 次（应为 1）—— 上游结构可能已变`);
    src = src.replace(SLOT_ANCHOR, SLOT_TO);
  }
  fs.writeFileSync(f, src);
  changed += 1;
  console.log(`已打补丁 E（inject+pill+slot）  ${f}`);
}
console.log(`\n完成：改动 ${changed} 个文件。回滚：node patch-capsule-client.mjs --revert`);