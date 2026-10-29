/**
 * 设备端（Android）客户端 bundle 构建 —— 用 **esbuild-wasm** 替换原生 esbuild。
 *
 * ## 为什么需要它
 *
 * 本机（DSH for Android）把 `/data/data` 挂成 **noexec**，故 `@esbuild/android-arm64`
 * 那个原生二进制**无法执行**（`spawn … EACCES`），`pnpm build:client` 直接失败。
 * `esbuild-wasm` 是同一版本（0.24.2）的 WebAssembly 构建，**不需要 exec 权限**，
 * 且与原生 esbuild **产物同源**（同一份 esbuild 代码，只是执行载体不同）。
 *
 * ## ⚠️ 与 `build.mjs` 的关系
 *
 * 本文件**刻意**与 `build.mjs` 保持同一组选项（entryPoints / format / platform /
 * target / charset / external / minify / legalComments）与外层包装模板 —— 两者若分叉，
 * 桌面与手机就会产出**不同的 bundle**，那种差异极难排查。改 `build.mjs` 时**必须同步改这里**。
 *
 * ⚠️ 本文件是**设备端应急路径**，不替代 `build.mjs`：桌面/CI 仍用原生 esbuild（更快）。
 *
 * 用法：`node plugin-src/client/build-wasm.mjs`
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild-wasm';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/jet-hub.js');
const loaderId = 'dsh-codearts-auth';

// ⚠️ Node 版本的 `initialize()` **不接受** `wasmURL` / `wasmModule` / `worker`
//    （那三个只在浏览器版有效，传了会直接抛）。Node 版内部会用 `node` 去跑包内自带的
//    `bin/esbuild`（一个 WASM 加载器脚本）—— 它经 `node` 解释执行，**不需要目标文件
//    有可执行位**，这正是本路径能绕开 `/data/data` noexec 的原因。
await esbuild.initialize({});

const result = await esbuild.build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 与 build.mjs 同因：默认 charset 'ascii' 会把中文转义成 \uXXXX，
  // 产物可读性差且使「用 includes 校验产物文案」的做法失效。
  charset: 'utf8',
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild-wasm did not produce a client bundle');

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
