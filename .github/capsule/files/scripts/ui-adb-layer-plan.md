// ADB 层验收方案（系统级触控）—— 目标 1 的最后一层。
//
// ## 这一层与「触控层（浏览器输入层）」的本质区别
//
// 已有的 `--realapp --touch` 用 CDP 的 `Input.dispatchTouchEvent` 注入触摸 ——
// 它走**浏览器**事件链，但**不经 Android InputDispatcher**。故测不到：
//   · 系统手势区冲突（屏幕边缘/底部返回手势抢走触摸）
//   · 系统级遮挡（状态栏、导航栏、输入法覆盖）
//   · 真实手指的多点抖动与压力差异
//
// 本方案用 DSH 的 `phone_control` 工具（`tap` / `swipe` / `screenshot`），
// 它经 **Android 无障碍/Shizuku 通道**注入**系统级**触摸事件 —— 这才是 ADB 层。
//
// ## 前置（用户侧，一次性）
//   · 启用 DSH 手机操作无障碍服务（`accessibilityConnected: true`）
//   · 会话权限为 danger-full-access（本会话已满足）
//   · 手机工具处于可用状态（`phone_control_status.status !== 'off'`）
//
// ## 步骤（本文件是**操作手册 + 判定清单**，由主代理按步执行）
//
// 1. `phone_control launch com.dshphone` —— 确保 App 在前台
// 2. `phone_control screenshot` —— 取基准截图，**记录返回的尺寸**（用于坐标换算）
// 3. `phone_control read` —— 取节点树，找抽屉开关节点的**精确坐标**
//    ⚠️ 优先用节点（nodeId）而非裸坐标：节点由无障碍树给出，不受截图缩放影响
// 4. `phone_control tap`（或 `click` 节点）—— 系统级点击抽屉开关
// 5. `phone_control screenshot` —— 验证抽屉是否真的滑出（**看像素**，不只看 DOM）
// 6. `phone_control tap` 遮罩区域 —— 系统级点击遮罩
// 7. `phone_control screenshot` —— 验证抽屉收回
//
// ## 判定清单（ADB 层专属，浏览器层测不到的）
//
// | 判据 | 为什么只有本层能测 |
// |---|---|
// | 开关可被**系统级**点击命中 | 浏览器层注入绕过 InputDispatcher |
// | 抽屉滑出后**在屏幕上可见** | 截图是像素证据，DOM 断言不是 |
// | 遮罩遮挡**整屏**（含状态栏区域） | 系统级遮挡只有截图像素能证 |
// | 屏幕边缘手势**不抢走**开关点击 | 需要真实系统手势区参与 |
// | 点击后**无系统 UI 覆盖**干扰 | 状态栏/导航栏只有本层可见 |
//
// ## 与既有验收的关系（三层分工，不互相冒充）
//
//   · 代码层        ：capsule 内 18 测试 + 门禁（静态产物）
//   · CDP 层        ：`--realapp`（真实 DOM/几何/事件链）
//   · **ADB 层（本方案）**：系统级触控 + 截图像素（真机最终观感）
//
// 本文件**不自动执行**（手机工具需交互授权，且截图需视觉判读）——
// 它是给主代理执行的清单，避免凭记忆操作而漏掉判定项。
console.log(`ADB 层验收方案（系统级触控）
=====================================

前置检查（执行前先跑）：
  1. phone_control_status  → accessibilityConnected 应为 true
                            status 不应为 'off'（若为 off，需用户在界面重新授权）
  2. 记录设备屏幕尺寸（screenshot 返回的 width/height），用于坐标换算

步骤与判定：
  ┌ 步骤 1  启动 App            phone_control launch com.dshphone
  ├ 步骤 2  取基准截图          phone_control screenshot   → 记下尺寸，确认当前是聊天页
  ├ 步骤 3  读节点树找开关      phone_control read         → 找 aria-label='展开菜单' 的节点
  │          ⚠️ 优先用 nodeId 点击（无障碍树坐标），而非裸坐标
  ├ 步骤 4  系统级点击开关      phone_control click(nodeId) 或 tap(x, y)
  ├ 步骤 5  截图验证滑出        phone_control screenshot   → 侧栏应可见（像素证据）
  ├ 步骤 6  系统级点击遮罩      phone_control tap(遮罩区域坐标)
  └ 步骤 7  截图验证收回        phone_control screenshot

ADB 层专属判定（浏览器层测不到）：
  [ ] 开关能被系统级点击命中（不经浏览器注入）
  [ ] 抽屉滑出后在屏幕上**可见**（截图像素，非 DOM 断言）
  [ ] 遮罩覆盖整屏（含状态栏下方区域）
  [ ] 屏幕边缘手势未抢走开关点击
  [ ] 点击后无系统 UI（状态栏/导航栏/输入法）干扰

已知限制（如实标注）：
  · 本层需交互授权，无法在无人值守时自动跑
  · 截图判读需视觉能力，非纯断言
  · 设备当前版本落后于产物（CSS 19156 ≠ 19190）⇒ 本层验收的仍是**修复前**的行为
    若要验修复后的行为，需先装 build-20261013-0123 或更新
`)
