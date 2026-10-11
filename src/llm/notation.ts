import { getPiece, pieceName, type GameState, type Move, type Pos } from '../engine'

/**
 * 给大模型看的坐标：沿用象棋程序通用的 UCCI 写法。
 * 列 a–i 从左到右（红方视角），行 0–9 从红方底线往上数。红帅开局在 e0，黑将在 e9。
 * 引擎内部 y=0 是黑方底线，所以行号 = 9 - y。
 */
export const FILES = 'abcdefghi'

export const square = (p: Pos) => `${FILES[p.x]}${9 - p.y}`

export function parseSquare(s: string): Pos | null {
  const m = /^([a-i])([0-9])$/.exec(s.trim().toLowerCase())
  return m ? { x: FILES.indexOf(m[1]), y: 9 - Number(m[2]) } : null
}

/** 例如"炮 h2→e2 吃 卒" */
export function moveText(state: GameState, m: Move): string {
  const piece = getPiece(state, m.pieceId)
  let text = `${pieceName(piece)} ${square(m.from)}→${square(m.to)}`
  if (m.captureId) text += ` 吃 ${pieceName(getPiece(state, m.captureId))}`
  if (m.swapId) text += `（与${pieceName(getPiece(state, m.swapId))}换位）`
  return text
}
