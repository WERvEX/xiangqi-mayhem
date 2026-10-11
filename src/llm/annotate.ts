import {
  applyAction,
  canAttackKing,
  findKing,
  generateMoves,
  getMods,
  getPiece,
  isProtected,
  kingThreat,
  other,
  pieceName,
  positionKey,
  type GameState,
  type Move,
  type Piece,
  type Side,
} from '../engine'
import { square } from './notation'

/**
 * 辅助标注：只给出引擎能直接算出来的事实，不含引擎自己的判断（不评估好坏）。
 */

/** 一个走法的标注，如 ["将军", "走后可被吃"] */
export function moveTags(state: GameState, m: Move): string[] {
  const side = state.turn
  const tags: string[] = []
  if (m.captureId && isProtected(state, getPiece(state, m.captureId))) tags.push('会被挡下')

  const next = applyAction(state, { type: 'move', side, pieceId: m.pieceId, to: m.to })
  if (next.phase === 'over') {
    tags.push(next.winner === side ? '直接获胜' : next.winner ? '直接输棋' : '导致和棋')
    return tags
  }
  const threat = kingThreat(next, side)
  if (threat === 'lethal') tags.push('将军')
  else if (threat === 'guarded') tags.push('攻击将帅（会被挡下）')

  // 除非自己还有额外行动，下一手就轮到对方（中间可能先选锦囊）
  const myExtra = next.phase === 'play' && next.turn === side
  if (!myExtra) {
    const opp = other(side)
    if (canAttackKing(next, opp)) tags.push('⚠走后己方将帅可被吃')
    else {
      const moved = getPiece(next, m.pieceId)
      if (moved.type !== 'K' && attackedUnprotected(next, opp, moved)) tags.push('走后可被吃')
    }
  }
  if ((next.positionCounts[positionKey(next)] ?? 0) >= 2) tags.push('重复局面（再出现一次判和）')
  return tags
}

/** attacker 能吃到 target，而且 target 没有护盾或锦囊保护 */
function attackedUnprotected(state: GameState, attacker: Side, target: Piece): boolean {
  if (isProtected(state, target)) return false
  return generateMoves(state, attacker, getMods(state, attacker)).some((mv) => mv.captureId === target.id)
}

/**
 * side 一方当前面临的威胁：哪些棋子正被对方攻击。
 * 「有保护」指被吃后己方可以吃回；「会被挡下」指有护盾或锦囊保护。
 */
export function threatsAgainst(state: GameState, side: Side): string[] {
  const opp = other(side)
  const attacks = generateMoves(state, opp, getMods(state, opp))
  const defended = new Set<string>()
  generateMoves(state, side, getMods(state, side), defended)
  const lines: string[] = []
  const seen = new Set<string>()
  const king = findKing(state, side)
  for (const mv of attacks) {
    if (!mv.captureId || seen.has(mv.captureId)) continue
    seen.add(mv.captureId)
    const target = getPiece(state, mv.captureId)
    const by = getPiece(state, mv.pieceId)
    let note = isProtected(state, target) ? '会被挡下' : defended.has(target.id) ? '有保护' : '无保护'
    if (target === king && !isProtected(state, target)) note = '可被直接吃掉！'
    lines.push(`${pieceName(target)} ${square(target)} 被 ${pieceName(by)} ${square(by)} 攻击（${note}）`)
  }
  // 将帅放在最前面
  return lines.sort((a, b) => Number(b.includes('！')) - Number(a.includes('！')))
}
