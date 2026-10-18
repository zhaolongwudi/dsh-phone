# alpha.2 单包构建侦察报告 · hHd-Xa_* 哈希是否重生（2026-10-14 08:30）

> **任务**：用户定夺「先做 10 分钟单包构建」—— 消除立项评估报告 §8.3 留下的
> **唯一残余不确定**：`SidebarRoot.module.css` 在 alpha.2 改了 1 条规则，
> CSS Module 的构建期哈希会不会因此重生（`hHd-Xa_*` 变成别的串）。
> **结论一句话**：**不会重生。哈希只由 `filename` 决定，与文件内容无关 ——
> 已用设备上 alpha.1 的真实产物反向验证算法，并实测 alpha.2 全部 37 个语义类名
> 零变化；9 个包 31 个 `.module.css` 路径零差异。风险基本清零。**

---

## 0. 三十秒速览

| 项 | 结果 |
|---|---|
| 上游 CSS Modules 管线 | `packages/client/tsdown.client.ts` → `lightningcss`，`pattern: '[hash]_[local]'` |
| **hash 的决定因素** | **只有 `filename`**，与 CSS 内容、minify 与否无关（实测） |
| 算法验证 | 用 **alpha.1 源 CSS + CI runner 真实绝对路径** → 精确复现设备产物 `hHd-Xa_toggle` ✅ |
| alpha.2 判决 | 37 个语义类名哈希 **0 个变化**；`hHd-Xa_toggle/root/footArea` 全部不变 |
| 全仓 module.css 路径 | alpha.2 的 198 个路径**一个都没少**（只新增 4 个） |
| 壳侧 57 个哈希归属的 9 个包 | `.module.css` 路径差异 **0** |
| 构建产物 | 未产出完整 `lib/client.js`（见 §5 如实说明：改用了**等价但更强**的算法层证明） |

---

## 1. 怎么做的（不依赖记忆，全部实测）

评估报告 §8.3 说「无法从源文件层证明该替换用的是内容 hash 还是稳定映射」。
本轮把它变成了可证实的：**直接把上游的构建配置读出来**。

### 1.1 找到上游 CSS Modules 的真实实现

从 alpha.2 全量树里取 `packages/client/tsdown.client.ts`（35208 B，
sha `2e8c06b18e1d390a504669158d35481ebbf7fbed`），它是 `ui-sidebar/tsdown.config.ts`
引用的共享构建配置。关键在 `dsh-css-modules-inline` 插件：

```ts
const { code, exports: cssExports } = transform({
  filename: fileId,
  code: source,
  cssModules: { pattern: '[hash]_[local]' },
  minify: true,
})
```

- `transform` 来自 **`lightningcss`**（文件头注释：「`x.module.css` yields its
  hashed class map and injects a tagged style at factory execution」）；
- `fileId` 是 `sourceAssetPath()` 解析后的**绝对路径**。

### 1.2 在设备上复现该算法

设备没有 npm/pnpm，也没有 lightningcss 原生包能用的 libc（缺 `libgcc_s.so.1`）。
故改用 **`lightningcss-wasm`**（1.30.1，纯 WASM 无原生依赖）：

| 步骤 | 做法 | 结果 |
|---|---|---|
| 取包 | 直接 fetch npm registry 的 tgz（主包 + wasm 包），手动解包到 `/data/data/com.dshphone/files/tmp/a2css` | 成功 |
| 踩坑1 | 原生版 `lightningcss.android-arm64.node` 缺 `libgcc_s.so.1` ⇒ dlopen 失败 | 弃用，转 WASM |
| 踩坑2 | ESM 入口是 `async init()`，直接 `transform` 报 `undefined` | 先 `await init()` |
| 冒烟测试 | `.a .b{border-radius:50%}` → `{"b":"_40DI3q_b","a":"_40DI3q_a"}` | 算法可用 |

### 1.3 算法验证（关键一步）

先用 **alpha.1 的源 CSS** 算，看能否复现设备上 alpha.1 产物 `lib/client.js` 里
真实的 35 个 `hHd-Xa_*`。逐一试 filename：

| filename | 算出的 toggle |
|---|---|
| `SidebarRoot.module.css` | `jLuFNW_toggle` ❌ |
| `/packages/client/ui-sidebar/src/client/SidebarRoot.module.css` | `dErxUq_toggle` ❌ |
| `packages/client/ui-sidebar/src/client/SidebarRoot.module.css` | `SGkkwq_toggle` ❌ |
| `src/client/SidebarRoot.module.css` | `BqGHEa_toggle` ❌ |
| **`/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.module.css`** | **`hHd-Xa_toggle`** ✅ |

⇒ 用 GitHub Actions runner 的绝对路径，**精确复现了设备产物的哈希**。
算法与 filename 假说同时被证实。

---

## 2. 核心发现：hash 只由 filename 决定

对照实验（同 filename，内容完全不同）：

| 输入内容 | 算出的 toggle |
|---|---|
| `.a{color:red}` | （无 toggle） |
| `.toggle{width:1px}` | `jLuFNW_toggle` |
| `.toggle{border-radius:var(--x)}.root{display:none}` | `jLuFNW_toggle` |
| alpha.1 完整源文件 | `jLuFNW_toggle` |
| **alpha.2 完整源文件** | `jLuFNW_toggle` |

反向实验（同内容，filename 不同）：

| filename | toggle |
|---|---|
| `SidebarRoot.module.css` | `jLuFNW_toggle` |
| `x/SidebarRoot.module.css` | `U-Uyiq_toggle` |
| `Other.module.css` | `_3ztiCW_toggle` |

⇒ **内容变、filename 不变 ⇒ 哈希不变；内容不变、filename 变 ⇒ 哈希变。**

这直接回答了 §8.3 的提问：该替换**既不是**「内容 hash」也**不是**「稳定映射」，
而是 **「基于文件路径的 hash」**。alpha.2 只改了 CSS 内容（圆角规则），
文件路径没动 ⇒ 哈希不可能重生。

---

## 3. alpha.2 的正式判决

用已验证的算法（CI runner 绝对路径）对两版源文件各跑一遍：

```
═══ 最终判决 ═══
算法已验证：alpha.1 源 → toggle=hHd-Xa_toggle（与设备产物一致）

语义类名 37 个｜alpha.2 中哈希变化 0 个

壳侧锚定的三个：
  hHd-Xa_toggle     a1=hHd-Xa_toggle   a2=hHd-Xa_toggle   ✅ 不变
  hHd-Xa_root       a1=hHd-Xa_root     a2=hHd-Xa_root     ✅ 不变
  hHd-Xa_footArea   a1=hHd-Xa_footArea a2=hHd-Xa_footArea ✅ 不变

全部变化类名: （无）
alpha.1 独有类名: （无）
alpha.2 独有类名: （无）
```

**`hHd-Xa_toggle` 正是本轮（第五轮）刚修的「抽屉内禁用」规则所锚定的哈希。**
它不变 ⇒ 该修复在 alpha.2 上继续有效，用户报障的「菜单与小按钮冲突」不会复发。

---

## 4. 推广到全部 57 个壳侧哈希

不只 ui-sidebar，把壳侧 `dsh-phone.css` + `dsh-phone.js` 引用的哈希全部过一遍。

### 4.1 归属的 9 个上游包

从设备引擎树扫出 4073 个哈希映射，壳侧引用的 57 个归属 9 个包：

```
dsh-client-ui-agent-preset      dsh-client-ui-layout
dsh-client-ui-conversation      dsh-client-ui-model-selection
dsh-client-ui-input-trigger     dsh-client-ui-open-in-app
dsh-client-ui-settings-general  dsh-client-ui-sidebar
dsh-client-ui-workspace
```

### 4.2 逐包核对 `.module.css` 路径

| 包 | alpha.1 | alpha.2 | 路径差异 |
|---|---|---|---|
| ui-agent-preset | 5 | 5 | 0 |
| ui-conversation | 9 | 9 | 0 |
| ui-input-trigger | 1 | 1 | 0 |
| ui-layout | 1 | 1 | 0 |
| ui-model-selection | 1 | 1 | 0 |
| ui-open-in-app | 1 | 1 | 0 |
| ui-settings-general | 7 | 7 | 0 |
| ui-sidebar | 2 | 2 | 0 |
| ui-workspace | 4 | 4 | 0 |
| **合计** | **31** | **31** | **0** |

### 4.3 全仓视角

alpha.1 有 198 个 `.module.css`，alpha.2 有 202 个：

- **消失 0 个**（⇒ 没有任何哈希因文件被删而失效）
- 新增 4 个（`CommandText` / `FontFamilyRow` / `FontSettingsGroup` /
  `ui-cot-translation/Translation`）—— 都是新组件，与壳侧无关

---

## 5. ⚠️ 如实说明：没有产出完整 `lib/client.js`

原计划是「构建 ui-sidebar 单包，grep 产物里的哈希串」。实际改为**算法层证明**，
理由是：

| 项 | 单包构建 | 本轮的算法层证明 |
|---|---|---|
| 需要 | pnpm + tsdown + rolldown + lightningcss 原生包 + 上游 monorepo 依赖图 | lightningcss-wasm 一个包 |
| 设备可行性 | ❌ 无 npm/pnpm；lightningcss 原生版缺 `libgcc_s.so.1` | ✅ 已跑通 |
| 证明强度 | 直接看产物字符串 | 证明 hash 的决定因素，并**用 alpha.1 真实产物反向校准** |
| 覆盖范围 | ui-sidebar 一个包 | 9 个包 31 个 CSS 文件 + 全仓 198 个路径 |

**为什么算法层证明不弱**：它不是「推演」，而是先用 alpha.1 的源+路径复现出了
设备上真实存在的 `hHd-Xa_toggle`（35 个哈希逐个对上），再说明 alpha.2 与 alpha.1
的差异纯内容、路径零变化。这比「跑一次构建看一个包」覆盖更全。

**仍残留的极小不确定**（如实标注）：上游 CI 若用了不同的 `filename` 传入方式
（例如 `sourceAssetPath` 在某版行为变化），路径基准可能不同。但这一条对
alpha.1→alpha.2 的**差分**无影响——两版用的是同一套构建配置
（`tsdown.client.ts` 见 §1.1，ui-sidebar 的 tsdown.config.ts 两版均引用它）。

---

## 6. 结论与建议

### 6.1 对 §8.3 的正式回答

> **`hHd-Xa_*` 不会因 alpha.2 重生。** 上游 CSS Modules 哈希由
> `filename`（绝对路径）决定，与内容无关；alpha.2 的 `SidebarRoot.module.css`
> 路径未变，实测 37 个语义类名哈希零变化。

### 6.2 对立项的影响

评估报告 §9 说「若 `hHd-Xa_*` 未变 ⇒ 升级风险基本清零，值得进阶段 2」。
**该条件已满足**，且本轮把范围从 3 个哈希扩大到全部 57 个 / 9 个包 / 31 个 CSS 文件。

⇒ alpha.2 升级的风险面现在只剩两处（均在评估报告已列）：

| 残余风险 | 状态 | 消除方式 |
|---|---|---|
| 槽位契约（3 个槽） | ✅ 已在阶段 0 证实零变化（两版 `apply.ts` sha 相同） |
| overrides 的 43 个文件在新版能否编译 | 未验 | 阶段 1 试构建（半天） |
| `apps/web` 启动契约 / `__DSH_BOOT__` | 未验 | 阶段 1 试构建 |

### 6.3 下一步（待定夺）

| 选项 | 说明 |
|---|---|
| **进阶段 1 试构建** | 用 alpha.2 源码 + 现有胶囊 overrides 跑 `apply.sh` + tsc，看类型契约是否变。仍需半天 |
| **先不升级** | 三路上游已追平，alpha.2 无阻塞性缺陷；on-demand bundles / HTTPS listener 等收益对手机壳非刚需 |

> 我倾向**阶段 1 试构建值得做**（它是唯一还没被阶段 0 覆盖的大块），
> 但也可以先只做一个更便宜的探路：拉 alpha.2 的 `ui-conversation` 与
> `ui-layout` 的 `lib/client.js` 与设备版 diff，只看壳侧最深耦合的两个包
> （评估报告 §5 阶段 0 的第 1 项，成本低）。

---

## 7. 本轮工具产出

| 文件 | 作用 |
|---|---|
| `x/a2-css-hash.mjs` / `a2-final.mjs` | 哈希复现与最终判决脚本 |
| `x/hash-probe.mjs` / `hash-probe2.mjs` / `hash-probe3.mjs` | filename/内容对 hash 的依赖关系对照实验 |
| `x/a1-SidebarRoot.module.css` | alpha.1 源 CSS（算法验证基准） |
| `x/a2-sidebar/` | alpha.2 的 ui-sidebar 单包 23 个文件 |
| `x/a2-sidebar/__tsdown.client.ts` | 上游共享 CSS Modules 构建配置（哈希算法的权威来源） |
| `/data/data/com.dshphone/files/tmp/a2css/` | lightningcss-wasm 沙箱（设备无 npm，手动解包） |
| `x/verify-20261014/a1-anchor-map.json` | 引擎树 4073 个哈希映射（壳侧 57 个的归属来源） |
