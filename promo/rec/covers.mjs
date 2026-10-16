// 视频封面：横屏 1920×1080（B 站 / YouTube）、竖屏 1080×1920（抖音）→ out/final/封面-*.png
// 在游戏页面里排版，直接用游戏自己的样式（楷体标题、锦囊卡片），棋盘是火烧连营起火瞬间的 2 倍截图。
//   node rec/covers.mjs [起火截图的序号，默认 1]
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { APP_URL, launch, newPage, sleep } from './recorder.mjs'
import { loadFound, openHotseat, playMove } from './scene.mjs'

const OUT = 'out/final'
const TMP = 'out/covers-tmp'
mkdirSync(OUT, { recursive: true })
mkdirSync(TMP, { recursive: true })
const pick = Number(process.argv[2] ?? 1) // 第 2 帧：炮已落下，左右的车、象正在起火

const CARDS = [
  { glyph: '火', name: '火烧连营', tier: 'gold', tierName: '黄金' },
  { glyph: '纵', name: '纵横天下', tier: 'prism', tierName: '棱彩' },
  { glyph: '魂', name: '借尸还魂', tier: 'gold', tierName: '黄金' },
]
const FEATURES = ['29 个锦囊', '联机对战', '挑战 AI', '大模型斗蛐蛐']

const browser = await launch()

// 1. 棋盘：火烧连营起火的瞬间（连拍，特效只持续一瞬）
const f = loadFound('huoshao', 1)
const game = await openHotseat(browser, { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 }, f.seed, f.actions)
await playMove(game, f.key, { look: 300, pause: 0 })
// 只留棋盘、背景透明；特效文字会画到棋盘边框外面（被烧的子在最上排），截图范围往外扩一圈
await game.addStyleTag({ content: 'html, body, body * { background: transparent !important } body * { visibility: hidden } svg.board, svg.board * { visibility: visible } svg.board { overflow: visible }' })
await game.evaluate(() => document.getElementById('__promo_cursor')?.remove())
const box = await game.locator('svg.board').boundingBox()
const clip = { x: box.x - 24, y: box.y - 56, width: box.width + 48, height: box.height + 80 }
for (let i = 0; i < 8; i++) {
  await game.screenshot({ path: `${TMP}/board-${i}.png`, clip, omitBackground: true })
  await sleep(50)
}
await game.context().close()
const board = `data:image/png;base64,${readFileSync(`${TMP}/board-${pick}.png`).toString('base64')}`

// 2. 排版：借用游戏页面的样式表，把 body 换成封面
const cards = CARDS.map(
  (c) => `<button class="aug-card tier-${c.tier}" disabled>
      <span class="glyph glyph-lg tier-${c.tier}">${c.glyph}</span>
      <div class="aug-card-name">${c.name}</div>
      <div class="tier-label tier-${c.tier}">${c.tierName}</div>
    </button>`,
).join('')
const features = FEATURES.map((t) => `<span class="feat">${t}</span>`).join('')

const STYLE = `
  body { margin: 0; overflow: hidden; }
  #cover { position: fixed; inset: 0; display: flex; box-sizing: border-box;
    background: radial-gradient(ellipse at 70% 45%, rgba(230,120,40,.18), transparent 55%),
                radial-gradient(ellipse at 20% 30%, rgba(230,179,74,.10), transparent 50%), #1a130e; }
  .cv-title { font-family: 'STKaiti','KaiTi','楷体',serif; margin: 0; line-height: 1.05;
    background: linear-gradient(180deg,#fff0c4,#e6b34a 70%,#c98b2a); -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 6px 18px rgba(0,0,0,.6)); }
  .cv-en { font-family: 'STKaiti','KaiTi',serif; color: #e0675c; letter-spacing: .5em; }
  .cv-tag { color: #f3e6cf; font-weight: 600; }
  .cv-cards { display: flex; gap: 22px; }
  .cv-cards .aug-card { opacity: 1; cursor: default; flex: 0 0 auto; }
  .cv-feats { display: flex; flex-wrap: wrap; gap: 14px; }
  .feat { color: #f0dcb4; border: 1px solid rgba(230,179,74,.45); background: rgba(230,179,74,.08); border-radius: 999px; }
  .cv-board { filter: drop-shadow(0 30px 50px rgba(0,0,0,.65)); }

  /* 横屏 */
  #cover.land { padding: 0 90px 0 120px; align-items: center; gap: 60px; }
  .land .cv-left { flex: 1; display: flex; flex-direction: column; gap: 34px; }
  .land .cv-title { font-size: 136px; letter-spacing: 8px; white-space: nowrap; }
  .land .cv-en { font-size: 30px; margin-top: 8px; }
  .land .cv-tag { font-size: 52px; }
  .land .cv-cards .aug-card { width: 200px; padding: 22px 10px 18px; }
  .land .aug-card-name { font-size: 28px; }
  .land .feat { font-size: 26px; padding: 8px 22px; }
  .land .cv-board { height: 960px; transform: rotate(2.5deg); }

  /* 竖屏 */
  #cover.port { flex-direction: column; align-items: center; padding: 130px 40px 0; gap: 34px; }
  .port .cv-head { text-align: center; display: flex; flex-direction: column; gap: 18px; align-items: center; }
  .port .cv-title { font-size: 150px; letter-spacing: 12px; white-space: nowrap; }
  .port .cv-en { font-size: 28px; margin-top: -10px; }
  .port .cv-tag { font-size: 50px; }
  .port .cv-board { width: 960px; margin-top: 10px; }
  .port .cv-cards .aug-card { width: 230px; padding: 22px 10px 18px; }
  .port .aug-card-name { font-size: 30px; }
  .port .cv-feats { justify-content: center; }
  .port .feat { font-size: 30px; padding: 8px 22px; }
`

const LAYOUTS = {
  横屏: {
    size: { width: 1920, height: 1080 },
    html: `<div id="cover" class="land">
      <div class="cv-left">
        <div><h1 class="cv-title">象棋大乱斗</h1><div class="cv-en">XIANGQI MAYHEM</div></div>
        <div class="cv-tag">每局规则都不一样的象棋</div>
        <div class="cv-cards">${cards}</div>
        <div class="cv-feats">${features}</div>
      </div>
      <img class="cv-board" src="${board}">
    </div>`,
  },
  竖屏: {
    size: { width: 1080, height: 1920 },
    html: `<div id="cover" class="port">
      <div class="cv-head">
        <h1 class="cv-title">象棋大乱斗</h1><div class="cv-en">XIANGQI MAYHEM</div>
        <div class="cv-tag">每局规则都不一样的象棋</div>
      </div>
      <img class="cv-board" src="${board}">
      <div class="cv-cards">${cards}</div>
      <div class="cv-feats">${features}</div>
    </div>`,
  },
}

for (const [name, { size, html }] of Object.entries(LAYOUTS)) {
  const page = await newPage(browser, { viewport: size, deviceScaleFactor: 1 }, { cursor: false })
  await page.goto(APP_URL)
  await page.waitForSelector('.home')
  await page.evaluate(
    ([html, css]) => {
      document.getElementById('root').remove()
      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
      document.body.insertAdjacentHTML('beforeend', html)
    },
    [html, STYLE],
  )
  await page.waitForFunction(() => [...document.images].every((i) => i.complete))
  await sleep(500)
  await page.screenshot({ path: `${OUT}/封面-${name}.png` })
  console.log(`${OUT}/封面-${name}.png`)
  await page.context().close()
}
await browser.close()
rmSync(TMP, { recursive: true, force: true })
