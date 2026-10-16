#!/usr/bin/env node
/**
 * 把「用量徽标」的客户端部分移植进 Our Free Model 的 client.js（补丁 F）。
 *
 * ## 徽标是什么
 *
 * 输入框里、**模型选择器左侧**的一枚胶囊（槽位 `conversation.input.right`）：
 *   · 折叠态：`渠道名 • 余额`（如 `OfficeAce • 9002.15积分`）+ 状态圆点
 *   · 点开：渠道名 / 更新时间 / ↻刷新 / 自动签到开关 / 显示偏好 / 逐账号积分明细 / 签到
 *   · 当前选中 `aggregate` 时，先解析出**真实渠道**，再显示那个渠道的积分。
 *
 * Jet Hub 退场后它随之消失 —— 因为徽标住在**渠道包的客户端**里，而 OFM 只加载
 * 自己的 client.js。本脚本把上游的客户端源码合并进来。
 *
 * ## 源码从哪来
 *
 * gitee 上游的 `plugin-src/client/`（**有源码**，不是从产物里抠）：
 *   usage-badge.js（组件）、badge-model.js（视图模型）、credits-format.js、
 *   quota-format.js、credit-expiry.js、credits-capabilities.js（能力表）、
 *   jet-hub-styles.js（样式）
 * 外加**转译过的** `src/provider-registry.ts` → `provider-registry.js`
 *（`credits-capabilities.js` 从它取 `creditCapabilitiesOf` / `descriptorOf`）。
 *
 * 按**拓扑序**拼成一个 IIFE，去掉 import/export 边界 —— 所有内部符号落在函数
 * 作用域里，既不污染 OFM 的模块作用域，也**不会与 OFM 自己的同名变量撞车**
 *（它自己有 `formatCredits` 之类）。对外只暴露 `UsageBadge`。
 *
 * ## ⚠️ 为什么 readActiveProvider 不用上游的 `aggregate.activeProvider`
 *
 * 那条**只在整轮成功后才写**，而徽标在**渲染门控阶段**就要同步拿它把虚拟的
 * `aggregate` 解析成真实渠道 ⇒ 用户实测一直看到占位
 *「聚合 · 待首次请求」（`<span>`，点不开也不像胶囊）。
 * 改用 `router.activeRoute`（**转发一开始就写**，见渠道包 `active-route.ts`）后，
 * 发过一条消息徽标就有真实渠道了。返回结构兼容（徽标只读 `provider`）。
 *
 * ## 与补丁 E 的关系
 *
 * **互不依赖**。锚点用 OFM 自己的 `settings.onboarding` 注册点，inject 的增补也由
 * 本脚本自己完成（不再借用补丁 E 改过的那行）——用户后来决定撤掉补丁 E
 *（右下角那个读数胶囊），若仍依赖它，撤 E 就会连带弄坏 F。
 *
 * 用法：
 *   node patch-badge-port.mjs --fetch     # 从 gitee 拉源文件并转译 registry
 *   node patch-badge-port.mjs --check
 *   node patch-badge-port.mjs --apply
 *   node patch-badge-port.mjs --revert
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const INSTALLED = path.join(HOME, 'profiles/phone/node_modules/dsh-our-free-model');
const PLUGIN_DIRS = [LOCAL, INSTALLED];

/** 上游客户端源码的本地缓存目录。 */
const CLIENT_DIR = process.env.OFM_CLIENT_DIR || '/data/data/com.dshphone/files/ofm-build/gitee-client';
const RAW_BASE = 'https://gitee.com/iJetLi/deepseek-harness-codearts/raw/master/plugin-src/client/';
/** registry 的服务端源码（要转译成 JS 才能进客户端 bundle）。 */
const REGISTRY_TS = '/data/data/com.dshphone/files/ofm-build/gitee-src/src/provider-registry.ts';
const ESBUILD = '/data/data/com.dshphone/files/ofm-build/node_modules/esbuild-wasm/lib/main.js';
const ESBUILD_CWD = '/data/data/com.dshphone/files/ofm-build';

/**
 * 参与拼接的源文件，**按拓扑序**（被依赖者在前）。
 * import 图（来自各文件头部）：
 *   credits-capabilities → provider-registry
 *   badge-model          → credits-format, quota-format
 *   usage-badge          → credits-capabilities, badge-model, quota-format,
 *                          credits-format, credit-expiry, jet-hub-styles
 */
const SRC_FILES = [
  'credits-format.js',
  'quota-format.js',
  'provider-registry.js',
  'credit-expiry.js',
  'credits-capabilities.js',
  'badge-model.js',
  'jet-hub-styles.js',
  'usage-badge.js',
];
/** 需要从 gitee 下载的（provider-registry.js 由 --fetch 转译生成，不在此列）。 */
const REMOTE_FILES = SRC_FILES.filter((f) => f !== 'provider-registry.js');

const MARK = 'patch F: usage badge';

/** inject 增补（本脚本自己完成，不依赖补丁 E）。 */
const INJECT_FROM = `const inject = ['slots', 'locale']`;
const INJECT_TO = `// ${MARK} —— 徽标需要 connection（调宿主 RPC）与 modelDirectories（当前渠道）。
// ⚠️ sessions / remote / remote.session 是 ctx.modelDirectories.directoryFor()
//    的内部依赖，缺了会在**输入区渲染路径**上抛错（不只影响徽标）。
const inject = ['slots', 'locale', 'connection', 'modelDirectories', 'sessions', 'remote', 'remote.session']`;

/**
 * RPC helper。
 *
 * ⚠️⚠️ **必须插在 `apply(ctx)` 内部**（替换掉函数首行），不能插在它前面。
 * 初版插在模块级，而函数体里要用 `ctx.connection` —— 模块级没有 `ctx`，
 * 调用时抛 `ReferenceError`，又被徽标的 `.catch(() => setActiveProvider(null))`
 * 静默吞掉，表现为**永远停在占位「聚合 · 待首次请求」**（用户实测报障）。
 */
const RPC_ANCHOR = `    function apply(ctx) {`;
const RPC_HELPER = `    function apply(ctx) {
      // ${MARK} —— 徽标统一走这条 RPC（与渠道页同一通道）。
      // ⚠️ 必须在 apply 内部定义：函数体要用 ctx.connection。
      const callJetHub = async (method, payload) => {
        const connection = ctx.connection
        if (connection?.rpc?.call === undefined) throw new Error('no-connection')
        const result = await connection.rpc.call('/api', 'jet-hub', { method, payload })
        if (result?.ok === true) return result.value
        throw new Error(result?.error?.message ?? result?.error?.code ?? 'rpc-failed')
      }
`;

/** 组件锚点（插在 apply 之前，模块级）。 */
const BADGE_ANCHOR = `    function apply(ctx) {`;

/** 槽位注册（插在 OFM 自己的 settings.onboarding 之前；与补丁 E 无关）。 */
const SLOT_ANCHOR = `      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({`;

/**
 * 去掉 import 语句（含多行 `import {\n a,\n b\n} from '...'`）。
 *
 * ⚠️ 不能用一条跨行正则：`import[\s\S]*?from` 会贪婪吞掉两个 import 之间的真实
 * 代码。逐行状态机才安全。本脚本初版只认单行 import，漏掉了 usage-badge.js 的
 * 两条多行 import（`credit-expiry.js` / `provider-registry.js`），直接导致页面
 * 报 `creditCapabilitiesOf is not defined`。
 */
function stripImports(src) {
  const out = [];
  let skipping = false;
  for (const line of src.split('\n')) {
    if (!skipping && /^\s*import\b/.test(line)) {
      skipping = !/from\s+['"][^'"]+['"]\s*;?\s*$/.test(line);
      continue;
    }
    if (skipping) {
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 把源文件拼成一个只暴露 UsageBadge 的 IIFE。 */
function badgeSource() {
  const missing = SRC_FILES.filter((f) => !fs.existsSync(path.join(CLIENT_DIR, f)));
  if (missing.length > 0) {
    throw new Error(`缺少源文件（先跑 --fetch）：${missing.join(', ')}\n  目录：${CLIENT_DIR}`);
  }
  const parts = SRC_FILES.map((f) => {
    let s = fs.readFileSync(path.join(CLIENT_DIR, f), 'utf8');
    s = stripImports(s);
    s = s.replace(/^export\s+(const|function|class|let|var)\s/gm, '$1 ');
    s = s.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
    return `      // ──────── ${f} ────────\n${s}`;
  });
  return `    // ── ${MARK} ─────────────────────────────────────────────
    // 「用量徽标」的依赖闭包（源码来自 gitee 上游 plugin-src/client/，见
    // patch-badge-port.mjs）。整体包在一个 IIFE 里：内部符号不外泄，故与 OFM
    // 自身的同名变量互不干扰；对外只给 UsageBadge。
    const OFM_USAGE_BADGE = (() => {
${parts.join('\n')}
      /**
       * provider id → 展示名，**与上游 plugin-src/client/jet-hub.js 逐字同款**：
       *
       *     function providerLabel(id) {
       *       return PROVIDERS.find((p) => p.id === id)?.label ?? id
       *     }
       *
       * ⚠️ 必须用 PROVIDER_REGISTRY 的 label（如「Loomy (讯飞)」「CodeArts (华为云)」），
       * 不能用 OFM 自己那份 CHANNEL_PROVIDERS 的 name（只有「Loomy」）——
       * 后者会让胶囊显示成「Loomy · 4615积分」，而用户要的原版是
       * 「Loomy (讯飞) · 4615积分」（带厂商）。这是用户对照截图指出的差异。
       *
       * PROVIDER_REGISTRY 已在本次拼接中带入（provider-registry.js，
       * 为 creditCapabilitiesOf 而打），故这里零额外依赖。
       */
      const providerLabel = (id) => PROVIDER_REGISTRY.find((d) => d.id === id)?.label ?? id
      return { UsageBadge, providerLabel }
    })()
    // ─────────────────────────────────────────────────────────────────────
`;
}

/** 槽位注册块（含全部 props 注入）。 */
function slotBlock() {
  return `      // ── ${MARK} ─────────────────────────────────────────────
      // 用量徽标：模型选择器左侧的「渠道 • 余额」胶囊，点开有明细与签到。
      // 槽位 conversation.input.right 的渲染位置就在 conversation.input.model
      // 之前（上游注释），故它天然落在模型选择器左侧。
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'our-free-model-usage',
        order: 100,
        locale: NS,
        inject: (sessionId) => ({
          // ⚠️ 必须惰性取目录（真机事故：在 inject 期求值会让整个输入区渲染中断）
          resolveDirectory: () => {
            const directory = ctx.modelDirectories.directoryFor(sessionId)
            return { store: directory.store, load: () => directory.load() }
          },
          // ⚠️ 用上游同款的 providerLabel（取自 PROVIDER_REGISTRY 的 label，带厂商后缀
          //    如「Loomy (讯飞)」），**不是** OFM 自己那份精简的 CHANNEL_LABELS。
          providerLabel: OFM_USAGE_BADGE.providerLabel,
          readBadge: (provider, options) => callJetHub('usage.badge', { provider, ...options }),
          /**
           * 聚合时把虚拟的 aggregate 解析成**真实渠道**，徽标才能显示对的那家的积分。
           *
           * ⚠️⚠️ 用 **router.activeRoute（转发一开始就写）**，而不是上游原先的
           * aggregate.activeProvider（**整轮成功后才写**）。原因（用户实测报障）：
           * 徽标在**渲染门控阶段**就要同步拿它，而后者要等整轮跑完 ⇒ 用户一直看到
           * 占位「聚合 · 待首次请求」（<span>，点不开也不像胶囊）。
           * 两者语义差别是刻意的（见渠道包 active-route.ts 模块头），这里要的正是
           * 「此刻正在用什么」。返回结构兼容：徽标只读 provider。
           */
          readActiveProvider: (canonicalId) =>
            callJetHub('router.activeRoute', canonicalId === undefined ? {} : { provider: canonicalId }),
          writePreference: (preference) => callJetHub('usage.badgePreference', { preference }),
          setAutoCheckin: (enabled) => callJetHub('usage.autoCheckin', { enabled }),
          dismissAutoCheckin: () => callJetHub('usage.autoCheckin', { dismiss: true }),
          claimCredits: (provider, options) => callJetHub('credits.claimAll', { provider, ...options }),
        }),
      }, OFM_USAGE_BADGE.UsageBadge))
      // ─────────────────────────────────────────────────────────────────────

${SLOT_ANCHOR}`;
}

const mode = process.argv[2] || '--check';

/**
 * 目标 client.js 列表。
 *
 * ⚠️ `OFM_BADGE_TARGETS`（冒号分隔）可覆盖为任意路径 —— **先在副本上演练整条
 * 补丁链**，再动线上文件。本脚本原先是**硬编码**两个安装位置，于是 2026-10-16
 * 我在副本上演练时，`--revert` 顺手把**线上**的 F 补丁也还原了
 *（`client.js` 1350964 → 454747 字节）。加这个开关就是为了让演练能真的只碰副本。
 */
const targets = () => {
  const override = process.env.OFM_BADGE_TARGETS;
  if (override !== undefined && override.length > 0) return override.split(':').filter((s) => s.length > 0);
  return PLUGIN_DIRS.map((d) => path.join(d, 'client.js'));
};

if (mode === '--fetch') {
  fs.mkdirSync(CLIENT_DIR, { recursive: true });
  let ok = 0;
  for (const f of REMOTE_FILES) {
    try {
      const r = await fetch(RAW_BASE + f, { signal: AbortSignal.timeout(90_000) });
      if (!r.ok) { console.error(`  ✗ ${f}  HTTP ${r.status}`); continue; }
      const t = await r.text();
      fs.writeFileSync(path.join(CLIENT_DIR, f), t);
      ok += 1;
      console.log(`  ✓ ${f.padEnd(26)} ${t.length} 字符`);
    } catch (e) { console.error(`  ✗ ${f}  ${e.message.slice(0, 60)}`); }
  }
  // provider-registry.ts → .js（credits-capabilities 从它取两个函数）
  if (!fs.existsSync(REGISTRY_TS)) {
    console.error(`  ✗ 缺 ${REGISTRY_TS}（先跑 update-channelpack.mjs 拉 gitee src）`);
  } else {
    const mod = await import(pathToFileURL(ESBUILD).href);
    const esbuild = mod.default ?? mod;
    await esbuild.initialize();
    const r = await esbuild.build({
      // ⚠️ 必须相对路径：esbuild-wasm 以进程 cwd 为解析基准，绝对路径会 resolve 失败。
      entryPoints: [path.relative(ESBUILD_CWD, REGISTRY_TS)],
      bundle: true, write: false, format: 'esm', platform: 'neutral',
    });
    const text = r.outputFiles[0].text;
    fs.writeFileSync(path.join(CLIENT_DIR, 'provider-registry.js'), text);
    console.log(`  ✓ ${'provider-registry.js'.padEnd(26)} ${text.length} 字符（转译自 .ts）`);
    ok += 1;
  }
  console.log(`\n就绪 ${ok}/${SRC_FILES.length} → ${CLIENT_DIR}`);
  process.exit(ok === SRC_FILES.length ? 0 : 1);
}

if (mode === '--check') {
  const badge = badgeSource();
  console.log(`源文件目录：${CLIENT_DIR}`);
  console.log(`  拼接后 ${(badge.length / 1024).toFixed(1)} KB（${SRC_FILES.length} 个文件）`);
  const need = ['creditCapabilitiesOf', 'descriptorOf', 'expirySplitParts', 'badgeView', 'UsageBadge', 'ensureJetHubStyles'];
  const undef = need.filter((n) => !new RegExp(`(function|const|let|var)\\s+${n}\\b`).test(badge));
  console.log(`  依赖自检：${undef.length === 0 ? '全部有定义 ✓' : `缺 ${undef.join(', ')}`}`);
  for (const f of targets()) {
    if (!fs.existsSync(f)) { console.log(`缺失  ${f}`); continue; }
    const src = fs.readFileSync(f, 'utf8');
    const has = src.includes('OFM_USAGE_BADGE');
    const slot = src.includes(`${MARK} —— 徽标需要 connection`);
    console.log(`${has && slot ? '已打补丁' : '未打补丁'}  F(组件=${has} inject=${slot})  ${f}`);
  }
  process.exit(undef.length === 0 ? 0 : 1);
}

if (mode === '--revert') {
  for (const f of targets()) {
    const bak = `${f}.pre-patch-f`;
    if (!fs.existsSync(bak)) { console.log(`无备份，跳过  ${f}`); continue; }
    fs.copyFileSync(bak, f);
    console.log(`已还原  ${f}`);
  }
  process.exit(0);
}

const badge = badgeSource();
const slot = slotBlock();
let changed = 0;
for (const f of targets()) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
  let src = fs.readFileSync(f, 'utf8');
  if (src.includes('OFM_USAGE_BADGE') && src.includes(`${MARK} —— 徽标需要 connection`)) {
    console.log(`补丁 F 已在，跳过  ${f}`);
    continue;
  }
  if (!fs.existsSync(`${f}.pre-patch-f`)) fs.copyFileSync(f, `${f}.pre-patch-f`);

  // F1: inject 增补（自己完成，不依赖补丁 E）
  if (!src.includes(`${MARK} —— 徽标需要 connection`)) {
    const n = src.split(INJECT_FROM).length - 1;
    if (n !== 1) throw new Error(`${f}: inject 锚点命中 ${n} 次（应为 1）`);
    src = src.replace(INJECT_FROM, INJECT_TO);
  }
  // F2: RPC helper —— **整体替换 apply 首行**（helper 自带该行，故替换后锚点仍在）
  if (!src.includes(`${MARK} —— 徽标统一走这条 RPC`)) {
    const n = src.split(RPC_ANCHOR).length - 1;
    if (n !== 1) throw new Error(`${f}: RPC 锚点命中 ${n} 次（应为 1）`);
    src = src.replace(RPC_ANCHOR, RPC_HELPER);
  }
  // F3: 组件闭包
  {
    const n = src.split(BADGE_ANCHOR).length - 1;
    if (n !== 1) throw new Error(`${f}: 组件锚点命中 ${n} 次（应为 1）`);
    src = src.replace(BADGE_ANCHOR, `${badge}\n${BADGE_ANCHOR}`);
  }
  // F4: 槽位注册
  {
    const n = src.split(SLOT_ANCHOR).length - 1;
    if (n !== 1) throw new Error(`${f}: 槽位锚点命中 ${n} 次（应为 1）`);
    src = src.replace(SLOT_ANCHOR, slot);
  }
  fs.writeFileSync(f, src);
  changed += 1;
  console.log(`已打补丁 F（inject + RPC + 组件 + 槽位）  ${f}`);
}
console.log(`\n完成：改动 ${changed} 个文件。回滚：node patch-badge-port.mjs --revert`);