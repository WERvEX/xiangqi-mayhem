// 镜头工具：把 scenes/found/*.json 里的局面作为同屏对战存档载入，并按棋盘坐标点击走子
import { readFileSync } from 'node:fs'
import { APP_URL, click, newPage, sleep } from './recorder.mjs'

const RULES_VERSION = 5
const CELL = 60
const PAD = 40
const W = CELL * 8 + PAD * 2
const H = CELL * 9 + PAD * 2

export function loadFound(scene, index = 0) {
  const list = JSON.parse(readFileSync(new URL(`../scenes/found/${scene}.json`, import.meta.url), 'utf8'))
  if (!list[index]) throw new Error(`${scene} 没有第 ${index} 个候选`)
  return list[index]
}

export function hotseatStorage(seed, actions) {
  const save = { v: 1, rules: RULES_VERSION, seed, actions, savedAt: new Date().toISOString(), label: '同屏对战', extra: null }
  return { 'xqm-saved-hotseat': JSON.stringify(save) }
}

/** 打开一个停在指定局面的同屏对战页面（还没开始录制） */
export async function openHotseat(browser, device, seed, actions) {
  const page = await newPage(browser, device, { storage: hotseatStorage(seed, actions) })
  await page.goto(APP_URL)
  await page.getByRole('button', { name: '继续上一局' }).click()
  await page.waitForSelector('svg.board')
  await page.mouse.move(-50, -50)
  await sleep(600)
  return page
}

/** 棋盘坐标（x 0..8, y 0..9）→ 页面坐标；同屏对战不翻转棋盘 */
export async function boardPoint(page, pos) {
  const box = await page.locator('svg.board').boundingBox()
  return {
    x: box.x + ((PAD + pos.x * CELL) / W) * box.width,
    y: box.y + ((PAD + pos.y * CELL) / H) * box.height,
  }
}

export async function clickPoint(page, pos, opts) {
  await click(page, await boardPoint(page, pos), opts)
}

/** 当前局面里某个棋子的位置（同屏对战在开发模式下把局面挂在 window.__xq 上） */
export async function piecePos(page, pieceId) {
  return page.evaluate((id) => {
    const p = window.__xq.state.pieces.find((q) => q.id === id)
    return { x: p.x, y: p.y }
  }, pieceId)
}

/** 先点棋子、停一下让观众看到可走的位置，再点目标 */
export async function playMove(page, action, { look = 900, pause = 200 } = {}) {
  await clickPoint(page, await piecePos(page, action.pieceId), { pause: look })
  await clickPoint(page, action.to, { pause })
}
