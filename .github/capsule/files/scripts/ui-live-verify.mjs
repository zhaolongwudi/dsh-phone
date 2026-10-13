// 设备端验收（第三层：真实渲染）：在本机运行中的 DSH 引擎上，对**真实页面**取
// DOM/几何证据，并做一次可逆的开合交互。
//
// ## 这一层补的是什么
//
// 本层此前的门禁全在「静态产物」面上：源码写了什么、产物里有什么类名、协议形态
// 对不对。这些**都证明不了**「在设备上真的渲染出来、点的动、几何对」。
//
// 本轮实测出的三类「静态全绿但设备上是坏的」：
//   ① 主 WebView 视口 1212×655 ⇒ `@media (max-width: 767px)` 不成立，
//      手机形态**压根未激活**（此前把「看不到效果」归因于「没条件验收」）；
//   ② 设备上跑的 `dsh-phone.js` 是 **25521B 基线版**（无标记层），
//      而工作区里是 29297B 三期版 —— 版本落差靠读源码看不出来；
//   ③ 只注入插件不注入 CSS ⇒ 组件渲染出来了，但 `.dsh-phone-mask` 高度为 0。
//
// ## 为什么必须用「隔离验收面」而不是主窗口
//
// 主 WebView 视口 1212×655，767px 断点不成立 ⇒ 手机形态永远测不到。
// 而 App 的内置浏览器 WebView 只有 454×673，天生满足断点。把主 WebView 的
// `dsh-auth-*` cookie 注入过去，它就成为一个**已认证 + 窄屏 + 不影响用户当前视图**
// 的验收面。
//
// ## 两种验收模式（装包前后各一条）
//
//   · **注入式**（默认 `--surface-auth` + `--run`）：设备上跑的是旧包时，
//     用 CDP 把工作区产物投到运行中的引擎上，验「产物本身对不对」。
//   · **真实 App**（`--realapp`）：设备上跑的已是新版时，**直接验当前页面** ——
//     验的是「设备实际装载的那份代码」。后者才是终态验收。
//     ⚠️ 它需要对**视口做临时仿真**（手机形态全在 `@media (max-width:767px)` 内，
//     而设备常是横屏 1212px）—— 只改渲染视口、不改代码/资源，且结束即 clear 并复核。
//
// 判据同源：两种模式用同一套断言（开关几何/不重叠/事实翻转/侧栏滑入…），
// 故「注入式通过」与「真实 App 通过」可直接对比，不会有标准漂移。
//
// ## 三层验收的分工
//
//   · CDP 层（本脚本）：真实 DOM、真实几何、真实开合翻转；
//   · ADB 层：实际遮挡与触控（本机 adb 无设备侧授权、无障碍未启用，未做，见报告）；
//   · 代码层：capsule 内的全部门禁与单测。
//
// 用法：
//   node scripts/ui-live-verify.mjs --list            # 列可用调试目标
//   node scripts/ui-live-verify.mjs --surface         # 看当前面状态（只读）
//   node scripts/ui-live-verify.mjs --surface-auth    # 建隔离验收面（注入 cookie）
//   node scripts/ui-live-verify.mjs --run             # 注入式验收
//   node scripts/ui-live-verify.mjs --realapp         # 真实 App 验收（窄屏仿真，可逆）
//   node scripts/ui-live-verify.mjs --restore         # 还原
//
// 无 CDP 通道/无引擎时**显式跳过**（CI 属预期），不假装通过。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'
import { dirname, join } from 'node:path'
import { resolveAssets, resolvePhoneJs, resolvePlugin } from './ui-tests/paths.mjs'

const NUL = String.fromCharCode(0)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 引擎端口（与壳层 DshService.localStartUrl() 一致）。 */
const ENGINE = 'http://127.0.0.1:3080/'

// ── 极简 CDP 客户端（不引第三方依赖：本层门禁须能在最小环境下跑） ──────────
class WS {
  constructor(sock, initial = Buffer.alloc(0)) {
    this.sock = sock; this.buf = Buffer.from(initial); this.frag = []; this.onmessage = null
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._drain() })
    if (this.buf.length) queueMicrotask(() => this._drain())
  }
  _drain() {
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f, off = 2
      // 握手响应与首帧可能同包到达；调用方已把残留字节交进来，故这里只处理完整帧
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10 }
      let mask = null
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4 }
      if (b.length < off + len) return
      let payload = b.subarray(off, off + len)
      if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4] }
      this.buf = b.subarray(off + len)
      if (op === 0x8) { this.sock.destroy(); return }
      if (op === 0x9) { this._frame(0xa, payload); continue }
      if (op === 0xa) continue
      this.frag.push(payload)
      if (fin) { const t = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.onmessage?.(t) }
    }
  }
  _frame(op, payload) {
    const mask = crypto.randomBytes(4), data = Buffer.from(payload)
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]
    let head
    if (data.length < 126) head = Buffer.from([0x80 | op, 0x80 | data.length])
    else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2) }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2) }
    this.sock.write(Buffer.concat([head, mask, data]))
  }
  send(t) { this._frame(0x1, Buffer.from(t, 'utf8')) }
}

let msgId = 0
class Cdp {
  constructor(ws, page) {
    this.ws = ws; this.page = page; this.pending = new Map(); this.listeners = new Map()
    ws.onmessage = t => {
      let m; try { m = JSON.parse(t) } catch { return }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return
      }
      if (m.method) for (const h of this.listeners.get(m.method) ?? []) { try { h(m.params) } catch { /* 处理器内部错误不影响会话 */ } }
    }
  }
  on(method, h) { if (!this.listeners.has(method)) this.listeners.set(method, new Set()); this.listeners.get(method).add(h) }
  send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')) } }, 20000)
    })
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
    return { value: r.result?.value }
  }
  close() { try { this.ws.sock.destroy() } catch { /* 已断开 */ } }
}

/** 枚举抽象套接字上可用的调试目标（page 类型）。 */
function listTargets(socketName) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(NUL + socketName)
    let raw = ''
    const t = setTimeout(() => { sock.destroy(); reject(new Error('超时')) }, 4000)
    sock.on('error', e => { clearTimeout(t); reject(e) })
    sock.on('data', d => {
      raw += d.toString('utf8')
      const i = raw.indexOf('\r\n\r\n'); if (i < 0) return
      clearTimeout(t); sock.destroy()
      try { resolve(JSON.parse(raw.slice(i + 4))) } catch (e) { reject(e) }
    })
    sock.on('connect', () => sock.write('GET /json/list HTTP/1.1\r\nHost: localhost\r\n\r\n'))
  })
}

/** 连到某抽象套接字的首个 page 目标。 */
function connectCdp(socketName) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(NUL + socketName)
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('连接超时 ' + socketName)) }, 8000)
    sock.on('error', e => { clearTimeout(timer); reject(e) })
    sock.on('connect', async () => {
      let raw = ''
      const targets = await new Promise((res, rej) => {
        const onData = d => {
          raw += d.toString('utf8')
          const i = raw.indexOf('\r\n\r\n'); if (i < 0) return
          sock.off('data', onData)
          try { res(JSON.parse(raw.slice(i + 4))) } catch (e) { rej(e) }
        }
        sock.on('data', onData)
        sock.write('GET /json/list HTTP/1.1\r\nHost: localhost\r\n\r\n')
        setTimeout(() => { sock.off('data', onData); rej(new Error('/json/list 超时')) }, 4000)
      }).catch(e => { clearTimeout(timer); sock.destroy(); throw e })
      const page = targets.find(x => x.type === 'page')
      if (!page) { clearTimeout(timer); sock.destroy(); return reject(new Error('无 page 目标')) }
      const key = crypto.randomBytes(16).toString('base64')
      sock.write([
        `GET /devtools/page/${String(page.webSocketDebuggerUrl).split('/devtools/page/')[1]} HTTP/1.1`,
        'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'))
      let hs = ''
      const onHs = d => {
        hs += d.toString('latin1')  // latin1：首帧与握手同包时按字节保留
        const i = hs.indexOf('\r\n\r\n'); if (i < 0) return
        sock.off('data', onHs)
        if (!/HTTP\/1\.1 101/.test(hs)) { clearTimeout(timer); sock.destroy(); return reject(new Error('握手失败')) }
        clearTimeout(timer)
        resolve(new Cdp(new WS(sock, Buffer.from(hs.slice(i + 4), 'latin1')), page))
      }
      sock.on('data', onHs)
    })
  })
}

/** 找出本机可用的 WebView 调试套接字（只探测，不遍历全部抽象命名空间）。 */
async function discoverSockets() {
  const found = []
  // 进程名 → pid：只有 App 自己的进程才有 webview_devtools_remote_<pid>。
  // 用 /proc 枚举（本机可读）而不是猜端口。
  let pids = []
  try { pids = (await import('node:fs')).readdirSync('/proc').filter(d => /^\d+$/.test(d)) } catch { /* 无 /proc */ }
  for (const pid of pids) {
    const name = 'webview_devtools_remote_' + pid
    const ok = await new Promise(res => {
      const s = net.connect(NUL + name)
      const t = setTimeout(() => { s.destroy(); res(false) }, 400)
      s.on('connect', () => { clearTimeout(t); s.destroy(); res(true) })
      s.on('error', () => { clearTimeout(t); res(false) })
    })
    if (ok) found.push(name)
  }
  return found
}

// ── 验收快照（只读） ─────────────────────────────────────────────────────
const SNAP = `
return (() => {
  const q = s => document.querySelector(s)
  const cs = e => e ? getComputedStyle(e) : null
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  const rail = q('[data-dsh-rail]') || q('.pI_x6G_sidebarCol')
  const cmask = q('.dsh-phone-mask'), lmask = q('.dsh-phone-sidebar-mask')
  const active = cmask && cs(cmask).display !== 'none' ? cmask : (lmask && cs(lmask).display !== 'none' ? lmask : null)
  return {
    viewport: { w: innerWidth, h: innerHeight },
    breakpoints: { js: matchMedia('(max-width: 767px)').matches, css: matchMedia('(max-width: 700px)').matches },
    facts: {
      mobileForm: document.documentElement.hasAttribute('data-dsh-mobile-form'),
      frame: !!q('[data-dsh-frame]'), rail: !!q('[data-dsh-rail]'),
      drawerOpen: document.documentElement.hasAttribute('data-dsh-drawer-open'),
      maskMounted: document.documentElement.hasAttribute('data-dsh-mask-mounted'),
      modalOpen: document.documentElement.hasAttribute('data-dsh-modal-open'),
      settingsOpen: document.documentElement.hasAttribute('data-dsh-settings-open'),
    },
    menu: { present: !!q('.dsh-phone-menu'), hidden: q('.dsh-phone-menu')?.hasAttribute('hidden') ?? null, expanded: q('.dsh-phone-menu')?.getAttribute('aria-expanded') ?? null, box: box(q('.dsh-phone-menu')) },
    // 三期：抽屉开关已迁入 header.leading（接管式）。两项都要测：
    //   · 接管成功 ⇒ 槽位开关渲染、旧按钮隐藏
    //   · 未接管   ⇒ 旧按钮照常（降级路径），此时 slotToggle 为 null 不算失败
    slotToggle: {
      present: !!q('.dsh-phone-menu-slot'),
      box: box(q('.dsh-phone-menu-slot')),
      expanded: q('.dsh-phone-menu-slot')?.getAttribute('aria-expanded') ?? null,
      mountedFact: document.documentElement.hasAttribute('data-dsh-toggle-mounted'),
      legacyVisible: q('.dsh-phone-menu') ? cs(q('.dsh-phone-menu')).display !== 'none' : false,
      headerBox: box(q('header')),
      titleRowBox: box(q('.wSkVaW_titleRow')),
    },
    rail: { box: box(rail), transform: cs(rail)?.transform, visibility: cs(rail)?.visibility, inert: rail?.inert ?? null },
    componentMask: { present: !!cmask, box: box(cmask), display: cs(cmask)?.display, z: cs(cmask)?.zIndex },
    localMask: { present: !!lmask, box: box(lmask), display: cs(lmask)?.display },
    activeMask: active ? { cls: active.className, box: box(active), display: cs(active).display, z: cs(active).zIndex } : null,
    slotErrors: [...document.querySelectorAll('[data-slot-error]')].map(e => e.getAttribute('data-slot-error')),
  }
})()`

// ── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }

const sockets = await discoverSockets()
if (sockets.length === 0) {
  console.log('设备端验收：跳过（未发现 WebView 调试套接字 —— 非本机运行环境，或 WebView 未开调试）')
  console.log('  说明：本层只在真机维护期可跑；无通道时不假装通过。')
  process.exit(0)
}

if (args.includes('--list')) {
  console.log('可用 WebView 调试目标：')
  for (const s of sockets) {
    try {
      const t = await listTargets(s)
      for (const p of t.filter(x => x.type === 'page')) console.log(`  ${s}\n    ${p.title?.slice(0, 50)} | ${p.url}`)
    } catch (e) { console.log(`  ${s}  （取目标失败：${e.message}）`) }
  }
  process.exit(0)
}

// 验收面选择：**按视口宽度实测挑**，而不是按枚举顺序。
//   手机形态只在 max-width:767px 下成立，故必须选真正窄的那个 WebView。
//   实测本机：主窗口 1212px（不满足）、内置浏览器 454px（满足）——
//   按枚举顺序猜会选错，必须实测宽度与认证态。
//
// ⚠️ `--realapp` 是例外：它**自己**做视口仿真，故宽视口正是它要处理的常态
//    （设备模拟器/平板横屏）。此时按「已认证」挑即可，不再要求窄视口 ——
//    否则会在真正需要它的场景下被这条守卫挡掉（本节实测踩到：
//    --realapp 报了「没有满足 767px 的已认证视口」而退出）。
const REALAPP = args.includes('--realapp')
let surface = arg('--socket')
let mainSock = null
if (!surface) {
  const infos = []
  for (const sock of sockets) {
    try {
      const c = await connectCdp(sock)
      const v = await c.evalJs(`return { w: innerWidth, h: innerHeight, mq: matchMedia('(max-width: 767px)').matches, unauthed: document.body.innerText.includes('authentication required'), title: document.title, hasFrame: !!document.querySelector('[data-rightbar-col]') }`)
      infos.push({ socket: sock, ...(v.value ?? {}) })
      c.close()
    } catch { /* 取不到就跳过 */ }
  }
  if (REALAPP) {
    // 真实 App 模式：挑**已认证且已挂载框架**的那个（通常是主窗口），不要求窄视口。
    const pick = infos.filter(i => !i.unauthed && i.hasFrame)[0] ?? infos.filter(i => !i.unauthed)[0]
    surface = pick?.socket
    if (!surface) {
      console.log('设备端验收（真实 App）：跳过（未找到已认证且已挂载的视口）')
      console.log('  实测：' + infos.map(i => `${i.socket}=${i.w}px${i.unauthed ? '(未认证)' : ''}${i.hasFrame ? '(有框架)' : ''}`).join(', '))
      process.exit(0)
    }
  } else {
    const pick = infos.filter(i => i.mq === true && i.unauthed === false)[0] ?? infos.find(i => i.mq === true)
    surface = pick?.socket
    mainSock = infos.find(i => i.mq === false)?.socket ?? null
    if (!surface) {
      console.log('设备端验收：跳过（本机没有满足 767px 断点的已认证视口）')
      console.log('  实测视口：' + infos.map(i => `${i.socket}=${i.w}px${i.unauthed ? '(未认证)' : ''}`).join(', '))
      console.log('  提示：手机形态只在窄视口成立。若设备已装新版，用 --realapp（自带视口仿真）。')
      process.exit(0)
    }
  }
}
if (!surface) { console.log('设备端验收：跳过（无可用的 page 目标）'); process.exit(0) }

const outPath = arg('--out')
const s = await connectCdp(surface)
console.log(`设备端验收 · 面=${surface} · ${s.page.url}`)

if (args.includes('--surface')) {
  const vp = await s.evalJs(`return { w: innerWidth, h: innerHeight, mq: matchMedia('(max-width: 767px)').matches, unauthed: document.body.innerText.includes('authentication required') }`)
  console.log('  视口/断点/认证：' + JSON.stringify(vp.value ?? vp.error))
  s.close()
  process.exit(0)
}

// 建面：把主窗口（宽视口）的 dsh-auth-* cookie 复制到窄面，使窄面变成
// 「已认证 + 满足断点」的验收面。cookie 值只在进程内传递，不打印、不落盘。
if (args.includes('--surface-auth')) {
  if (!mainSock) { console.log('  ✗ 未找到宽视口主窗口，无法取认证 cookie'); s.close(); process.exit(1) }
  const m = await connectCdp(mainSock)
  await m.send('Network.enable')
  const cookies = (await m.send('Network.getAllCookies')).cookies ?? []
  m.close()
  const auth = cookies.find(c => c.name.startsWith('dsh-auth-'))
  if (!auth) { console.log('  ✗ 主窗口未持有 dsh-auth-* cookie'); s.close(); process.exit(1) }
  await s.send('Network.enable')
  const r = await s.send('Network.setCookie', {
    name: auth.name, value: auth.value, domain: auth.domain, path: auth.path,
    httpOnly: auth.httpOnly, secure: auth.secure, sameSite: auth.sameSite,
  })
  console.log(`  cookie ${auth.name} 注入：${r.success ? '成功' : '失败 ' + JSON.stringify(r)}（值不打印）`)
  await s.send('Page.enable')
  await s.send('Page.navigate', { url: ENGINE })
  await sleep(3000)
  const st = await s.evalJs(`return { w: innerWidth, h: innerHeight, mq: matchMedia('(max-width: 767px)').matches, unauthed: document.body.innerText.includes('authentication required'), hasFrame: !!document.querySelector('[data-rightbar-col]') }`)
  console.log('  建面结果：' + JSON.stringify(st.value ?? st.error))
  s.close(); process.exit(0)
}

if (args.includes('--restore')) {
  // 还原：删掉注入的 cookie，并导航回引擎首页
  await s.send('Network.enable')
  const cs = (await s.send('Network.getAllCookies')).cookies ?? []
  let n = 0
  for (const c of cs.filter(x => x.name.startsWith('dsh-auth-'))) {
    await s.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }); n++
  }
  await s.send('Page.navigate', { url: ENGINE })
  await sleep(1200)
  const st = await s.evalJs(`return { unauthed: document.body.innerText.includes('authentication required') }`)
  console.log(`  已还原（清除 ${n} 个 cookie、导航回首页）：` + JSON.stringify(st.value ?? st.error))
  s.close(); process.exit(0)
}

// ── 真实 App 模式（--realapp）：设备上装的已是新版时，直接验当前页面 ──────
//    与注入式的区别：不投任何产物 —— 验的就是 APK 里装载的那份代码。
//    唯一让步是**视口仿真**（手机形态全在 @media(max-width:767px) 内，而设备常是
//    横屏 1212px）：只改渲染视口，不改代码/资源，结束立即 clear 并复核恢复。
if (args.includes('--realapp')) {
  const width = Number(arg('--width', '400'))

  // ⚠️ **强制重载到设备自身的真实状态**（默认行为，不可跳过）。
  //    为什么必须：`--realapp` 的意义是「验设备实际装载的那份代码」，但若同一会话里
  //    先前跑过**注入式**实验（Fetch 替换 combo / 写 #dsh-phone-presentation），
  //    页面里跑的就是**注入产物**而非设备自身的 —— 此时验收会**假绿**。
  //    本轮实测踩到：先跑注入实验验证修复，再跑 `--realapp` 得 23/23 全绿；
  //    而重载后真实设备是 `slotText:""`（修复根本未生效）。
  //    故每次 `--realapp` 都先清缓存 + 硬重载，并**报告设备实测指纹**供比对。
  await s.send('Page.enable')
  await s.send('Network.enable')
  await s.send('Network.setCacheDisabled', { cacheDisabled: true })
  await s.send('Page.reload', { ignoreCache: true })
  await sleep(6000)
  const fp = (await s.evalJs(`
    const st = document.getElementById('dsh-phone-presentation')
    const slot = document.querySelector('.dsh-phone-menu-slot')
    return {
      cssLen: st ? st.textContent.length : null,
      slotText: slot ? (slot.textContent || '').trim() : null,
      hasMinWidth44: st ? st.textContent.includes('min-width:44px') : null,
    }
  `)).value
  console.log('\n⓪ 已强制重载（清注入污染）· 设备实测指纹：' + JSON.stringify(fp))
  if (fp && fp.cssLen != null && !fp.hasMinWidth44) {
    console.log('   注：设备 CSS 无 `min-width:44px` ⇒ 跑的是**修复前**的包（修复需重装 APK）')
  }

  // ── `--preview`：把**即将发布**的产物投到真实引擎上预演（而非验设备自带的）──
  //   用途：设备落后于产物时（如刚修完还没重装），回答「新包能不能过」。
  //   与默认 `--realapp` 的区别必须说清：
  //     · 默认      ：验**设备实际装载**的那份（权威，但受设备版本限制）
  //     · --preview ：验**将要发布**的那份（预演，**不证明设备已装**）
  //   两者互补，且共用同一套判据（故结果可直接对比）。
  const PREVIEW = args.includes('--preview')
  if (PREVIEW) {
    const a = resolveAssets()
    const cssText = readFileSync(a.css, 'utf8')
    let jsText = readFileSync(resolvePhoneJs(), 'utf8')
    const bundleText = readFileSync(resolvePlugin('qqBundle'), 'utf8')
    // 剥掉形态层守卫（改由文档创建期接管标志位，避免与设备原生脚本并存互改状态）
    const guardRe = /^\s*if \(window\.__dshPhonePresentation\) return;\s*\n\s*window\.__dshPhonePresentation = true;\s*\n/m
    if (!guardRe.test(jsText)) { console.log('  ✗ 形态层未找到守卫行，无法安全剥离'); s.close(); process.exit(2) }
    jsText = jsText.replace(guardRe, '')
    // ⚠️ 报**字节数**而非字符数：版本判定（ui-verify-installed）用的是字节数，
    //    两处口径不一致会让数字对不上（本层 CSS 含大量中文注释，字符数 16868 vs
    //    字节数 19190，差 2300+ —— 曾让人误以为「预演的 CSS 变小了」）。
    console.log('\nⓅ 预演模式：投入**即将发布**的产物 ' + JSON.stringify({
      cssBytes: Buffer.byteLength(cssText), jsBytes: Buffer.byteLength(jsText), bundleBytes: Buffer.byteLength(bundleText),
    }))
    // 让设备原生脚本短路
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(window, '__dshPhonePresentation', { configurable: true, get() { return true }, set() {} })`,
    })
    await s.send('Page.reload', { ignoreCache: true })
    await sleep(4000)
    // 无损替换 combo 中的 dsh-phone-qq 段
    const combo = await s.evalJs(`
      const url = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('dsh-phone-qq') && n.includes('plugins/'))
      if (!url) return { error: 'no combo' }
      const r = await fetch(url, { cache: 'no-store' })
      return { body: await r.text() }
    `)
    if (!combo.value?.body) { console.log('  ✗ 取 combo 失败：' + JSON.stringify(combo.value)); s.close(); process.exit(2) }
    const cbText = combo.value.body
    const segs = [...cbText.matchAll(/window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/g)].map(m => ({ id: m[1], at: m.index }))
    const qi = segs.findIndex(x => x.id === 'dsh-phone-qq')
    if (qi < 0) { console.log('  ✗ combo 内无 dsh-phone-qq'); s.close(); process.exit(2) }
    const s0 = segs[qi].at, s1 = qi + 1 < segs.length ? segs[qi + 1].at : cbText.length
    const patched = cbText.slice(0, s0) + bundleText + '\n' + cbText.slice(s1)
    console.log(`     combo ${cbText.length}B → ${patched.length}B（${segs.length} 模块，无损替换第 ${qi} 段）`)
    await s.send('Fetch.enable', { patterns: [{ urlPattern: '*plugins/*', requestStage: 'Request' }] })
    s.on('Fetch.requestPaused', async p => {
      if (/dsh-phone-qq/.test(p.request.url) && /plugins\//.test(p.request.url)) {
        try {
          await s.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/javascript; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }],
            body: Buffer.from(patched, 'utf8').toString('base64') })
          return
        } catch { /* 落到 continue */ }
      }
      try { await s.send('Fetch.continueRequest', { requestId: p.requestId }) } catch { /* 已失联 */ }
    })
    await s.send('Page.reload', { ignoreCache: true })
    await sleep(7000)
    // 注入形态层产物（等价于装新 APK）
    // compat.js 是**上游文件**（本层未覆盖它），故 capsule 工作区里通常没有。
    // 它是「WebView 兼容垫片」，设备上已由 APK assets 注入且**与本层无关** ——
    // 故缺失时跳过注入即可（不注入不会影响本层判据；强行要求会误报环境问题）。
    const compatPath = join(dirname(a.css), 'dsh-phone.compat.js')
    const compatSrc = existsSync(compatPath) ? readFileSync(compatPath, 'utf8') : ''
    if (!compatSrc) console.log('     注：capsule 内无 dsh-phone.compat.js（上游文件），跳过其注入')
    const injRes = await s.evalJs(`
      document.querySelectorAll('.dsh-phone-menu,.dsh-phone-sidebar-mask').forEach(e => e.remove())
      document.documentElement.removeAttribute('data-dsh-drawer-open')
      let st = document.getElementById('dsh-phone-presentation')
      if (!st) { st = document.createElement('style'); st.id = 'dsh-phone-presentation'; document.head.appendChild(st) }
      st.textContent = ${JSON.stringify(cssText)}
      try { ${compatSrc} } catch (e) { return { compatErr: String(e && e.message || e) } }
      try { ${jsText}; return { ok: true } } catch (e) { return { ok: false, err: String(e && e.message || e) } }
    `)
    console.log('     形态层注入：' + JSON.stringify(injRes.value ?? injRes.error))
    await sleep(900)
    await s.send('Fetch.disable')
  }

  const pre = (await s.evalJs(SNAP)).value
  console.log('\n① 仿真前（设备当前视口）：' + JSON.stringify({ vp: pre.viewport, bp: pre.breakpoints, facts: pre.facts, menu: pre.menu, slotToggle: pre.slotToggle }, null, 1))
  if (!pre.slotToggle.mountedFact && !pre.facts.maskMounted) {
    console.log('  ⊘ 本页未见接管事实 ⇒ 设备上跑的可能仍是旧包。')
    console.log('    先跑 `ui-verify-installed.mjs` 判定版本；旧包请用 --surface-auth + --run 做注入式验收。')
    s.close(); process.exit(0)
  }
  // 关过渡（无焦点面里动画帧不推进，会读到过渡中间态 —— 此坑此前踩过）
  await s.evalJs(`
    const st = document.createElement('style'); st.id = 'probe-notrans'
    st.textContent = '[data-dsh-rail],.pI_x6G_sidebarCol,.dsh-phone-mask,.dsh-phone-sidebar-mask{transition:none!important}'
    document.head.appendChild(st); return 1
  `)
  await s.send('Emulation.setDeviceMetricsOverride', { width, height: 655, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 655 })
  await sleep(800)
  const narrow = (await s.evalJs(SNAP)).value
  const overlapFn = (a, b) => a && b && !(a[0]+a[2] <= b[0] || b[0]+b[2] <= a[0] || a[1]+a[3] <= b[1] || b[1]+b[3] <= a[1])
  console.log(`\n② 仿真窄屏（width=${width}）：` + JSON.stringify({ vp: narrow.viewport, bp: narrow.breakpoints, facts: narrow.facts, slotToggle: narrow.slotToggle, overlap: overlapFn(narrow.slotToggle.box, narrow.slotToggle.titleRowBox), rail: narrow.rail }, null, 1))

  // ── 交互方式：`--touch` 用**真实触摸事件**，否则用合成 click ─────────────
  //   `.click()` 只派发最后一步 click，绕过 touchstart→touchend 事件链，
  //   因此**测不出**遮挡、可点区过小、pointer-events:none、touchstart 被吞。
  //   `Input.dispatchTouchEvent` 从浏览器输入层注入，走完整链 —— 这是不启用
  //   无障碍/adb 时最接近真机的验证（详见下方「触控层」说明）。
  const USE_TOUCH = args.includes('--touch')
  /** 在元素中心做一次真实触摸（按下 60ms 后抬起）。 */
  const touchTap = async (cx, cy) => {
    const pt = [{ x: Math.round(cx), y: Math.round(cy), radiusX: 6, radiusY: 6, force: 1 }]
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt })
    await sleep(60)
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  let touchDiag = null
  if (USE_TOUCH) {
    // 遮挡检查：开关中心点上，最顶层元素是否就是开关自己。
    // 这是 `.click()` 永远测不到的一类真实缺陷（视觉可见但点不到）。
    touchDiag = (await s.evalJs(`
      const slot = document.querySelector('.dsh-phone-menu-slot')
      if (!slot) return null
      const b = slot.getBoundingClientRect()
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2
      const top = document.elementFromPoint(cx, cy)
      const cs = getComputedStyle(slot)
      return {
        cx, cy, w: b.width, h: b.height,
        topTag: top ? top.tagName : null, topCls: top ? String(top.className).slice(0, 60) : null,
        isSelfOrChild: !!(top && (top === slot || slot.contains(top))),
        inViewport: b.x >= 0 && b.y >= 0 && b.x + b.width <= innerWidth && b.y + b.height <= innerHeight,
        bigEnough: b.width >= 24 && b.height >= 24,
        // 触控相关 CSS：touch-action:none 会让点击失效；pointer-events:none 收不到事件
        touchAction: cs.touchAction, pointerEvents: cs.pointerEvents,
        text: (slot.textContent || '').trim(),
      }
    `)).value
    console.log('\n  触摸目标诊断：' + JSON.stringify(touchDiag, null, 1))

    // **事件链探针**：记录真实触摸时实际到达的事件序列（passive 监听，不改行为）。
    //  为什么值得单独验：结果对（drawerOpen 翻转）不代表链路健康 ——
    //  若某层在 touchstart 上 preventDefault，触摸反馈会丢失（按住无视觉响应），
    //  而 `.click()` 类断言完全看不出来。
    await s.evalJs(`
      window.__evt = []
      const slot = document.querySelector('.dsh-phone-menu-slot')
      if (!slot) return 1
      const rec = n => e => window.__evt.push({
        type: n, defaultPrevented: e.defaultPrevented,
        target: e.target ? (e.target.tagName + '.' + String(e.target.className).slice(0, 24)) : null,
      })
      for (const n of ['touchstart','touchend','pointerdown','pointerup','click']) {
        slot.addEventListener(n, rec(n), { passive: true, capture: true })
      }
      return 1
    `)
  }

  const clickInfo = await s.evalJs(`
    const slot = document.querySelector('.dsh-phone-menu-slot')
    const legacy = document.querySelector('.dsh-phone-menu')
    const t = (slot && getComputedStyle(slot).display !== 'none') ? slot : ((legacy && getComputedStyle(legacy).display !== 'none') ? legacy : null)
    if (!t) return 'none'
    ${USE_TOUCH ? 'return \'touch:\' + String(t.className)' : 't.click(); return String(t.className)'}
  `)
  if (USE_TOUCH && touchDiag) await touchTap(touchDiag.cx, touchDiag.cy)
  console.log('\n③ 交互目标（' + (USE_TOUCH ? '真实触摸' : '合成 click') + '）：' + JSON.stringify(clickInfo.value ?? clickInfo.error))
  await sleep(700)
  const opened = (await s.evalJs(SNAP)).value
  // 事件链：真实触摸时读取探针记录（供判据用）
  const evtChain = USE_TOUCH ? (await s.evalJs(`return { events: window.__evt || [] }`)).value : null
  if (USE_TOUCH && evtChain) {
    const ts = evtChain.events.map(e => e.type)
    console.log('   事件链：' + (ts.length ? ts.join(' → ') : '(空 —— 未捕获到任何事件)'))
  }
  // 关闭：优先触摸遮罩的**右侧空白区**（避开侧栏，侧栏占 x<280）
  const cl = await s.evalJs(`
    const cm = document.querySelector('.dsh-phone-mask'), lm = document.querySelector('.dsh-phone-sidebar-mask')
    const t = (cm && getComputedStyle(cm).display !== 'none') ? cm : ((lm && getComputedStyle(lm).display !== 'none') ? lm : null)
    if (!t) return { clicked: null }
    const b = t.getBoundingClientRect()
    ${USE_TOUCH
      ? "return { clicked: String(t.className), tx: Math.min(b.x + b.width - 30, b.x + 340), ty: b.y + b.height / 2 }"
      : 't.click(); return { clicked: String(t.className) }'}
  `)
  if (USE_TOUCH && cl.value?.tx != null) await touchTap(cl.value.tx, cl.value.ty)
  await sleep(700)
  const closed = (await s.evalJs(SNAP)).value
  await s.send('Emulation.clearDeviceMetricsOverride')
  await sleep(800)
  const restored = (await s.evalJs(SNAP)).value

  const checks = [
    ['真实 App 上形态层已激活（窄屏 mobile-form）', narrow?.facts.mobileForm === true],
    ['真实 App 上槽位开关已接管（toggle-mounted）', narrow?.slotToggle.mountedFact === true],
    ['真实 App 上遮罩组件已接管（mask-mounted）', narrow?.facts.maskMounted === true],
    ['开关渲染且几何非零', (narrow?.slotToggle.box?.[2] ?? 0) > 0 && (narrow?.slotToggle.box?.[3] ?? 0) > 0],
    ['开关位于 header 内', !!narrow?.slotToggle.headerBox && !!narrow?.slotToggle.box &&
      // ⚠️ 必须比 headerBox 与 box —— 曾误写成 box 与 box 自比（恒真 ⇒ 假绿）。
      narrow.slotToggle.box[1] >= narrow.slotToggle.headerBox[1] - 1 &&
      narrow.slotToggle.box[1] + narrow.slotToggle.box[3] <= narrow.slotToggle.headerBox[1] + narrow.slotToggle.headerBox[3] + 1],
    ['开关与标题行不重叠', !overlapFn(narrow?.slotToggle.box, narrow?.slotToggle.titleRowBox)],
    ['标题行仍可见（宽 > 0）', (narrow?.slotToggle.titleRowBox?.[2] ?? 0) > 0],
    ['旧自绘按钮已被隐藏（无两个开关）', narrow?.slotToggle.legacyVisible === false],
    // 阈值与**仿真前**对比，不写死绝对值：该视图 header 本身 76px（空白会话 hero 头），
    // 写死 41 会假红（本节首轮踩到）。接管只应改列布局，不应改高度。
    ['header 高度未被接管改变（与仿真前相同）', ((narrow?.slotToggle.headerBox)?.[3] ?? -1) === ((pre?.slotToggle.headerBox)?.[3] ?? -2)],
    ['点开关后事实翻转', opened?.facts.drawerOpen === true],
    ['点开关后 aria-expanded 翻转（形态层同步）', opened?.slotToggle.expanded === 'true'],
    ['点开关后侧栏滑入视口（x>=0）', (opened?.rail.box?.[0] ?? -1) >= 0],
    ['点开关后遮罩可见且铺满', (opened?.activeMask?.box?.[3] ?? 0) > 100],
    ['点遮罩后事实收回', closed?.facts.drawerOpen === false],
    ['点遮罩后侧栏滑出（x<0）', (closed?.rail.box?.[0] ?? 0) < 0],
    ['无槽位错误', (narrow?.slotErrors ?? []).length === 0],
    ['仿真已复原（视口回到原值）', JSON.stringify(pre.viewport) === JSON.stringify(restored?.viewport)],
  ]

  // ── 触控层专项判据（仅 --touch 时）──────────────────────────────────────
  //   这些是 `.click()` **测不到**的一类真实缺陷：
  //     · 元素被别的层遮住（视觉可见、点不到像素）
  //     · 触摸目标过小 / 出视口
  //     · 开关无可见内容（宽度只靠 padding 撑起，实测过 22px）
  //     · pointer-events / touch-action 让它收不到事件
  if (USE_TOUCH && touchDiag) {
    checks.push(
      ['触控：开关在视口内（点得到像素）', touchDiag.inViewport === true],
      // elementFromPoint 命中的最顶层元素必须是开关自己或其子元素。
      // 否则说明有别的元素压在它上面 —— 真实手指会点到那个元素。
      ['触控：开关中心无遮挡（最顶层就是它）', touchDiag.isSelfOrChild === true],
      ['触控：可点区不过小（≥24px 两边）', touchDiag.bigEnough === true],
      // 开关必须有**可见内容**：无内容时宽度只由 padding 撑起（实测 22px），
      // 且用户看不出这是开关 —— 两个后果都由该判据兜住。
      ['触控：开关有可见文本（非空按钮）', (touchDiag.text ?? '').length > 0],
      ['触控：touch-action 未禁用点击', touchDiag.touchAction !== 'none'],
      ['触控：pointer-events 可接收事件', touchDiag.pointerEvents !== 'none'],
      ['触控：遮罩可接收触摸（pointer-events 非 none）', opened?.activeMask != null],
      ['触控：真实触摸后抽屉打开', opened?.facts.drawerOpen === true],
      ['触控：真实触摸遮罩后关闭', closed?.facts.drawerOpen === false],
    )
    // **事件链判据**：结果对（drawerOpen 翻转）不代表链路健康 ——
    //   若某层在 touchstart 上 preventDefault，触摸反馈会丢失（按住无视觉响应），
    //   而结果仍可能正确。故验「实际到达了哪些事件」与「有没有被吞」。
    if (evtChain) {
      const ts = evtChain.events.map(e => e.type)
      checks.push(
        ['触控链：收到 touchstart', ts.includes('touchstart')],
        ['触控链：收到 touchend', ts.includes('touchend')],
        // 浏览器合成的 click 是「触摸被当成点击」的证据；缺失说明被吞或位移过大。
        ['触控链：浏览器合成了 click', ts.includes('click')],
        // touchstart 被 preventDefault ⇒ 触摸反馈丢失（真实可用性缺陷）。
        ['触控链：touchstart 未被 preventDefault',
          evtChain.events.filter(e => e.type === 'touchstart').every(e => e.defaultPrevented === false)],
        // 所有事件都应落在开关自身上（落在别处说明被上层截走）。
        ['触控链：事件 target 均为开关自身',
          evtChain.events.length > 0 && evtChain.events.every(e => String(e.target).includes('dsh-phone-menu-slot'))],
      )
    }
  }

  // ── 断点一致性判据 ───────────────────────────────────────────────────────
  //  本层手机形态由**两个独立消费方**判断：JS 的 matchMedia 与 CSS 的 @media。
  //  两者若不一致会出现**半态**（JS 认为手机、CSS 认为桌面），且**不报错**。
  //  故在断点两侧各取一点实测。用的是 --realapp 已建好的仿真通道。
  {
    const probe = async (w) => {
      await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: 655, deviceScaleFactor: 1, mobile: true, screenWidth: w, screenHeight: 655 })
      await sleep(600)
      return (await s.evalJs(`
        const html = document.documentElement
        // CSS 断点是否生效：用只在 @media(max-width:767px) 内声明的变量探测
        const topbar = getComputedStyle(html).getPropertyValue('--dsh-phone-topbar').trim()
        return {
          vw: innerWidth,
          visualW: visualViewport ? visualViewport.width : null,
          jsBp: matchMedia('(max-width: 767px)').matches,
          cssBp: topbar === '44px',
          mobileForm: html.hasAttribute('data-dsh-mobile-form'),
        }
      `)).value
    }
    const inside = await probe(700)   // 断点内
    const outside = await probe(900)  // 断点外
    console.log('\n  断点一致性探测：')
    console.log('    700px → ' + JSON.stringify(inside))
    console.log('    900px → ' + JSON.stringify(outside))
    checks.push(
      ['断点内：JS 与 CSS 断点一致（无半态）', inside.jsBp === inside.cssBp],
      ['断点内：形态事实与 JS 断点一致', inside.mobileForm === inside.jsBp],
      ['断点外：JS 与 CSS 断点一致（无半态）', outside.jsBp === outside.cssBp],
      ['断点外：形态事实与 JS 断点一致', outside.mobileForm === outside.jsBp],
    )
    // 复原到窄屏（后续判据依赖窄屏状态）
    await s.send('Emulation.setDeviceMetricsOverride', { width, height: 655, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 655 })
    await sleep(500)
  }

  console.log('\n═══ ' + (PREVIEW ? '发布前预演' : '真实 App 验收') + '（窄屏仿真，可逆' + (USE_TOUCH ? '；交互=真实触摸事件' : '') + '）═══')
  let pass = 0
  for (const [n, ok] of checks) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++ }
  console.log(`\n通过 ${pass}/${checks.length}`)
  if (outPath) writeFileSync(outPath, JSON.stringify({ mode: 'realapp', pre, narrow, opened, closed, restored, checks }, null, 2))
  // 提示语必须区分两种模式 —— 否则预演结果会被误读成「设备已通过」。
  console.log(PREVIEW
    ? '\n注：**预演模式** —— 验的是「即将发布」的产物（已投入运行中的引擎），' +
      '\n    **不证明设备已装**。设备是否已装请跑 ui-verify-installed.mjs 判定。'
    : '\n注：本步只改渲染视口（可逆），未改代码/资源 —— 验的是设备实际装载的那份。')
  s.close()
  process.exit(pass === checks.length ? 0 : 1)
}

// ── 验收主流程 ───────────────────────────────────────────────────────────
// ⚠️ 必须显式 --run。默认**只做只读快照**、不点击。
//    原因：主流程含一次真实点击（开抽屉）。在 CI、或用户在正常用 App 时被
//    误触发，都会打扰真实会话 —— 所以「会改变页面状态的动作」一律要显式开关。
if (!args.includes('--run') && !args.includes('--snapshot')) {
  console.log('设备端验收：未指定动作。')
  console.log('  --snapshot  只读快照（推荐先跑这个）')
  console.log('  --run       注入式验收（含一次可逆开合点击）')
  console.log('  --realapp   真实 App 验收（设备已装新版时用；窄屏仿真可逆）')
  console.log('  --surface-auth / --restore  建面 / 还原')
  console.log('  --list      列出调试目标')
  s.close(); process.exit(0)
}

const vp = await s.evalJs(`return { w: innerWidth, h: innerHeight, mq: matchMedia('(max-width: 767px)').matches, unauthed: document.body.innerText.includes('authentication required') }`)
const v = vp.value
if (!v || v.unauthed) {
  console.log('  跳过：当前面未认证（需先把主窗口的 dsh-auth-* cookie 注入本面）')
  s.close(); process.exit(0)
}
if (!v.mq) {
  console.log(`  跳过：本面视口 ${v.w}×${v.h} 不满足 767px 断点 —— 手机形态在此面上不成立，测不出结论。`)
  console.log('  提示：验收面应取窄视口那个 WebView（内置浏览器通常 ~454px）。')
  s.close(); process.exit(0)
}

// 只读快照模式：采一次状态就退出，不点击
if (args.includes('--snapshot') && !args.includes('--run')) {
  const snap = (await s.evalJs(SNAP)).value
  console.log('\n只读快照：' + JSON.stringify(snap, null, 1))
  if (outPath) writeFileSync(outPath, JSON.stringify({ surface, snapshot: snap }, null, 2))
  s.close(); process.exit(0)
}

// ⚠️ 关掉抽屉的 CSS 过渡再测几何。
//    实测踩到的假象：rail 带 `transition: transform .16s`，而隔离面**无焦点**
//    （document.hasFocus()=false）⇒ 动画帧不推进，几何永远停在 translateX(-100%)。
//    证据：禁用 transition 后立即读到正确的滑入终值 matrix(1,0,0,1,0,0)。
await s.evalJs(`
  const st = document.createElement('style'); st.id = 'dsh-phone-live-probe-notransition'
  st.textContent = '[data-dsh-rail],.pI_x6G_sidebarCol{transition:none!important}'
  document.head.appendChild(st); return 1
`)

const base = await s.evalJs(SNAP)
const b = base.value
console.log('\n静态基线：' + JSON.stringify({ vp: b.viewport, facts: b.facts, railBox: b.rail.box, componentMask: b.componentMask, localMask: b.localMask, slotToggle: b.slotToggle }, null, 1))

// 点开关：接管后是槽位按钮，未接管则是形态层自绘按钮。
// ⚠️ 必须按**实际可见性**选目标，不能硬编码类名 —— 否则接管后点到已被 CSS
//    display:none 的旧按钮，点击无效会被误报成「开关坏了」（本节实测踩到过）。
const clickedTarget = await s.evalJs(`
  const slot = document.querySelector('.dsh-phone-menu-slot')
  const legacy = document.querySelector('.dsh-phone-menu')
  const target = (slot && getComputedStyle(slot).display !== 'none') ? slot
    : ((legacy && getComputedStyle(legacy).display !== 'none') ? legacy : null)
  if (target) target.click()
  return target ? String(target.className) : 'none'
`)
console.log('  点击目标：' + JSON.stringify(clickedTarget.value ?? clickedTarget.error))
await sleep(600)
const opened = (await s.evalJs(SNAP)).value
console.log('\n点开后：' + JSON.stringify({ drawerOpen: opened.facts.drawerOpen, railBox: opened.rail.box, railVisibility: opened.rail.visibility, activeMask: opened.activeMask, menuExpanded: opened.menu.expanded, slotExpanded: opened.slotToggle.expanded }, null, 1))

const cl = await s.evalJs(`
  const cm = document.querySelector('.dsh-phone-mask'), lm = document.querySelector('.dsh-phone-sidebar-mask')
  const t = (cm && getComputedStyle(cm).display !== 'none') ? cm : ((lm && getComputedStyle(lm).display !== 'none') ? lm : null)
  if (!t) return { why: '无可见遮罩' }
  t.click(); await new Promise(r => setTimeout(r, 600))
  return { clicked: t.className, drawerOpen: document.documentElement.hasAttribute('data-dsh-drawer-open') }
`)
console.log('\n点遮罩关闭：' + JSON.stringify(cl.value ?? cl.error))
const closed = (await s.evalJs(SNAP)).value

const checks = [
  ['形态事实 data-dsh-mobile-form 已发布（窄屏）', b?.facts.mobileForm === true],
  ['框架/侧栏事实 [data-dsh-frame]+[data-dsh-rail] 已发布', b?.facts.frame === true && b?.facts.rail === true],
  ['抽屉开关在场且可见（槽位或自绘至少其一）', (b?.slotToggle.present === true || b?.menu.present === true)],
  ['槽位组件已接管（mask-mounted 发布）', b?.facts.maskMounted === true],
  ['静态时组件遮罩隐藏', b?.componentMask.display === 'none'],
  ['点开后 drawer-open 事实翻转', opened?.facts.drawerOpen === true],
  ['点开后侧栏滑入视口（x>=0）', (opened?.rail.box?.[0] ?? -1) >= 0],
  ['点开后侧栏可见', opened?.rail.visibility === 'visible'],
  ['点开后遮罩铺满可视区（高>100）', (opened?.activeMask?.box?.[3] ?? 0) > 100],
  ['点开后本地遮罩退让（不重叠）', opened?.localMask.display === 'none'],
  ['点遮罩后事实收回、侧栏滑出', closed?.facts.drawerOpen === false && (closed?.rail.box?.[0] ?? 0) < 0],
  ['无槽位错误', (opened?.slotErrors ?? []).length === 0],
]

// 三期抽屉开关迁移的专项判定（仅在该槽真的接管时才要求，否则属降级路径、不算失败）。
// 为什么要单列：开关迁入 header 后最容易坏的是**布局**（与标题重叠 / 挤出 header），
// 而这在功能断言里完全看不出来（点击照样能开）。
if (b?.slotToggle.mountedFact === true) {
  const st = b.slotToggle
  const hit = (a, c) => a && c && !(a[0]+a[2] <= c[0] || c[0]+c[2] <= a[0] || a[1]+a[3] <= c[1] || c[1]+c[3] <= a[1])
  checks.push(
    ['开关迁移：槽位开关渲染且几何非零', (st.box?.[2] ?? 0) > 0 && (st.box?.[3] ?? 0) > 0],
    ['开关迁移：位于 header 内', !!st.headerBox && !!st.box && st.box[1] >= st.headerBox[1] - 1 && st.box[1] + st.box[3] <= st.headerBox[1] + st.headerBox[3] + 1],
    ['开关迁移：与标题行不重叠', hit(st.box, st.titleRowBox) === false],
    ['开关迁移：标题行仍可见（宽 > 0）', (st.titleRowBox?.[2] ?? 0) > 0],
    ['开关迁移：旧自绘按钮已隐藏（无两个开关）', st.legacyVisible === false],
    ['开关迁移：点开后 aria-expanded 翻转（形态层同步）', opened?.slotToggle.expanded === 'true'],
    ['开关迁移：点遮罩后 aria-expanded 复原', closed?.slotToggle.expanded === 'false'],
  )
} else {
  console.log('  （开关未接管 ⇒ 走降级路径，跳过迁移专项判定；功能断言仍然生效）')
}
console.log('\n═══ 设备端验收（CDP 层）═══')
let pass = 0
for (const [n, ok] of checks) { console.log('  ' + (ok ? '✓' : '✗') + ' ' + n); if (ok) pass++ }
console.log(`\n通过 ${pass}/${checks.length}`)
if (outPath) writeFileSync(outPath, JSON.stringify({ surface, base: b, opened, closed, checks }, null, 2))
console.log('\n注：本步只读 + 一次可逆开合；不写磁盘、不改持久状态。')
s.close()
process.exit(pass === checks.length ? 0 : 1)
