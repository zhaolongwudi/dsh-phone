#!/usr/bin/env node
/**
 * 补丁 H：聚合面板的**候选三态**（修「非临期候选的开关点了没用」真实缺陷）。
 *
 * ## 缺陷是什么（受控实验证实的）
 *
 * 宿主为每个候选下发两个字段：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `state` | `'allowed'` / `'rejected'` / `'default-rejected'` —— **三态门控** |
 * | `rejected` | `state !== 'allowed'` —— 即「**当前不参与轮换**」（含默认不参与） |
 *
 * 而 npm 版客户端（`dsh-providers-hub@1.6.261016`）**从不读 `state`**：
 *
 *   1. `rejectionsFromCatalog()` 按 `rejected === true` 摊平拒绝表 ⇒ 把
 *      **「未接入临期折算 ⇒ 默认不参与」**的候选也摊了进去 ⇒ 面板显示**「已拒绝」**
 *      （用户从没点过）—— **面板在撒谎**；
 *   2. 点那个开关时一律发 `aggregate.setRejected { rejected: false }` ——
 *      对这类候选**删的是一个根本不存在的拒绝键** ⇒ 宿主状态**纹丝不动**。
 *
 * ## 受控实验（本机实测，可复跑）
 *
 * 以 `glm-5-3-flash` 的 `qoder/gfmodel`（`expiryWired:false`）为例：
 *
 * ```
 * 【1】基线                                state=default-rejected  rejected=true
 * 【2】setRejected {rejected:false}  → ok   state=default-rejected  ❌ 没变（死开关）
 * 【3】setAllowed  {allowed:true}    → ok   state=allowed           ✅ 这才是「手工打开」
 * 【4】setAllowed  {allowed:false}   → ok   state=default-rejected  （回滚）
 * ```
 *
 * 全库当前分布：**145 条 `allowed` / 38 条 `default-rejected`**
 * ⇒ 有 38 条候选的开关是**点了没反应**的。
 *
 * ## 修法（照抄上游的权威实现，不自己发明）
 *
 * gitee 上游 `plugin-src/client/aggregate-panel-logic.js` 已有正确实现
 *（`candidateToggleAction` / `candidateStateOf` / `rejectionsFromCatalog`），
 * 且其注释明确记录了这个缺陷的两次修订（2026-10-15 加 `state`、老宿主回退）。
 * 本补丁把那三个纯函数的语义**逐条搬进** OFM 的 `client.js`：
 *
 * - `rejectionsFromCatalog`：**只有 `state === 'rejected'` 才算用户显式拒绝**；
 *   老宿主（响应无 `state`）回退到只看 `rejected`（否则升级期用户存过的拒绝状态全丢）。
 * - 开关**写哪张表**由 `state` 决定：
 *   `rejected` → 删拒绝；`allowed` → 未接入的写白名单 `false`、已接入的写拒绝；
 *   `default-rejected`（及未知值）→ **写白名单 `true`**（= 「手工打开」）。
 * - 文案按三态说真话：`已拒绝` / `参与轮换` / **`默认不参与`**。
 *
 * ⚠️ 未知/畸形 `state` **不得**走 `allowed` 分支 —— 那会发出 `allowed:false`，
 *   把「读不懂的状态」写成用户明确不允许（上游注释专门记了这条）。
 *
 * 用法：
 *   node patch-aggregate-toggle.mjs --check
 *   node patch-aggregate-toggle.mjs --apply
 *   node patch-aggregate-toggle.mjs --revert
 *
 * ⚠️⚠️ **`--revert` 会还原 `targets()` 里的全部文件（默认含线上那份）**。
 *    2026-10-16 真的踩过：我想在副本上演练整条补丁链，跑了
 *    `patch-badge-port.mjs --revert`（那个脚本**没有** target 覆盖）⇒ 它把**线上**
 *    的 F 补丁一起还原了（`client.js` 1350964 → 454747 字节，F/G 全没）。
 *    所幸各补丁的 `.pre-patch-*` 备份就是天然的恢复点：
 *    `client.js.pre-patch-h` 正是「F+G 完好、H 未打」那一版，拷回即复原。
 *    ⇒ **演练请在副本目录里跑**（或用 `OFM_H_TARGETS` 指向副本），不要对线上跑 revert。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME || '/data/data/com.dshphone/files/dsh-home';
const PROFILE = path.join(HOME, 'profiles/phone/node_modules');
const LOCAL = '/storage/emulated/0/Download/dsh/ai/_ofm/dsh-our-free-model';
const PLUGIN_DIRS = [LOCAL, path.join(PROFILE, 'dsh-our-free-model')];

const MARK = 'patch H: aggregate three-state';

/**
 * 目标 client.js 列表。
 *
 * ⚠️ `OFM_H_TARGETS`（冒号分隔）可覆盖 —— **先对副本验证再动线上文件**：改坏
 * `client.js` 会让整个设置页白屏。
 */
const targets = () => {
  const override = process.env.OFM_H_TARGETS;
  if (override !== undefined && override.length > 0) return override.split(':').filter((s) => s.length > 0);
  return PLUGIN_DIRS.map((d) => path.join(d, 'client.js'));
};

// ── 1) 纯函数：插在 isRejected 之前（与它同层，模块级）────────────────────────
const HELPERS_ANCHOR = 'function isRejected(rejections, canonicalId, provider, realId) {';

const HELPERS = `// ── ${MARK} ─────────────────────────────────────────────────────
// 聚合候选的三态判定与「点哪张表」的唯一判据（照抄 gitee 上游
// plugin-src/client/aggregate-panel-logic.js 的语义，见 patch-aggregate-toggle.mjs）。
//
// ⚠️ 宿主为每个候选下发 \`state\`（\`allowed\`/\`rejected\`/\`default-rejected\`）与
//    \`rejected\`（= \`state !== 'allowed'\`，语义是「**当前不参与轮换**」）。
//    二者**不等价**：未接入临期折算的候选「默认不参与」，那不是用户拒绝。
//    客户端**只渲染宿主下发的 state、不自己判定**（本仓库「同一语义两套判据」红线）。

/** 候选的显示态；老宿主（响应无 \`state\`）回退到拒绝表判据。 */
function candidateStateOf(canonicalId, candidate, rejections) {
  if (typeof candidate?.state === 'string') return candidate.state;
  return isRejected(rejections, canonicalId, candidate?.provider, candidate?.realId) ? 'rejected' : 'allowed';
}

/** 三态的按钮文案（必须**说真话**：默认不参与 ≠ 已拒绝）。 */
function describeCandidateState(state) {
  if (state === 'rejected') {
    return {
      label: '已拒绝',
      title: '你拒绝了这个渠道参与该模型的轮换。点击恢复参与。',
      pressed: false,
      off: true
    };
  }
  if (state === 'allowed') {
    return {
      label: '参与轮换',
      title: '该渠道参与这个模型的轮换。点击拒绝。',
      pressed: true,
      off: false
    };
  }
  // default-rejected 与任何未知/畸形值：都按「当前未参与 ⇒ 可手工打开」呈现。
  return {
    label: '默认不参与',
    title: '该渠道没有可靠的积分到期信息，默认不参与轮换。点击手工打开'
      + '（打开后排在所有能算出临期的候选之后）。',
    pressed: false,
    off: true
  };
}

/**
 * 一条候选的开关**该写哪张表** —— 唯一判据，调用方不得再按 \`expiryWired\` 分支。
 *
 * ⚠️ 未知/畸形 state **不得**沿用 \`allowed\` 分支：那会发 \`allowed:false\`，
 *    等于把「读不懂的状态」写成用户明确不允许。
 */
function candidateToggleAction(canonicalId, candidate, state) {
  const payload = {
    canonicalId,
    provider: candidate?.provider,
    realId: candidate?.realId
  };
  if (state === 'rejected') {
    return { rpc: 'aggregate.setRejected', payload: { ...payload, rejected: false } };
  }
  if (state === 'allowed') {
    // 未接入折算的渠道「不参与」写白名单，已接入的写拒绝表。
    return candidate?.expiryWired === false
      ? { rpc: 'aggregate.setAllowed', payload: { ...payload, allowed: false } }
      : { rpc: 'aggregate.setRejected', payload: { ...payload, rejected: true } };
  }
  return { rpc: 'aggregate.setAllowed', payload: { ...payload, allowed: true } };
}

/**
 * 把 \`aggregate.catalog\` 的响应摊平成拒绝表（\`canonicalId → provider → realId → true\`）。
 *
 * ⚠️⚠️ **只有 \`state === 'rejected'\` 才算用户显式拒绝**（宿主把 \`rejected\` 的语义
 *    收窄成「当前不参与轮换」，它**也**为「默认不参与」的候选返回 \`true\`）。
 *    只看 \`rejected\` 会：① 面板把默认不参与显示成「已拒绝」（撒谎）；
 *    ② 用户点「参与」时发 \`rejected:false\`，对未接入渠道**语义错位且无效**。
 *
 * ⚠️ **兼容老宿主**（响应里没有 \`state\`）：那时 \`rejected\` 的旧语义**就是**
 *    「用户显式拒绝」⇒ 必须回退到只看 \`rejected\`，否则升级期用户存过的拒绝状态
 *    会**全部消失**（界面显示全部参与）。
 */
function rejectionsFromCatalog(catalog) {
  const out = {};
  const models = catalog?.models;
  if (!Array.isArray(models)) return out;
  for (const model of models) {
    const canonicalId = model?.canonicalId;
    if (typeof canonicalId !== 'string' || canonicalId.length === 0) continue;
    if (!Array.isArray(model.candidates)) continue;
    for (const candidate of model.candidates) {
      if (candidate?.rejected !== true) continue;
      // state 是字符串时以它为准（只有 'rejected' 才算显式拒绝）；否则回退旧判据。
      if (typeof candidate.state === 'string' && candidate.state !== 'rejected') continue;
      const provider = candidate.provider;
      const realId = candidate.realId;
      if (typeof provider !== 'string' || provider.length === 0) continue;
      if (typeof realId !== 'string' || realId.length === 0) continue;
      if (!Object.hasOwn(out, canonicalId)) out[canonicalId] = {};
      if (!Object.hasOwn(out[canonicalId], provider)) out[canonicalId][provider] = {};
      out[canonicalId][provider][realId] = true;
    }
  }
  return out;
}
`;

// ── 2) 旧的 rejectionsFromCatalog 整块删除（已被上面那份替代）─────────────────
const OLD_REJECTIONS = `function rejectionsFromCatalog(models) {
  const out = {};
  if (!Array.isArray(models)) return out;
  for (const model of models) {
    const canonicalId = model?.canonicalId;
    if (typeof canonicalId !== "string" || canonicalId.length === 0) continue;
    if (!Array.isArray(model.candidates)) continue;
    for (const candidate of model.candidates) {
      if (candidate?.rejected !== true) continue;
      const provider = candidate.provider;
      const realId = candidate.realId;
      if (typeof provider !== "string" || provider.length === 0) continue;
      if (typeof realId !== "string" || realId.length === 0) continue;
      if (!Object.hasOwn(out, canonicalId)) out[canonicalId] = {};
      if (!Object.hasOwn(out[canonicalId], provider)) out[canonicalId][provider] = {};
      out[canonicalId][provider][realId] = true;
    }
  }
  return out;
}
`;

// ── 3) 开关：按 state 决定写哪张表 ───────────────────────────────────────────
const OLD_TOGGLE = `  const onToggleRejected = React2.useCallback(async (canonicalId, provider, realId) => {
    const next = !isRejected(rejections, canonicalId, provider, realId);
    setRejections((prev) => toggleRejection(prev, canonicalId, provider, realId, next));
    try {
      const res = await rpcCall("aggregate.setRejected", {
        canonicalId,
        provider,
        realId,
        rejected: next
      });
      await load(true);
      setNotice(null);
    } catch (caught) {
      setNotice(\`保存失败：\${caught?.message ?? String(caught)}\`);
      await load();
    }
  }, [rejections, rpcCall, load]);`;

const NEW_TOGGLE = `  const onToggleRejected = React2.useCallback(async (canonicalId, candidate) => {
    // ${MARK} —— 写哪张表由三态决定（未接入渠道的「不参与」在**白名单**里，不在拒绝表）。
    // ⚠️ 原先一律发 setRejected{rejected:!rejected}：对 default-rejected 候选删的是
    //    一个不存在的键 ⇒ 宿主纹丝不动 ⇒ 开关点了没反应（受控实验证实）。
    const state = candidateStateOf(canonicalId, candidate, rejections);
    const action = candidateToggleAction(canonicalId, candidate, state);
    // 乐观更新只作用于**拒绝表**那一半；白名单侧由随后的 load(true) 回填
    //（两边都乐观改会出现两份互相打架的状态）。
    if (action.rpc === "aggregate.setRejected") {
      setRejections((prev) => toggleRejection(
        prev,
        canonicalId,
        candidate.provider,
        candidate.realId,
        action.payload.rejected === true
      ));
    }
    try {
      await rpcCall(action.rpc, action.payload);
      await load(true);
      setNotice(null);
    } catch (caught) {
      setNotice(\`保存失败：\${caught?.message ?? String(caught)}\`);
      await load();
    }
  }, [rejections, rpcCall, load]);`;

// ── 4) 候选行：按三态渲染（文案说真话 + 传 candidate 给开关）──────────────────
const OLD_RENDER_HEAD = `  const renderCandidate = (canonicalId, candidate) => {
    const rejected = isRejected(rejections, canonicalId, candidate.provider, candidate.realId);
    const expiry = expiryOrder === null ? void 0 : expiryOrder[candidate.provider];`;

const NEW_RENDER_HEAD = `  const renderCandidate = (canonicalId, candidate) => {
    // ${MARK} —— 三态来自**宿主下发的** state（客户端只渲染、不判定）。
    const state = candidateStateOf(canonicalId, candidate, rejections);
    const view = describeCandidateState(state);
    const rejected = state !== "allowed";
    const expiry = expiryOrder === null ? void 0 : expiryOrder[candidate.provider];`;

const OLD_BUTTON = `      React2.createElement("button", {
        type: "button",
        className: "dim-jh-aggToggle" + (rejected ? " dim-jh-aggToggleOff" : ""),
        // ⚠️ 语义是「**参与**轮换」的正向开关，与用户直觉一致：
        //    打开 = 允许用这个渠道；关闭 = 不同意参与轮换（规格 §7.1 的原话）。
        "aria-pressed": String(!rejected),
        title: rejected ? "已拒绝：该渠道不参与这个模型的轮换" : "参与轮换",
        onClick: () => {
          void onToggleRejected(canonicalId, candidate.provider, candidate.realId);
        }
      }, rejected ? "已拒绝" : "参与轮换")`;

const NEW_BUTTON = `      React2.createElement("button", {
        type: "button",
        className: "dim-jh-aggToggle" + (view.off ? " dim-jh-aggToggleOff" : ""),
        // ⚠️ 语义是「**参与**轮换」的正向开关，与用户直觉一致：
        //    打开 = 允许用这个渠道；关闭 = 不同意参与轮换（规格 §7.1 的原话）。
        // ⚠️ ${MARK}：文案/标题按**三态**给（默认不参与 ≠ 已拒绝 —— 面板必须说真话）。
        "aria-pressed": String(view.pressed),
        title: view.title,
        onClick: () => {
          void onToggleRejected(canonicalId, candidate);
        }
      }, view.label)`;

// ── 5) load() 的调用点：响应是 { models }，摊平函数签名随之改 ─────────────────
const OLD_LOAD_CALL = `      const res = await rpcCall("aggregate.catalog", { force });
      const models2 = res?.models ?? [];
      setModels(models2);
      setRejections(rejectionsFromCatalog(models2));`;

const NEW_LOAD_CALL = `      const res = await rpcCall("aggregate.catalog", { force });
      const models2 = res?.models ?? [];
      setModels(models2);
      // ${MARK} —— 传**整个响应**（摊平函数要按 state 判，见那里的长注释）。
      setRejections(rejectionsFromCatalog({ models: models2 }));`;

const EDITS = [
  { name: 'H1 三态纯函数（新增，插在 isRejected 前）', kind: 'insert-before', anchor: HELPERS_ANCHOR, text: HELPERS },
  { name: 'H2 摊平拒绝表：删旧实现', kind: 'remove', text: OLD_REJECTIONS },
  { name: 'H3 开关：按 state 写正确的表', kind: 'replace', from: OLD_TOGGLE, to: NEW_TOGGLE },
  { name: 'H4 候选行：三态渲染', kind: 'replace', from: OLD_RENDER_HEAD, to: NEW_RENDER_HEAD },
  { name: 'H5 候选行：按钮（文案 + 传 candidate）', kind: 'replace', from: OLD_BUTTON, to: NEW_BUTTON },
  { name: 'H6 load()：摊平函数入参改为整个响应', kind: 'replace', from: OLD_LOAD_CALL, to: NEW_LOAD_CALL },
];

const mode = process.argv[2] || '--check';
const count = (s, needle) => s.split(needle).length - 1;

/**
 * 单文件状态：'patched' | 'superseded' | 'clean'。
 *
 * ⚠️ **补丁 I 会取代本补丁（H）**：两者改的是**同一段**
 * （聚合候选的三态判定与开关回调）。补丁 I 把整块换成 gitee 排序版，
 * 那里**已包含** H 的全部语义（且多一个 `expiryWired === false` 分支，
 * 参见 `gitee-client-src/aggregate-panel-logic.js` 的 `candidateToggleAction`）。
 *
 * ⇒ 打了 I 之后再跑 H 的 `--check`，若仍按「锚点找不到 ⇒ 失败」报，
 *    会让人误以为**坏了**。故显式识别为 `superseded`（**信息，不是错误**）。
 */
const stateOf = (src) => {
  if (src.includes(MARK)) return 'patched';
  if (src.includes('patch I: aggregate ordering')) return 'superseded';
  return 'clean';
};

/** 对一份源码做「能不能安全施加」的预检，返回问题清单。 */
function precheck(src) {
  const problems = [];
  if (src.includes(MARK)) return problems; // 已打，无需检查
  // 已被补丁 I 取代 ⇒ 不是问题（I 的语义是 H 的超集）。
  if (src.includes('patch I: aggregate ordering')) return problems;
  for (const e of EDITS) {
    if (e.kind === 'insert-before') {
      const n = count(src, e.anchor);
      if (n !== 1) problems.push(`${e.name}：锚点命中 ${n} 次（应为 1）`);
    } else if (e.kind === 'remove') {
      const n = count(src, e.text);
      if (n !== 1) problems.push(`${e.name}：待删块命中 ${n} 次（应为 1）`);
    } else {
      const n = count(src, e.from);
      if (n !== 1) problems.push(`${e.name}：锚点命中 ${n} 次（应为 1）`);
    }
  }
  // 关键守卫：改动后 setAllowed 必须真的被调用（否则「手工打开」仍不可达）。
  return problems;
}

if (mode === '--check') {
  let bad = 0;
  for (const f of targets()) {
    if (!fs.existsSync(f)) { console.log(`  ✗ 缺失  ${f}`); bad += 1; continue; }
    const src = fs.readFileSync(f, 'utf8');
    const st = stateOf(src);
    const label = st === 'patched' ? '已打补丁 H'
      : st === 'superseded' ? '已被补丁 I 取代（I 含 H 全部语义，正常）'
        : '未打补丁  ';
    console.log(`  ${label}  ${f}`);
    if (st === 'clean') {
      const problems = precheck(src);
      for (const p of problems) { console.log(`      ✗ ${p}`); bad += 1; }
      if (problems.length === 0) console.log('      ✓ 锚点齐备，可施加');
    }
  }
  process.exit(bad > 0 ? 1 : 0);
}

if (mode === '--revert') {
  for (const f of targets()) {
    const bak = `${f}.pre-patch-h`;
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
  const st = stateOf(src);
  if (st === 'patched') { console.log(`补丁 H 已在，跳过  ${f}`); continue; }
  /**
   * ⚠️⚠️ 已被补丁 I 取代时**必须跳过**（真实风险）：I 的产物里已没有 H 的锚点。
   * 继续往下走有两个坏结果：
   *   ① `precheck` 因「锚点找不到」而报错 ⇒ 看起来像坏了（其实正常）；
   *   ② 更糟：`--apply` 只在 `!existsSync(.pre-patch-h)` 时备份 —— 若那份备份已被
   *      清理，就会**把 I 的产物当原始文件备份**，回滚再也回不到干净版。
   * ⇒ 直接跳过并说明，让用户知道这是**正常状态**。
   */
  if (st === 'superseded') {
    console.log(`补丁 I 已取代 H（I 含 H 全部语义），跳过  ${f}`);
    continue;
  }

  const problems = precheck(src);
  if (problems.length > 0) {
    console.error(`✗ ${f}：`);
    for (const p of problems) console.error(`    ${p}`);
    console.error('  拒绝改动（上游结构可能已变）。');
    process.exit(1);
  }

  if (!fs.existsSync(`${f}.pre-patch-h`)) fs.copyFileSync(f, `${f}.pre-patch-h`);

  for (const e of EDITS) {
    if (e.kind === 'insert-before') {
      src = src.replace(e.anchor, `${e.text}${e.anchor}`);
    } else if (e.kind === 'remove') {
      src = src.replace(e.text, '');
    } else {
      src = src.replace(e.from, e.to);
    }
    console.log(`  已施加  ${e.name}`);
  }

  // 落盘前守卫：「手工打开」的端点必须真的可达。
  if (!src.includes("'aggregate.setAllowed'") && !src.includes('"aggregate.setAllowed"')) {
    throw new Error(`${f}: 施加后仍找不到 aggregate.setAllowed，拒绝写入`);
  }
  fs.writeFileSync(f, src);
  changed += 1;
  console.log(`已打补丁 H  ${f}\n`);
}
console.log(`完成：改动 ${changed} 个文件。回滚：node patch-aggregate-toggle.mjs --revert`);
