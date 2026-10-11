import { describe, expect, it } from 'vitest'
import { applyAction, createGame, type GameState, type Piece, type PieceType, type Side } from '../engine'
import { soundsFor } from './soundEvents'

type Spec = [Side, PieceType, number, number, number?]

/** 摆一个局面：红方在下（y 7–9 是红方九宫），帅将不在同一列，免得一开始就能飞将 */
function position(specs: Spec[]): GameState {
  const s = createGame('sound-test')
  s.phase = 'play'
  s.draft = null
  s.draftsDone = 99
  s.turn = 'red'
  const all: Spec[] = [['red', 'K', 3, 9], ['black', 'K', 5, 0], ...specs]
  s.pieces = all.map(
    ([side, type, x, y, shield = 0], i): Piece => ({
      id: `${side[0]}${type}${i}`,
      type,
      side,
      x,
      y,
      alive: true,
      home: { x, y },
      shield,
    }),
  )
  return s
}

const rookMove = (s: GameState, x: number, y: number) => {
  const rook = s.pieces.find((p) => p.side === 'red' && p.type === 'R')!
  return applyAction(s, { type: 'move', side: 'red', pieceId: rook.id, to: { x, y } })
}

describe('音效', () => {
  it('普通走子是落子声，吃子是吃子声', () => {
    const s = position([['red', 'R', 0, 8], ['black', 'P', 0, 4]])
    expect(soundsFor(s, rookMove(s, 0, 6), 'red')).toEqual(['move'])
    expect(soundsFor(s, rookMove(s, 0, 4), 'red')).toEqual(['capture'])
  })

  it('攻击被护盾挡下：只有护盾的声音，没有落子声', () => {
    const s = position([['red', 'R', 0, 8], ['black', 'P', 0, 4, 1]])
    expect(soundsFor(s, rookMove(s, 0, 4), 'red')).toEqual(['shieldBlock'])
  })

  it('走到能直接吃掉对方将帅的位置时提醒', () => {
    const s = position([['red', 'R', 0, 8]])
    expect(soundsFor(s, rookMove(s, 5, 8), 'red')).toEqual(['move', 'check'])
  })

  it('吃掉将帅：自己赢了、输了、观战分别是胜利、失败、胜利的声音', () => {
    const s = position([['red', 'R', 5, 8]])
    const next = rookMove(s, 5, 0)
    expect(next.phase).toBe('over')
    expect(soundsFor(s, next, 'red')).toEqual(['capture', 'win'])
    expect(soundsFor(s, next, 'black')).toEqual(['capture', 'lose'])
    expect(soundsFor(s, next, null)).toEqual(['capture', 'win'])
  })

  it('选锦囊：一方选好是轻响，双方选完揭晓', () => {
    const s0 = createGame('sound-draft')
    const s1 = applyAction(s0, { type: 'pick', side: 'red', augmentId: s0.draft!.sides.red.options[0] })
    const s2 = applyAction(s1, { type: 'pick', side: 'black', augmentId: s1.draft!.sides.black.options[0] })
    expect(soundsFor(s0, s1, 'red')).toEqual(['pick'])
    expect(soundsFor(s1, s2, 'red')).toContain('reveal')
  })

  it('悔棋（往回走）和一次跳很多步时不出声', () => {
    const s = position([['red', 'R', 0, 8]])
    const next = rookMove(s, 0, 6)
    expect(soundsFor(next, s, 'red')).toEqual([])
    const far = { ...next, turnNo: next.turnNo + 10 }
    expect(soundsFor(s, far, 'red')).toEqual([])
    // 同一局面重新渲染
    expect(soundsFor(next, { ...next }, 'red')).toEqual([])
  })
})
