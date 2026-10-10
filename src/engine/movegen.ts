import { buildGrid, crossedRiver, forward, inBounds, inPalace, type Grid } from './board'
import type { GameState, Move, Piece, RuleMods, Side } from './types'

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const
const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const
const HORSE = [
  [1, 2],
  [-1, 2],
  [1, -2],
  [-1, -2],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
] as const

/**
 * 生成某一方的全部走法（已应用锦囊修改）。
 * 采用"吃将获胜"规则，所以不过滤送将的走法。
 */
export function generateMoves(state: GameState, side: Side, mods: RuleMods): Move[] {
  const grid = buildGrid(state.pieces)
  const out: Move[] = []
  for (const p of state.pieces) {
    if (p.alive && p.side === side) genPiece(p, grid, mods, out)
  }
  return out
}

function genPiece(p: Piece, grid: Grid, mods: RuleMods, out: Move[]) {
  const side = p.side
  /** 能落子返回 true（空位或敌子） */
  const push = (x: number, y: number): boolean => {
    if (!inBounds(x, y)) return false
    const t = grid[y][x]
    if (t && t.side === side) return false
    out.push({ pieceId: p.id, from: { x: p.x, y: p.y }, to: { x, y }, captureId: t?.id })
    return true
  }
  const occupied = (x: number, y: number) => inBounds(x, y) && grid[y][x] !== null

  switch (p.type) {
    case 'K': {
      for (const [dx, dy] of ORTHO) {
        const nx = p.x + dx
        const ny = p.y + dy
        if (!inBounds(nx, ny)) continue
        const ok = mods.kingLeavePalace ? !crossedRiver(side, ny) : inPalace(side, nx, ny)
        if (ok) push(nx, ny)
      }
      // 飞将：同一直线上中间无子时可直接吃掉对方将帅
      const dy = forward(side)
      for (let y = p.y + dy; inBounds(p.x, y); y += dy) {
        const t = grid[y][p.x]
        if (t) {
          if (t.type === 'K' && t.side !== side) push(p.x, y)
          break
        }
      }
      break
    }
    case 'A': {
      for (const [dx, dy] of DIAG) {
        const nx = p.x + dx
        const ny = p.y + dy
        if (!inBounds(nx, ny)) continue
        const ok = mods.advisorLeavePalace ? !crossedRiver(side, ny) : inPalace(side, nx, ny)
        if (ok) push(nx, ny)
      }
      break
    }
    case 'B': {
      for (const [dx, dy] of DIAG) {
        const nx = p.x + dx * 2
        const ny = p.y + dy * 2
        if (!inBounds(nx, ny)) continue
        if (occupied(p.x + dx, p.y + dy)) continue // 塞象眼
        if (!mods.elephantCrossRiver && crossedRiver(side, ny)) continue
        push(nx, ny)
      }
      break
    }
    case 'N': {
      for (const [dx, dy] of HORSE) {
        const nx = p.x + dx
        const ny = p.y + dy
        if (!inBounds(nx, ny)) continue
        if (!mods.horseNoLeg) {
          const legX = Math.abs(dx) === 2 ? p.x + dx / 2 : p.x
          const legY = Math.abs(dy) === 2 ? p.y + dy / 2 : p.y
          if (occupied(legX, legY)) continue // 蹩马腿
        }
        push(nx, ny)
      }
      break
    }
    case 'R': {
      const dirs = mods.rookDiagonal ? [...ORTHO, ...DIAG] : ORTHO
      for (const [dx, dy] of dirs) {
        for (let x = p.x + dx, y = p.y + dy; inBounds(x, y); x += dx, y += dy) {
          push(x, y)
          if (grid[y][x]) break
        }
      }
      break
    }
    case 'C': {
      const maxScreens = mods.cannonMaxScreens ?? 1
      for (const [dx, dy] of ORTHO) {
        let screens = 0
        for (let x = p.x + dx, y = p.y + dy; inBounds(x, y); x += dx, y += dy) {
          const t = grid[y][x]
          if (!t) {
            if (screens === 0) push(x, y)
            continue
          }
          if (screens > 0 && t.side !== side) push(x, y)
          screens++
          if (screens > maxScreens) break
        }
      }
      break
    }
    case 'P': {
      const f = forward(side)
      push(p.x, p.y + f)
      const crossed = crossedRiver(side, p.y)
      if (crossed || mods.pawnSidewaysEarly) {
        push(p.x - 1, p.y)
        push(p.x + 1, p.y)
      }
      if (crossed && mods.pawnRetreat) push(p.x, p.y - f)
      break
    }
  }
}
