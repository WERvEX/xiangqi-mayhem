import type { GameState, Piece, PieceType, Side } from './types'

export const COLS = 9
export const ROWS = 10

export const other = (s: Side): Side => (s === 'red' ? 'black' : 'red')
export const inBounds = (x: number, y: number) => x >= 0 && x < COLS && y >= 0 && y < ROWS
/** 前进方向的 dy */
export const forward = (s: Side) => (s === 'red' ? -1 : 1)
export const crossedRiver = (s: Side, y: number) => (s === 'red' ? y <= 4 : y >= 5)
export const inPalace = (s: Side, x: number, y: number) =>
  x >= 3 && x <= 5 && (s === 'red' ? y >= 7 : y <= 2)
export const enemyBaseline = (s: Side) => (s === 'red' ? 0 : 9)

const BACK_ROW: PieceType[] = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R']

export function initialPieces(): Piece[] {
  const pieces: Piece[] = []
  const counters: Record<string, number> = {}
  const add = (side: Side, type: PieceType, x: number, y: number) => {
    const key = side[0] + type
    const n = (counters[key] = (counters[key] ?? 0) + 1)
    pieces.push({ id: `${key}${n}`, type, side, x, y, alive: true, home: { x, y }, shield: 0 })
  }
  for (const side of ['red', 'black'] as const) {
    const back = side === 'red' ? 9 : 0
    const cannon = side === 'red' ? 7 : 2
    const pawn = side === 'red' ? 6 : 3
    BACK_ROW.forEach((t, x) => add(side, t, x, back))
    add(side, 'C', 1, cannon)
    add(side, 'C', 7, cannon)
    for (const x of [0, 2, 4, 6, 8]) add(side, 'P', x, pawn)
  }
  return pieces
}

/** grid[y][x] */
export type Grid = (Piece | null)[][]

export function buildGrid(pieces: Piece[]): Grid {
  const grid: Grid = Array.from({ length: ROWS }, () => Array<Piece | null>(COLS).fill(null))
  for (const p of pieces) if (p.alive) grid[p.y][p.x] = p
  return grid
}

export function pieceAt(state: GameState, x: number, y: number): Piece | undefined {
  return state.pieces.find((p) => p.alive && p.x === x && p.y === y)
}

export function getPiece(state: GameState, id: string): Piece {
  const p = state.pieces.find((q) => q.id === id)
  if (!p) throw new Error(`棋子不存在: ${id}`)
  return p
}

export function findKing(state: GameState, side: Side): Piece | undefined {
  return state.pieces.find((p) => p.alive && p.side === side && p.type === 'K')
}

export const PIECE_CHARS: Record<Side, Record<PieceType, string>> = {
  red: { K: '帥', A: '仕', B: '相', N: '傌', R: '俥', C: '炮', P: '兵' },
  black: { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' },
}

export const SIDE_NAMES: Record<Side, string> = { red: '红方', black: '黑方' }

export const pieceName = (p: Piece) => PIECE_CHARS[p.side][p.type]

const PIECE_VALUE: Record<PieceType, number> = { K: 0, A: 2, B: 2, N: 4, R: 9, C: 4.5, P: 1 }

export function material(state: GameState, side: Side): number {
  let sum = 0
  for (const p of state.pieces) {
    if (!p.alive || p.side !== side) continue
    sum += p.type === 'P' && crossedRiver(side, p.y) ? 2 : PIECE_VALUE[p.type]
  }
  return sum
}

export function roundOf(state: GameState): number {
  return Math.floor(state.turnNo / 2) + 1
}

export function addLog(state: GameState, text: string, side?: Side) {
  state.log.push({ round: roundOf(state), side, text })
}
