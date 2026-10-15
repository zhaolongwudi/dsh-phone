import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/jet-hub.js');
/* ⚠️ 必须等于包的 `name`（rc.11 改名后为 dsh-providers-hub）。
   依据（引擎源码）：dsh-client-modules 的 graphRow(packageName,…) 用 package.json 的 name
   作为这一行 bundle 的 id，再用它去 `factories.has(id)` 校验注册结果 ——
   两者不等就是用户实测的启动失败：`loaded without registering "…" via __ModuleLoader__.load`。
   ⚠️ 上游 rc.11 自己漏改了本行（改名只做了 package.json / cordis.patch.yml）。
   等上游补上后，本文件可以整体撤掉 override。 */
const loaderId = 'dsh-providers-hub';

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 默认 charset 为 'ascii'，会把所有中文转义成 \uXXXX：产物可读性差，
  // 且使「用 includes 校验产物文案」的做法天然失效。改用 utf8 后产物保留原文，
  // 加载器按 utf8 读取 bundle（dsh-client-modules 用 "utf8" 解码），故安全。
  charset: 'utf8',
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
