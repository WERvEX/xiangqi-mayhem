import {
  applyTrustedMove,
  crossedRiver,
  exposesKing,
  findKing,
  generateMoves,
  getMods,
  isProtected,
  legalMoves,
  other,
  positionKey,
  type Action,
  type GameState,
  type Move,
  type PieceType,
  type Side,
} from '../engine'

const VALUE: Record<PieceType, number> = { K: 0, A: 2, B: 2, N: 4, R: 9, C: 4.5, P: 1 }
const WIN = 10000

// ───────────── 难度与性格 ─────────────

export type Difficulty = 'beginner' | 'normal' | 'hard' | 'master'
export type Personality = 'balanced' | 'aggressive' | 'solid'

interface DifficultyParams {
  name: string
  desc: string
  maxDepth: number
  /** 思考时间上限（毫秒） */
  timeMs: number
  quiescence: boolean
  /** 根节点评分的随机扰动，越大越"随性" */
  noise: number
  /** 随手乱走一步的概率 */
  blunder: number
  /** 挑锦囊的方式 */
  pick: 'random' | 'best'
}

export const DIFFICULTIES: Record<Difficulty, DifficultyParams> = {
  beginner: { name: '入门', desc: '经常走错，适合熟悉规则', maxDepth: 1, timeMs: 300, quiescence: false, noise: 3, blunder: 0.25, pick: 'random' },
  normal: { name: '普通', desc: '会抓住明显的机会', maxDepth: 2, timeMs: 600, quiescence: true, noise: 1, blunder: 0.04, pick: 'best' },
  hard: { name: '困难', desc: '算得更深，很少失误', maxDepth: 4, timeMs: 1500, quiescence: true, noise: 0.25, blunder: 0, pick: 'best' },
  master: { name: '大师', desc: '全力计算', maxDepth: 12, timeMs: 3000, quiescence: true, noise: 0, blunder: 0, pick: 'best' },
}

interface Weights {
  /** 进攻因素（推进、靠近对方将帅）的权重 */
  attack: number
  /** 防守因素（护盾、士象）的权重 */
  defense: number
  /** 和棋的评分：激进型不愿意和 */
  draw: number
}

export const PERSONALITIES: Record<Personality, { name: string; desc: string; weights: Weights }> = {
  balanced: { name: '均衡', desc: '攻守兼备', weights: { attack: 1, defense: 1, draw: 0 } },
  aggressive: { name: '激进', desc: '爱吃子、主动进攻，偏爱进攻型锦囊', weights: { attack: 1.8, defense: 0.6, draw: -1.5 } },
  solid: { name: '稳健', desc: '重视防守，偏爱护盾和保将锦囊', weights: { attack: 0.7, defense: 1.6, draw: 0.5 } },
}

// ───────────── 锦囊选择 ─────────────

type Tag = 'attack' | 'defense' | 'neutral'

/** 经验价值（大致对应模拟中的得分率）与类型标签 */
const AUGMENT_AI: Record<string, [number, Tag]> = {
  tianma: [50, 'attack'],
  feixiang: [47, 'neutral'],
  xianfeng: [50, 'attack'],
  huitou: [52, 'neutral'],
  chugong: [47, 'defense'],
  xiexing: [53, 'defense'],
  zhongzhi: [52, 'defense'],
  yulin: [52, 'defense'],
  liangcao: [55, 'neutral'],
  changtong: [55, 'attack'],
  tiejia: [58, 'defense'],
  lianzhu: [52, 'attack'],
  huoshao: [50, 'attack'],
  huima: [47, 'attack'],
  longma: [46, 'attack'],
  yujia: [50, 'neutral'],
  geshan: [47, 'attack'],
  yixing: [46, 'defense'],
  jinzhong: [58, 'defense'],
  jinchan: [55, 'defense'],
  kongcheng: [57, 'defense'],
  jieshi: [42, 'defense'],
  fanjian: [45, 'attack'],
  shensu: [58, 'attack'],
  huangpao: [57, 'attack'],
  huangjinjia: [56, 'defense'],
  zongheng: [52, 'attack'],
  mantian: [50, 'attack'],
  tianjiang: [50, 'attack'],
}

function augmentScore(id: string, personality: Personality): number {
  const [value, tag] = AUGMENT_AI[id] ?? [50, 'neutral']
  if (personality === 'aggressive') return value + (tag === 'attack' ? 6 : tag === 'defense' ? -3 : 0)
  if (personality === 'solid') return value + (tag === 'defense' ? 6 : tag === 'attack' ? -3 : 0)
  return value
}

// ───────────── 对外接口 ─────────────

export interface BotOptions {
  difficulty?: Difficulty
  personality?: Personality
  /** 以下参数会覆盖难度预设，主要供模拟脚本使用 */
  depth?: number
  timeMs?: number
  quiescence?: boolean
  noise?: number
  pick?: 'random' | 'best'
  /** 随机数来源，便于复现 */
  rng?: () => number
}

/** 为 side 选择一个操作；不是 side 行动的时候返回 null */
export function chooseAction(state: GameState, side: Side, opts: BotOptions = {}): Action | null {
  const preset = opts.difficulty ? DIFFICULTIES[opts.difficulty] : null
  const personality = opts.personality ?? 'balanced'
  const rng = opts.rng ?? Math.random

  if (state.phase === 'draft') {
    const ds = state.draft!.sides[side]
    if (ds.done) return null
    const pick = opts.pick ?? preset?.pick ?? 'random'
    if (pick === 'random') {
      return { type: 'pick', side, augmentId: ds.options[Math.floor(rng() * ds.options.length)] }
    }
    const ranked = [...ds.options].sort((a, b) => augmentScore(b, personality) - augmentScore(a, personality))
    // 选项都不理想时刷新一次
    const strong = opts.difficulty === 'hard' || opts.difficulty === 'master'
    if (strong && state.rerollsLeft[side] > 0 && augmentScore(ranked[0], personality) < 50) {
      return { type: 'reroll', side }
    }
    return { type: 'pick', side, augmentId: ranked[0] }
  }
  if (state.phase !== 'play' || state.turn !== side) return null

  const moves = legalMoves(state)
  if (moves.length === 0) return null
  const toAction = (m: Move): Action => ({ type: 'move', side, pieceId: m.pieceId, to: m.to })

  // 先看能不能直接吃掉对方将帅
  const king = findKing(state, other(side))
  const kill = king && moves.find((m) => m.captureId === king.id && !isProtected(state, king))
  if (kill) return toAction(kill)

  const blunder = preset?.blunder ?? 0
  if (blunder > 0 && rng() < blunder) {
    // 随手走一步，但不至于直接送将
    const safe = moves.filter((m) => !exposesKing(state, m))
    const pool = safe.length ? safe : moves
    return toAction(pool[Math.floor(rng() * pool.length)])
  }

  const best = search(state, {
    maxDepth: opts.depth ?? preset?.maxDepth ?? 2,
    timeMs: opts.timeMs ?? (opts.depth !== undefined ? Infinity : (preset?.timeMs ?? Infinity)),
    quiescence: opts.quiescence ?? preset?.quiescence ?? false,
    noise: opts.noise ?? preset?.noise ?? 0.3,
    weights: PERSONALITIES[personality].weights,
    rng,
  })
  return toAction(best)
}

// ───────────── 搜索 ─────────────

interface SearchParams {
  maxDepth: number
  timeMs: number
  quiescence: boolean
  noise: number
  weights: Weights
  rng: () => number
}

interface TTEntry {
  depth: number
  score: number
  flag: 'exact' | 'lower' | 'upper'
  best?: string
}

class Searcher {
  nodes = 0
  aborted = false
  readonly tt = new Map<string, TTEntry>()
  readonly killers: string[][] = []
  private readonly deadline: number
  private readonly p: SearchParams

  constructor(p: SearchParams) {
    this.p = p
    this.deadline = performance.now() + p.timeMs
  }

  private checkTime() {
    if ((++this.nodes & 255) === 0 && performance.now() > this.deadline) this.aborted = true
  }

  /** 从 parentSide 的视角给 child 打分 */
  childScore(parentSide: Side, child: GameState, depth: number, alpha: number, beta: number, ply: number): number {
    if (child.phase === 'over') {
      if (child.winner === parentSide) return WIN - ply
      if (child.winner) return -WIN + ply
      return this.p.weights.draw
    }
    if (child.phase === 'draft') return evaluate(child, parentSide, this.p.weights, !this.p.quiescence)
    if (child.turn === parentSide) return this.negamax(child, depth, alpha, beta, ply) // 额外行动：仍然是我走
    return -this.negamax(child, depth, -beta, -alpha, ply)
  }

  negamax(state: GameState, depth: number, alpha: number, beta: number, ply: number): number {
    this.checkTime()
    if (this.aborted) return 0
    if (depth <= 0) {
      return this.p.quiescence ? this.qsearch(state, alpha, beta, ply, 6) : evaluate(state, state.turn, this.p.weights, true)
    }

    const key = ttKey(state)
    const entry = this.tt.get(key)
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.score
      if (entry.flag === 'lower' && entry.score >= beta) return entry.score
      if (entry.flag === 'upper' && entry.score <= alpha) return entry.score
    }

    const moves = this.order(state, legalMoves(state), entry?.best, ply)
    if (moves.length === 0) return -WIN + ply

    const alpha0 = alpha
    let best = -Infinity
    let bestKey: string | undefined
    for (const m of moves) {
      const score = this.childScore(state.turn, applyTrustedMove(state, m), depth - 1, alpha, beta, ply + 1)
      if (this.aborted) return 0
      if (score > best) {
        best = score
        bestKey = moveKey(m)
      }
      if (best > alpha) alpha = best
      if (alpha >= beta) {
        if (!m.captureId) this.addKiller(ply, moveKey(m))
        break
      }
    }

    if (this.tt.size > 300_000) this.tt.clear()
    const flag = best <= alpha0 ? 'upper' : best >= beta ? 'lower' : 'exact'
    this.tt.set(key, { depth, score: best, flag, best: bestKey })
    return best
  }

  /** 静态搜索：只看吃子，直到局面"安静"下来 */
  qsearch(state: GameState, alpha: number, beta: number, ply: number, qdepth: number): number {
    this.checkTime()
    if (this.aborted) return 0
    const standPat = evaluate(state, state.turn, this.p.weights, false)
    if (standPat >= beta || qdepth === 0) return standPat
    if (standPat > alpha) alpha = standPat

    const captures = orderCaptures(state, legalMoves(state).filter((m) => m.captureId))
    let best = standPat
    for (const m of captures) {
      const child = applyTrustedMove(state, m)
      let score: number
      if (child.phase === 'over') score = child.winner === state.turn ? WIN - ply : child.winner ? -WIN + ply : this.p.weights.draw
      else if (child.phase === 'draft') score = evaluate(child, state.turn, this.p.weights, false)
      else if (child.turn === state.turn) score = this.qsearch(child, alpha, beta, ply + 1, qdepth - 1)
      else score = -this.qsearch(child, -beta, -alpha, ply + 1, qdepth - 1)
      if (this.aborted) return 0
      if (score > best) best = score
      if (best > alpha) alpha = best
      if (alpha >= beta) break
    }
    return best
  }

  private addKiller(ply: number, key: string) {
    const k = (this.killers[ply] ??= [])
    if (k[0] === key) return
    k.unshift(key)
    k.length = Math.min(k.length, 2)
  }

  /** 置换表里的最佳走法 → 吃子（先吃大子）→ 杀手走法 → 其他 */
  order(state: GameState, moves: Move[], ttBest: string | undefined, ply: number): Move[] {
    const killers = this.killers[ply] ?? []
    const score = (m: Move) => {
      const key = moveKey(m)
      if (key === ttBest) return 1e6
      if (m.captureId) return 1e4 + captureValue(state, m) * 10 - attackerValue(state, m)
      const k = killers.indexOf(key)
      return k >= 0 ? 1000 - k : 0
    }
    return moves.map((m) => [score(m), m] as const).sort((a, b) => b[0] - a[0]).map(([, m]) => m)
  }
}

function search(state: GameState, p: SearchParams): Move {
  const s = new Searcher(p)
  const me = state.turn
  let rootMoves = s.order(state, legalMoves(state), undefined, 0)
  let best = rootMoves[0]
  // 有随机扰动时，需要每个根走法的准确分数，所以不在根节点剪枝
  const fullWindow = p.noise > 0

  for (let depth = 1; depth <= p.maxDepth; depth++) {
    const scored: [number, Move][] = []
    let alpha = -Infinity
    for (const m of rootMoves) {
      const score = s.childScore(me, applyTrustedMove(state, m), depth - 1, fullWindow ? -Infinity : alpha, Infinity, 1)
      if (s.aborted) break
      scored.push([score, m])
      if (score > alpha) alpha = score
    }
    if (s.aborted && depth > 1) break // 这一层没算完，用上一层的结果

    const noisy = scored.map(([sc, m]) => [sc + p.rng() * p.noise, m] as [number, Move])
    noisy.sort((a, b) => b[0] - a[0])
    if (noisy.length) best = noisy[0][1]
    // 下一层先算这一层最好的走法，剪枝效率更高
    const rank = new Map(scored.map(([sc, m]) => [m, sc]))
    rootMoves = [...rootMoves].sort((a, b) => (rank.get(b) ?? -Infinity) - (rank.get(a) ?? -Infinity))
    // 已经找到必胜，没必要再算
    if (scored.some(([sc]) => sc > WIN / 2)) break
    if (s.aborted) break
  }
  return best
}

const moveKey = (m: Move) => `${m.pieceId}>${m.to.x}${m.to.y}`
const ttKey = (s: GameState) => `${positionKey(s)}|${s.extraMoves.length}`

function captureValue(state: GameState, m: Move): number {
  const t = state.pieces.find((p) => p.id === m.captureId)!
  return t.type === 'K' ? 100 : VALUE[t.type]
}

function attackerValue(state: GameState, m: Move): number {
  return VALUE[state.pieces.find((p) => p.id === m.pieceId)!.type]
}

function orderCaptures(state: GameState, moves: Move[]): Move[] {
  return moves
    .map((m) => [captureValue(state, m) * 10 - attackerValue(state, m), m] as const)
    .sort((a, b) => b[0] - a[0])
    .map(([, m]) => m)
}

// ───────────── 局面评估 ─────────────

const NEUTRAL: Weights = PERSONALITIES.balanced.weights

/**
 * side 视角的静态评估。
 * hangingTerm：没有静态搜索时，用"能立刻吃到的最大价值"粗略补偿悬子
 */
export function evaluate(state: GameState, side: Side, w: Weights = NEUTRAL, hangingTerm = true): number {
  let score = 0
  const kings: Partial<Record<Side, { x: number; y: number }>> = {}
  for (const p of state.pieces) if (p.alive && p.type === 'K') kings[p.side] = p

  for (const p of state.pieces) {
    if (!p.alive) continue
    const sign = p.side === side ? 1 : -1
    let v = p.type === 'P' && crossedRiver(p.side, p.y) ? 2 : VALUE[p.type]
    const adv = p.side === 'red' ? 9 - p.y : p.y
    // 进攻：推进，以及靠近对方将帅
    if (p.type === 'R' || p.type === 'N' || p.type === 'C') {
      v += adv * 0.04 * w.attack
      const ek = kings[other(p.side)]
      if (ek && Math.abs(ek.x - p.x) + Math.abs(ek.y - p.y) <= 3) v += 0.25 * w.attack
    }
    if (p.type === 'P' && crossedRiver(p.side, p.y)) v += Math.min(adv, 7) * 0.1 * w.attack
    // 防守：护盾、士象护驾
    v += Math.min(p.shield, 2) * (p.type === 'K' ? 3 : Math.min(VALUE[p.type], 4) * 0.5) * w.defense
    if (p.type === 'A' || p.type === 'B') v += 0.3 * w.defense
    score += sign * v
  }

  if (hangingTerm && state.turn === side && state.phase === 'play') {
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
