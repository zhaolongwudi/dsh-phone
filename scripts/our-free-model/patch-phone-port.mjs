#!/usr/bin/env node
/**
 * dsh-our-free-model 的手机版移植补丁（phone-port patch）。
 *
 * ## 这份补丁的历史与现状
 *
 * 早先手机上并存两份同源渠道代码（OFM 内嵌的 vendor/channel-pack 与独立的
 * dsh-providers-hub「Jet Hub」）。两者抢同一网关端口 8326、并从 .credentials.yaml
 * 认领同一批 *_ACCOUNT_* 凭据，故当时让 **Jet Hub 独占渠道池**，OFM 的渠道界面
 * 改为读 Jet Hub 的 RPC —— 那就是补丁 A/C 的由来。
 *
 * **2026-10-16 起改向**：OFM 自带的渠道包已同步到 gitee 上游最新（含 Jet Hub 的
 * 全部功能），Jet Hub 退场。因此：
 *   · 补丁 **A 已删除** —— 不再阻止挂载，OFM 直接跑自己的渠道包；
 *   · 补丁 C 保留 —— 渠道界面的 RPC 端点仍是 'jet-hub'（上游渠道包就叫这个名字）；
 *   · 补丁 D 的数据源改到 **OFM 自己的渠道包**（原先读 Jet Hub 的 registry 文件，
 *     Jet Hub 一撤就找不到）。
 *
 * ## 现在只剩两处（均可逆、幂等）
 *
 *   B. index.js —— distributionOf() 一律 'managed'，停用应用内自升级
 *      （否则升级会用上游原样文件覆盖补丁 C/D）。
 *   C. client.js —— 渠道页的 RPC 端点由 'channel-pack' 改为 'jet-hub'，
 *      让本插件的界面驱动自带渠道包的引擎。
 *   D. client.js —— 渠道清单与积分能力表对齐渠道包的 provider-registry。
 *      本页的两张表都是写死的静态数组，渠道包新增渠道后：
 *        · 少了卡片 ⇒ 无法在本页登录/刷新/看积分；
 *        · 少了 credits 条目 ⇒ 卡片上不加载也不显示余额与签到。
 *      补丁 D 每次运行都读 registry 把两者补齐（只增不改）。
 *
 * 用法：
 *   node patch-phone-port.mjs --check    # 报告各目标的补丁状态与差集
 *   node patch-phone-port.mjs --apply    # 打补丁（先备份 .pre-patch）
 *   node patch-phone-port.mjs --revert   # 从 .pre-patch 还原
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const INSTALLED = path.join(HOME, 'profiles/phone/node_modules/dsh-our-free-model');

const PLUGIN_DIRS = [LOCAL, INSTALLED];

// ── B：锁 managed，停用自升级（index.js）────────────────────────────────────
const B_FROM = `function distributionOf(config, settings) {
  if (config?.distribution === 'managed' || settings.get().distribution === 'managed') return 'managed'`;

const B_TO = `function distributionOf(config, settings) {
  // ── phone-port patch B ────────────────────────────────────────────────
  // 本移植版含人工补丁（patch C/D），插件自带的应用内升级会用上游原样文件
  // 覆盖它们，因此发行模式一律视为 managed：自升级、公告 feed 与热重载全部停用。
  // 上游更新由 update.mjs 拉取后重新打补丁完成。
  return 'managed'
  if (config?.distribution === 'managed' || settings.get().distribution === 'managed') return 'managed'`;

// ── C：渠道页 RPC 端点切到自带渠道包（client.js）────────────────────────────
const C_FROM = `connection.rpc.call('/api', 'channel-pack', { method, payload }, controller.signal)`;

const C_TO = `connection.rpc.call('/api', 'jet-hub', { method, payload }, controller.signal) /* phone-port patch C：本页读自带渠道包（vendor/channel-pack）的 RPC。它源自 gitee 上游，端点名就是 'jet-hub'。 */`;

const PATCHES = [
  { name: 'B', file: 'index.js', mark: 'phone-port patch B', from: B_FROM, to: B_TO },
  { name: 'C', file: 'client.js', mark: 'phone-port patch C', from: C_FROM, to: C_TO },
];

// ── D：渠道清单与积分能力表对齐渠道包的 provider-registry（client.js）──────
/**
 * 「有哪些渠道」「各渠道有什么积分能力」的唯一真相源现在是 **OFM 自带渠道包** 的
 * `vendor/channel-pack/src/provider-registry.ts`（同步 gitee 上游时一并更新）。
 *
 * ⚠️ 该文件是 TypeScript，Node 不能直接 import；但它是**纯数据结构、零 import**，
 * 故这里用正则解析。格式见 gitee 上游 src/provider-registry.ts。
 */
const REGISTRY_REL = 'vendor/channel-pack/src/provider-registry.ts';

/**
 * 新增渠道的卡片展示元数据。registry 只有 id/label/logoClass/credits，
 * 不含本页要用的 accent（色条）/ note（说明）/ login（登录方式），故在此维护。
 * registry 里有、本表没有的渠道会按 label 拆出 name/org 并用中性默认值补上。
 */
const CHANNEL_META = {
  minimaxintl: { name: 'MiniMax Code 国际版', org: 'MiniMax', accent: '#E4007F', note: '国际版端点，每日签到', login: 'browser' },
  opencode: { name: 'OpenCode', org: '匿名免费线', accent: '#6B7280', note: '无需登录的匿名免费通道，余额位显示通道可用性', login: 'none' },
  officeace: { name: 'OfficeAce', org: 'OfficeAce', accent: '#0F9D58', note: '云侧积分余额，订阅页挂载时自动领取每日额度', login: 'browser' },
  accio: { name: 'Accio', org: '阿里', accent: '#FF6A00', note: '每日 200 积分由登录触发（24h 内有效，不累积）', login: 'browser' },
};

/**
 * 新增渠道的积分能力。本表优先；表里没有的按 registry 的
 * `credits.dailyCheckin` 推导（true ⇒ claim，即可手动领每日额度）。
 * 语义对照：claim ⟺ dailyCheckin；status = 有独立签到状态查询；
 * unit = 余额量纲（dollars/tokens）；quota = 余额是配额（gemini）。
 */
const CREDITS_META = {
  minimaxintl: { claim: true },
  opencode: {},
  officeace: {},
  accio: {},
};

const D_ANCHOR_PROVIDERS_OPEN = 'const CHANNEL_PROVIDERS = [';
const D_ANCHOR_CREDITS_OPEN = 'const CHANNEL_CREDITS = {';
const D_ANCHOR_CLOSE = '\n    ]';
const D_ANCHOR_CREDITS_CLOSE = '\n    }';

/** 在插件目录里找一个存在的 registry 文件（本地副本优先）。 */
function registryPath() {
  for (const d of PLUGIN_DIRS) {
    const p = path.join(d, REGISTRY_REL);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`找不到渠道包的 provider-registry：${PLUGIN_DIRS.map((d) => path.join(d, REGISTRY_REL)).join(' 或 ')}`);
}

/**
 * 解析 provider-registry.ts，取出 `channel: true` 的渠道。
 * 条目形如：
 *     {
 *         id: 'codearts',
 *         label: 'CodeArts (华为云)',
 *         ...
 *         credits: { balance: true, dailyCheckin: true },
 *         channel: true,
 *     },
 */
function registryChannels() {
  const file = registryPath();
  const src = fs.readFileSync(file, 'utf8');
  // ⚠️ 只按 `id:` 定位**每段的起点**，段体取到下一段起点为止；`label` 在**段内**
  // 单独找。理由（两次实测踩坑，都会静默少渠道）：
  //   1. 「一次正则跨条目吃掉整段」不可行：条目内部也有缩进的 `}`，非贪婪匹配
  //      会提前收尾，导致后续条目全部失配（初版只解析出 1 个，实际有 17 个）。
  //   2. `id` 与 `label` **之间可能夹多行注释**（minimax 那条夹了 3 行，为区分
  //      国际版），故不能要求二者相邻 —— 否则它会静默消失（客户端少一张卡片）。
  // ⚠️ 缩进是 **4 空格**（条目本身 2 空格缩进的 `{`），实测确认，别照抄成 8。
  const idRe = /\n {4}id: '([a-z0-9_-]+)'/g;
  const marks = [...src.matchAll(idRe)];
  const out = [];
  for (let i = 0; i < marks.length; i += 1) {
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(from, to);
    if (!/channel:\s*true/.test(body)) continue;
    const id = marks[i][1];
    const label = /^\s*label: '([^']*)'/m.exec(body)?.[1] ?? id;
    out.push({
      id,
      label,
      credits: { dailyCheckin: /dailyCheckin:\s*true/.test(body) },
    });
  }
  if (out.length === 0) throw new Error(`从 ${file} 解析不出任何渠道 —— 上游结构可能已变`);
  return out;
}

/** 把 label（如 'Accio (阿里)'）拆成 name 与 org。 */
function splitLabel(label) {
  const m = /^([^(（]+?)\s*[(（]([^)）]+)[)）]\s*$/.exec(String(label).trim());
  return m
    ? { name: m[1].trim(), org: m[2].trim() }
    : { name: String(label).trim(), org: '' };
}

/** 生成一行渠道卡片条目（排版与数组里现有条目逐字一致）。 */
function channelLine(channel) {
  const meta = CHANNEL_META[channel.id]
    ?? { ...splitLabel(channel.label), accent: '#6B7280', note: '由渠道包提供', login: 'browser' };
  return `      { id: '${channel.id}', name: '${meta.name}', org: '${meta.org}', accent: '${meta.accent}', note: '${meta.note}', login: '${meta.login}' },`;
}

/** 生成一行积分能力条目。 */
function creditsLine(channel) {
  const meta = CREDITS_META[channel.id]
    ?? (channel.credits?.dailyCheckin === true ? { claim: true } : {});
  const body = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  return `      ${channel.id}: {${body === '' ? '' : ` ${body} `}},`;
}

/** 纯函数：把缺失的条目插进某个字面量对象/数组的末尾。 */
function appendMissing(src, { openAnchor, closeAnchor, listedPattern, buildLine, channels }) {
  const open = src.indexOf(openAnchor);
  if (open < 0) throw new Error(`补丁 D 的锚点未命中：${openAnchor} —— 上游结构可能已变`);
  const close = src.indexOf(closeAnchor, open);
  if (close < 0) throw new Error(`补丁 D 的收尾锚点未命中：${JSON.stringify(closeAnchor)} —— 上游结构可能已变`);
  const listed = new Set([...src.slice(open, close).matchAll(listedPattern)].map((m) => m[1]));
  const missing = channels.filter((c) => !listed.has(c.id));
  if (missing.length === 0) return { src, added: [] };
  const block = missing.map(buildLine).join('\n');
  return { src: src.slice(0, close) + '\n' + block + src.slice(close), added: missing.map((c) => c.id) };
}

/** 补丁 D：渠道卡片清单。 */
function patchChannelProviders(src, channels) {
  return appendMissing(src, {
    openAnchor: D_ANCHOR_PROVIDERS_OPEN,
    closeAnchor: D_ANCHOR_CLOSE,
    listedPattern: /\{ id: '([a-z0-9_-]+)'/g,
    buildLine: channelLine,
    channels,
  });
}

/** 补丁 D：积分能力表。 */
function patchChannelCredits(src, channels) {
  return appendMissing(src, {
    openAnchor: D_ANCHOR_CREDITS_OPEN,
    closeAnchor: D_ANCHOR_CREDITS_CLOSE,
    listedPattern: /^\s{6}([a-z0-9_-]+): \{/gm,
    buildLine: creditsLine,
    channels,
  });
}

const mode = process.argv[2] || '--check';
const targetsOf = (file) => PLUGIN_DIRS.map((d) => path.join(d, file));

function check() {
  for (const p of PATCHES) {
    for (const f of targetsOf(p.file)) {
      if (!fs.existsSync(f)) { console.log(`缺失      ${p.name}  ${f}`); continue; }
      const on = fs.readFileSync(f, 'utf8').includes(p.mark);
      console.log(`${on ? '已打补丁' : '未打补丁'}  ${p.name}  ${f}`);
    }
  }
  const channels = registryChannels();
  console.log(`渠道包 registry（${registryPath()}）：`);
  console.log(`  ${channels.length} 个真渠道：${channels.map((c) => c.id).join(', ')}`);
  for (const f of targetsOf('client.js')) {
    if (!fs.existsSync(f)) { console.log(`缺失      D  ${f}`); continue; }
    const src = fs.readFileSync(f, 'utf8');
    const a = patchChannelProviders(src, channels).added;
    const b = patchChannelCredits(src, channels).added;
    console.log(`${a.length ? `待补卡片(${a.join(', ')})` : '卡片已对齐'} / ${b.length ? `待补积分(${b.join(', ')})` : '积分已对齐'}  D  ${f}`);
  }
}

function apply() {
  for (const p of PATCHES) {
    for (const f of targetsOf(p.file)) {
      if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
      const src = fs.readFileSync(f, 'utf8');
      if (src.includes(p.mark)) { console.log(`补丁 ${p.name} 已在，跳过  ${f}`); continue; }
      const n = src.split(p.from).length - 1;
      if (n !== 1) throw new Error(`${f}: 补丁 ${p.name} 的锚点命中 ${n} 次（应为 1）—— 上游结构可能已变，拒绝打补丁`);
      if (!fs.existsSync(`${f}.pre-patch`)) fs.copyFileSync(f, `${f}.pre-patch`);
      fs.writeFileSync(f, src.replace(p.from, p.to));
      console.log(`已打补丁 ${p.name}  ${f}`);
    }
  }
  const channels = registryChannels();
  for (const f of targetsOf('client.js')) {
    if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
    const src = fs.readFileSync(f, 'utf8');
    const a = patchChannelProviders(src, channels);
    const b = patchChannelCredits(a.src, channels);
    if (a.added.length === 0 && b.added.length === 0) {
      console.log(`补丁 D 已对齐（${channels.length} 个渠道），跳过  ${f}`);
      continue;
    }
    if (!fs.existsSync(`${f}.pre-patch`)) fs.copyFileSync(f, `${f}.pre-patch`);
    fs.writeFileSync(f, b.src);
    const parts = [];
    if (a.added.length) parts.push(`卡片 +${a.added.join(', ')}`);
    if (b.added.length) parts.push(`积分能力 +${b.added.join(', ')}`);
    console.log(`已打补丁 D：${parts.join('  ')}  ${f}`);
  }
}

function revert() {
  for (const file of ['index.js', 'client.js']) {
    for (const f of targetsOf(file)) {
      const bak = `${f}.pre-patch`;
      if (!fs.existsSync(bak)) { console.log(`无备份，跳过  ${f}`); continue; }
      fs.copyFileSync(bak, f);
      console.log(`已还原  ${f}`);
    }
  }
}

if (mode === '--apply') apply();
else if (mode === '--revert') revert();
else check();