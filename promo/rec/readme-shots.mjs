// README 用的截图（不显示假光标）：node rec/readme-shots.mjs [draft huoshao win llm eve]
// 输出到 out/readme/*.png；大模型两张需要录屏专用浏览器配置和 promo-proxy 转发
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { APP_URL, LANDSCAPE, launch, newPage, sleep } from './recorder.mjs'
import { clickPoint, loadFound, openHotseat, playMove } from './scene.mjs'

const OUT = 'out/readme'
mkdirSync(OUT, { recursive: true })
const COLUMN = { x: 650, y: 0, width: 620, height: 1010 } // 中间的对局区域
const btn = (page, name) => page.getByRole('button', { name })
const noCursor = (page) => page.evaluate(() => document.getElementById('__promo_cursor')?.remove())

async function hotseatShots(browser, which) {
  if (which.has('draft')) {
    const page = await newPage(browser, LANDSCAPE, { cursor: false, random: 7 })
    await page.goto(APP_URL)
    await btn(page, /对战玩家/).click()
    await btn(page, /同屏对战/).click()
    await page.locator('.aug-cards .aug-card').first().waitFor()
    await sleep(1500)
    await page.screenshot({ path: `${OUT}/draft.png`, clip: COLUMN })
    await page.context().close()
  }
  if (which.has('huoshao')) {
    // 特效只持续一瞬间，连拍几张再挑
    const f = loadFound('huoshao', 1)
    const page = await openHotseat(browser, LANDSCAPE, f.seed, f.actions)
    await playMove(page, f.key, { look: 300, pause: 0 })
    await noCursor(page)
    for (let i = 0; i < 8; i++) {
      await page.screenshot({ path: `${OUT}/huoshao-${i}.png`, clip: COLUMN })
      await sleep(120)
    }
    await page.context().close()
  }
  if (which.has('win')) {
    const f = loadFound('kingcap', 0)
    const page = await openHotseat(browser, LANDSCAPE, f.seed, f.actions)
    await playMove(page, f.key, { look: 300, pause: 0 })
    await noCursor(page)
    await page.locator('.game-over').waitFor()
    await sleep(1200)
    await page.screenshot({ path: `${OUT}/win.png`, clip: COLUMN })
    await page.context().close()
  }
}

async function openProfile() {
  const ctx = await chromium.launchPersistentContext('out/llm-profile', {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--hide-scrollbars', '--mute-audio'],
    locale: 'zh-CN',
    ...LANDSCAPE,
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto('http://localhost:5173/')
  await page.evaluate(() => ['ai', 'eve'].forEach((s) => localStorage.removeItem(`xqm-saved-${s}`)))
  await page.reload()
  await page.waitForSelector('.home')
  return { ctx, page }
}

const myTurn = (page) =>
  page.waitForFunction(() => /轮到你走棋/.test(document.body.innerText), null, { timeout: 180000, polling: 500 })

async function llmShot() {
  const { ctx, page } = await openProfile()
  await btn(page, /挑战 AI/).click()
  await btn(page, '大模型').click()
  await page.locator('select').first().selectOption({ index: 0 })
  await btn(page, /冷静解说/).click()
  await btn(page, '开始对局').click()
  await page.locator('.aug-cards .aug-card').first().click({ timeout: 120000 })
  await myTurn(page)
  for (const [from, to] of [
    [{ x: 7, y: 7 }, { x: 4, y: 7 }],
    [{ x: 7, y: 9 }, { x: 6, y: 7 }],
  ]) {
    await clickPoint(page, from, { pause: 300, ms: 50 })
    await clickPoint(page, to, { pause: 300, ms: 50 })
    await sleep(500)
    await myTurn(page)
  }
  await btn(page, /偷看思考/).click()
  await page.mouse.move(-50, -50)
  await sleep(1500)
  await page.screenshot({ path: `${OUT}/llm.png`, clip: { x: 90, y: 0, width: 1180, height: 1010 } })
  await ctx.close()
}

async function eveShot(watchSec = 80) {
  const { ctx, page } = await openProfile()
  await btn(page, /模型斗蛐蛐/).click()
  const selects = page.locator('.lobby-card select')
  await selects.nth(0).selectOption({ index: 0 })
  await selects.nth(1).selectOption('calm')
  await selects.nth(2).selectOption({ index: 1 })
  await selects.nth(3).selectOption('calm')
  const hear = page.getByLabel(/对喷模式/)
  if (!(await hear.isChecked())) await hear.check()
  await btn(page, '开始对局').click()
  await btn(page, /显示思考/).click()
  await page.mouse.move(-50, -50)
  await sleep(watchSec * 1000)
  await page.screenshot({ path: `${OUT}/eve.png`, clip: { x: 90, y: 0, width: 1740, height: 1010 } })
  await btn(page, /暂停/).click().catch(() => {})
  await ctx.close()
}

const which = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['draft', 'huoshao', 'win', 'llm', 'eve'])
const browser = await launch()
await hotseatShots(browser, which)
await browser.close()
if (which.has('llm')) await llmShot()
if (which.has('eve')) await eveShot()
console.log('完成')
