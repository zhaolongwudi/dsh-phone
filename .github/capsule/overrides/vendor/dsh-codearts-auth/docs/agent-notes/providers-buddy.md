<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## 模型计费倍率与同名模型（必须写进 `name`，不是 `description`）

**倍率必须拼进 `name`。** 这是被用户报障纠正过的结论：

- composer 的**模型切换菜单只渲染 `name`** —— `dsh-client-ui-model-selection`
  的 ModelSelect 里只有 `title: model.name` 与 `children: model.name`，
  **完全不读 `description`**。
- `description` 只在 **`/model` 弹窗**里用（`optionsOf` 的 `detail`，渲染成
  `提供方 · description`）。

**真实缺陷**（用户报障）：「消耗倍率没有显示在切换模型列表的后面」——
早期版本把倍率放进 `description`（因为误以为那是"唯一的展示位"），
结果在切换菜单里根本不可见。

安全性：`name` **纯属展示**，DSH 的选择与持久化只用 `id`
（`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话历史。

展示形态：`Deepseek-V4.1-Flash · x0.03`；有促销时 `GLM-5.3 · x0.79→x0.50`
（箭头比「（促销 …）」短，适合窄菜单）。

三套远端的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 | 归一化 |
|---|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前），早期带 `"x0.03 credits"` 后缀，可为空串 | `normalizeCreditsRate` |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）**，已结束占位为 `"0x"` | `normalizeDiscountedRate` |
| `lobsterai` | `data[].costMultiplier` | **裸数字 `0.05`** | `displayNameFor` 里拼 `x${n}` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = **免费**，另有 `original_price_factor` + `promotion` | `qoderDisplayName` |
| `trae` | `display_contact_config.consumption_rate.data.rate`（**该字段本身是 JSON 字符串，须二次 `JSON.parse`**） | **裸数字** `0.08`；`0` = 免费；`enable:false` = 无倍率 | `traeDisplayName`（活动期拼 `x原价→x折后价`） |
| `codearts` | 无 | 两个目录端点都不含计费字段 | — |

要点与坑：

- ⚠️ **`credits` 与 `discountedCredits` 的 x 位置相反**（`"x0.29"` vs `"0.50x"`）。
  早期版本只认前缀写法，导致**促销价全部静默丢失** —— 单测直接暴露了它。
  两个 `normalize*` 函数各自接受两种写法（对上游格式变更更鲁棒）
- ⚠️ **两个端点下发的模型 id 集合不同，必须取并集**（实测 2026-09-21，
  账号 `3C656A62`）：
  ```
  scoped     → hy4-preview, hy4-preview-x   （30 个模型）
  /v3/config → hy4-preview-f                （22 个模型）
  促销 modelIds → ["hy4-preview-f"]         ← 只挂在 v3/config 独有的那个 id 上
  ```
  而 `hy4-preview-f`（新用户限时免费变体）**被 craft/ask/plan 三个 agent 引用**
  —— 服务端明确说它可选。早期只返回 scoped，于是该促销永远对不上，
  界面显示 `x0.29` 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费
  我们还是 0.29」）。**不同账号下发的变体 id 也不同**（另一账号两端都是
  `hy4-preview`，所以它没暴露这个问题）—— 排查时**必须多账号对照**
- ⚠️ **`reconcileWithFallback` 是白名单式重建，会丢弃不在兜底表的 id** ——
  上面那个 `hy4-preview-f` 正因此被丢掉。判据用 **`agentReferenced`**
  （服务端自己的「可选」信号，由 `parseModelsFromConfig` 收集**全部** agent
  的引用），**不要猜 id 后缀**：`-f` / `-x` / `-sg` / `-ioa` 含义各异，
  猜错会放进不可用的模型。追加时放在**末尾**，不打乱兜底表顺序。
  ⚠️ `auto` 与 **`default`** 是同类内部别名（都不被 agent 引用），
  由 `isAutoSelectAlias` 过滤；但**不要前缀匹配** —— 会误伤国际版
  被 craft 引用的 `default-model` / `fast-model` 等抽象别名
- ⚠️ **促销只由 `/v3/config` 下发，企业模型端点（scoped）没有**（实测 2026-09-21：
  scoped 的 25948 字符响应里 `discount` / `promo` / `0.50x` 出现 **0 次**）。
  而 scoped 被**优先返回** → 早期实现直接 `return scoped`，于是**促销永远不显示**
  （用户报障「codebuddy 的倍率显示也是没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。
  现补一次 `/v3/config` 并**同时取它的模型与促销表**（失败不影响列表）
- ⚠️ **必须按 `schedule` 本地推算此刻是否生效，不能只看 `enabled`**：
  实测 `glm-5.2` 有两条**互补**活动（夜间 `23:00–7:50` 带 `0.50x`、
  白天 `7:50–23:00` 只带角标）。不看时段就按 priority 恒定取夜间那条 →
  **白天也显示折扣价**，用户按折扣价预期却被按原价计费。
  时段字段是 `schedule.daily[].{start,end}`（`HH:MM`，**小时可能不补零**如 `7:50`）
  + `schedule.timezone`（用 `Intl` 换算，别硬编码 +8）+ `validFrom`/`validUntil`。
  时区不可解析时**不误杀**（宁可多显示一次折扣）
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**：实测 `hy4-preview` 的夜间活动
  是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
  早期把 `0x` 一律当哨兵丢弃，于是「夜间免费」永远不显示
  （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**「已结束」由有效期表达**。
  防御：**无任何时间窗口**的 `factor: 0` 仍按占位跳过（免费额度必然限时）
- ⚠️ `modelPromotions` 是**数组**（不是对象），且用 `modelIds[]` **按模型关联**
  （不是全局折扣）；同模型命中多个活动时取 `priority` 最高者
- ⚠️ **`/v3/config` 有 UA 校验**：UA 不对返回 `{"code":12403,"msg":"check ua,
  get coding copilot version error"}`（**HTTP 200**，极易误判为「该端点没有促销」）。
  必须带产品的 `userAgent`（CodeBuddy 实测 `CodeBuddyIDE/1.106.1`）
- ⚠️ **LobsterAI 的 `description` 可能已自带倍率文案**（实测 DeepSeek-V4.1-Flash
  写着「分时计价：当前空闲时段 x0.05…」）。前置倍率前必须 `includes` 判重，
  否则出现「x0.05 · …x0.05…」重复
- `reconcileWithFallback` 是**白名单式重建**：新增的远端字段不在此显式搬运就会
  被静默丢弃（`creditsRate` / `discountedCreditsRate` 已加）

### ⚠️ TRAE 思考档位：多通道合并**不得**用空档位条目覆盖有档位的条目（Issue IKI7WT/IKILR7）

**真实缺陷**（用户报障「模型缺少思考强度」）：`parseTraeBatchModelList` 用
**无条件「后面的覆盖前面的」**合并同名模型，其注释假设「后面的条目带着更完整的
配置」——**该假设与真实数据正好相反**。上游把**空档位**的 `solo_work_lite` /
`solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成了更空的条目。
UI 表现为 `TraeAdapter.reasoningFor` 返回 `undefined` → 不声明 `reasoning` →
「当前模型未提供推理等级」。

实测（2026-09-26，`scripts/probe-trae-reasoning-order.ts`）：**13 个模型**丢掉档位
（`deepseek-v4.1-flash` / `glm-5.2` / `glm-5.3` / `kimi-k3` / `qwen3.8-max` /
`DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` …）。修复后目录里
**有档位的模型从 5 个恢复到 15 个**。

同一模型在不同通道的档位**不一致**（这正是「后覆盖前」出事的原因）：

| 通道 | `deepseek-v4.1-flash` 的 `reasoning_effort_config` | 顺序 |
|---|---|---|
| `chat_v3` | `{default:high, options:[light,high,extra_high], support_thinking:true}` | 早 |
| `solo_agent` | 同上，且 `max_tokens` 32000 / `context_window.max` 1000000 / `max_mode:true` | 中 |
| `solo_agent_remote` / `solo_agent_lite` | 同上 | 中 |
| `solo_work_remote` / **`solo_work_lite`** | `{options:[], support_thinking:false}` | **最后** |

修正后的合并规则（三条，见 `parseTraeBatchModelList` 注释）：

1. **空档位不得覆盖有档位**（已选有档位 + 候选无档位 → 保留已选）；
2. **两侧都有档位时按 `channelPriority` 取更靠前者**（默认 `TRAE_CHANNELS`，
   「顺序即优先级」，故通常落到 `solo_agent`）；
3. **其余情形（含两侧都无档位）保持既有「后覆盖前」**，避免与本缺陷无关的
   通道迁移 —— 这条保证 `glm-5.1` / `qwen-3.5` 等无档位模型行为**逐字节不变**。

四个必须记住的点：

- ⚠️ **档位必须与 `function` 同源，整条择优**：发档位的通道必须正是声明支持它的
  通道。**不要**只把 `reasoningConfig` 单独搬运到另一条条目上（例如保留
  `solo_work_lite` 的 `function` 却声明档位）——那是在一个自称
  `support_thinking:false` 的通道上宣布档位。
- ⚠️ **判据必须与 `TraeAdapter.reasoningFor` 完全一致**：配置存在 **且**
  `support_thinking !== false` **且** `options` 非空（`declaresReasoningOptions`）。
  只判「配置存在」会选中 `{support_thinking:false, options:['high']}` 这种
  适配器里仍返回 `undefined` 的条目，**等于没修**。两处改动必须同步。
- ⚠️ **可调用性不受影响**：候选始终只来自**列出了该模型的通道**，故无论选中哪条
  都不会路由到「未列出该模型」的通道（那才会回流内 4001）。已实测：
  `deepseek-v4.1-flash` 通道从 `solo_work_lite` 迁到 `solo_agent` 后，
  不带档位与 `reasoning_effort=extra_high` **各发一次均 HTTP 200、正常返回**。
- ⚠️ **`DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`（无后缀）修好后仍然无档位** ——
  它们**所有**带档位的通道条目都被 `is_invisible_to_user=true` 剔除（官方隐藏），
  只剩 `solo_coder` / `chat` 的可见条目。这是官方可见性，**不是**合并缺陷；
  带 `-Official` 后缀的那两个已正常恢复。

排查/回归：

- `scripts/probe-trae-reasoning-order.ts` —— 按上游顺序回放「后覆盖前」，列出被吃掉的
  模型与修复后的目录（只读，零额度）
- `scripts/probe-trae-merge-replay.ts <模型 id…>` —— 打印指定模型在**全部通道**的条目
  （含三条硬过滤的 DROP 原因、`max_tokens` / `context_window` / `max_mode` 差异）
  与最终合并结果
- `tests/unit/trae.spec.ts` 的「档位不被空档位条目覆盖」段（7 条）—— ⚠️ 已做**反向
  验证**：临时退回「无条件后覆盖前」时其中 4 条会失败，故不是同义反复
- `tests/e2e/trae-reasoning-probe.e2e.spec.ts`（`pnpm test:e2e:trae-reasoning`，**消耗
  额度**，双闸门 `DSH_TRAE_REASONING_E2E=1` + `…_CONFIRM=yes`）—— 真实目录档位断言
  + `resolveModel` 真声明出 `efforts` + 新通道真实收发两次

### ⚠️ TRAE 账号展示名：`ScreenName` 是自动生成的默认名，必须用脱敏手机号

**真实缺陷**（用户报障 2026-09-27）：「用 trae provider 登录后用户名字显示无法区分
各个用户，有其他名字昵称或者手机尾号之类的信息可以区分吗？」

根因：`GetUserInfo` 的 **`ScreenName` 是字节 passport 按 uid 自动生成的默认名**
（`用户` + uid 片段）。实测四个账号：

形态完全雷同，一屏列出来认不出谁是谁 —— 与 Raccoon 的 `RaccoonAva`
（`buildRaccoonNickname`）是**同一类问题**。

实测可用字段（2026-09-27，四个真实账号逐个调 `GetUserInfo` 核对）：

| 字段 | 值 | 可区分性 |
|---|---|---|
| `ScreenName` | `用户<uid片段>` 等 | ❌ 自动生成、形态雷同 |
| **`NonPlainTextMobile`** | `130******00` | ✅ **末两位互异** |
| `NonPlainTextEmail` | 四个**全为空**（`LastLoginType` 均为 `sms`） | ⚠️ 仅邮箱登录有值 |
| `Description` | 全为空 | ❌ |
| `AvatarUrl` | 每人独立 hash | ⚠️ 可区分但不可读 |
| `RegisterTime` | `2026-03-28` / `2026-09-27` / `2026-08-19` ×2 | ⚠️ 有两个撞车 |
| `UserID` | `4051111222220009` 等 | ⚠️ 可区分但过长不可读 |

要点：

- ⚠️ **字段名是 `NonPlainTextMobile`**（不是 `Mobile` / `Phone`），且是**脱敏**形态
  （中间 6 位打码）。展示就照原样用，**不要试图还原或截取后四位** ——
  `130******00` 整体已足够短且可辨认
- ⚠️ **`NonPlainTextEmail` 实测为空**，别因为「有手机号就以为邮箱也有」而写死依赖；
  它只是邮箱登录账号的兜底
- 取值顺序（`traeDisplayNickname`）：**手机号 → 脱敏邮箱 → `ScreenName` → 账号 id**
- ⚠️ **手机号必须写回凭据**（不只写账号条目）：账号条目会随 Jet Hub 的账号操作
  整体重写，凭据里存一份才能在续期后稳定拿到。`applyTraeRefresh` 用 `...previous`
  展开，故自动保留 `phone` / `email` —— 改它时别把这两个字段丢掉
- ⚠️ **回调的 `userInfo` 参数不含手机号 / 邮箱**（实测只有 `UserID` / `ScreenName` /
  `TenantID`），**只在 `GetUserInfo` 响应里** —— 故 `exchangeTraeCallback` 必须真发
  那次 `GetUserInfo` 才能拿到，不能只依赖回调
- ⚠️ **老账号必须主动回填**：光改代码只影响新登录的账号。`TraeAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，仿 `RaccoonAuth.repairAccountNicknames`）在启动时补一次
- ⚠️ **拿不到真实标识时不得改写昵称**：`Jet Hub` 允许用户手动改昵称
  （`account.update`），若退回去用凭据里的 `ScreenName` 重算，会把用户改过的名字
  覆盖成服务端默认名 —— 属无谓且有害的写入。故 `fetchUserContact` 在两者皆空时
  返回 `undefined`，调用方**直接 `continue`**
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace，每次启动都写会
  平白触发一次文档写

排查 / 验证：

- `scripts/probe-trae-userinfo.mjs` —— 打印每个 TRAE 账号 `GetUserInfo` 的
  **完整响应**（只读，零模型额度）
- `scripts/verify-trae-nickname.mjs` —— 用真实账号跑一遍 `repairAccountNicknames`
  并打印修复前后昵称（⚠️ **会写真实账号池昵称**，这正是修复效果本身）
- `tests/unit/trae.spec.ts` 的「TRAE 账号展示名」段（6 条，含四个真实手机号
  互不相同的断言）、`tests/unit/trae-auth.spec.ts` 的「repairAccountNicknames
  老账号回填」段（7 条，含「无标识不改写昵称」「幂等不重复请求」）

### ⚠️ LobsterAI 账号展示名：服务端把**手机号本身**当昵称下发（露 4 位）

**用户要求**（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
现在也改为只漏出 2 位」。

⚠️ **关键事实：`130****1100` 是服务端下发的 `user.nickname` 原值，不是本插件
截取的**。`buildLobsteraiCredential` 只做 `nickname: payload.nickname ?? ''` 照抄。
实测四个真实账号的登录响应即为此形态：

故修法是**归一化掩码**（`maskLobsteraiPhoneTail`，`src/lobsterai.ts`）而非改
某个 `slice(-4)` —— 那会是个找不到的假想目标。

要点：

- ⚠️ **两种输入都收敛到同一形态，因此幂等**：完整 11 位（`13011111100`，
  `profile-summary` 返回的就是完整号码）与已脱敏的露 4 位形态，输出都是
  `130******00`。幂等意味着老账号无需重新登录、重复运行不产生新写入
- ⚠️ **判据只认「像手机号」的形态**：`/^1\d{10}$/`（完整）或
  `/^\d{3}\*+\d+$/`（已脱敏）。**绝不能泛化到任意字符串** —— 那会把真实昵称
  （`用户<uid片段>` / `<自定义昵称>` / 邮箱形态）一起打掉。单测有专门一条守这个
- ⚠️ **星号个数按原串总长推算**（`总长 - 3 - 2`），长度保持不变；
  故对非 11 位的号码也自洽
- ⚠️ **末 2 位必须仍可区分**：四个真实账号掩码后为
  掩码把区分度也抹掉就失去意义了（单测断言 `Set.size === 4`）
- ⚠️ **老账号必须主动回填**：`LobsteraiAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，与 `RaccoonAuth` / `TraeAuth` 同名方法同一模式）
- ⚠️ **纯本地、零网络**：掩码只依赖凭据里的昵称（与 TRAE 那条需要发
  `GetUserInfo` 不同）。单测断言 `fetcher` 未被调用
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace

排查 / 验证：

- `scripts/probe-lobsterai-profile.mjs` —— 打印 `profile-summary` 的完整响应
  （**发现 `nickname` 在这里是完整号码 `13011111100`**，与登录响应的脱敏形态不同）
- `scripts/verify-lobsterai-nickname.mjs` —— 用真实账号跑一遍
  `repairAccountNicknames` 并打印修复前后昵称（⚠️ **会写真实账号池昵称**）
- `tests/unit/lobsterai.spec.ts` 的「手机号掩码（只露末 2 位）」段（8 条，
  含「非手机号形态原样返回」「末两位仍可区分」）、
  `tests/unit/lobsterai-auth.spec.ts` 的「老账号展示名回填」段（7 条，
  含「纯本地不发请求」「幂等」）

### ⚠️ 改昵称类修复必须**重启宿主**才生效，且旧进程会覆盖你的写入

**这是本轮实操踩到的坑**（2026-09-27）：用脚本把 `state.json` 的昵称改对之后，
**几分钟内又变回了旧值**（TRAE 的 `用户<uid片段>` 复活）。

根因：**当时有一个 1 小时前启动的 DSH 宿主进程仍在运行**（PID 9616，监听 3080）。
它加载的是**旧代码**（没有 `repairAccountNicknames`），内存里的账号池是旧昵称；
而 `AccountPool` 的写入是**整体 replace**（限流标记、续期回写等都会触发落盘），
于是它的下一次写盘就把脚本的修改**原样盖回去**。

两条必须记住的推论：

- ⚠️ **`repairAccountNicknames` 是「启动时」逻辑**：改完代码必须**重启 DSH**
  才会执行。不重启的话，无论脚本改多少次，旧进程都会覆盖
- ⚠️ **手工改 `state.json` 前先确认没有宿主在跑**（`Get-NetTCPConnection -LocalPort 3080`
  或看 node 进程），否则改动会被静默回滚 —— 症状是「明明改对了，过一会儿又变回去」，
  极易误判为「修复没生效 / 代码写错了」
- ⚠️ 验证修复是否真的生效，**唯一可靠方式是重启宿主**，然后看启动日志里有没有
  `[jet-hub] 已修正 N 个 … 账号的显示名`。脚本验证只能证明「逻辑正确」，
  不能证明「线上已生效」

### TRAE 倍率（藏在 `display_contact_config` 里，且该字段是** JSON 字符串**）

⚠️ **最大的坑**：`display_contact_config` 的值是**一个字符串**，里面才是 JSON。
直接读 `entry.display_contact_config.consumption_rate` 永远得到 `undefined` ——
必须 `JSON.parse` 两次（外层响应一次、这个字段再一次）。解析函数
`readConsumptionRate` / `readActivityDiscount`（`src/trae.ts`）。

```json
{ "consumption_rate": { "enable": true, "data": { "rate": 0.08 } },
  "activity_discount": { "enable": true, "subKey": "limited_discount",
    "data": { "current": { "discount_type": "limited",
                          "before_consumption_rate": 0.8,
                          "consumption_rate": 0.08, "discount": 10 },
              "limited": { "end_at": 1790265540 } } } }
```

- 倍率是 **裸数字**（`0.08`），既不是 buddy 的字符串 `"x0.29"`，也不是
  LobsterAI 的 `costMultiplier`
- ⚠️ **`rate: 0` 是「免费」，是合法值** —— 与 Qoder 的 `price_factor: 0` 同类，
  用 `> 0` 过滤会恰好漏掉免费模型；展示为「免费」而非 `x0`
- ⚠️ **`consumption_rate.enable === false` 视为「无倍率」**，不是「倍率 0」

#### ⚠️ `activity_discount.enable === true` **不等于**当前有折扣

**实测陷阱**（2026-09-20，与 Qoder 的 `promotion` 同类：**标志为真不等于当前生效**）：
`off_peak` 型条目形如

```json
{ "type": "none", "before_consumption_rate": 0.13,
  "after_consumption_rate": 0.13, "discount": 100 }
```

`enable` 是 `true`，但 `discount_type` 为 **`"none"`**、`before === after`
（`discount: 100` 是百分比制下的「无折扣」）。**照显会得到 `x0.13→x0.13`**，
让用户以为有活动。三条判据缺一不可（`readActivityDiscount`）：

1. `enable !== false`；
2. `data.current.discount_type` 存在且**不是 `"none"`**；
3. `before_consumption_rate` 为正，且**严格大于** `consumption_rate`。

另外 ⚠️ **`end_at`（Unix 秒）仅 `limited` 型带**（`subsidy` / `off_peak` 没有）。
**已过期必须整个不展示折扣** —— 否则用户按折扣价预期、实际被按原价计费。

展示形态由 `traeDisplayName`（`src/trae-adapter.ts`）拼装：
常态 `Qwen3.8-Flash · x0.08`；活动期 `Seed-2.1-Pro · x0.8→x0.08`。
`resolveModel` 的 `name` **不带**倍率（与 Qoder 一致）。兜底表路径**不显示倍率**
（兜底表无该字段，不猜价格）。

实测参考值（2026-09-20，`solo_agent` 可见集）：`glm-5.3-flash` x0.06、
`qwen3.8-flash` x0.08、`deepseek-v4.1-flash` x0.13、`glm-5.2` x0.78、
`qwen3.8-max` x1.5、`kimi-k3` x1.83；同一模型在三个通道的 `rate` **一致**。

### Qoder 倍率（`price_factor`，与腾讯系语义不同）

模型目录来自本机加密缓存 `~/.qoder/.models/{uid}/catalog-v6`
（`chat` 场景 17 个模型），倍率字段是 **`price_factor`**：

- ⚠️ **不是 `cost_multiplier`** —— 那是 LobsterAI 的字段名，两者易混
- ⚠️ **`price_factor: 0` 是「免费」**（实测 `qfmodel` / Qwen3.8-Flash），
  **0 是合法值**，不能用 `> 0` 过滤，否则恰好漏掉用户最关心的免费模型。
  展示为「免费」而非 `x0`
- 另有 `original_price_factor`（如 `qfmodel` 的 0.1 = 免费前的原价）
- ⚠️ **`price_factor` 是「采集时刻的生效价」，不是恒定原价** ——
  错峰窗口内它是折后价、窗口外是原价。故展示时**必须结合窗口本地推算**，
  不能直接照搬（照搬的后果：窗口一切换，界面价格就与真实计费不符）
- ⚠️ **错峰判据用 `windowStart`/`windowEnd` 本地推算（`promotionActiveNow`），
  *不*采信 `promotion.active`** —— 后者是目录下发那一刻的快照，
  客户端长时间不重启就会与真实时段脱节。窗口字段缺失时才回退到 `active`。
  生效价 = `beforePromotionPriceFactor × discountFactor`（实测三条全部吻合），
  窗口外则用原价。窗口统一 22:00–08:00（UTC+8），支持跨零点
- ⚠️ **折扣形态三个 provider 必须统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
  buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
  中文角标」（`x0.2 错峰 4 折`），两个问题：① 看不出原价与折扣幅度；
  ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。用户要求对齐 TRAE。
  `promotion.badgeZh` 因此**不再参与展示**（字段保留，目录原始数据仍可对照）
- ⚠️ **本表的倍率数值必须逐条对照 catalog，不要凭印象填**：
  早期版本多处是手工估值，与真实值大范围不符（**14 个模型有偏差**：
  `smodel` 写 3.2 实际 8、`qmodel_38max` 写 0.5 实际 0.2、`auto` 写 1 实际 0.5 …），
  用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。
  ⚠️ 而当时的单测**只断言了 id 列表**，所以价格漂移长期未被发现 ——
  改这张表时必须同步更新数值断言（`qoder-product.spec.ts`）
- `resolveModel` 的 `name` **不带**倍率后缀（价格只属于选择列表语境）

**解密该缓存**（`decryptModelCatalog`，`src/qoder-wasm.ts`）：

⚠️ **第二个参数是 `uid`，不是 `machine_id`**。两个官方调用点容易读反：
目录缓存的 `readSharedCacheSnapshot(A)` 传 uid，BYOK 的
`model_cache_decrypt(i, n)` 传 machineId。传错会得到
`AES-GCM decrypt failed: aead::Error` —— 看着像密文损坏，实为参数错。
调试脚本：`scripts/probe-qoder-catalog-debug.mjs`（两个候选都试）、
`scripts/probe-qoder-pricing.mjs`（打印 17 个模型的计费字段全貌）

### 同名模型必须消歧（`buildDisplayNames`）

远端会给**不同 id 配同一个 `name`**，而 DSH 按 `name` 展示 → 列表里出现
两个完全一样的条目。实测三组：

| 组 | 远端 name | 区别 |
|---|---|---|
| `deepseek-v4.1-flash` / `-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，`credits` x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

**用户报障**：「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」。
IDE 按 name 归并，我们按 id 列出。二者是**不同区域的独立计费实体**，
不能靠丢弃其一来回避。

- 算法：对每组同名 id 求**公共前缀**，剩余段作为变体标记追加
  （`Deepseek-V4.1-Flash · x0.03 SG`、`Hy3 · x0.05 X`），空剩余段者不加标记
- ⚠️ **不要硬编码 `-sg`**：撞车组随服务端上新变化，本次实测三组里只有一组是
  `-sg`；也不要「取 id 最后一段」（会把 `gpt-5.6-sol` 的 `sol` 当变体）。
  公共前缀只在**确实撞车时**才切分
- ⚠️ **倍率与变体标记都只在 `name` 里出现一次**：初版两处都写，
  端到端实测出现重复文案与「计费 x0.00 · 」这种孤立分隔符
- LobsterAI **实测无同名**（28 个模型，0 组重名），故它不做消歧；
  兜底表路径也**不显示倍率**（兜底表无该字段，不猜价格）

排查脚本（全部只读 GET，零模型额度）：`scripts/probe-pricing.mjs`（各 provider
计费字段）、`scripts/probe-promotions.mjs`（`credits` 全量与促销结构）、
`scripts/probe-lobsterai-cost.mjs`（LobsterAI 倍率归属）、
`scripts/probe-lobsterai-dupes.mjs`（LobsterAI 同名检查）、
`scripts/probe-codearts-benefit.mjs`（CodeArts benefit 集合与判定）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## ⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不能硬编码模型名

CodeArts 的 `snap-access/api/v2/chat/completions` 上有**两套模型注册**：benefit
（免费额度）与非 benefit。**benefit 模型的 chat 请求必须带 `maas_type: benefit`
请求头，且该头必须参与 SDK-HMAC-SHA256 签名**，否则后端返回
`InferHub.002002009.404 The model is not registered`（HTTP 200 + SSE 内嵌错误）。
反过来，给**非** benefit 模型带该头会被拒（`unsupported model`）。

**真实缺陷**（用户报障，2026-09-23）：用 `deepseek-v4.1-flash` 发消息后失败
（`Insufficient Balance` / `QUOTA`）。根因是 `src/llm-adapter.ts` 早期把 benefit
集合**硬编码**为 `new Set(['glm-5.3-flash'])` —— `deepseek-v4.1-flash` 是
2026-09 新增的 benefit 模型，因此从不带该头，后端按非 benefit 通道处理它。

实证矩阵（2026-09-23，对齐 deveco-code-rust `fb1b4a2`）：

| 模型 id | 来源 | 不带 maas_type | 带 maas_type |
|---|---|---|---|
| `glm-5.3-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4.1-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash-0731` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-pro-0813` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `deepseek-v4-pro`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `GLM-5.2` | model/builtin | ✓ 成功 | ✗ unsupported |

结论：**`gateway/config` 返回的模型即 benefit 集合**，无需靠模型名硬编码。

要点：

- 判定 `isCodeArtsBenefitModel`（`src/models.ts`）：远端拉取并缓存的集合
  （`~/.cache/deveco/codearts_benefit_models.json`）∪ 静态兜底
  `CODEARTS_BENEFIT_FALLBACK`（`glm-5.3-flash` / `deepseek-v4.1-flash`）。
  远端集合优先，后端新增 benefit 模型**无需改代码**
- ⚠️ **只记录「归一化未改写」的 id**：gateway 下发的是
  `deepseek-v4-flash-0731`，而 `normalizeModelId` 会把它改写成
  `deepseek-v4-flash` —— 两者在后端是**不同模型、benefit 属性相反**，
  记录改写后的 id 会让无后缀模型多带 `maas_type` 而失败
- ⚠️ **判定必须在 `stream()` 的重试循环外算一次**（要读缓存文件，不宜每轮 IO）
- ⚠️ **缓存读写必须用顶层 `import { … } from 'node:fs'`，不能用 `require`** ——
  本包是 ESM（`package.json` 的 `"type": "module"`），`require` 未定义、抛
  ReferenceError 后被 `catch` 静默吞掉，表现为「写不进也读不回」（`loadModelsCache`
  的模型列表磁盘缓存曾因此长期失效）
- `deepseek-v4.1-flash` 的上下文窗口按 IDE 下发的 inferhub-provider 配置声明为
  **1000000**（与无后缀 v4-flash/pro 的 1048576 不同）
- 回归用例：`tests/unit/models.spec.ts`（集合判定 / 落盘不含改写 id / 缓存往返）、
  `tests/unit/llm-adapter.spec.ts`（v4.1 带 `maas_type` 且参与签名、无后缀
  v4-flash 不带）、`tests/e2e/v4-models.e2e.spec.ts`（真实收发，需闸门）

### ⚠️⚠️ `InferHub.4004.200` 有**两条下发通道**，只接一条 = 两套判据（Issue IKLBSH A6）

同一个上游条件（该账号没有 benefit 包）走两条通道，**修复前只接了 SSE 那条**：

| 通道 | 形态 | 修复前 |
|---|---|---|
| SSE | HTTP **200** + `{error_code:"InferHub.4004.200",…}` | ✅ `consumeSse` 抛 `BENEFIT_NOT_FOUND_CODE` → 去头重试 |
| HTTP | **4xx** + 同一码 | ❌ **未接** → 径直落 `httpErrorCode` 归 `INVALID_REQUEST` 抛出，**去头一次也不试** |

症状：**同一条件下 SSE 能自愈、4xx 却硬报错** —— 即「同一语义两套判据」。

⚠️ **该缺陷由既有分支显式锁定过**：`origin/issue/IKJOF7-benefit-diagnostics`
（2026-10-05，Gitee IKJOF7 取证提交）用 `it.fails` 写了
「HTTP 4xx + 正文含 `InferHub.4004.200` 时也应当去头重试」，当时的结论是
**「已确认，但本分支不修」**（该提交只做了可观测性）。现已补上那一半。

**修法**：`isBenefitNotFoundBody(body)`（`src/llm-adapter.ts`）在 4xx 分支里
**复用同一个码值常量**与**同一个 `benefitHeaderDropped` 门禁**（只去头一次）——
两条通道共享标记，故叠加也**不会**放大成两轮请求。

⚠️ **不去采纳 issue 建议的「1s / 2s / 3s 递增退避重试最多 3 次」**：issue 给的
证据是「去掉请求头后密集取样 9 次全部 200」—— 那证明的正是**去头即通**，
而不是「需要多次退避」；且 `benefitHeaderDropped` 的既有语义写明「只试一次，
避免与真实失败互相掩盖」。**按证据改，不按建议改。**

⚠️ **4xx 分支的处理顺序不能挪**（`stream()` 的 HTTP 非 2xx 分支）：
鉴权刷新 → **额度** → **benefit 4xx** → 限流换号 → 排队探测 → `httpErrorCode`。
benefit 那条必须排在**限流之前**（否则被 `isRateLimited` 截走当可重试），
且必须在**额度判据之后**（`4004` 与 `4291` 是两个码，互不混淆但顺序仍锚定）。

回归用例：`tests/unit/llm-adapter.spec.ts` 的
「★ benefit 去头重试必须接上 4xx 通道」（4 条：主用例 + 非 benefit 模型对照 +
报文不含该码对照 + SSE 通道既有行为不变）。

## ⚠⚠️ 腾讯系内容级风控：system 里的客户端模板句会被**整轮拦死**（Issue IKJNA1）

**用户报障**（Gitee issue IKJNA1，2026-10-04）：ZCode 经本机 OpenAI 网关调
`workbuddy/deepseek-v4.1-flash` 稳定失败，ZCode 侧只显示
`provider_code=INVALID_REQUEST reason=unknown`；网关侧原始报错是

```text
workbuddy: 请求被安全策略拦截，请稍后重试或联系支持。 Illegal API invocation from an unapproved channel
```

DSH 直连同一模型正常 ⇒ 差别只在**外部客户端往 system 里注了什么**。

### 根因（本机 2026-10-05 实测复现，`www.workbuddy.ai` 与 `copilot.tencent.com` **两端点一致**）

腾讯网关按**请求内容指纹**拦截，与账号、凭据、请求头、tools 全无关。最小充分
触发串是 ZCode 内建的 gitStatus 模板句常量
（`$Js="Main branch (you will usually use this for PRs)"`，拼在
`Main branch … : <分支名>` 那一行，每个 git 仓库里的会话必然注入）。

| 探针（`max_tokens=16`，被拦不耗额度） | 结果 |
|---|---|
| 中性 system | ✅ 200 |
| `Main branch (you will usually use this for PRs): master` | ❌ 400 `code:11128` |
| `Main branch: master`（只留标签） | ✅ 200 |
| 换分支名（`dev`） | ❌ 400 ⇒ **分支值无关** |
| 句中 / 段中被别的句子夹住 | ❌ 400 ⇒ **位置无关** |
| **改写该句**为 `Main branch (PRs usually go here)` | ✅ 200 |
| 同一句放进 **user** 消息 | ✅ 200 ⇒ **只拦 system** |
| 同一句放进 **tool** 消息 | ✅ 200 ⇒ 同上 |
| 指纹在**第二条** system（非 `messages[0]`） | ❌ 400 ⇒ **所有 system 都要改** |
| 只差一个词（`normally` 替 `usually`） | ✅ 200 ⇒ **逐字符**匹配 |
| 内层多一个空格 | ✅ 200 ⇒ 同上 |
| **全小写 / 全大写** | ❌ 400 ⇒ **大小写不敏感** |

⚠️ **本机客户端侧对不上号**：本地装的是 ZCode **3.14.3**，其 asar 里
`Main branch` / `you will usually use this for PRs` **命中 0 次**（issue 报障用的是
3.14.4）。取证脚本 `scripts/probe-zcode-gitstatus-fingerprint.mjs`（按字节流找，
⚠️ **不能用 rg**：asar 是 297MB 单行二进制，rg 的行长上限会静默漏报 ——
`-o ".{200}Current branch:.{300}"` 返回 0 而 `-c "Current branch"` 返回 1）。
⇒ 「客户端一定注入这一句」这条来自 issue 报告者的 3.14.4，**服务端那一半已本机实测**。

### 修法：网关出站方向的**表驱动**窄改写

`src/openai-gateway/tencent-fingerprint.ts`，只对 `buddy` / `workbuddy`，
只改 **system** 消息，三处接入点（**改一处漏两处 = 换一个端点又被拦**）：

| 端点 | 接入点 |
|---|---|
| `/v1/chat/completions` | `messages.ts` 的 `convertMessage`（`role==='system'` 分支） |
| `/v1/responses` | `responses.ts` 的 `toMessages`（input 里的 `system` / `developer`） |
| `/v1/responses` | `responses.ts` 的 `toResponsesGenerateOptions`（**`instructions`** —— Responses 端唯一的 system 通道，客户端常把整份系统提示词放这里） |

四条实现约束（每条都对应上表一行实测，改动时别把它们「简化」掉）：

1. **只动 system**：`user` / `assistant` / `tool` 一概不碰（改它们没有收益，
   却会篡改用户原话与工具输出）。
2. **所有** system 消息都改，不只 `messages[0]`。
3. **大小写不敏感的精确字面量**（`new RegExp(escapeRegExp(find), 'gi')`）：
   `i` 是必需的（全小写 / 全大写都被拦），但**不能**泛化成正则/关键词黑名单
   （只差一个词、多一个空格服务端都放行）。
4. **不含指纹的文本逐字节不变**：腾讯侧按前缀缓存，无谓地重建字符串会让每轮
   都算新前缀、白吃缓存命中 ⇒ 实现里有一次 `toLowerCase().includes()` 预检。

⚠️ **表驱动而不是写死一处**：屏蔽名单服务端掌握、可能随时更新，任何客户端将来
都可能撞上新指纹。新增一条 = 表里加一行 + 一条用例。

### ⚠️⚠️ 千万不要把 `11128` 加进 `isContentRejection`

`buddy-adapter.ts` 的 `isContentRejection`（11140 / `request illegal` /
`安全审核|safety review`）**维持现状是正确的**。11128 是**内容级**拦截 ——
同一账号换掉那一句就 200。认成账号级会走
`markPolicyBlockedAccount` → **30 分钟账号冷却**（`policyBlockResetAtMs`），
而池里每个账号都会在同一句上被拦 ⇒ 把「一句话被拦」放大成「整个账号池半小时
不可用」。

⚠️ **实测的 HTTP 400 形态根本走不到那个判据**（400 在适配器里是「非法请求」早退），
所以这层保护真正生效的地方是**流内**那条通道（HTTP 200 + 无 `choices` 的错误帧，
`buddy-adapter.ts:1855`）。回归用例按此设计：`buddy-adapter.spec.ts` 的
「内容级风控（11128）」段，**流内那条才会红**（已做反向验证：把 `11128` 加进
`isContentRejection` → 该用例红；400 那条不红，别拿它当判据）。

### 端到端实发验证（已通过）

`scripts/verify-workbuddy-gitstatus-e2e.ts`（`npx tsx`）走**插件真实链路**：
ZCode 形状的 OpenAI 请求体 → `toGenerateOptions`（含改写）→ **真实** `BuddyAdapter`
（真实 fetch / 凭据 / 产品配置）→ 腾讯线上。对照组是同一份请求体**绕过**网关转换。

```text
provider = workbuddy   model = deepseek-v4.1-flash
① 修复前（绕过网关转换，system 原样）
   ❌ INVALID_REQUEST  Illegal API invocation from an unapproved channel
② 修复后（走网关转换）
   ✅ 正文："1+1 等于 2。"  [block-start,reasoning-delta,text-delta,usage,block-end,finish]
```

`--cn` 换 CodeBuddy 中国版同样通过（`① ❌ / ② ✅`）。

只读探针 `scripts/probe-workbuddy-gitstatus-fingerprint.mjs`（绕开适配器、逐账号发
同一条对照请求；`--cn` 切 CodeBuddy）可随时重跑复核上表。

### ⚠️⚠️ 第二条指纹：**Claude Code 的身份句**，且它的锚点与上一条**相反**（Issue IKLS2L，2026-10-14）

**用户报障**（Gitee issue IKLS2L）：Claude Desktop 的「Code」页（内置 Claude Code
v2.1.295）经 cc-switch（Anthropic→Responses 转换）→ 本机网关 `127.0.0.1:8326/v1/responses`
调 `hub/hub-deepseek-v4.1-flash`（聚合，12 条候选）时稳定失败：

```text
HTTP 400 / code 11128 / Illegal API invocation from an unapproved channel
```

实测窗口 **277 次尝试 / 94 次失败**（约 34%），日志累计 187 次该错误。可用性不坏
（hub 会自动切到 officeace 等），但**每次白撞一次往返**，且 `markRecentFailure` 会把
workbuddy（链上第 2 位、`x0.00` 免费的渠道）标成「近期失败过」而被并发请求避开。

**成因（Claude Code 侧，不在本仓库内）**：`mrt()` 的 `[model-check]` 探测路径调用
`Qno({...})` 时**漏传 `skipSystemPromptPrefix`** ⇒ 每次都注入身份句；主请求路径
`aF()` 传了，故多数请求正常。这正是「同一会话里成功与失败交替」的来源。

**本仓库的修法**：`CONTENT_FINGERPRINTS` 补一行（表就是为此设计的）。`find` **刻意不带
尾句点**，一条同时覆盖 `yl` 与 `sf` 两个常量；`af` 实测放行故**不登记**。

| 探针（`max_tokens=16`；⚠️ **必须 `stream:true`**） | workbuddy | buddy |
|---|---|---|
| 中性 system | ✅ 200 | ✅ 200 |
| `You are Claude Code, Anthropic's official CLI for Claude` | ❌ 400/11128 | ❌ 400/11128 |
| 同句 + 尾句点 / + `, running within the Claude Agent SDK.` | ❌ 400/11128 | ❌ 400/11128 |
| `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | ✅ 200 | ✅ 200 |
| 少一个字母（`…for Claud`） | ✅ 200 | ✅ 200 |
| **多**一个字母（`…for ClaudeX`） | ❌ 400/11128 | ❌ 400/11128 |
| 拆成前半句 / 后半句**单独**发 | ✅ 200 | ✅ 200 |
| **assistant 正文**放同一句 | ❌ 400/11128 | ❌ 400/11128 |
| 同一句放 `user` | ✅ 200 | ✅ 200 |
| **改写后**（`…Anthropic's CLI for Claude.`） | ✅ 200 | ✅ 200 |

⚠️⚠️ **该指纹的锚点是「行首」的，与上一条「位置无关」相反** —— 这是本轮实测推翻
issue 描述的一格（issue 按 IKJNA1 同构写成了「子串精确匹配、位置无关」）：

| 形态 | 结果 |
|---|---|
| 裸串（在文本**绝对开头**） | ❌ 400/11128 |
| **前接空格 / 前换行 / 前接任意前言 / 双换行包裹** | ✅ **200 放行** |
| 后接句点 / 破折号 / 中文句号 / 一长段正文 | ❌ 400/11128 |

⇒ 语义是「**前导字符一个都不容忍、后缀完全自由**」。**这条对将来加新指纹的人是硬提醒**：
拿「夹在句中放行」当判据会得到**假阴性**（真因是锚点，不是这句不再触发），据此删掉一条
仍然必需的登记就重新打开这个 bug。故 `tencent-fingerprint.ts` 里 **`find` 刻意不做行首锚定**
—— 改写宁可略宽（漏改 = 整轮 400；多改 = 语义等价的措辞变化）。

⚠️ **非流式请求会被更早地拒掉**：两端点对不带 `stream:true` 的请求都回
`HTTP 400 / code 11101 Non-stream chat request is currently not supported` —— 探针若不带它，
会把「不支持非流式」**误读成风控拦截**（本轮探针第一版就踩了，八个格子全报 400）。

**可复核凭据**：`tests/e2e/buddy-fingerprint-roles.e2e.spec.ts` 的
「Claude Code 身份句（IKLS2L 实测依据）」一节 —— 含**贪心探针**（行首/非行首**两侧都测**）
与「`af` 刻意不登记」的反向断言。⚠️ 与 ZCode 那条不同，这句字面量**可以**写在源码里：
改写已覆盖 `system` 与 `assistant` 正文两处，排查这个风控 bug 的会话不会再拦死自己。

回归用例在 `tests/unit/openai-gateway-tencent-fingerprint.spec.ts`（17 条）。
⚠️ 已做**反向验证**：正则去掉 `i` → 大小写用例红；`instructions` 那处改回原样 →
Responses 端用例红。

## 模型计费倍率与同名模型（必须写进 `name`，不是 `description`）

**倍率必须拼进 `name`。** 这是被用户报障纠正过的结论：

- composer 的**模型切换菜单只渲染 `name`** —— `dsh-client-ui-model-selection`
  的 ModelSelect 里只有 `title: model.name` 与 `children: model.name`，
  **完全不读 `description`**。
- `description` 只在 **`/model` 弹窗**里用（`optionsOf` 的 `detail`，渲染成
  `提供方 · description`）。

**真实缺陷**（用户报障）：「消耗倍率没有显示在切换模型列表的后面」——
早期版本把倍率放进 `description`（因为误以为那是"唯一的展示位"），
结果在切换菜单里根本不可见。

安全性：`name` **纯属展示**，DSH 的选择与持久化只用 `id`
（`selectionOf` 返回 `model: model.id`），故附加价格不会污染会话历史。

展示形态：`Deepseek-V4.1-Flash · x0.03`；有促销时 `GLM-5.3 · x0.79→x0.50`
（箭头比「（促销 …）」短，适合窄菜单）。

三套远端的倍率字段**形态互不相同**，绝不可共用解析：

| provider | 字段 | 真实形态 | 归一化 |
|---|---|---|---|
| `buddy` / `workbuddy` | `data.models[].credits` | **字符串 `"x0.29"`**（x 在前），早期带 `"x0.03 credits"` 后缀，可为空串 | `normalizeCreditsRate` |
| `buddy` / `workbuddy` | `modelPromotions[].discount.discountedCredits` | **字符串 `"0.50x"`（x 在后！）**，已结束占位为 `"0x"` | `normalizeDiscountedRate` |
| `lobsterai` | `data[].costMultiplier` | **裸数字 `0.05`** | `displayNameFor` 里拼 `x${n}` |
| `qoder` | 目录 `chat[].price_factor` | **裸数字**，`0` = **免费**，另有 `original_price_factor` + `promotion` | `qoderDisplayName` |
| `trae` | `display_contact_config.consumption_rate.data.rate`（**该字段本身是 JSON 字符串，须二次 `JSON.parse`**） | **裸数字** `0.08`；`0` = 免费；`enable:false` = 无倍率 | `traeDisplayName`（活动期拼 `x原价→x折后价`） |
| `codearts` | 无 | 两个目录端点都不含计费字段 | — |

要点与坑：

- ⚠️ **`credits` 与 `discountedCredits` 的 x 位置相反**（`"x0.29"` vs `"0.50x"`）。
  早期版本只认前缀写法，导致**促销价全部静默丢失** —— 单测直接暴露了它。
  两个 `normalize*` 函数各自接受两种写法（对上游格式变更更鲁棒）
- ⚠️ **两个端点下发的模型 id 集合不同，必须取并集**（实测 2026-09-21，
  账号 `3C656A62`）：
  ```
  scoped     → hy4-preview, hy4-preview-x   （30 个模型）
  /v3/config → hy4-preview-f                （22 个模型）
  促销 modelIds → ["hy4-preview-f"]         ← 只挂在 v3/config 独有的那个 id 上
  ```
  而 `hy4-preview-f`（新用户限时免费变体）**被 craft/ask/plan 三个 agent 引用**
  —— 服务端明确说它可选。早期只返回 scoped，于是该促销永远对不上，
  界面显示 `x0.29` 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费
  我们还是 0.29」）。**不同账号下发的变体 id 也不同**（另一账号两端都是
  `hy4-preview`，所以它没暴露这个问题）—— 排查时**必须多账号对照**
- ⚠️ **`reconcileWithFallback` 是白名单式重建，会丢弃不在兜底表的 id** ——
  上面那个 `hy4-preview-f` 正因此被丢掉。判据用 **`agentReferenced`**
  （服务端自己的「可选」信号，由 `parseModelsFromConfig` 收集**全部** agent
  的引用），**不要猜 id 后缀**：`-f` / `-x` / `-sg` / `-ioa` 含义各异，
  猜错会放进不可用的模型。追加时放在**末尾**，不打乱兜底表顺序。
  ⚠️ `auto` 与 **`default`** 是同类内部别名（都不被 agent 引用），
  由 `isAutoSelectAlias` 过滤；但**不要前缀匹配** —— 会误伤国际版
  被 craft 引用的 `default-model` / `fast-model` 等抽象别名
- ⚠️ **促销只由 `/v3/config` 下发，企业模型端点（scoped）没有**（实测 2026-09-21：
  scoped 的 25948 字符响应里 `discount` / `promo` / `0.50x` 出现 **0 次**）。
  而 scoped 被**优先返回** → 早期实现直接 `return scoped`，于是**促销永远不显示**
  （用户报障「codebuddy 的倍率显示也是没折扣的，GLM-5.2 是 0.5，现在显示 0.79」）。
  现补一次 `/v3/config` 并**同时取它的模型与促销表**（失败不影响列表）
- ⚠️ **必须按 `schedule` 本地推算此刻是否生效，不能只看 `enabled`**：
  实测 `glm-5.2` 有两条**互补**活动（夜间 `23:00–7:50` 带 `0.50x`、
  白天 `7:50–23:00` 只带角标）。不看时段就按 priority 恒定取夜间那条 →
  **白天也显示折扣价**，用户按折扣价预期却被按原价计费。
  时段字段是 `schedule.daily[].{start,end}`（`HH:MM`，**小时可能不补零**如 `7:50`）
  + `schedule.timezone`（用 `Intl` 换算，别硬编码 +8）+ `validFrom`/`validUntil`。
  时区不可解析时**不误杀**（宁可多显示一次折扣）
- ⚠️ **`factor: 0` 是「免费」，不是「活动已结束」**：实测 `hy4-preview` 的夜间活动
  是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
  早期把 `0x` 一律当哨兵丢弃，于是「夜间免费」永远不显示
  （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**「已结束」由有效期表达**。
  防御：**无任何时间窗口**的 `factor: 0` 仍按占位跳过（免费额度必然限时）
- ⚠️ `modelPromotions` 是**数组**（不是对象），且用 `modelIds[]` **按模型关联**
  （不是全局折扣）；同模型命中多个活动时取 `priority` 最高者
- ⚠️ **`/v3/config` 有 UA 校验**：UA 不对返回 `{"code":12403,"msg":"check ua,
  get coding copilot version error"}`（**HTTP 200**，极易误判为「该端点没有促销」）。
  必须带产品的 `userAgent`（CodeBuddy 实测 `CodeBuddyIDE/1.106.1`）
- ⚠️ **LobsterAI 的 `description` 可能已自带倍率文案**（实测 DeepSeek-V4.1-Flash
  写着「分时计价：当前空闲时段 x0.05…」）。前置倍率前必须 `includes` 判重，
  否则出现「x0.05 · …x0.05…」重复
- `reconcileWithFallback` 是**白名单式重建**：新增的远端字段不在此显式搬运就会
  被静默丢弃（`creditsRate` / `discountedCreditsRate` 已加）

### ⚠️ TRAE 思考档位：多通道合并**不得**用空档位条目覆盖有档位的条目（Issue IKI7WT/IKILR7）

**真实缺陷**（用户报障「模型缺少思考强度」）：`parseTraeBatchModelList` 用
**无条件「后面的覆盖前面的」**合并同名模型，其注释假设「后面的条目带着更完整的
配置」——**该假设与真实数据正好相反**。上游把**空档位**的 `solo_work_lite` /
`solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成了更空的条目。
UI 表现为 `TraeAdapter.reasoningFor` 返回 `undefined` → 不声明 `reasoning` →
「当前模型未提供推理等级」。

实测（2026-09-26，`scripts/probe-trae-reasoning-order.ts`）：**13 个模型**丢掉档位
（`deepseek-v4.1-flash` / `glm-5.2` / `glm-5.3` / `kimi-k3` / `qwen3.8-max` /
`DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` …）。修复后目录里
**有档位的模型从 5 个恢复到 15 个**。

同一模型在不同通道的档位**不一致**（这正是「后覆盖前」出事的原因）：

| 通道 | `deepseek-v4.1-flash` 的 `reasoning_effort_config` | 顺序 |
|---|---|---|
| `chat_v3` | `{default:high, options:[light,high,extra_high], support_thinking:true}` | 早 |
| `solo_agent` | 同上，且 `max_tokens` 32000 / `context_window.max` 1000000 / `max_mode:true` | 中 |
| `solo_agent_remote` / `solo_agent_lite` | 同上 | 中 |
| `solo_work_remote` / **`solo_work_lite`** | `{options:[], support_thinking:false}` | **最后** |

修正后的合并规则（三条，见 `parseTraeBatchModelList` 注释）：

1. **空档位不得覆盖有档位**（已选有档位 + 候选无档位 → 保留已选）；
2. **两侧都有档位时按 `channelPriority` 取更靠前者**（默认 `TRAE_CHANNELS`，
   「顺序即优先级」，故通常落到 `solo_agent`）；
3. **其余情形（含两侧都无档位）保持既有「后覆盖前」**，避免与本缺陷无关的
   通道迁移 —— 这条保证 `glm-5.1` / `qwen-3.5` 等无档位模型行为**逐字节不变**。

四个必须记住的点：

- ⚠️ **档位必须与 `function` 同源，整条择优**：发档位的通道必须正是声明支持它的
  通道。**不要**只把 `reasoningConfig` 单独搬运到另一条条目上（例如保留
  `solo_work_lite` 的 `function` 却声明档位）——那是在一个自称
  `support_thinking:false` 的通道上宣布档位。
- ⚠️ **判据必须与 `TraeAdapter.reasoningFor` 完全一致**：配置存在 **且**
  `support_thinking !== false` **且** `options` 非空（`declaresReasoningOptions`）。
  只判「配置存在」会选中 `{support_thinking:false, options:['high']}` 这种
  适配器里仍返回 `undefined` 的条目，**等于没修**。两处改动必须同步。
- ⚠️ **可调用性不受影响**：候选始终只来自**列出了该模型的通道**，故无论选中哪条
  都不会路由到「未列出该模型」的通道（那才会回流内 4001）。已实测：
  `deepseek-v4.1-flash` 通道从 `solo_work_lite` 迁到 `solo_agent` 后，
  不带档位与 `reasoning_effort=extra_high` **各发一次均 HTTP 200、正常返回**。
- ⚠️ **`DeepSeek-V4-Flash` / `DeepSeek-V4-Pro`（无后缀）修好后仍然无档位** ——
  它们**所有**带档位的通道条目都被 `is_invisible_to_user=true` 剔除（官方隐藏），
  只剩 `solo_coder` / `chat` 的可见条目。这是官方可见性，**不是**合并缺陷；
  带 `-Official` 后缀的那两个已正常恢复。

排查/回归：

- `scripts/probe-trae-reasoning-order.ts` —— 按上游顺序回放「后覆盖前」，列出被吃掉的
  模型与修复后的目录（只读，零额度）
- `scripts/probe-trae-merge-replay.ts <模型 id…>` —— 打印指定模型在**全部通道**的条目
  （含三条硬过滤的 DROP 原因、`max_tokens` / `context_window` / `max_mode` 差异）
  与最终合并结果
- `tests/unit/trae.spec.ts` 的「档位不被空档位条目覆盖」段（7 条）—— ⚠️ 已做**反向
  验证**：临时退回「无条件后覆盖前」时其中 4 条会失败，故不是同义反复
- `tests/e2e/trae-reasoning-probe.e2e.spec.ts`（`pnpm test:e2e:trae-reasoning`，**消耗
  额度**，双闸门 `DSH_TRAE_REASONING_E2E=1` + `…_CONFIRM=yes`）—— 真实目录档位断言
  + `resolveModel` 真声明出 `efforts` + 新通道真实收发两次

### ⚠️ TRAE 账号展示名：`ScreenName` 是自动生成的默认名，必须用脱敏手机号

**真实缺陷**（用户报障 2026-09-27）：「用 trae provider 登录后用户名字显示无法区分
各个用户，有其他名字昵称或者手机尾号之类的信息可以区分吗？」

根因：`GetUserInfo` 的 **`ScreenName` 是字节 passport 按 uid 自动生成的默认名**
（`用户` + uid 片段）。实测四个账号：

形态完全雷同，一屏列出来认不出谁是谁 —— 与 Raccoon 的 `RaccoonAva`
（`buildRaccoonNickname`）是**同一类问题**。

实测可用字段（2026-09-27，四个真实账号逐个调 `GetUserInfo` 核对）：

| 字段 | 值 | 可区分性 |
|---|---|---|
| `ScreenName` | `用户<uid片段>` 等 | ❌ 自动生成、形态雷同 |
| **`NonPlainTextMobile`** | `130******00` | ✅ **末两位互异** |
| `NonPlainTextEmail` | 四个**全为空**（`LastLoginType` 均为 `sms`） | ⚠️ 仅邮箱登录有值 |
| `Description` | 全为空 | ❌ |
| `AvatarUrl` | 每人独立 hash | ⚠️ 可区分但不可读 |
| `RegisterTime` | `2026-03-28` / `2026-09-27` / `2026-08-19` ×2 | ⚠️ 有两个撞车 |
| `UserID` | `4051111222220009` 等 | ⚠️ 可区分但过长不可读 |

要点：

- ⚠️ **字段名是 `NonPlainTextMobile`**（不是 `Mobile` / `Phone`），且是**脱敏**形态
  （中间 6 位打码）。展示就照原样用，**不要试图还原或截取后四位** ——
  `130******00` 整体已足够短且可辨认
- ⚠️ **`NonPlainTextEmail` 实测为空**，别因为「有手机号就以为邮箱也有」而写死依赖；
  它只是邮箱登录账号的兜底
- 取值顺序（`traeDisplayNickname`）：**手机号 → 脱敏邮箱 → `ScreenName` → 账号 id**
- ⚠️ **手机号必须写回凭据**（不只写账号条目）：账号条目会随 Jet Hub 的账号操作
  整体重写，凭据里存一份才能在续期后稳定拿到。`applyTraeRefresh` 用 `...previous`
  展开，故自动保留 `phone` / `email` —— 改它时别把这两个字段丢掉
- ⚠️ **回调的 `userInfo` 参数不含手机号 / 邮箱**（实测只有 `UserID` / `ScreenName` /
  `TenantID`），**只在 `GetUserInfo` 响应里** —— 故 `exchangeTraeCallback` 必须真发
  那次 `GetUserInfo` 才能拿到，不能只依赖回调
- ⚠️ **老账号必须主动回填**：光改代码只影响新登录的账号。`TraeAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，仿 `RaccoonAuth.repairAccountNicknames`）在启动时补一次
- ⚠️ **拿不到真实标识时不得改写昵称**：`Jet Hub` 允许用户手动改昵称
  （`account.update`），若退回去用凭据里的 `ScreenName` 重算，会把用户改过的名字
  覆盖成服务端默认名 —— 属无谓且有害的写入。故 `fetchUserContact` 在两者皆空时
  返回 `undefined`，调用方**直接 `continue`**
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace，每次启动都写会
  平白触发一次文档写

排查 / 验证：

- `scripts/probe-trae-userinfo.mjs` —— 打印每个 TRAE 账号 `GetUserInfo` 的
  **完整响应**（只读，零模型额度）
- `scripts/verify-trae-nickname.mjs` —— 用真实账号跑一遍 `repairAccountNicknames`
  并打印修复前后昵称（⚠️ **会写真实账号池昵称**，这正是修复效果本身）
- `tests/unit/trae.spec.ts` 的「TRAE 账号展示名」段（6 条，含四个真实手机号
  互不相同的断言）、`tests/unit/trae-auth.spec.ts` 的「repairAccountNicknames
  老账号回填」段（7 条，含「无标识不改写昵称」「幂等不重复请求」）

### ⚠️ LobsterAI 账号展示名：服务端把**手机号本身**当昵称下发（露 4 位）

**用户要求**（2026-09-27）：「lobsterai 的用户名字显示的手机号尾号漏出 4 位，
现在也改为只漏出 2 位」。

⚠️ **关键事实：`130****1100` 是服务端下发的 `user.nickname` 原值，不是本插件
截取的**。`buildLobsteraiCredential` 只做 `nickname: payload.nickname ?? ''` 照抄。
实测四个真实账号的登录响应即为此形态：

故修法是**归一化掩码**（`maskLobsteraiPhoneTail`，`src/lobsterai.ts`）而非改
某个 `slice(-4)` —— 那会是个找不到的假想目标。

要点：

- ⚠️ **两种输入都收敛到同一形态，因此幂等**：完整 11 位（`13011111100`，
  `profile-summary` 返回的就是完整号码）与已脱敏的露 4 位形态，输出都是
  `130******00`。幂等意味着老账号无需重新登录、重复运行不产生新写入
- ⚠️ **判据只认「像手机号」的形态**：`/^1\d{10}$/`（完整）或
  `/^\d{3}\*+\d+$/`（已脱敏）。**绝不能泛化到任意字符串** —— 那会把真实昵称
  （`用户<uid片段>` / `<自定义昵称>` / 邮箱形态）一起打掉。单测有专门一条守这个
- ⚠️ **星号个数按原串总长推算**（`总长 - 3 - 2`），长度保持不变；
  故对非 11 位的号码也自洽
- ⚠️ **末 2 位必须仍可区分**：四个真实账号掩码后为
  掩码把区分度也抹掉就失去意义了（单测断言 `Set.size === 4`）
- ⚠️ **老账号必须主动回填**：`LobsteraiAuth.repairAccountNicknames`
  （`src/index.ts` 启动时调用，与 `RaccoonAuth` / `TraeAuth` 同名方法同一模式）
- ⚠️ **纯本地、零网络**：掩码只依赖凭据里的昵称（与 TRAE 那条需要发
  `GetUserInfo` 不同）。单测断言 `fetcher` 未被调用
- ⚠️ **只在昵称确实变化时落盘**：`updateAccount` 是整体 replace

排查 / 验证：

- `scripts/probe-lobsterai-profile.mjs` —— 打印 `profile-summary` 的完整响应
  （**发现 `nickname` 在这里是完整号码 `13011111100`**，与登录响应的脱敏形态不同）
- `scripts/verify-lobsterai-nickname.mjs` —— 用真实账号跑一遍
  `repairAccountNicknames` 并打印修复前后昵称（⚠️ **会写真实账号池昵称**）
- `tests/unit/lobsterai.spec.ts` 的「手机号掩码（只露末 2 位）」段（8 条，
  含「非手机号形态原样返回」「末两位仍可区分」）、
  `tests/unit/lobsterai-auth.spec.ts` 的「老账号展示名回填」段（7 条，
  含「纯本地不发请求」「幂等」）

### ⚠️ 改昵称类修复必须**重启宿主**才生效，且旧进程会覆盖你的写入

**这是本轮实操踩到的坑**（2026-09-27）：用脚本把 `state.json` 的昵称改对之后，
**几分钟内又变回了旧值**（TRAE 的 `用户<uid片段>` 复活）。

根因：**当时有一个 1 小时前启动的 DSH 宿主进程仍在运行**（PID 9616，监听 3080）。
它加载的是**旧代码**（没有 `repairAccountNicknames`），内存里的账号池是旧昵称；
而 `AccountPool` 的写入是**整体 replace**（限流标记、续期回写等都会触发落盘），
于是它的下一次写盘就把脚本的修改**原样盖回去**。

两条必须记住的推论：

- ⚠️ **`repairAccountNicknames` 是「启动时」逻辑**：改完代码必须**重启 DSH**
  才会执行。不重启的话，无论脚本改多少次，旧进程都会覆盖
- ⚠️ **手工改 `state.json` 前先确认没有宿主在跑**（`Get-NetTCPConnection -LocalPort 3080`
  或看 node 进程），否则改动会被静默回滚 —— 症状是「明明改对了，过一会儿又变回去」，
  极易误判为「修复没生效 / 代码写错了」
- ⚠️ 验证修复是否真的生效，**唯一可靠方式是重启宿主**，然后看启动日志里有没有
  `[jet-hub] 已修正 N 个 … 账号的显示名`。脚本验证只能证明「逻辑正确」，
  不能证明「线上已生效」

### TRAE 倍率（藏在 `display_contact_config` 里，且该字段是** JSON 字符串**）

⚠️ **最大的坑**：`display_contact_config` 的值是**一个字符串**，里面才是 JSON。
直接读 `entry.display_contact_config.consumption_rate` 永远得到 `undefined` ——
必须 `JSON.parse` 两次（外层响应一次、这个字段再一次）。解析函数
`readConsumptionRate` / `readActivityDiscount`（`src/trae.ts`）。

```json
{ "consumption_rate": { "enable": true, "data": { "rate": 0.08 } },
  "activity_discount": { "enable": true, "subKey": "limited_discount",
    "data": { "current": { "discount_type": "limited",
                          "before_consumption_rate": 0.8,
                          "consumption_rate": 0.08, "discount": 10 },
              "limited": { "end_at": 1790265540 } } } }
```

- 倍率是 **裸数字**（`0.08`），既不是 buddy 的字符串 `"x0.29"`，也不是
  LobsterAI 的 `costMultiplier`
- ⚠️ **`rate: 0` 是「免费」，是合法值** —— 与 Qoder 的 `price_factor: 0` 同类，
  用 `> 0` 过滤会恰好漏掉免费模型；展示为「免费」而非 `x0`
- ⚠️ **`consumption_rate.enable === false` 视为「无倍率」**，不是「倍率 0」

#### ⚠️ `activity_discount.enable === true` **不等于**当前有折扣

**实测陷阱**（2026-09-20，与 Qoder 的 `promotion` 同类：**标志为真不等于当前生效**）：
`off_peak` 型条目形如

```json
{ "type": "none", "before_consumption_rate": 0.13,
  "after_consumption_rate": 0.13, "discount": 100 }
```

`enable` 是 `true`，但 `discount_type` 为 **`"none"`**、`before === after`
（`discount: 100` 是百分比制下的「无折扣」）。**照显会得到 `x0.13→x0.13`**，
让用户以为有活动。三条判据缺一不可（`readActivityDiscount`）：

1. `enable !== false`；
2. `data.current.discount_type` 存在且**不是 `"none"`**；
3. `before_consumption_rate` 为正，且**严格大于** `consumption_rate`。

另外 ⚠️ **`end_at`（Unix 秒）仅 `limited` 型带**（`subsidy` / `off_peak` 没有）。
**已过期必须整个不展示折扣** —— 否则用户按折扣价预期、实际被按原价计费。

展示形态由 `traeDisplayName`（`src/trae-adapter.ts`）拼装：
常态 `Qwen3.8-Flash · x0.08`；活动期 `Seed-2.1-Pro · x0.8→x0.08`。
`resolveModel` 的 `name` **不带**倍率（与 Qoder 一致）。兜底表路径**不显示倍率**
（兜底表无该字段，不猜价格）。

实测参考值（2026-09-20，`solo_agent` 可见集）：`glm-5.3-flash` x0.06、
`qwen3.8-flash` x0.08、`deepseek-v4.1-flash` x0.13、`glm-5.2` x0.78、
`qwen3.8-max` x1.5、`kimi-k3` x1.83；同一模型在三个通道的 `rate` **一致**。

### Qoder 倍率（`price_factor`，与腾讯系语义不同）

模型目录来自本机加密缓存 `~/.qoder/.models/{uid}/catalog-v6`
（`chat` 场景 17 个模型），倍率字段是 **`price_factor`**：

- ⚠️ **不是 `cost_multiplier`** —— 那是 LobsterAI 的字段名，两者易混
- ⚠️ **`price_factor: 0` 是「免费」**（实测 `qfmodel` / Qwen3.8-Flash），
  **0 是合法值**，不能用 `> 0` 过滤，否则恰好漏掉用户最关心的免费模型。
  展示为「免费」而非 `x0`
- 另有 `original_price_factor`（如 `qfmodel` 的 0.1 = 免费前的原价）
- ⚠️ **`price_factor` 是「采集时刻的生效价」，不是恒定原价** ——
  错峰窗口内它是折后价、窗口外是原价。故展示时**必须结合窗口本地推算**，
  不能直接照搬（照搬的后果：窗口一切换，界面价格就与真实计费不符）
- ⚠️ **错峰判据用 `windowStart`/`windowEnd` 本地推算（`promotionActiveNow`），
  *不*采信 `promotion.active`** —— 后者是目录下发那一刻的快照，
  客户端长时间不重启就会与真实时段脱节。窗口字段缺失时才回退到 `active`。
  生效价 = `beforePromotionPriceFactor × discountFactor`（实测三条全部吻合），
  窗口外则用原价。窗口统一 22:00–08:00（UTC+8），支持跨零点
- ⚠️ **折扣形态三个 provider 必须统一为「原价→折后价」**（TRAE `x0.4→x0.2`、
  buddy `x0.79→x0.50`、Qoder `x0.5→x0.2`）。Qoder 早期是「只有折后价 +
  中文角标」（`x0.2 错峰 4 折`），两个问题：① 看不出原价与折扣幅度；
  ② 角标与数字**冗余**（0.2/0.5 本就是 4 折）。用户要求对齐 TRAE。
  `promotion.badgeZh` 因此**不再参与展示**（字段保留，目录原始数据仍可对照）
- ⚠️ **本表的倍率数值必须逐条对照 catalog，不要凭印象填**：
  早期版本多处是手工估值，与真实值大范围不符（**14 个模型有偏差**：
  `smodel` 写 3.2 实际 8、`qmodel_38max` 写 0.5 实际 0.2、`auto` 写 1 实际 0.5 …），
  用户报障「qwen3.8-max 是 0.5 打折到 0.2，界面显示的是 0.5」。
  ⚠️ 而当时的单测**只断言了 id 列表**，所以价格漂移长期未被发现 ——
  改这张表时必须同步更新数值断言（`qoder-product.spec.ts`）
- `resolveModel` 的 `name` **不带**倍率后缀（价格只属于选择列表语境）

**解密该缓存**（`decryptModelCatalog`，`src/qoder-wasm.ts`）：

⚠️ **第二个参数是 `uid`，不是 `machine_id`**。两个官方调用点容易读反：
目录缓存的 `readSharedCacheSnapshot(A)` 传 uid，BYOK 的
`model_cache_decrypt(i, n)` 传 machineId。传错会得到
`AES-GCM decrypt failed: aead::Error` —— 看着像密文损坏，实为参数错。
调试脚本：`scripts/probe-qoder-catalog-debug.mjs`（两个候选都试）、
`scripts/probe-qoder-pricing.mjs`（打印 17 个模型的计费字段全貌）

### 同名模型必须消歧（`buildDisplayNames`）

远端会给**不同 id 配同一个 `name`**，而 DSH 按 `name` 展示 → 列表里出现
两个完全一样的条目。实测三组：

| 组 | 远端 name | 区别 |
|---|---|---|
| `deepseek-v4.1-flash` / `-sg` | 都是 `Deepseek-V4.1-Flash` | 新加坡区，`credits` x0.00 vs x0.03 |
| `hy3` / `hy3-x` | 都是 `Hy3` | — |
| `hy4-preview-f` / `hy4-preview` | 都是 `Hy4 preview` | — |

**用户报障**：「workbuddy 国际版同时显示 2 个 ds v4.1 flash，IDE 只有一个」。
IDE 按 name 归并，我们按 id 列出。二者是**不同区域的独立计费实体**，
不能靠丢弃其一来回避。

- 算法：对每组同名 id 求**公共前缀**，剩余段作为变体标记追加
  （`Deepseek-V4.1-Flash · x0.03 SG`、`Hy3 · x0.05 X`），空剩余段者不加标记
- ⚠️ **不要硬编码 `-sg`**：撞车组随服务端上新变化，本次实测三组里只有一组是
  `-sg`；也不要「取 id 最后一段」（会把 `gpt-5.6-sol` 的 `sol` 当变体）。
  公共前缀只在**确实撞车时**才切分
- ⚠️ **倍率与变体标记都只在 `name` 里出现一次**：初版两处都写，
  端到端实测出现重复文案与「计费 x0.00 · 」这种孤立分隔符
- LobsterAI **实测无同名**（28 个模型，0 组重名），故它不做消歧；
  兜底表路径也**不显示倍率**（兜底表无该字段，不猜价格）

排查脚本（全部只读 GET，零模型额度）：`scripts/probe-pricing.mjs`（各 provider
计费字段）、`scripts/probe-promotions.mjs`（`credits` 全量与促销结构）、
`scripts/probe-lobsterai-cost.mjs`（LobsterAI 倍率归属）、
`scripts/probe-lobsterai-dupes.mjs`（LobsterAI 同名检查）、
`scripts/probe-codearts-benefit.mjs`（CodeArts benefit 集合与判定）、
`scripts/verify-description.mjs`（端到端打印**切换菜单实际渲染的 name**）

## ⚠️ CodeArts benefit（免费额度）模型：集合必须动态判定，不能硬编码模型名

CodeArts 的 `snap-access/api/v2/chat/completions` 上有**两套模型注册**：benefit
（免费额度）与非 benefit。**benefit 模型的 chat 请求必须带 `maas_type: benefit`
请求头，且该头必须参与 SDK-HMAC-SHA256 签名**，否则后端返回
`InferHub.002002009.404 The model is not registered`（HTTP 200 + SSE 内嵌错误）。
反过来，给**非** benefit 模型带该头会被拒（`unsupported model`）。

**真实缺陷**（用户报障，2026-09-23）：用 `deepseek-v4.1-flash` 发消息后失败
（`Insufficient Balance` / `QUOTA`）。根因是 `src/llm-adapter.ts` 早期把 benefit
集合**硬编码**为 `new Set(['glm-5.3-flash'])` —— `deepseek-v4.1-flash` 是
2026-09 新增的 benefit 模型，因此从不带该头，后端按非 benefit 通道处理它。

实证矩阵（2026-09-23，对齐 deveco-code-rust `fb1b4a2`）：

| 模型 id | 来源 | 不带 maas_type | 带 maas_type |
|---|---|---|---|
| `glm-5.3-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4.1-flash` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash-0731` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-pro-0813` | gateway/config | 404 未注册 | ✓ 成功 |
| `deepseek-v4-flash`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `deepseek-v4-pro`（无后缀） | 静态表 / 归一化结果 | ✓ 成功 | ✗ unsupported |
| `GLM-5.2` | model/builtin | ✓ 成功 | ✗ unsupported |

结论：**`gateway/config` 返回的模型即 benefit 集合**，无需靠模型名硬编码。

要点：

- 判定 `isCodeArtsBenefitModel`（`src/models.ts`）：远端拉取并缓存的集合
  （`~/.cache/deveco/codearts_benefit_models.json`）∪ 静态兜底
  `CODEARTS_BENEFIT_FALLBACK`（`glm-5.3-flash` / `deepseek-v4.1-flash`）。
  远端集合优先，后端新增 benefit 模型**无需改代码**
- ⚠️ **只记录「归一化未改写」的 id**：gateway 下发的是
  `deepseek-v4-flash-0731`，而 `normalizeModelId` 会把它改写成
  `deepseek-v4-flash` —— 两者在后端是**不同模型、benefit 属性相反**，
  记录改写后的 id 会让无后缀模型多带 `maas_type` 而失败
- ⚠️ **判定必须在 `stream()` 的重试循环外算一次**（要读缓存文件，不宜每轮 IO）
- ⚠️ **缓存读写必须用顶层 `import { … } from 'node:fs'`，不能用 `require`** ——
  本包是 ESM（`package.json` 的 `"type": "module"`），`require` 未定义、抛
  ReferenceError 后被 `catch` 静默吞掉，表现为「写不进也读不回」（`loadModelsCache`
  的模型列表磁盘缓存曾因此长期失效）
- `deepseek-v4.1-flash` 的上下文窗口按 IDE 下发的 inferhub-provider 配置声明为
  **1000000**（与无后缀 v4-flash/pro 的 1048576 不同）
- 回归用例：`tests/unit/models.spec.ts`（集合判定 / 落盘不含改写 id / 缓存往返）、
  `tests/unit/llm-adapter.spec.ts`（v4.1 带 `maas_type` 且参与签名、无后缀
  v4-flash 不带）、`tests/e2e/v4-models.e2e.spec.ts`（真实收发，需闸门）

## ⚠️⚠️ 更正：腾讯风控**也拦 `assistant` 正文**，且直连路径必须一起改（2026-10-12）

上面「腾讯系内容级风控」一节的「只动 system，`user` / `assistant` / `tool` 一概不碰」**已被实测推翻**，
以本节为准。补测矩阵（真实登录态直打 `copilot.tencent.com`，触发串取磁盘原文逐字）：

| 触发串位置 | 结果 |
|---|---|
| `system`（含非首位） | ❌ 400/11128（已知） |
| `user` | ✅ 200 |
| `tool` 结果 | ✅ 200 |
| **`assistant` 正文 `content`** | ❌ **400/11128 ← 新格** |
| `assistant` 的 `reasoning_content` | ✅ 200 |
| `tool_calls[].function.arguments` | ✅ 200 |
| 与文档同字节数的良性长文本 | ✅ 200 ⇒ **体量不是原因** |

**为什么初版漏了这格**：那条 assistant 探针把触发句改写成了转述形态（`I see … here.`），
而服务端是**逐字符**匹配 —— 那个形态本身不含触发串，**等于空跑**，却得出了「assistant 放行」的结论。

**已落地的修法**（四处产出点，缺一即复发）：

- `src/openai-gateway/messages.ts` 的 `assistant` 分支（原来只有 `system`）；
- `src/openai-gateway/responses.ts` 的 `assistant` 分支（与 Chat 同判据）；
- `src/buddy-adapter.ts` 的 `serializeMessages`：**`assistant` 正文 + `system`**（DSH **直连**方向，
  原先**完全没有任何改写**）；
- `src/buddy-adapter.ts` 的 `stream()` 里 `options.system` 那一条 —— 它**绕过** `serializeMessages`，
  是最容易漏的第四个点。

`user` / `tool` 结果 / `reasoning_content` / `arguments` **刻意不改**：实测不拦，
改它们换不来放行，却会篡改用户原话与要回读给模型看的证据，并白吃腾讯侧前缀缓存。
用例把「该改的改了」与「不该改的一字没动」**两侧**都锁住
（`tests/unit/buddy-adapter.spec.ts` 的「直连路径的腾讯风控指纹改写」段）。

**真实报障机制（自指污染）**：排查这个风控 bug 的会话会先 `read` 记录该指纹的文档
（`providers-buddy.md` 自己就逐字写着那句 —— tool 结果，不拦），模型随后把它**逐字复述进
自己的正文**（拦）。那句一旦进了历史就每轮原样重放 ⇒ 会话从此报废，且
**换任何腾讯系模型都一样** —— 用户当时报的 `step-5-preview` 与 `space-bunny` 同一个错，
正是「症状跟会话走、不跟模型走」。

**取证 / 验收脚本**（⚠️ 均在 `scripts/` 下，而**该目录被 `.gitignore` 忽略**，
属本机一次性工具、**不入库**，故以下名字在仓库里查不到，别当假指路）：
`probe-buddy-role-matrix.mjs`（角色矩阵）、`probe-buddy-assistant-bisect.mjs`
（二分定位到单行 + 体量对照，写在另一份 checkout `dsh-codearts/scripts/`）、
`verify-buddy-fingerprint-fix.mts`（同一份被拦历史：裸 fetch ❌11128 /
打过补丁的真实 `BuddyAdapter` ✅）。要长期保留就得把它们挪进版本控制内的目录。

ℹ️ 验收时还暴露过一个「`space-bunny` 报 `tool calls and tool results do not match`」的
现象 —— **已在下一小节解决**（真因不是工具配对，而是 wire 首条角色）。

### 已修：上面那个「尚未修」的独立问题，真因**不是**工具配对（2026-10-12 同日）

末节登记的 `space-bunny` 报 `tool calls and tool results do not match`，取证后结论是
**报错文案在骗人**：

1. 先逐格核对真实适配器产出的 wire（`dump-buddy-tool-count.mts`）：**无孤儿、无重复 id、
   每条 assistant 的调用都被紧随的结果完整覆盖** ⇒ 配对根本没坏；
2. 再做单变量实验（`probe-spacebunny-firstmsg.mjs`）：同一份请求体，**只把开头的
   system 去掉、让首条变成「带 tool_calls 的 assistant」**——
   `space-bunny` → 400/**11148**（`displayMsg.zh`=「工具记录不完整，请新建任务」），
   `step-5-preview` → **200**。补回一条 system，两个模型都 200。

⇒ 真正的判据是 **wire 的首条角色**，与工具配对无关。上游那句文案是误导性的。
（另注：`11101 Unmarshal chat params failed` 是另一类 —— 那是 `arguments` 传了**对象**
而非 JSON 字符串，Go 侧反序列化失败。）

**修法**：`buddy-adapter.ts` 的 `stream()` 在序列化后检查「首条是不是 assistant」，
是则补一条最小中性 system（`LEADING_SYSTEM_PLACEHOLDER`）。该文本刻意不含任何
风控指纹字面量 —— 否则这条兜底自己会把会话送进 11128。

生产里确实可触发：会话历史被压缩/截断到把开头的 system 与首条 user 一起削掉时，
剩下的历史就以 assistant 开头。与既有的「WorkBuddy 网关强制 `messages[0]` 是 system」
是同族约束，只是 CodeBuddy 侧只在「首条是带 tool_calls 的 assistant」时发作。

⚠️ 有一条**既有**用例 `sends assistant reasoning_content and null content for tool-only
turns` 原先按**下标**断言 `messages[0]` 是 assistant —— 那正是把旧形状当契约的地方，
已改为按角色取。教训：wire 的位置断言在上游补位时会整体平移，别用下标锁角色。

用例：`tests/unit/buddy-adapter.spec.ts` 的「wire 首条不得是 assistant」段（3 条：
补位且不破坏配对、正常历史不多塞、`options.system` 已就位时不重复补）。
验收：同一份被拦历史走真实适配器，`step-5-preview` 与 `space-bunny` **都 ✅**。

### ⚠️ 2026-10-12 子代理审计抓到两个**真缺陷**（均已修）

对上面两个提交跑了一轮 subagent 驱动的审计 + 对抗性审计（两个独立视角并行：
功能面 / 测试面，各自做了变异验证）。抓到的东西按严重度：

**① 补位判据过窄（真缺陷，我第一版就写错了）**
判据写成 `role === 'assistant'`，只覆盖 assistant-first。**user-first / tool-first 照样原样发出** ——
而本仓库 `account-probe.ts` 的 `PROBE_SYSTEM` 注释里早有 2026-09-25 的双端点对照实测：
**WorkBuddy 网关强制 `messages[0]` 是 system，否则 400 + 11128**。
⇒ 真正的判据是 **`!== 'system'`**。与 `PROBE_SYSTEM` 那段「无条件给所有 provider
都带 system，判据不该依赖另一个产品碰巧不校验」的取舍一致。

**② `this.product.id` 零覆盖（测试盲区，实测存活变异）**
`serializeMessages(…, this.product.id)` 改成 `serializeMessages(…, 'buddy')`
（完全忽略产品配置）⇒ **163 条用例全绿**。原因：`buddy` 与 `workbuddy` **都在**
`TENCENT_PROVIDERS` 那张表里，「喂 WORKBUDDY 也能改写」那条用例**结构上无法区分**
这两个实现 —— 是同义反复。
修法：**反向**用例（喂非腾讯系产品，断言 wire 逐字节不变）。已验证它能抓住该变异。

⚠️ 两条的**共同教训**：「按文案/按当前观察写死判据」会漏掉相邻形态。真实判据往往是
「X 必须满足」，而不是「我实测到的那种坏法」—— 后者永远漏其余分支。

**③ 实测凭据从 `scripts/` 挪进 `tests/e2e/`（悬空引用）**
上面那张角色表与「首条角色」那条判据，原先只以**脚本**形式存在于被 gitignore 的
`scripts/`（另一份 checkout），注释指向它们 ⇒ 后人无法复核。现各入库一个带双闸门的
e2e 规格（`buddy-fingerprint-roles.e2e.spec.ts` / `buddy-first-message-role.e2e.spec.ts`）。
⚠️ 这两个文件**不可省**：单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对**。

**④ `buddy-growth.ts` 是第三条旁路（当前无害，已加路标）**
它有两处直发 `POST …/v2/chat/completions`，**不经 `BuddyAdapter`、故不过改写**。
当前安全（请求体写死「你好」/「1+1等于几」，无指纹也无 assistant 历史），
但那条安全性依赖「请求体写死」这个易碎前提 ⇒ 已在其注释里写明将来要接上。

**⑤ 未采纳**：一条 `toLowerCase()` 预检的性能优化建议（5.4×，属优化非正确性，
且实测非命中时 `String.replace` 返回**同一对象**、前缀缓存没被破坏）—— 留待需要时再做。
