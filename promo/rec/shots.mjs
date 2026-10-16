// 各个镜头的录制脚本。node rec/shots.mjs [镜头名 ...]，不带参数录全部（不含大模型镜头）
// 输出 out/clips/<镜头名>.mp4 和 .marks.json（镜头内的时间标记，剪辑时用）
import { mkdirSync } from 'node:fs'
import { APP_URL, click, hideCursor, LANDSCAPE, launch, moveTo, newPage, PORTRAIT, record, sleep } from './recorder.mjs'
import { boardPoint, clickPoint, loadFound, openHotseat, playMove } from './scene.mjs'

const OUT = 'out/clips'
mkdirSync(OUT, { recursive: true })

/** 新开局时固定的随机种子（决定开局锦囊选项），挑过的 */
const INTRO_RANDOM = 7

const btn = (page, name) => page.getByRole('button', { name })

/** 依次把光标移到每张锦囊卡上，再点第 pick 张 */
async function browseAndPick(page, pick, dwell = 650) {
  const cards = page.locator('.aug-cards .aug-card')
  await cards.first().waitFor()
  await sleep(700) // 发牌动画
  const n = await cards.count()
  for (let i = 0; i < n; i++) {
    await moveTo(page, cards.nth(i), 380)
    await sleep(dwell)
  }
  await click(page, cards.nth(pick), { pause: 400 })
}

// ───────────── 开场 + 锦囊三选一 ─────────────

async function intro(browser, device, name) {
  const page = await newPage(browser, device, { random: INTRO_RANDOM })
  await page.goto(APP_URL)
  await page.waitForSelector('.home')
  await hideCursor(page)
  await sleep(500)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(2600)
  await click(page, btn(page, /对战玩家/), { pause: 700 })
  await click(page, btn(page, /同屏对战/), { pause: 0 })
  stop.mark('board')
  await sleep(2400)
  stop.mark('draft')
  await browseAndPick(page, 1)
  stop.mark('redPicked')
  await sleep(900)
  await browseAndPick(page, 0, 350)
  stop.mark('revealed')
  await hideCursor(page)
  await sleep(3500)
  await stop()
}

/** 锦囊图鉴：从白银滚到棱彩 */
async function codex(browser, device, name) {
  const page = await newPage(browser, device)
  await page.goto(APP_URL)
  await page.waitForSelector('.home')
  await hideCursor(page)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(500)
  await click(page, btn(page, '锦囊图鉴'), { pause: 1500 })
  stop.mark('open')
  const box = page.locator('.codex-modal')
  const target = (await box.locator('.codex').boundingBox()) ?? (await box.boundingBox())
  await moveTo(page, { x: target.x + target.width / 2, y: target.y + 200 }, 400)
  // 平滑滚动：每帧滚一点
  for (const tier of ['gold', 'prism']) {
    const h = page.locator(`.codex .tier-label.tier-${tier}`)
    const top = await h.evaluate((el) => el.getBoundingClientRect().top)
    const start = await page.locator('.codex-modal').evaluate((el) => {
      const sc = [el, ...el.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== 'visible')
      return sc ? sc.getBoundingClientRect().top : 0
    })
    const dist = top - start - 10
    const steps = 45
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, dist / steps)
      await sleep(16)
    }
    stop.mark(tier)
    await sleep(2200)
  }
  await stop()
}

// ───────────── 锦囊效果 ─────────────

/** 载入找好的局面，点出关键一步，留时间看特效 */
function effect(scene, index = 0, { look = 1000, after = 2600, lead = 600 } = {}) {
  return async (browser, device, name) => {
    const f = loadFound(scene, index)
    const page = await openHotseat(browser, device, f.seed, f.actions)
    const stop = await record(page, `${OUT}/${name}.mp4`)
    await sleep(lead)
    await playMove(page, f.key, { look })
    stop.mark('moved')
    await hideCursor(page)
    await sleep(after)
    await stop()
  }
}

/** 吃将：先停在将帅被红圈标出的局面，再吃将，出现胜利弹窗 */
async function kingcap(browser, device, name) {
  const f = loadFound('kingcap', 0)
  const page = await openHotseat(browser, device, f.seed, f.actions)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  // 光标在黑将附近晃一下，引导视线到红圈
  const king = await page.evaluate(() => window.__xq.state.pieces.find((p) => p.type === 'K' && p.side === 'black'))
  const kp = await boardPoint(page, king)
  await moveTo(page, { x: kp.x + 60, y: kp.y + 40 }, 600)
  await sleep(1800)
  stop.mark('capture')
  await playMove(page, f.key, { look: 900, pause: 0 })
  stop.mark('over')
  await hideCursor(page)
  await sleep(3500)
  await stop()
}

/** 回放：吃将结束后 → 查看回放 → 播放 → 回主页 → 对局记录 → 分享链接 */
async function replay(browser, device, name) {
  const f = loadFound('kingcap', 0)
  const page = await openHotseat(browser, device, f.seed, f.actions)
  await playMove(page, f.key, { look: 50, pause: 0 })
  await page.locator('.game-over').getByRole('button', { name: '查看回放' }).waitFor()
  await hideCursor(page)
  await sleep(1500)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(400)
  await click(page, page.locator('.game-over').getByRole('button', { name: '查看回放' }), { pause: 600 })
  stop.mark('replay')
  await click(page, page.getByTitle('回到开局'), { pause: 300 })
  // 调到 4 倍速
  const speed = page.getByTitle('播放速度')
  for (let i = 0; i < 4 && !/^4/.test((await speed.textContent()) ?? ''); i++) await click(page, speed, { pause: 150, ms: 150 })
  await click(page, page.getByTitle(/播放/).first(), { pause: 0 })
  await hideCursor(page)
  await sleep(3200)
  stop.mark('history')
  await page.goto(APP_URL) // 回主页（直接跳转，比依次点返回利落）
  await page.waitForSelector('.home')
  await hideCursor(page)
  await sleep(300)
  await click(page, btn(page, '对局记录'), { pause: 1500 })
  const share = page.getByRole('button', { name: /分享/ }).first()
  stop.mark('share')
  await click(page, share, { pause: 2600 })
  await stop()
}

// ───────────── 对战玩家 ─────────────

/** 联机：房主和客人两个页面同时录，剪辑时左右拼在一起 */
async function online(browser, device, name) {
  const half = device === LANDSCAPE ? { viewport: { width: 960, height: 1080 }, deviceScaleFactor: 1 } : device
  const host = await newPage(browser, half, { random: 11 })
  const guest = await newPage(browser, half, { random: 12 })
  await host.goto(APP_URL)
  await guest.goto(APP_URL)
  await host.waitForSelector('.home')
  await hideCursor(host)
  await hideCursor(guest)
  const stopH = await record(host, `${OUT}/${name}-host.mp4`)
  const stopG = await record(guest, `${OUT}/${name}-guest.mp4`)
  await sleep(600)
  await click(host, btn(host, /对战玩家/), { pause: 500 })
  await click(host, btn(host, /联机对战/), { pause: 500 })
  await click(host, btn(host, /红/).first(), { pause: 300 })
  await click(host, btn(host, '创建房间'), { pause: 0 })
  const invite = host.locator('.invite input')
  await invite.waitFor({ timeout: 30000 })
  stopH.mark('created')
  stopG.mark('created')
  await moveTo(host, invite, 500)
  await sleep(1500)
  const link = await invite.inputValue()
  await guest.goto(link)
  const join = btn(guest, /加入/)
  try {
    await join.first().waitFor({ timeout: 4000 })
    await click(guest, join.first(), { pause: 0 })
  } catch {
    // 有的流程打开链接就直接加入
  }
  await host.waitForSelector('.aug-cards', { timeout: 30000 })
  stopH.mark('connected')
  stopG.mark('connected')
  await Promise.all([browseAndPick(host, 0, 250), browseAndPick(guest, 2, 250)])
  await sleep(1500)
  // 红方（房主）走一步炮二平五，客人那边同步出现
  await hideCursor(guest)
  await clickPoint(host, { x: 7, y: 7 }, { pause: 600 })
  await clickPoint(host, { x: 4, y: 7 }, { pause: 0 })
  stopH.mark('moved')
  stopG.mark('moved')
  await hideCursor(host)
  await sleep(2500)
  await stopH()
  await stopG()
}

/** 同屏：载入一个对局，红黑各走一步 */
async function hotseat(browser, device, name) {
  const f = loadFound('shield', 1)
  const n = f.actions.length
  // 往回找最近的连续两步走子
  let k = n - 1
  while (k > 1 && !(f.actions[k].type === 'move' && f.actions[k - 1].type === 'move')) k--
  const page = await openHotseat(browser, device, f.seed, f.actions.slice(0, k - 1))
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(500)
  await playMove(page, f.actions[k - 1], { look: 600, pause: 900 })
  await playMove(page, f.actions[k], { look: 600, pause: 0 })
  await hideCursor(page)
  await sleep(1800)
  await stop()
}

// ───────────── 挑战 AI ─────────────

async function ai(browser, device, name) {
  const page = await newPage(browser, device, { random: 21 })
  await page.goto(APP_URL)
  await page.waitForSelector('.home')
  await hideCursor(page)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(500)
  await click(page, btn(page, /挑战 AI/), { pause: 700 })
  stop.mark('setup')
  await click(page, btn(page, /^困难/), { pause: 500 })
  await click(page, btn(page, /^激进/), { pause: 700 })
  await click(page, btn(page, '开始对局'), { pause: 0 })
  stop.mark('game')
  await browseAndPick(page, 0, 300)
  await page.waitForSelector('.aug-cards', { state: 'detached' })
  await sleep(1200)
  // 炮二平五，等 AI 应对
  await clickPoint(page, { x: 7, y: 7 }, { pause: 500 })
  await clickPoint(page, { x: 4, y: 7 }, { pause: 0 })
  stop.mark('moved')
  await hideCursor(page)
  await page.waitForFunction(() => /轮到你|红方走棋/.test(document.body.innerText), null, { timeout: 30000 })
  await sleep(1200)
  stop.mark('hint')
  await click(page, btn(page, /提示/), { pause: 0 })
  await page.waitForSelector('.hint-arrow', { timeout: 30000 })
  stop.mark('arrow')
  await hideCursor(page)
  await sleep(3000)
  await stop()
}

// ───────────── 结尾主页 ─────────────

async function home(browser, device, name) {
  const page = await newPage(browser, device)
  await page.goto(APP_URL)
  await page.waitForSelector('.home')
  await hideCursor(page)
  await sleep(500)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(11000)
  await stop()
}

// ───────────── 镜头表 ─────────────

const SHOTS = {
  'L-intro': [intro, LANDSCAPE],
  'L-codex': [codex, LANDSCAPE],
  'L-tianma': [effect('tianma'), LANDSCAPE],
  'L-zongheng': [effect('zongheng', 1), LANDSCAPE],
  'L-huoshao': [effect('huoshao', 1), LANDSCAPE],
  'L-jieshi': [effect('jieshi'), LANDSCAPE],
  'L-shield': [effect('shield'), LANDSCAPE],
  'L-kingcap': [kingcap, LANDSCAPE],
  'L-online': [online, LANDSCAPE],
  'L-hotseat': [hotseat, LANDSCAPE],
  'L-ai': [ai, LANDSCAPE],
  'L-replay': [replay, LANDSCAPE],
  'L-home': [home, LANDSCAPE],
  'P-zongheng': [effect('zongheng', 1), PORTRAIT],
  'P-intro': [intro, PORTRAIT],
  'P-tianma': [effect('tianma', 0, { after: 1800 }), PORTRAIT],
  'P-zongheng2': [effect('zongheng', 0, { after: 1800 }), PORTRAIT],
  'P-jieshi': [effect('jieshi', 0, { after: 1800 }), PORTRAIT],
  'P-online': [online, PORTRAIT],
  'P-ai': [ai, PORTRAIT],
  'P-home': [home, PORTRAIT],
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS)
const browser = await launch()
for (const name of names) {
  const shot = SHOTS[name]
  if (!shot) throw new Error(`未知镜头 ${name}`)
  console.log(name)
  try {
    await shot[0](browser, shot[1], name)
  } catch (e) {
    console.error(`  ${name} 失败：${e.message.split('\n')[0]}`)
    let i = 0
    for (const ctx of browser.contexts()) for (const pg of ctx.pages()) await pg.screenshot({ path: `out/fail-${name}-${i++}.png` }).catch(() => {})
  }
  for (const ctx of browser.contexts()) await ctx.close().catch(() => {})
}
await browser.close()
