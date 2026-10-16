#!/usr/bin/env node
/**
 * 探测「Web 服务实际发出的客户端 bundle 字节」——判断改盘上的 client.js 后，
 * **刷新页面能否生效**，还是必须重启应用。
 *
 * 为什么要这个探针：
 *   `dsh-client-modules` 把每个包的客户端 bundle 组合成 combo 脚本按 URL 提供，
 *   而它的扫描是**增量、按包**的（源码注释：「Bundle content changes reach the
 *   graph only through ClientModuleRegistry.rebuilt」）。也就是说**改盘上的文件
 *   未必立刻反映到已发出的 combo 上**。在「改完要不要重启」这件事上，猜测没有意义
 *   —— 直接把服务端当前会发的字节抓下来比对。
 *
 * 用法：
 *   node probe-served-bundle.mjs                     # 报 combo 列表与字节数
 *   node probe-served-bundle.mjs --grep 关键字        # 在发出的字节里找关键字
 *   node probe-served-bundle.mjs --compare <本地文件> # 与盘上文件比对
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const BASE = process.env.DSH_URL || 'http://127.0.0.1:3080';
const args = process.argv.slice(2);
const grepIdx = args.indexOf('--grep');
const cmpIdx = args.indexOf('--compare');
const needle = grepIdx >= 0 ? args[grepIdx + 1] : undefined;
const cmpFile = cmpIdx >= 0 ? args[cmpIdx + 1] : undefined;

function authCookie() {
  const text = fs.readFileSync(`${HOME}/.credentials.yaml`, 'utf8');
  const m = /client-connection\/browser-session:[\s\S]*?\n\s+secret:\s*(\S+)/.exec(text);
  if (m === null) throw new Error('凭据库里找不到 browser-session secret');
  const secret = Buffer.from(m[1], 'base64url');
  const authority = new URL(BASE).host;
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 86400_000 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest().toString('base64url');
  const name = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
  return `${name}=v1.${body}.${sig}`;
}
const cookie = authCookie();
const get = async (url) => {
  const r = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
  return { status: r.status, text: await r.text() };
};

const index = await get(`${BASE}/`);
if (index.status !== 200) { console.error(`✗ 首页 HTTP ${index.status}`); process.exit(1); }
console.log(`首页 HTTP 200，${index.text.length} 字符`);

// combo 的 URL 形如 `plugins/??<id>/client.js,<id>/client.js`（相对路径、多包合成
// 一条）。把 index 里真正 src/href 引用的都抓出来（`&amp;` 要还原成 `&`）。
const urls = [...new Set(
  [...index.text.matchAll(/(?:src|href)="(plugins\/[^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&')),
)];
console.log(`\nindex 里引用 ${urls.length} 个 plugins 资源（去重后）`);

let ourUrl;
for (const u of urls) {
  const res = await get(`${BASE}/${u}`);
  const has = res.text.includes('dsh-our-free-model');
  if (has) {
    console.log(`  → ours  ${res.text.length} 字节  JetHubPage=${res.text.includes('JetHubPage')}`);
    ourUrl = { u, text: res.text };
  } else {
    console.log(`  · 其它  ${res.text.length} 字节  ${u.slice(0, 60)}…`);
  }
}

if (ourUrl === undefined) { console.error('\n✗ 没找到承载 dsh-our-free-model 的 combo 资源'); process.exit(1); }

console.log(`\n=== 服务端当前发出的 ours bundle ===`);
console.log(`  字节数      : ${ourUrl.text.length}`);
console.log(`  含 JetHubPage: ${ourUrl.text.includes('JetHubPage')}   ← 补丁 G 是否已在发出的字节里`);

if (needle !== undefined) {
  let n = 0, i = -1;
  while ((i = ourUrl.text.indexOf(needle, i + 1)) >= 0) n += 1;
  console.log(`  含 "${needle}": ${n} 次`);
}
if (cmpFile !== undefined) {
  const disk = fs.readFileSync(cmpFile, 'utf8');
  console.log(`\n=== 与盘上文件比对 ===`);
  console.log(`  盘上        : ${cmpFile}  ${disk.length} 字节`);
  console.log(`  发出        : ${ourUrl.text.length} 字节`);
  console.log(`  逐字节相同  : ${disk === ourUrl.text ? '是 ✓' : '否 ✗（服务端仍发旧内容）'}`);
  if (disk !== ourUrl.text) {
    // 给出「盘上独有」的特征串，便于判断差异性质（是否只是 sourcemap 尾注）。
    console.log(`  盘上有 JetHubPage : ${disk.includes('JetHubPage')}`);
    console.log(`  发上有 JetHubPage : ${ourUrl.text.includes('JetHubPage')}`);
  }
}
