#!/usr/bin/env node
/**
 * 从 gitee 拉取渠道包上游的 src/ 源码。
 *
 * 上游：https://gitee.com/iJetLi/deepseek-harness-codearts （master）
 * OFM 的 vendor/channel-pack 就是这个仓库的拷贝（出处见其 NOTICE.md）。
 *
 * 只拉 .ts（源码）—— .wasm 等二进制不在源码同步范围内，沿用现有文件。
 *
 * 用法：
 *   node fetch-gitee-src.mjs [目标目录]
 *   默认目标：/data/data/com.dshphone/files/ofm-build/gitee-src
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'iJetLi/deepseek-harness-codearts';
const BRANCH = process.env.GITEE_BRANCH || 'master';
const API = `https://gitee.com/api/v5/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW = `https://gitee.com/${REPO}/raw/${BRANCH}/`;
const DEST = process.argv[2] || '/data/data/com.dshphone/files/ofm-build/gitee-src';
const CONCURRENCY = 6;

const meta = await (await fetch(API, { signal: AbortSignal.timeout(90000) })).json();
const all = (meta.tree ?? []).filter((t) => t.type === 'blob' && t.path.startsWith('src/'));
const files = all.filter((t) => t.path.endsWith('.ts'));
console.log(`上游 ${BRANCH} 的 src/：${all.length} 个文件，其中 .ts ${files.length} 个`);
if (all.length !== files.length) {
  console.log(`  （跳过 ${all.length - files.length} 个非 .ts：${all.filter((t) => !t.path.endsWith('.ts')).map((t) => path.basename(t.path)).join(', ')}）`);
}

fs.mkdirSync(DEST, { recursive: true });
let ok = 0;
const failed = [];
const queue = [...files];

async function worker() {
  while (queue.length > 0) {
    const f = queue.shift();
    const out = path.join(DEST, f.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(RAW + f.path, { signal: AbortSignal.timeout(90000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        if (t.length === 0) throw new Error('空响应');
        fs.writeFileSync(out, t);
        ok += 1;
        break;
      } catch (error) {
        if (attempt === 3) { failed.push(`${f.path}: ${error.message}`); }
        else await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`完成：成功 ${ok}，失败 ${failed.length} → ${DEST}`);
failed.forEach((f) => console.log('  ✗ ' + f));