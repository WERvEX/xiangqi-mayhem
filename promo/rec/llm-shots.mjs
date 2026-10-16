// 大模型镜头：使用 rec/llm-setup.mjs 里用户本人配置好的独立浏览器配置（out/llm-profile），无头运行。
// 这些镜头里不出现网址，直接用本地地址；火山方舟的请求走开发服务器的 /__llm_proxy 转发。
//
//   node rec/llm-shots.mjs L-llm-settings L-llm L-eve P-llm P-eve
//   可选环境变量：RED=<模型配置序号> BLACK=<模型配置序号>（斗蛐蛐双方用哪个配置，默认 0 和 1）
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { click, CURSOR_SCRIPT, hideCursor, LANDSCAPE, moveTo, PORTRAIT, record, sleep } from './recorder.mjs'
import { clickPoint } from './scene.mjs'

const URL = 'http://localhost:5173/'
const OUT = 'out/clips'
mkdirSync(OUT, { recursive: true })

async function openProfile(device) {
  const ctx = await chromium.launchPersistentContext('out/llm-profile', {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--hide-scrollbars', '--mute-audio'],
    locale: 'zh-CN',
    ...device,
  })
  await ctx.addInitScript(CURSOR_SCRIPT)
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  page.device = device
  await page.goto(URL)
  await page.waitForSelector('.home')
  const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem('xqm-llm-profiles') ?? '[]').length)
  if (!profiles) throw new Error('录屏专用浏览器里还没有大模型配置，先运行 node rec/llm-setup.mjs')
  // 清掉上次没下完的存档，免得主页出现"继续上一局"
  await page.evaluate(() => ['ai', 'eve'].forEach((s) => localStorage.removeItem(`xqm-saved-${s}`)))
  await page.reload()
  await page.waitForSelector('.home')
  await page.mouse.move(-50, -50)
  return { ctx, page }
}

const btn = (page, name) => page.getByRole('button', { name })
const hide = hideCursor

/** 选下拉框里的第 i 项（光标先移过去，让观众看到在选模型） */
async function chooseOption(page, select, i) {
  await moveTo(page, select, 400)
  const value = await select.evaluate((el, i) => el.options[Math.min(i, el.options.length - 1)].value, i)
  await select.selectOption(value)
  await sleep(500)
}

async function pickFirstCard(page) {
  const cards = page.locator('.aug-cards .aug-card')
  await cards.first().waitFor({ timeout: 120000 })
  await sleep(900)
  await click(page, cards.first(), { pause: 400 })
}

/** 等到又轮到玩家走棋（大模型发言并落子之后） */
async function waitMyTurn(page, timeout = 180000) {
  await page.waitForFunction(() => /轮到你走棋/.test(document.querySelector('.status, .game')?.innerText ?? document.body.innerText), null, {
    timeout,
    polling: 500,
  })
}

// ───────────── 镜头 ─────────────

/** 设置页：已配置的模型列表（列表里不显示密钥） */
async function llmSettings(device, name) {
  const { ctx, page } = await openProfile(device)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(500)
  await click(page, btn(page, '⚙ 设置'), { pause: 3000 })
  await hide(page)
  await sleep(1000)
  await stop()
  await ctx.close()
}

/** 挑战大模型：选模型和人设 → 开局 → 玩家走两步，大模型点评并落子 → 偷看思考 */
async function llmGame(device, name) {
  const { ctx, page } = await openProfile(device)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(500)
  await click(page, btn(page, /挑战 AI/), { pause: 600 })
  await click(page, btn(page, '大模型'), { pause: 700 })
  stop.mark('setup')
  await chooseOption(page, page.locator('select').first(), Number(process.env.RED ?? 0))
  await click(page, btn(page, /冷静解说/), { pause: 800 })
  await click(page, btn(page, '开始对局'), { pause: 0 })
  stop.mark('game')
  await pickFirstCard(page)
  await waitMyTurn(page)
  await sleep(800)
  // 炮二平五
  stop.mark('move1')
  await clickPoint(page, { x: 7, y: 7 }, { pause: 500 })
  await clickPoint(page, { x: 4, y: 7 }, { pause: 0 })
  await hide(page)
  await page.locator('.speech-bubble:visible').first().waitFor({ timeout: 180000 })
  stop.mark('speech1')
  await waitMyTurn(page)
  stop.mark('reply1')
  await sleep(1500)
  // 马八进七
  stop.mark('move2')
  await clickPoint(page, { x: 7, y: 9 }, { pause: 500 })
  await clickPoint(page, { x: 6, y: 7 }, { pause: 0 })
  await hide(page)
  await waitMyTurn(page)
  stop.mark('reply2')
  await sleep(1200)
  stop.mark('peek')
  await click(page, btn(page, /偷看思考/), { pause: 0 })
  await hide(page)
  await sleep(6000)
  await stop()
  await ctx.close()
}

/** 模型斗蛐蛐：设置双方 → 开局 → 观战一段时间，中途打开双方思考 */
async function eve(device, name, watchSec = 150) {
  const { ctx, page } = await openProfile(device)
  const stop = await record(page, `${OUT}/${name}.mp4`)
  await sleep(500)
  await click(page, btn(page, /模型斗蛐蛐/), { pause: 800 })
  stop.mark('setup')
  const selects = page.locator('.lobby-card select')
  // 每个阵营一张卡片：第 1 个下拉框是模型，第 2 个是人设
  await chooseOption(page, selects.nth(0), Number(process.env.RED ?? 0))
  await selects.nth(1).selectOption('calm')
  await chooseOption(page, selects.nth(2), Number(process.env.BLACK ?? 1))
  await selects.nth(3).selectOption('calm')
  const hear = page.getByLabel(/对喷模式/)
  if (!(await hear.isChecked())) await click(page, hear, { pause: 500 })
  await click(page, btn(page, '开始对局'), { pause: 0 })
  stop.mark('game')
  await hide(page)
  const t0 = Date.now()
  let thoughtShown = false
  while (Date.now() - t0 < watchSec * 1000) {
    await sleep(1000)
    const bubbles = await page.locator('.speech-bubble:visible').count()
    if (!thoughtShown && bubbles >= 6) {
      stop.mark('thought')
      await click(page, btn(page, /显示思考/), { pause: 0 })
      await hide(page)
      thoughtShown = true
    }
  }
  stop.mark('end')
  await stop()
  // 暂停对局，存档留着以后需要时接着下
  await btn(page, /暂停/).click().catch(() => {})
  await ctx.close()
}

const SHOTS = {
  'L-llm-settings': [llmSettings, LANDSCAPE],
  'L-llm': [llmGame, LANDSCAPE],
  'L-eve': [eve, LANDSCAPE],
  'P-llm': [llmGame, PORTRAIT],
  'P-eve': [(d, n) => eve(d, n, 70), PORTRAIT],
}

for (const name of process.argv.slice(2)) {
  const shot = SHOTS[name]
  if (!shot) throw new Error(`未知镜头 ${name}`)
  console.log(name)
  await shot[0](shot[1], name)
}
