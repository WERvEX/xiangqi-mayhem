import {
  applyAction,
  crossedRiver,
  findKing,
  generateMoves,
  getMods,
  isProtected,
  legalMoves,
  other,
  type Action,
  type GameState,
  type Move,
  type PieceType,
  type Side,
} from '../engine'

const VALUE: Record<PieceType, number> = { K: 0, A: 2, B: 2, N: 4, R: 9, C: 4.5, P: 1 }
const WIN = 10000

export interface BotOptions {
  /** 搜索深度（半回合数），默认 2 */
  depth?: number
  /** 根节点评分的随机扰动幅度，避免每局一模一样 */
  noise?: number
  /** 随机数来源，便于复现 */
  rng?: () => number
  /** 锦囊选择策略：random 用于统计锦囊强度，best 按经验价值挑 */
  pick?: 'random' | 'best'
}

/** 为 side 选择一个操作；不是 side 行动的时候返回 null */
export function chooseAction(state: GameState, side: Side, opts: BotOptions = {}): Action | null {
  const rng = opts.rng ?? Math.random
  if (state.phase === 'draft') {
    const ds = state.draft!.sides[side]
    if (ds.done) return null
    const id =
      opts.pick === 'best'
        ? [...ds.options].sort((a, b) => (PICK_VALUE[b] ?? 0) - (PICK_VALUE[a] ?? 0))[0]
        : ds.options[Math.floor(rng() * ds.options.length)]
    return { type: 'pick', side, augmentId: id }
  }
  if (state.phase !== 'play' || state.turn !== side) return null

  const moves = order(state, legalMoves(state))
  if (moves.length === 0) return null
  const depth = opts.depth ?? 2
  const noise = opts.noise ?? 0.3
  let best: Move = moves[0]
  let bestScore = -Infinity
  for (const m of moves) {
    const child = play(state, m)
    const score = scoreChild(state, child, depth - 1, -Infinity, Infinity) + rng() * noise
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  // 有额外行动但最佳选择是"不动"时，也允许跳过；这里简单起见总是走
  return { type: 'move', side, pieceId: best.pieceId, to: best.to }
}

function play(state: GameState, m: Move): GameState {
  return applyAction(state, { type: 'move', side: state.turn, pieceId: m.pieceId, to: m.to })
}

/** 从 parent 行动方的视角给 child 打分 */
function scoreChild(parent: GameState, child: GameState, depth: number, alpha: number, beta: number): number {
  const me = parent.turn
  if (child.phase === 'over') return child.winner === me ? WIN : child.winner ? -WIN : 0
  if (child.turn === me) return negamax(child, depth, alpha, beta) // 额外行动：仍然是我走
  return -negamax(child, depth, -beta, -alpha)
}

function negamax(state: GameState, depth: number, alpha: number, beta: number): number {
  if (depth <= 0 || state.phase !== 'play') return evaluate(state, state.turn)
  const moves = order(state, legalMoves(state))
  if (moves.length === 0) return -WIN
  let best = -Infinity
  for (const m of moves) {
    const score = scoreChild(state, play(state, m), depth - 1, alpha, beta)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

/** 吃子优先、吃大子优先，提高剪枝效率 */
function order(state: GameState, moves: Move[]): Move[] {
  const val = (m: Move) => {
    if (!m.captureId) return 0
    const t = state.pieces.find((p) => p.id === m.captureId)!
    return t.type === 'K' ? 1000 : VALUE[t.type] * 10 + 1
  }
  return moves.map((m) => [val(m), m] as const).sort((a, b) => b[0] - a[0]).map(([, m]) => m)
}

/** side 视角的静态评估 */
export function evaluate(state: GameState, side: Side): number {
  let score = 0
  for (const p of state.pieces) {
    if (!p.alive) continue
    const sign = p.side === side ? 1 : -1
    let v = p.type === 'P' && crossedRiver(p.side, p.y) ? 2 : VALUE[p.type]
    // 往前推进的子力略加分，鼓励进攻
    const adv = p.side === 'red' ? 9 - p.y : p.y
    if (p.type === 'R' || p.type === 'N' || p.type === 'C') v += adv * 0.04
    if (p.type === 'P' && crossedRiver(p.side, p.y)) v += Math.min(adv, 7) * 0.1
    v += Math.min(p.shield, 2) * (p.type === 'K' ? 3 : Math.min(VALUE[p.type], 4) * 0.5)
    score += sign * v
  }
  // 轮到 side 走：能立刻吃到的最大价值（粗略的"悬子"判断）
  if (state.turn === side) {
    const enemyKing = findKing(state, other(side))
    let bestGain = 0
    for (const m of generateMoves(state, side, getMods(state, side))) {
      if (!m.captureId) continue
      if (enemyKing && m.captureId === enemyKing.id && !isProtected(state, enemyKing)) return WIN / 2
      const t = state.pieces.find((p) => p.id === m.captureId)!
      if (!isProtected(state, t)) bestGain = Math.max(bestGain, VALUE[t.type])
    }
    score += bestGain * 0.7
  }
  return score
}

/** 选锦囊时的经验价值（模拟统计后可调整） */
const PICK_VALUE: Record<string, number> = {}

export function setPickValues(values: Record<string, number>) {
  Object.assign(PICK_VALUE, values)
}
