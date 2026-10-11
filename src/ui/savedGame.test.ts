import { describe, expect, it } from 'vitest'
import { applyAction, createGame, legalMoves, type Action, type GameState } from '../engine'
import { replayStates } from './savedGame'

describe('存档恢复', () => {
  it('按操作序列重放出同样的局面', () => {
    let s: GameState = createGame('save-test')
    const actions: Action[] = []
    for (let i = 0; i < 12 && s.phase !== 'over'; i++) {
      let a: Action
      if (s.phase === 'draft') {
        const side = s.draft!.sides.red.done ? 'black' : 'red'
        a = { type: 'pick', side, augmentId: s.draft!.sides[side].options[0] }
      } else {
        const m = legalMoves(s)[i % 5]
        a = { type: 'move', side: s.turn, pieceId: m.pieceId, to: m.to }
      }
      actions.push(a)
      s = applyAction(s, a)
    }
    // 存档经过 JSON，操作是新的对象
    const states = replayStates('save-test', JSON.parse(JSON.stringify(actions)))!
    expect(states).toHaveLength(actions.length + 1)
    expect(states[states.length - 1].pieces).toEqual(s.pieces)
  })

  it('存档损坏时返回 null', () => {
    expect(replayStates('save-test', [{ type: 'move', side: 'red', pieceId: 'nope', to: { x: 0, y: 0 } }])).toBeNull()
  })
})
