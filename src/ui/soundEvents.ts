import { kingThreat, other, type FxKind, type GameState, type LogEntry, type Side } from '../engine'

export type SoundName =
  | 'select'
  | 'move'
  | 'capture'
  | 'shieldBlock'
  | 'shieldUp'
  | 'protect'
  | 'revive'
  | 'promote'
  | 'burn'
  | 'summon'
  | 'convert'
  | 'swap'
  | 'extra'
  | 'check'
  | 'draft'
  | 'pick'
  | 'reveal'
  | 'win'
  | 'lose'
  | 'draw'

/** 一次最多跳过这么多条日志还播放音效；更多时（回放拖动、恢复存档）不播放 */
const MAX_FRESH = 12
const MAX_TURNS = 2

const FX_SOUNDS: Record<Exclude<FxKind, 'capture' | 'shield'>, SoundName> = {
  protect: 'protect',
  revive: 'revive',
  promote: 'promote',
  burn: 'burn',
  summon: 'summon',
  convert: 'convert',
  swap: 'swap',
  extra: 'extra',
}

const fxSound = (e: LogEntry): SoundName | null => {
  const kind = e.fx?.kind
  if (!kind || kind === 'capture') return null
  // 护盾：挡下攻击和获得护盾用不同的声音
  if (kind === 'shield') return e.text.includes('挡下') ? 'shieldBlock' : 'shieldUp'
  return FX_SOUNDS[kind]
}

/**
 * 局面从 prev 变到 next 时要播放的音效（按先后顺序）。
 * 只处理往前走一步的情况；悔棋、回放往回拖、一次跳很多步都不出声。
 * mySide：自己执哪一方，用来区分胜负音效；观战时为 null
 */
export function soundsFor(prev: GameState, next: GameState, mySide: Side | null): SoundName[] {
  if (next.seed !== prev.seed || next.log.length < prev.log.length || next.turnNo < prev.turnNo) return []
  // 普通走子不写日志，所以同时看走子记录
  if (next.log.length === prev.log.length && next.lastMove === prev.lastMove) return []
  const fresh = next.log.slice(prev.log.length)
  if (fresh.length > MAX_FRESH || next.turnNo - prev.turnNo > MAX_TURNS) return []
  const out: SoundName[] = []
  const add = (s: SoundName | null) => {
    if (s && !out.includes(s)) out.push(s)
  }

  if (next.lastMove && next.lastMove !== prev.lastMove) {
    // 攻击被护盾或锦囊挡下时攻击者原地不动，不出落子声
    const blocked = fresh.some((e) => e.fx?.kind === 'protect' || fxSound(e) === 'shieldBlock')
    if (fresh.some((e) => e.fx?.kind === 'capture')) add('capture')
    else if (!blocked) add('move')
  }
  for (const e of fresh) add(fxSound(e))

  if (next.phase === 'draft' && prev.phase !== 'draft') add('draft')
  else if (next.phase === 'draft' && prev.phase === 'draft') add('pick')
  if (prev.phase === 'draft' && next.phase !== 'draft') add('reveal')

  if (next.phase === 'over') {
    if (next.winner === null) add('draw')
    else add(mySide === null || next.winner === mySide ? 'win' : 'lose')
  } else if (next.phase === 'play') {
    // 有一方的将帅可以被直接吃掉
    if ((['red', 'black'] as const).some((side) => kingThreat(next, other(side)) === 'lethal')) add('check')
  }
  return out
}
