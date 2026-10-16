// 录屏工具：用 CDP 的 Page.startScreencast 逐帧抓取页面，再用 ffmpeg 按真实时间戳合成固定帧率视频。
// 截的是页面本身的像素（含 deviceScaleFactor），不受系统缩放和窗口遮挡影响。
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const DEV_SERVER = 'http://localhost:5173'
/**
 * 录制时用正式网址打开游戏，请求转给本地开发服务器：画面里的邀请链接、回放链接显示的就是正式网址。
 * 开发服务器的模块路径都在根目录下（/src/...、/@vite/...），所以把 /xiangqi-mayhem 前缀去掉再转发。
 */
export const APP_URL = 'https://wervex.github.io/xiangqi-mayhem/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** 横屏：1920×1080 原生。桌面布局是中间一列对局、两侧放大模型对话框，这个高度刚好放下整个对局界面 */
export const LANDSCAPE = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
/** 竖屏：540×960 × 2 = 1080×1920，走游戏的手机布局，整个对局界面刚好放进一屏 */
export const PORTRAIT = { viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, isMobile: true, hasTouch: false }

export async function launch() {
  return chromium.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--mute-audio'] })
}

/** 假鼠标：无头浏览器的截图里没有光标，用一个跟随 mousemove 的圆点代替，点击时有个波纹 */
export const CURSOR_SCRIPT = `
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div')
  c.id = '__promo_cursor'
  c.style.cssText = 'position:fixed;left:-100px;top:-100px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
    'background:rgba(255,255,255,.85);border:2px solid rgba(0,0,0,.55);box-shadow:0 1px 6px rgba(0,0,0,.4);' +
    'pointer-events:none;z-index:2147483647;transition:transform .12s'
  document.body.appendChild(c)
  addEventListener('mousemove', (e) => { c.style.display = ''; c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
  // 鼠标移出窗口时页面收不到 mousemove，圆点会停在原处，所以隐藏光标要直接藏起来
  window.__promoHideCursor = () => { c.style.display = 'none' }
  addEventListener('mousedown', () => { c.style.transform = 'scale(.7)' }, true)
  addEventListener('mouseup', () => { c.style.transform = '' }, true)
})
`

/**
 * random：固定 Math.random 的种子，让"新开一局"的种子和锦囊选项每次录制都一样
 */
export async function newPage(browser, device, { cursor = true, storage, random } = {}) {
  const ctx = await browser.newContext({ ...device, locale: 'zh-CN' })
  await ctx.route('https://wervex.github.io/**', async (route) => {
    const u = new URL(route.request().url())
    const path = u.pathname.replace(/^\/xiangqi-mayhem(?=\/|$)/, '') || '/'
    try {
      const response = await route.fetch({ url: DEV_SERVER + path + u.search })
      await route.fulfill({ response })
    } catch {
      await route.abort()
    }
  })
  if (cursor) await ctx.addInitScript(CURSOR_SCRIPT)
  if (random !== undefined) {
    await ctx.addInitScript((seed) => {
      let a = seed >>> 0
      Math.random = () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }, random)
  }
  if (storage) {
    await ctx.addInitScript((items) => {
      if (sessionStorage.getItem('__promo_seeded')) return
      sessionStorage.setItem('__promo_seeded', '1')
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v)
    }, storage)
  }
  const page = await ctx.newPage()
  page.device = device
  return page
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 光标平滑移到目标中心再点击 */
/** 隐藏假光标（下次移动鼠标时自动出现） */
export async function hideCursor(page) {
  await page.mouse.move(-50, -50)
  await page.evaluate(() => window.__promoHideCursor?.()).catch(() => {})
}

export async function moveTo(page, target, ms = 450) {
  if (typeof target.scrollIntoViewIfNeeded === 'function') await target.scrollIntoViewIfNeeded()
  const box = typeof target.boundingBox === 'function' ? await target.boundingBox() : target
  if (!box) throw new Error('目标不可见')
  const x = box.x + (box.width ?? 0) / 2
  const y = box.y + (box.height ?? 0) / 2
  await page.mouse.move(x, y, { steps: Math.max(2, Math.round(ms / 16)) })
  return { x, y }
}

export async function click(page, target, { pause = 250, ms } = {}) {
  await moveTo(page, target, ms)
  await sleep(120)
  await page.mouse.down()
  await sleep(70)
  await page.mouse.up()
  await sleep(pause)
}

/** 开始录制，返回 stop()：停止并输出 mp4（固定 30fps） */
export async function record(page, outFile, { fps = 30, maxFps = 40 } = {}) {
  const { viewport, deviceScaleFactor } = page.device
  const W = Math.round(viewport.width * deviceScaleFactor)
  const H = Math.round(viewport.height * deviceScaleFactor)
  const dir = outFile + '.frames'
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames = []
  // 限制存盘帧率：动画一直在动时（如"思考中…"计时）浏览器会持续发帧，全部存下来太占磁盘。
  // 间隔太近的帧先暂存，稍后没有新帧再补写，保证画面最终停在最新状态。
  const minGap = 1 / maxFps
  let pending = null
  const write = (f) => {
    const name = `${String(frames.length).padStart(6, '0')}.jpg`
    writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'))
    frames.push({ name, t: f.t })
  }
  const lastT = () => (frames.length ? frames[frames.length - 1].t : -Infinity)
  const flusher = setInterval(() => {
    if (pending && Date.now() / 1000 - pending.arrived >= minGap) {
      write(pending)
      pending = null
    }
  }, 15)
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const f = { data, t: metadata.timestamp, arrived: Date.now() / 1000 }
    if (f.t - lastT() >= minGap) {
      pending = null
      write(f)
    } else pending = f
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId })
    } catch {
      // 录制结束后才到达的帧
    }
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
  const t0 = Date.now() / 1000
  // 时间标记：剪辑时按标记切分镜头，写到 <输出>.marks.json
  const marks = {}

  async function stop() {
    const tEnd = Date.now() / 1000
    await cdp.send('Page.stopScreencast')
    await sleep(100)
    clearInterval(flusher)
    if (pending) write(pending)
    if (!frames.length) throw new Error('没有录到任何帧')
    // 屏幕没变化时浏览器不发新帧，所以每帧的时长 = 到下一帧的时间差
    const lines = []
    frames.forEach((f, i) => {
      const next = i + 1 < frames.length ? frames[i + 1].t : tEnd
      const start = i === 0 ? Math.min(f.t, t0) : f.t
      lines.push(`file '${f.name}'`, `duration ${Math.max(0.001, next - start).toFixed(4)}`)
    })
    lines.push(`file '${frames[frames.length - 1].name}'`)
    writeFileSync(join(dir, 'list.txt'), lines.join('\n'))
    await ffmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
      '-vf', `scale=${W}:${H}:flags=lanczos,fps=${fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-threads', '4', outFile,
    ])
    const dur = tEnd - t0
    let peak = 0
    for (let i = 0, j = 0; i < frames.length; i++) {
      while (frames[i].t - frames[j].t > 1) j++
      peak = Math.max(peak, i - j + 1)
    }
    console.log(`  录制 ${outFile}：${dur.toFixed(1)}s，${frames.length} 帧（动画时峰值 ${peak} fps）`)
    writeFileSync(outFile + '.marks.json', JSON.stringify({ duration: dur, ...marks }, null, 1))
    rmSync(dir, { recursive: true, force: true })
  }
  stop.mark = (name) => {
    marks[name] = +(Date.now() / 1000 - t0).toFixed(2)
  }
  return stop
}

export function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
  })
}
