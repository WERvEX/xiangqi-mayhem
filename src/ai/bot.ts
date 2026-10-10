import {
  applyTrustedMove,
  buildGrid,
  crossedRiver,
  exposesKing,
  findKing,
  generateMoves,
  getMods,
  isProtected,
  legalMoves,
  other,
  positionKey,
  roundOf,
  type Action,
  type GameState,
  type Grid,
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
  tiejia: [55, 'defense'],
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
  /**
   * 评估函数版本：1 为最初的简单版；2 加入位置分、灵活性、悬子与将帅安全；
   * 3 在 2 的基础上加入开局出子评分（默认）
   */
  evalVersion?: 1 | 2 | 3
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
    evaluate: EVALUATORS[opts.evalVersion ?? 3],
    rng,
  })
  return toAction(best)
}

// ───────────── 走法缓存 ─────────────

interface SideMoves {
  moves: Move[]
  /** 受到保护的己方棋子 id */
  defends: Set<string>
}

interface Analysis {
  grid: Grid
  sides: Partial<Record<Side, SideMoves>>
}

/**
 * 同一个局面在搜索里会被多次用到（生成走法、静态搜索、评估），
 * 把棋盘网格和双方走法缓存在局面对象上，避免重复生成。局面对象不可变，所以缓存不会过期。
 */
const analysisCache = new WeakMap<GameState, Analysis>()

function analysis(state: GameState): Analysis {
  let a = analysisCache.get(state)
  if (!a) {
    a = { grid: buildGrid(state.pieces), sides: {} }
    analysisCache.set(state, a)
  }
  return a
}

function sideMoves(state: GameState, side: Side): SideMoves {
  const a = analysis(state)
  let sm = a.sides[side]
  if (!sm) {
    const defends = new Set<string>()
    sm = { moves: generateMoves(state, side, getMods(state, side), defends, a.grid), defends }
    a.sides[side] = sm
  }
  return sm
}

/** 与 legalMoves 相同（含额外行动的限制），但结果会被评估复用 */
function searchMoves(state: GameState): Move[] {
  const moves = sideMoves(state, state.turn).moves
  const extra = state.extraMoves[0]
  if (!extra) return moves
  return moves.filter((m) => (!extra.pieceId || m.pieceId === extra.pieceId) && (!extra.noCapture || !m.captureId))
}

/** 走法目标格上的棋子（吃子时为被吃的子） */
const targetOf = (state: GameState, m: Move) => analysis(state).grid[m.to.y][m.to.x]!
const moverOf = (state: GameState, m: Move) => analysis(state).grid[m.from.y][m.from.x]!

// ───────────── 搜索 ─────────────

type EvalFn = (state: GameState, side: Side, w: Weights, hangingTerm: boolean) => number

interface SearchParams {
  maxDepth: number
  timeMs: number
  quiescence: boolean
  noise: number
  weights: Weights
  evaluate: EvalFn
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
    if (child.phase === 'draft') return this.p.evaluate(child, parentSide, this.p.weights, !this.p.quiescence)
    if (child.turn === parentSide) return this.negamax(child, depth, alpha, beta, ply) // 额外行动：仍然是我走
    return -this.negamax(child, depth, -beta, -alpha, ply)
  }

  negamax(state: GameState, depth: number, alpha: number, beta: number, ply: number): number {
    this.checkTime()
    if (this.aborted) return 0
    if (depth <= 0) {
      return this.p.quiescence
        ? this.qsearch(state, alpha, beta, ply, 6)
        : this.p.evaluate(state, state.turn, this.p.weights, true)
    }

    const key = ttKey(state)
    const entry = this.tt.get(key)
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.score
      if (entry.flag === 'lower' && entry.score >= beta) return entry.score
      if (entry.flag === 'upper' && entry.score <= alpha) return entry.score
    }

    const moves = this.order(state, searchMoves(state), entry?.best, ply)
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
    const standPat = this.p.evaluate(state, state.turn, this.p.weights, false)
    if (standPat >= beta || qdepth === 0) return standPat
    if (standPat > alpha) alpha = standPat

    // 只看真正能吃掉的子：被护盾或锦囊挡下的"吃子"只会掉护盾、棋子还在原地，
    // 放进静态搜索会一路连锁展开，留给正常搜索处理
    const captures = orderCaptures(
      state,
      searchMoves(state).filter((m) => m.captureId && !isProtected(state, targetOf(state, m))),
    )
    let best = standPat
    for (const m of captures) {
      const child = applyTrustedMove(state, m)
      let score: number
      if (child.phase === 'over') score = child.winner === state.turn ? WIN - ply : child.winner ? -WIN + ply : this.p.weights.draw
      else if (child.phase === 'draft') score = this.p.evaluate(child, state.turn, this.p.weights, false)
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
  let rootMoves = s.order(state, searchMoves(state), undefined, 0)
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
  const t = targetOf(state, m)
  return t.type === 'K' ? 100 : VALUE[t.type]
}

function attackerValue(state: GameState, m: Move): number {
  return VALUE[moverOf(state, m).type]
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
 * 第一版评估（保留用于对比）：子力 + 推进奖励 + 靠近对方将帅 + 护盾、士象。
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

// ───────────── 第二版评估 ─────────────

/** 从 side 的角度看第几行：0 为对方底线，9 为己方底线；<= 4 表示已过河 */
const rankOf = (side: Side, y: number) => (side === 'red' ? y : 9 - y)

/** 位置分：只依赖棋子类型和位置，与锦囊无关 */
function positional(type: PieceType, side: Side, x: number, y: number): number {
  const r = rankOf(side, y)
  const center = x >= 3 && x <= 5
  switch (type) {
    case 'R':
      // 车困在底线不好，出到河口、对方二路好
      return (r === 9 ? -0.25 : 0) + (r <= 2 ? 0.25 : r <= 6 ? 0.12 : 0) + (center && r <= 6 ? 0.05 : 0)
    case 'N':
      // 马怕边、怕窝在底线，中路和河口最活
      return -0.07 * Math.abs(x - 4) + (r === 9 ? -0.25 : 0) + (r >= 2 && r <= 5 ? 0.2 : r <= 1 ? 0.05 : 0)
    case 'C':
      // 中炮有威胁；炮钻到对方底线附近反而容易被困
      return (x === 4 ? 0.15 : 0) + (r <= 1 ? -0.1 : 0)
    case 'K':
      // 将帅待在九宫底线中央最安全，没事别乱动
      return (x === 4 ? 0 : -0.1) + (r === 9 ? 0 : -0.15)
    case 'P':
      if (r > 4) return r === 5 ? 0.05 : 0
      // 过河兵：越靠近九宫越好，到了底线只能横走，价值下降
      return Math.min(9 - r, 7) * 0.1 + (center ? 0.15 : 0) + (r === 0 ? -0.3 : 0)
    default:
      return 0
  }
}

/** 开局出子评分的衰减：第 1 回合为 1，第 13 回合起为 0 */
const DEVELOPMENT_DECAY = Array.from({ length: 14 }, (_, r) => Math.max(0, 1 - (r - 1) / 12))

const EVALUATORS: Record<1 | 2 | 3, EvalFn> = {
  1: evaluate,
  2: (s, side, w) => evaluateV2(s, side, w),
  3: (s, side, w) => evaluateV2(s, side, w, true, true),
}

// evaluateV2 复用的临时数组（按格子编号索引）
const ATTACK = { red: new Uint8Array(90), black: new Uint8Array(90) }
const CHEAPEST = { red: new Float64Array(90), black: new Float64Array(90) }
const MOBILITY_COUNT = new Uint8Array(90)

/** 灵活性：每个可走的格子值多少分 */
const MOBILITY: Partial<Record<PieceType, number>> = { R: 0.025, N: 0.06, C: 0.02 }

/**
 * 第二版评估：子力 + 位置分 + 灵活性 + 悬子 + 将帅安全 + 护盾、士象。
 * 双方走法各生成一次，从中得到灵活性、攻击范围和保护关系。
 * 所有走法都来自规则引擎，所以锦囊带来的变化（比如车能斜走）会自动反映在评分里。
 */
export function evaluateV2(state: GameState, side: Side, w: Weights = NEUTRAL, _hanging = true, development = false): number {
  const sides: Side[] = ['red', 'black']
  const red = sideMoves(state, 'red')
  const black = sideMoves(state, 'black')
  const grid = analysis(state).grid
  const defends = { red: red.defends, black: black.defends }
  const moves = { red: red.moves, black: black.moves }

  // 轮到走的一方能直接吃掉对方将帅：胜负已定
  if (state.phase === 'play') {
    const target = state.pieces.find((p) => p.alive && p.side !== state.turn && p.type === 'K')
    if (target && !isProtected(state, target) && moves[state.turn].some((m) => m.captureId === target.id)) {
      return state.turn === side ? WIN / 2 : -WIN / 2
    }
  }

  // 每一方能攻击到的空格、对每个格子上敌子的最便宜攻击者、每个子的可走步数。
  // 用按格子编号（y * 9 + x）索引的定长数组，复用预先分配的内存
  ATTACK.red.fill(0)
  ATTACK.black.fill(0)
  CHEAPEST.red.fill(Infinity)
  CHEAPEST.black.fill(Infinity)
  MOBILITY_COUNT.fill(0)
  for (const s of sides) {
    const attack = ATTACK[s]
    const cheapest = CHEAPEST[s]
    for (const m of moves[s]) {
      if (m.swapId) continue
      const a = grid[m.from.y][m.from.x]!
      MOBILITY_COUNT[m.from.y * 9 + m.from.x]++
      const to = m.to.y * 9 + m.to.x
      if (m.captureId) {
        const av = a.type === 'K' ? 100 : VALUE[a.type]
        if (av < cheapest[to]) cheapest[to] = av
      } else if (a.type !== 'C') {
        // 炮平移到的格子并不受它攻击
        attack[to] = 1
      }
    }
  }

  let score = 0
  for (const p of state.pieces) {
    if (!p.alive) continue
    const sign = p.side === side ? 1 : -1
    const enemy = other(p.side)
    const val = p.type === 'P' && crossedRiver(p.side, p.y) ? 2 : VALUE[p.type]
    let v = val + positional(p.type, p.side, p.x, p.y)
    // 开局出子：车马还在开局原位时扣分，随回合数逐渐减弱，第 13 回合起归零
    if (development && (p.type === 'R' || p.type === 'N') && p.x === p.home.x && p.y === p.home.y) {
      v -= 0.4 * DEVELOPMENT_DECAY[Math.min(roundOf(state), 13)]
    }
    const at = p.y * 9 + p.x
    v += MOBILITY_COUNT[at] * (MOBILITY[p.type] ?? 0)
    v += Math.min(p.shield, 2) * (p.type === 'K' ? 3 : Math.min(VALUE[p.type], 4) * 0.5) * w.defense
    if (p.type === 'A' || p.type === 'B') v += 0.3 * w.defense

    if (p.type !== 'K') {
      const c = CHEAPEST[enemy][at]
      const attacker = c === Infinity || isProtected(state, p) ? undefined : c
      const defended = defends[p.side].has(p.id)
      const myMove = state.turn === p.side
      if (attacker !== undefined) {
        // 悬子：轮到自己还来得及救，轮到对方基本就丢了
        if (!defended) v -= (myMove ? 0.15 : 0.6) * val
        else if (attacker < val) v -= (myMove ? 0.1 : 0.5) * (val - attacker)
      } else if (!defended && (p.type === 'R' || p.type === 'N' || p.type === 'C')) {
        v -= 0.06 * Math.min(val, 4) // 没有保护的大子，容易被抓
      }
    }
    score += sign * v
  }

  // 将帅安全：安全出口越少、附近敌方攻击子越多越危险
  for (const s of sides) {
    const king = state.pieces.find((p) => p.alive && p.side === s && p.type === 'K')
    if (!king) continue
    const enemy = other(s)
    let escapes = 0
    for (const m of moves[s]) {
      if (m.pieceId !== king.id || m.swapId) continue
      const unsafe = m.captureId ? defends[enemy].has(m.captureId) : ATTACK[enemy][m.to.y * 9 + m.to.x] === 1
      if (!unsafe) escapes++
    }
    let danger = escapes === 0 ? 0.5 : escapes === 1 ? 0.2 : 0
    for (const q of state.pieces) {
      if (!q.alive || q.side !== enemy || !(q.type === 'R' || q.type === 'N' || q.type === 'C')) continue
      if (Math.abs(q.x - king.x) + Math.abs(q.y - king.y) <= 3) danger += 0.2
    }
    // 自己的将帅危险按防守权重扣分；对方的将帅危险按进攻权重加分
    score += s === side ? -danger * w.defense : danger * w.attack
  }
  return score
}
