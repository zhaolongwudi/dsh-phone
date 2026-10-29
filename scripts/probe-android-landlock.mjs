/**
 * Android Landlock 可用性探针（Issue F-14 的事实登记，**可复跑**）。
 *
 * ## 为什么要留一个可跑的探针
 *
 * `overrides/runtime/overlays/@deepseek-ai/dsh-sandbox-local/lib/index.js` 里有一条
 * `android: ["landlock"]` 的候选链，读起来像「Android 上 Landlock 沙箱可用」。
 * 而**设备实测是 `unusable`** ⇒ `chainVerdict()` 返回 `"unavailable"` ⇒
 * `selectRunner` 抛 `SandboxUnavailableError` ⇒ 本机任何 `workspace-write` 的 bash
 * 都**不会执行**（只能靠一次性 `danger-full-access` 授权）。
 *
 * 也就是说：手机版实际只有「完全访问」一种可用模式，那条 android 分支
 * **在本机是不可达代码**。这不是崩溃，而是「补丁预期与现实之间的落差」——
 * 后续维护者若不知情，会以为 android 沙箱已被验证过。
 *
 * ## 怎么跑
 * ```sh
 * export PATH=/data/data/com.dshphone/files/bin:$PATH
 * node .github/capsule/files/scripts/probe-android-landlock.mjs
 * ```
 * 只能在**真机**上跑（要有 `/data/app/<hash>/lib/arm64/libdshlandlock.so`），
 * 不能在构建机/CI 上跑 —— 故它不接进 `apply.sh`，只作为人工复核手段。
 *
 * ## 输出
 * - `usable`       → Landlock 可用（此时 `workspace-write` 的 bash 可执行）
 * - `unusable`     → **本机实测值**：沙箱不可用，android 分支不可达
 * - `unsupported`  → 内核/ABI 不支持
 *
 * ## ⚠️ 边界（如实登记）
 * 本结论只来自**这一台设备**。是否所有 Android 设备/内核
 * （≥5.13 且 seccomp 放行 `landlock_create_ruleset`）都不可用，
 * **未确认**；`.so` 本身**确实存在于 APK 的 lib 目录**（不是打包缺失，
 * 是运行期 probe 失败）。若将来在别的机型上得到 `usable`，
 * 请更新本节与胶囊 README 里 F-14 的登记。
 */
const soPath = process.execPath.replace(/libnode\.so$/, 'libdshlandlock.so')

let probe
try {
  const mod = await import('file:///data/data/com.dshphone/files/tree/node_modules/@deepseek-ai/node-addon-system/lib/index.js')
  probe = mod.probe
} catch (error) {
  console.error('✗ 无法加载 node-addon-system（本脚本只能在**设备上**、用设备树的 node 跑）')
  console.error(`  ${error.message}`)
  process.exit(2)
}

const verdict = probe(soPath, { timeoutMs: 5000 })
console.log(`目标 .so : ${soPath}`)
console.log(`probe    : ${verdict}`)
if (verdict === 'unusable') {
  console.log('⇒ Issue F-14 的登记成立：Android Landlock 不可用，`workspace-write` 的 bash 不会执行。')
} else if (verdict === 'usable') {
  console.log('⚠️ 与 Issue F-14 的登记**不符**（本机曾实测 unusable）——请更新胶囊 README 与 F-14 段落。')
}
