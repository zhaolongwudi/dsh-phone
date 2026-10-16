#!/usr/bin/env node
/**
 * 补丁 J：徽标读数**双端点回退** —— 让「用量徽标恒占位」**不必重启**就能修好。
 *
 * ## 背景：目标① 卡在哪
 *
 * 上一轮把宿主侧修好了（`record()` 同时写路由键与模型键），**但宿主把 pack.js
 * 缓存在进程内** ⇒ 不重启 DSH 就不生效。实测：
 *
 * ```
 * router.activeRoute      {provider:'glm-5-3-flash'} → {"provider": null}    ✗ 徽标拿不到
 * aggregate.activeProvider{canonicalId:'glm-5-3-flash'} → {"provider":"loomy"} ✓ 有数据
 * ```
 *
 * 也就是说：**旧的 `aggregate.activeProvider` 端点本来就能按模型查**，
 * 只是上游当初为了「实时性」换成了 `router.activeRoute`（转发一开始就写），
 * 而那个新端点的宿主侧修复还没生效。
 *
 * ## 这个补丁做什么
 *
 * 把徽标的读数改成**先问新端点、拿不到再问旧端点**（都按 `canonicalId` 查）：
 *
 * ```js
 * readActiveProvider: async (canonicalId) => {
 *   const viaRoute = await callJetHub('router.activeRoute', { provider: canonicalId })
 *   if (viaRoute?.provider != null) return viaRoute
 *   return await callJetHub('aggregate.activeProvider', { canonicalId })
 * }
 * ```
 *
 * ⚠️ **回退时必须传 `canonicalId`**（不能无参）—— 无参时宿主回的是
 * `lastActiveProvider`（「任意虚拟模型最近一次成功」），那正是你 2026-10-16 报障的
 * 「用 glm5.3 显示的是腾讯 codebuddy」的成因。本补丁全程传 canonicalId，
 * 故**不会复现**那个缺陷（已读服务端实现核对：有 canonicalId 时读
 * `activeProviderByModel.get(canonicalId)`，是分模型的）。
 *
 * ⚠️ **语义差异是刻意接受的**：新端点是「此刻正在用什么」（转发一开始就写），
 * 旧端点是「上次整轮成功用了什么」。回退只在**新端点无数据**时发生，
 * 而那时本来就没有「此刻」可显示（旧客户端会一直显示占位「聚合 · 待首次请求」）
 * ⇒ 显示一个真实用过的渠道，明显优于显示占位。
 *
 * ## 与上一轮宿主修复的关系
 *
 * **不冲突、可叠加**：重启后新端点有值，回退分支自然不再走；
 * 不重启也能显示。两者都留着最稳（新端点更实时，旧端点是兜底）。
 *
 * ## 用法
 *
 *   node patch-badge-fallback.mjs --check
 *   node patch-badge-fallback.mjs --apply
 *   node patch-badge-fallback.mjs --revert
 *
 * ⚠️ `OFM_J_TARGETS`（冒号分隔）可覆盖目标 —— **先在副本上演练**再动线上。
 *    （教训：`--revert` 会作用到全部目标文件，2026-10-16 曾因此误还原线上文件。）
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const PROFILE = path.join(HOME, 'profiles/phone/node_modules');
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const PLUGIN_DIRS = [LOCAL, path.join(PROFILE, 'dsh-our-free-model')];

const MARK = 'patch J: badge endpoint fallback';

const targets = () => {
  const override = process.env.OFM_J_TARGETS;
  if (override !== undefined && override.length > 0) return override.split(':').filter((s) => s.length > 0);
  return PLUGIN_DIRS.map((d) => path.join(d, 'client.js'));
};

/** 上游原文（唯一，已核对出现次数 = 1）。 */
const OLD = `readActiveProvider: (canonicalId) =>
            callJetHub('router.activeRoute', canonicalId === undefined ? {} : { provider: canonicalId }),`;

/**
 * 替换为双端点回退。
 *
 * ⚠️⚠️ 第一个调用必须包 **try/catch**（真实约束）：`callJetHub` 在端点不存在、
 *    RPC 失败、无连接时是 **throw**（不是返回 null）——见它的定义
 *    `if (result?.ok === true) return result.value; throw new Error(...)`。
 *    若不包，老宿主/异常路径下**回退永远不会执行**，而回退正是本补丁的全部意义。
 *
 * ⚠️ 写成**具名 async 函数**（本 bundle 已大量使用 `async (…) =>`，语法无虞）。
 */
const NEW = `readActiveProvider: async (canonicalId) => {
            // ${MARK} —— 先问新端点（转发一开始就写，最实时）。
            //   ⚠️ 必须 try/catch：callJetHub 失败是 **throw**，不接住就轮不到回退。
            try {
              const viaRoute = await callJetHub(
                'router.activeRoute',
                canonicalId === undefined ? {} : { provider: canonicalId },
              );
              if (viaRoute?.provider !== null && viaRoute?.provider !== undefined) return viaRoute;
            } catch {
              // 老宿主不认新端点 ⇒ 安静落到下面的旧端点，不打断徽标渲染。
            }
            // ⚠️⚠️ **回退必须传 canonicalId**（不能无参）：无参时宿主回的是
            //    lastActiveProvider（「任意虚拟模型最近一次成功」）⇒ 徽标会显示
            //    **别的模型**走过的渠道（用户 2026-10-16 报障的成因）。
            //    有 canonicalId 时宿主读 activeProviderByModel.get(canonicalId)，是分模型的。
            //
            // 为什么需要回退：宿主把 pack.js 缓存在进程内，而「按模型键记录」那处修复
            // 要重启 DSH 才生效；旧端点本就有按模型的历史数据 ⇒ 先用起来，
            // 重启后新端点有值，这里自然不再走（两者可叠加，新端点优先）。
            if (canonicalId === undefined) return { provider: null };
            return await callJetHub('aggregate.activeProvider', { canonicalId });
          },`;

const stateOf = (src) => (src.includes(MARK) ? 'patched' : 'clean');

const mode = process.argv[2] || '--check';
const count = (s, n) => s.split(n).length - 1;

if (mode === '--check') {
  let bad = 0;
  for (const f of targets()) {
    if (!fs.existsSync(f)) { console.log(`  ✗ 缺失  ${f}`); bad += 1; continue; }
    const src = fs.readFileSync(f, 'utf8');
    const st = stateOf(src);
    console.log(`  ${st === 'patched' ? '已打补丁 J' : '未打补丁  '}  ${f}`);
    if (st === 'clean') {
      const n = count(src, OLD);
      if (n !== 1) { console.log(`      ✗ 锚点命中 ${n} 次（应为 1）`); bad += 1; }
      else console.log('      ✓ 锚点唯一，可施加');
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}

if (mode === '--revert') {
  for (const f of targets()) {
    const bak = `${f}.pre-patch-j`;
    if (!fs.existsSync(bak)) { console.log(`无备份，跳过  ${f}`); continue; }
    fs.copyFileSync(bak, f);
    console.log(`已还原  ${f}`);
  }
  process.exit(0);
}

let changed = 0;
for (const f of targets()) {
  if (!fs.existsSync(f)) { console.log(`跳过（不存在）${f}`); continue; }
  let src = fs.readFileSync(f, 'utf8');
  if (stateOf(src) === 'patched') { console.log(`补丁 J 已在，跳过  ${f}`); continue; }

  const n = count(src, OLD);
  if (n !== 1) {
    console.error(`✗ ${f}：锚点命中 ${n} 次（应为 1）—— 上游结构可能已变，拒绝改动。`);
    process.exit(1);
  }
  if (!fs.existsSync(`${f}.pre-patch-j`)) fs.copyFileSync(f, `${f}.pre-patch-j`);

  src = src.replace(OLD, NEW);

  // ── 落盘前守卫（任一不满足就不写）─────────────────────────────────────────
  if (!src.includes("callJetHub('aggregate.activeProvider', { canonicalId })")) {
    throw new Error(`${f}: 施加后找不到旧端点回退调用，拒绝写入`);
  }
  /**
   * ⚠️ 用**正则**而不是字面量核对缩进（真实教训）：我最初写成
   *    `src.includes("callJetHub(\n              'router.activeRoute'")`（14 空格），
   *    而行 92 实际是 **16 空格** ⇒ 守卫误报「新端点调用丢失」并拒绝写入，
   *    而**替换本身是对的**。字面量守卫必须与生成文本逐字对齐，很容易随
   *    排版调整而失效 ⇒ 这里只核对语义（是不是还有 `'router.activeRoute'` 这个端点名）。
   */
  if (!/callJetHub\(\s*'router\.activeRoute'/.test(src)) {
    throw new Error(`${f}: 施加后新端点调用丢失，拒绝写入`);
  }
  // ⚠️ 回退**必须**带上 canonicalId —— 无参回退会复现「显示别的模型」那个报障。
  if (/callJetHub\('aggregate\.activeProvider', \{\}\)/.test(src)) {
    throw new Error(`${f}: 回退调用没有传 canonicalId（会复现「显示别的模型的渠道」缺陷），拒绝写入`);
  }
  fs.writeFileSync(f, src);
  changed += 1;
  console.log(`已打补丁 J（徽标读数双端点回退）  ${f}`);
}
console.log(`\n完成：改动 ${changed} 个文件。回滚：node patch-badge-fallback.mjs --revert`);
