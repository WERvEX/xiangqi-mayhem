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
export function generateMoves(state: GameState, side: Side, mods: RuleMods, defends?: Set<string>): Move[] {
  const grid = buildGrid(state.pieces)
  const out: Move[] = []
  for (const p of state.pieces) {
    if (p.alive && p.side === side) genPiece(p, grid, mods, out, defends)
  }
  return out
}

/**
 * defends：可选，收集"如果这里是敌子就能吃到"的己方棋子 id，即受到保护的己方棋子。
 * 只有 AI 评估时需要。
 */
function genPiece(p: Piece, grid: Grid, mods: RuleMods, out: Move[], defends?: Set<string>) {
  const side = p.side
  /** 能落子返回 true（空位或敌子） */
  const push = (x: number, y: number): boolean => {
    if (!inBounds(x, y)) return false
    const t = grid[y][x]
    if (t && t.side === side) {
      defends?.add(t.id)
      return false
    }
    out.push({ pieceId: p.id, from: { x: p.x, y: p.y }, to: { x, y }, captureId: t?.id })
    return true
  }
  const occupied = (x: number, y: number) => inBounds(x, y) && grid[y][x] !== null

  switch (p.type) {
    case 'K': {
      const kingOk = (nx: number, ny: number) =>
        mods.kingLeavePalace ? !crossedRiver(side, ny) : inPalace(side, nx, ny)
      const dirs = mods.kingDiagonal ? [...ORTHO, ...DIAG] : ORTHO
      for (const [dx, dy] of dirs) {
        const nx = p.x + dx
        const ny = p.y + dy
        if (!inBounds(nx, ny) || !kingOk(nx, ny)) continue
        const t = grid[ny][nx]
        if (t && t.side === side) {
          defends?.add(t.id)
          // 移形换影：与相邻的己方棋子换位（只限上下左右）
          if (mods.kingSwap && (dx === 0 || dy === 0)) {
            out.push({ pieceId: p.id, from: { x: p.x, y: p.y }, to: { x: nx, y: ny }, swapId: t.id })
          }
          continue
        }
        push(nx, ny)
        // 御驾亲征：在己方半场内像车一样直线行走
        if (t || !mods.kingLeavePalace || (dx !== 0 && dy !== 0)) continue
        // 最多再走一格（共两格）
        const x2 = nx + dx
        const y2 = ny + dy
        if (inBounds(x2, y2) && kingOk(x2, y2)) push(x2, y2)
      }
      // 飞将：同一直线上中间无子（隔山飞将：可隔一子）时可直接吃掉对方将帅
      const dy = forward(side)
      let screens = 0
      for (let y = p.y + dy; inBounds(p.x, y); y += dy) {
        const t = grid[y][p.x]
        if (!t) continue
        if (t.type === 'K' && t.side !== side) {
          push(p.x, y)
          break
        }
        screens++
        if (screens > (mods.kingFlyThroughOne ? 1 : 0)) break
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
        if (!mods.elephantNoEye && occupied(p.x + dx, p.y + dy)) continue // 塞象眼
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
      // 龙马精神：马也能走田字（会被塞象眼，不受河界限制）
      if (mods.horseElephantStep) {
        for (const [dx, dy] of DIAG) push(p.x + dx * 2, p.y + dy * 2)
      }
      break
    }
    case 'R': {
      const dirs = mods.rookDiagonal ? [...ORTHO, ...DIAG] : ORTHO
      for (const [dx, dy] of dirs) {
        let jumped = false
        // 纵横天下：斜走最多两格
        const maxSteps = dx !== 0 && dy !== 0 ? 2 : Infinity
        let steps = 0
        const diagonal = dx !== 0 && dy !== 0
        for (let x = p.x + dx, y = p.y + dy; inBounds(x, y) && steps < maxSteps; x += dx, y += dy, steps++) {
          const t = grid[y][x]
          // 纵横天下：斜走只有紧挨着的一格可以吃子
          if (!(diagonal && t && steps > 0)) push(x, y)
          if (!t) continue
          // 畅通无阻：穿过己方棋子
          if (mods.rookPassFriendly && t.side === side && !diagonal) continue
          // 瞒天过海：可以越过第一个棋子继续前进
          if (!mods.rookJump || jumped) break
          jumped = true
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
      if (mods.pawnRetreat) push(p.x, p.y - f)
      if (crossed && mods.pawnDiagonalForward) {
        push(p.x - 1, p.y + f)
        push(p.x + 1, p.y + f)
      }
      break
    }
  }
}
