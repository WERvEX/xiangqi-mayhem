import { AUGMENT_LIST, AUGMENTS, TIER_NAMES, type AugmentDef } from './augments'
import {
  addLog,
  findKing,
  getPiece,
  initialPieces,
  material,
  other,
  pieceName,
  roundOf,
  SIDE_NAMES,
} from './board'
import { generateMoves } from './movegen'
import { rngFor, shuffle } from './rng'
import type { Action, DraftSide, GameState, Move, Piece, RuleMods, Side, Tier } from './types'

export const CONFIG = {
  /** 在这些回合发放锦囊；轮流在红方、黑方走棋前发放（见 draftSide） */
  draftRounds: [1, 5, 10, 16],
  rerollsPerGame: 1,
  maxRounds: 150,
  /** 子力落后达到该值时，本次锦囊品质提升一档 */
  comebackThreshold: 5,
  /** 每次发放的品质概率 [白银, 黄金, 棱彩]，双方共用同一次结果 */
  tierOdds: [
    [0.75, 0.25, 0],
    [0.3, 0.6, 0.1],
    [0, 0.6, 0.4],
    [0, 0.3, 0.7],
  ],
}

const TIERS: Tier[] = ['silver', 'gold', 'prism']

export class IllegalActionError extends Error {}

/**
 * 第 index 次锦囊在哪一方走棋前发放。轮流进行，
 * 避免新锦囊总是让红方先用上（模拟显示这会让红方胜率明显偏高）。
 */
export const draftSide = (index: number): Side => (index % 2 === 0 ? 'red' : 'black')

export function createGame(seed: string): GameState {
  const s: GameState = {
    seed,
    phase: 'play',
    turn: 'red',
    turnNo: 0,
    pieces: initialPieces(),
    augments: { red: [], black: [] },
    rerollsLeft: { red: CONFIG.rerollsPerGame, black: CONFIG.rerollsPerGame },
    draft: null,
    draftsDone: 0,
    extraMoves: [],
    lastMove: null,
    positionCounts: {},
    winner: null,
    endReason: null,
    log: [],
  }
  s.positionCounts[positionKey(s)] = 1
  if (CONFIG.draftRounds[0] === 1) startDraft(s)
  return s
}

export function getMods(state: GameState, side: Side): RuleMods {
  const m: RuleMods = {}
  for (const a of state.augments[side]) {
    const mods = AUGMENTS[a.id].mods
    if (!mods) continue
    const { cannonMaxScreens, ...flags } = mods
    Object.assign(m, flags)
    if (cannonMaxScreens) m.cannonMaxScreens = Math.max(m.cannonMaxScreens ?? 1, cannonMaxScreens)
  }
  return m
}

/** 当前行动方的合法走法（考虑额外行动的限制） */
export function legalMoves(state: GameState): Move[] {
  if (state.phase !== 'play') return []
  let moves = generateMoves(state, state.turn, getMods(state, state.turn))
  const extra = state.extraMoves[0]
  if (extra) {
    moves = moves.filter(
      (m) => (!extra.pieceId || m.pieceId === extra.pieceId) && (!extra.noCapture || !m.captureId),
    )
  }
  return moves
}

/** 吃掉 target 时会被什么挡下：护盾、某个锦囊，或者 null（能吃掉） */
function findProtection(s: GameState, target: Piece): 'shield' | { def: AugmentDef; data: Record<string, number> } | null {
  if (target.shield > 0) return 'shield'
  for (const a of s.augments[target.side]) {
    const def = AUGMENTS[a.id]
    if (def.protects?.(s, target.side, target, a.data)) return { def, data: a.data }
  }
  return null
}

/** 吃掉这个棋子会不会被挡下（护盾或锦囊） */
export function isProtected(s: GameState, target: Piece): boolean {
  return findProtection(s, target) !== null
}

/**
 * attacker 对对方将帅的威胁（不考虑轮次）：
 * lethal 能直接吃掉；guarded 能攻击到但会被护盾或锦囊挡下；null 没有威胁
 */
export function kingThreat(state: GameState, attacker: Side): 'lethal' | 'guarded' | null {
  const king = findKing(state, other(attacker))
  if (!king) return null
  const hits = generateMoves(state, attacker, getMods(state, attacker)).some((m) => m.captureId === king.id)
  if (!hits) return null
  return findProtection(state, king) ? 'guarded' : 'lethal'
}

/** attacker 现在能否直接吃掉对方的将帅（被护盾或锦囊保护时不算） */
export function canAttackKing(state: GameState, attacker: Side): boolean {
  return kingThreat(state, attacker) === 'lethal'
}

/** 走完这步后，对方下一手能否直接吃掉自己的将帅（用于送将提醒） */
export function exposesKing(state: GameState, move: Move): boolean {
  const side = state.turn
  const next = applyAction(state, { type: 'move', side, pieceId: move.pieceId, to: move.to })
  if (next.phase === 'over' || next.turn === side) return false
  return canAttackKing(next, other(side))
}

export function applyAction(prev: GameState, action: Action): GameState {
  if (prev.phase === 'over') throw new IllegalActionError('对局已结束')
  const s = cloneState(prev)
  switch (action.type) {
    case 'move':
      doMove(s, action)
      break
    case 'skip':
      doSkip(s, action.side)
      break
    case 'pick':
      doPick(s, action.side, action.augmentId)
      break
    case 'reroll':
      doReroll(s, action.side)
      break
    case 'resign':
      finish(s, other(action.side), `${SIDE_NAMES[action.side]}认输`)
      break
  }
  return s
}

function doMove(s: GameState, action: Extract<Action, { type: 'move' }>) {
  if (s.phase !== 'play' || action.side !== s.turn) throw new IllegalActionError('还没轮到你')
  const move = legalMoves(s).find(
    (m) => m.pieceId === action.pieceId && m.to.x === action.to.x && m.to.y === action.to.y,
  )
  if (!move) throw new IllegalActionError('不合法的走法')

  const side = s.turn
  const piece = getPiece(s, move.pieceId)
  const target = move.captureId ? getPiece(s, move.captureId) : null
  let captured = null
  let blocked = false
  const protection = target ? findProtection(s, target) : null

  if (move.swapId) {
    const mate = getPiece(s, move.swapId)
    mate.x = piece.x
    mate.y = piece.y
    piece.x = move.to.x
    piece.y = move.to.y
    addLog(s, `移形换影！${pieceName(piece)}与${pieceName(mate)}交换了位置`, side, { kind: 'swap', pos: move.to })
  } else if (target && protection) {
    blocked = true
    if (protection === 'shield') {
      target.shield--
      addLog(s, `${pieceName(piece)}攻击${pieceName(target)}，被护盾挡下！`, side, { kind: 'shield', pos: move.to })
    } else protection.def.onProtect?.(s, target.side, target, protection.data)
  } else {
    if (target) {
      target.alive = false
      captured = target
      addLog(s, `${pieceName(piece)}吃掉了${pieceName(target)}`, side, { kind: 'capture', pos: move.to })
    }
    piece.x = move.to.x
    piece.y = move.to.y
  }
  s.lastMove = move

  const isExtra = s.extraMoves.length > 0
  if (isExtra) s.extraMoves.shift()

  if (captured?.type === 'K') {
    finish(s, side, `${SIDE_NAMES[side]}吃掉了对方的${pieceName(captured)}`)
    return
  }
  if (captured) {
    for (const a of s.augments[captured.side]) {
      AUGMENTS[a.id].onOwnCaptured?.(s, captured.side, captured, a.data)
    }
  }
  for (const a of s.augments[side]) {
    AUGMENTS[a.id].onAfterMove?.(s, side, { move, piece, captured, blocked, isExtra }, a.data)
  }

  if (s.extraMoves.length > 0) {
    if (legalMoves(s).length > 0) {
      addLog(s, `【${AUGMENTS[s.extraMoves[0].source].name}】可以再走一步`, side, { kind: 'extra', pos: at(piece) })
      return
    }
    s.extraMoves = []
  }
  endTurn(s)
}

function doSkip(s: GameState, side: Side) {
  if (s.phase !== 'play' || side !== s.turn || s.extraMoves.length === 0) {
    throw new IllegalActionError('当前没有可以跳过的额外行动')
  }
  s.extraMoves.shift()
  if (s.extraMoves.length === 0 || legalMoves(s).length === 0) endTurn(s)
}

function endTurn(s: GameState) {
  s.extraMoves = []
  s.turnNo++
  s.turn = other(s.turn)

  const key = positionKey(s)
  s.positionCounts[key] = (s.positionCounts[key] ?? 0) + 1
  if (s.positionCounts[key] >= 3) return finish(s, null, '同一局面重复三次，判和')
  if (roundOf(s) > CONFIG.maxRounds) return finish(s, null, `超过 ${CONFIG.maxRounds} 回合，判和`)

  if (s.turn === draftSide(s.draftsDone) && CONFIG.draftRounds[s.draftsDone] === roundOf(s)) {
    startDraft(s)
    return
  }
  checkNoMoves(s)
}

function checkNoMoves(s: GameState) {
  if (s.phase === 'play' && legalMoves(s).length === 0) {
    finish(s, other(s.turn), `${SIDE_NAMES[s.turn]}无棋可走`)
  }
}

function finish(s: GameState, winner: Side | null, reason: string) {
  s.phase = 'over'
  s.winner = winner
  s.endReason = reason
  s.extraMoves = []
  addLog(s, reason)
}

function positionKey(s: GameState): string {
  const pieces = s.pieces
    .filter((p) => p.alive)
    .map((p) => `${p.id}${p.type}${p.x}${p.y}${p.shield}`)
    .join(',')
  const augs = (['red', 'black'] as const)
    .map((side) =>
      s.augments[side].map((a) => `${a.id}:${AUGMENTS[a.id].status?.(a.data) ?? ''}`).join(';'),
    )
    .join('/')
  return `${s.turn}|${pieces}|${augs}`
}

// ───────────── 锦囊发放 ─────────────

function rollTier(s: GameState, index: number): Tier {
  const odds = CONFIG.tierOdds[Math.min(index, CONFIG.tierOdds.length - 1)]
  const r = rngFor(s.seed, 'tier', index)()
  let acc = 0
  for (let i = 0; i < TIERS.length; i++) {
    acc += odds[i]
    if (r < acc) return TIERS[i]
  }
  return TIERS[TIERS.length - 1]
}

const TIER_ORDER: Record<Tier, Tier[]> = {
  silver: ['silver', 'gold', 'prism'],
  gold: ['gold', 'silver', 'prism'],
  prism: ['prism', 'gold', 'silver'],
}

/** 抽 3 个选项：优先目标品质、优先没出现过的；不足时向相邻品质补齐 */
function drawOptions(
  s: GameState,
  side: Side,
  index: number,
  rerollNo: number,
  tier: Tier,
  exclude: string[],
): string[] {
  const rng = rngFor(s.seed, 'options', side, index, rerollNo)
  const owned = new Set(s.augments[side].map((a) => a.id))
  const available = AUGMENT_LIST.filter((a) => !owned.has(a.id))
  const fresh = available.filter((a) => !exclude.includes(a.id))
  const result: string[] = []
  for (const pool of [fresh, available]) {
    for (const t of TIER_ORDER[tier]) {
      for (const a of shuffle(
        pool.filter((x) => x.tier === t),
        rng,
      )) {
        if (result.length < 3 && !result.includes(a.id)) result.push(a.id)
      }
    }
  }
  return result
}

function startDraft(s: GameState) {
  const index = s.draftsDone
  const baseTier = rollTier(s, index)
  const makeSide = (side: Side): DraftSide => {
    const behind = material(s, other(side)) - material(s, side)
    const comeback = behind >= CONFIG.comebackThreshold
    // 粮草先行：下一次锦囊品质提升一档
    const boosted = s.augments[side].find((a) => a.data.boost)
    if (boosted) boosted.data.boost = 0
    const steps = (comeback ? 1 : 0) + (boosted ? 1 : 0)
    const tier = TIERS[Math.min(TIERS.indexOf(baseTier) + steps, TIERS.length - 1)]
    const options = drawOptions(s, side, index, 0, tier, [])
    return { tier, options, rerollNo: 0, done: options.length === 0, picked: null, comeback: steps > 0 }
  }
  s.draft = { index, round: roundOf(s), sides: { red: makeSide('red'), black: makeSide('black') } }
  s.phase = 'draft'
  addLog(s, `第 ${roundOf(s)} 回合：发放${TIER_NAMES[baseTier]}锦囊`)
  maybeEndDraft(s)
}

function doPick(s: GameState, side: Side, augmentId: string) {
  const ds = s.draft?.sides[side]
  if (s.phase !== 'draft' || !ds || ds.done) throw new IllegalActionError('现在不能选择锦囊')
  if (!ds.options.includes(augmentId)) throw new IllegalActionError('不在可选范围内')
  const owned = { id: augmentId, data: {} }
  s.augments[side].push(owned)
  ds.done = true
  ds.picked = augmentId
  addLog(s, `${SIDE_NAMES[side]}获得锦囊【${AUGMENTS[augmentId].name}】`, side)
  AUGMENTS[augmentId].onPick?.(s, side, owned.data)
  maybeEndDraft(s)
}

function doReroll(s: GameState, side: Side) {
  const ds = s.draft?.sides[side]
  if (s.phase !== 'draft' || !ds || ds.done) throw new IllegalActionError('现在不能刷新')
  if (s.rerollsLeft[side] <= 0) throw new IllegalActionError('刷新次数已用完')
  s.rerollsLeft[side]--
  ds.rerollNo++
  ds.options = drawOptions(s, side, s.draft!.index, ds.rerollNo, ds.tier, ds.options)
}

function maybeEndDraft(s: GameState) {
  const d = s.draft
  if (!d || !d.sides.red.done || !d.sides.black.done) return
  s.draft = null
  s.draftsDone++
  s.phase = 'play'
  checkNoMoves(s)
}

/** 下一次发放锦囊的回合，没有则为 null */
export function nextDraftRound(state: GameState): number | null {
  return CONFIG.draftRounds[state.draftsDone] ?? null
}

const at = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })

/** 比 structuredClone 快得多；日志条目和走法对象创建后不会再被修改，可以共享 */
function cloneState(s: GameState): GameState {
  return {
    ...s,
    pieces: s.pieces.map((p) => ({ ...p })),
    augments: {
      red: s.augments.red.map((a) => ({ id: a.id, data: { ...a.data } })),
      black: s.augments.black.map((a) => ({ id: a.id, data: { ...a.data } })),
    },
    rerollsLeft: { ...s.rerollsLeft },
    draft: s.draft && {
      ...s.draft,
      sides: {
        red: { ...s.draft.sides.red, options: [...s.draft.sides.red.options] },
        black: { ...s.draft.sides.black, options: [...s.draft.sides.black.options] },
      },
    },
    extraMoves: s.extraMoves.map((e) => ({ ...e })),
    positionCounts: { ...s.positionCounts },
    log: [...s.log],
  }
}
