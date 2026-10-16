#!/usr/bin/env node
/**
 * 访问运行中 DSH 实例的插件 RPC（默认 Jet Hub）。
 *
 * 为什么要自签 cookie：
 *   Web 的启动令牌（`launchToken`）只存在于进程内存里，日志里被 redact 成
 *   `?token=[redacted]`，外部无从获取 —— 所以 `fetch` 裸请求一律 401。
 *   但**校验 cookie 的签名密钥是持久化的**：它由 client-connection 首次启动时
 *   写入凭据库（`.credentials.yaml` 的 `client-connection/browser-session` 记录，
 *   `initializeSecret()` 生成一次后长期复用）。而校验算法就是普通 HMAC-SHA256，
 *   故本地可以照 dsh-client-connection 的 `encodeCookie()` 逐字自签一个 cookie。
 *
 * 签名算法（与 dsh-client-connection/lib/index.js 逐字同构）：
 *   body    = base64url(JSON.stringify({ version:1, authority, issuedAt, expiresAt }))
 *   签名    = base64url(HMAC-SHA256(secret, body))
 *   cookie 值 = `v1.${body}.${签名}`
 *   cookie 名 = 'dsh-auth-' + base64url(SHA256(authority))
 *   authority = 请求的 host（http 下就是 `127.0.0.1:3080`）
 *
 * 用法：
 *   node hub-rpc.mjs <method> ['<json payload>']       # 默认打 Jet Hub
 *   DSH_ENDPOINT=our-free-model node hub-rpc.mjs summary
 *   DSH_URL=http://127.0.0.1:3099 node hub-rpc.mjs provider.status
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const BASE = process.env.DSH_URL || 'http://127.0.0.1:3080';
const ENDPOINT = process.env.DSH_ENDPOINT || 'jet-hub';

/** 从凭据库取 Web 的 cookie 签名密钥（持久化，可复用）。 */
function signingSecret() {
  const text = fs.readFileSync(`${HOME}/.credentials.yaml`, 'utf8');
  const m = /client-connection\/browser-session:[\s\S]*?\n\s+secret:\s*(\S+)/.exec(text);
  if (m === null) throw new Error('凭据库里找不到 client-connection/browser-session 的 secret');
  return Buffer.from(m[1], 'base64url');
}

/** 自签一个会话 cookie。 */
function authCookie() {
  const secret = signingSecret();
  const authority = new URL(BASE).host;
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 30 * 86400_000 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest().toString('base64url');
  const name = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
  return `${name}=v1.${body}.${sig}`;
}

/** 按 client-connection 的信封格式发一次 RPC。 */
export async function call(method, payload = {}, { timeoutMs = 180_000 } = {}) {
  const rpcId = 'r' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const res = await fetch(`${BASE}/api/${ENDPOINT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authCookie(), origin: BASE, referer: `${BASE}/` },
    body: JSON.stringify({ type: 'client-request', rpcId, method: ENDPOINT, payload: { method, payload } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`响应不是 JSON：${text.slice(0, 200)}`); }
  return json.result ?? json;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const [method, payloadJson] = process.argv.slice(2);
  if (method === undefined) {
    console.log('用法: node hub-rpc.mjs <method> [json payload]');
    process.exit(1);
  }
  const result = await call(method, payloadJson !== undefined ? JSON.parse(payloadJson) : {});
  console.log(JSON.stringify(result, null, 2));
}