// 按上游 package.json 的 files 清单，从 raw.githubusercontent 拉取发布文件集
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'Ebony-Vinyl/dsh-our-free-model';
const REF = process.env.OFM_REF || 'main';
const OUT = path.resolve(process.env.OFM_OUT || './dsh-our-free-model');

const PREFIXES = [
  'index.js', 'client.js', 'LICENSE', 'package.json', 'icon.svg', 'cordis.patch.yml',
  'adapter/', 'src/', 'locale/', 'vendor/channel-pack/',
];
const want = (p) => PREFIXES.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));

const treeRes = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`, {
  headers: { 'User-Agent': 'dsh-ofm-port' },
});
if (!treeRes.ok) throw new Error(`tree HTTP ${treeRes.status}`);
const tree = await treeRes.json();
const blobs = tree.tree.filter((n) => n.type === 'blob' && want(n.path));
console.log(`发布文件 ${blobs.length} 个 / 仓库总数 ${tree.tree.filter((n) => n.type === 'blob').length}`);

let done = 0, bytes = 0, failed = [];
const queue = [...blobs];
const workers = Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const node = queue.shift();
    const dest = path.join(OUT, node.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${REF}/${node.path}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== node.size) throw new Error(`size ${buf.length} != ${node.size}`);
        fs.writeFileSync(dest, buf);
        bytes += buf.length; done++;
        break;
      } catch (e) {
        if (attempt === 3) failed.push(`${node.path}: ${e.message}`);
        else await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
});
await Promise.all(workers);

console.log(`完成 ${done}/${blobs.length}，${(bytes / 1024).toFixed(0)} KB`);
if (failed.length) { console.log('失败:'); failed.forEach((f) => console.log(' ', f)); process.exitCode = 1; }

// 记录本轮上游版本与提交，供后续比对
const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));
const commit = await (await fetch(`https://api.github.com/repos/${REPO}/commits/${REF}`, { headers: { 'User-Agent': 'dsh-ofm-port' } })).json();
const stamp = { repo: `https://github.com/${REPO}`, ref: REF, version: pkg.version, commit: commit.sha, date: commit.commit.author.date, fetchedAt: new Date().toISOString() };
fs.writeFileSync(path.join(OUT, '.ofm-upstream.json'), JSON.stringify(stamp, null, 2));
console.log('上游锁定:', JSON.stringify(stamp));