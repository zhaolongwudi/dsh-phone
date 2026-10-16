// 静态扫描发布文件里的所有 ESM import，逐个动态解析并核对命名导出是否存在
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('./dsh-our-free-model');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(ROOT);

const RE = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const specs = new Map(); // 说明符 -> Set(请求的导出名)

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(RE)) {
    const clause = m[1].trim(), spec = m[2];
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    const set = specs.get(spec) ?? new Set();
    if (!clause.startsWith('{')) set.add('default'); // 默认导入
    for (const part of clause.matchAll(/\{([\s\S]*?)\}/g)) {
      for (let n of part[1].split(',')) {
        n = n.trim(); if (!n) continue;
        n = n.split(/\s+as\s+/)[0].trim();
        set.add(n);
      }
    }
    specs.set(spec, set);
  }
}

const mods = [...specs.keys()].sort();
const isRelative = (s) => s.startsWith('.');
console.log(`扫描 ${files.length} 个 js 文件，外部说明符 ${mods.filter((s) => !isRelative(s)).length} 个\n`);

let bad = 0;
for (const spec of mods) {
  const names = [...specs.get(spec)];
  if (isRelative(spec)) {
    // 相对导入：确认文件存在（补 .js / 目录 index.js）
    const hits = [];
    for (const f of files) {
      const dir = path.dirname(path.relative(ROOT, f));
      const target = path.normalize(path.join(dir, spec));
      if (fs.existsSync(path.join(ROOT, target)) || fs.existsSync(path.join(ROOT, target + '.js')) || fs.existsSync(path.join(ROOT, target, 'index.js'))) hits.push(f);
    }
    if (!hits.length) { console.log(`缺失相对目标 ${spec}`); bad++; }
    continue;
  }
  let mod;
  try { mod = await import(spec); }
  catch (e) { console.log(`解析失败 ${spec}: ${e.message.split('\n')[0]}`); bad++; continue; }
  const missing = names.filter((n) => n !== 'default' && !(n in mod));
  if (missing.length) { console.log(`缺少导出 ${spec} -> ${missing.join(', ')}`); bad++; }
  else console.log(`ok ${spec}  (${names.length} 项: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''})`);
}
console.log(bad ? `\n发现 ${bad} 处问题` : '\n全部 import 可解析，命名导出齐全');
process.exitCode = bad ? 1 : 0;