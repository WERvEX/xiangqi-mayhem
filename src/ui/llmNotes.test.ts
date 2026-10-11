import { describe, expect, it } from 'vitest'
import { createGame, type Action } from '../engine'
import { validNotes, type LiveNote } from './llmNotes'

describe('大模型发言记录', () => {
  const state = createGame('notes-test')
  const redPick: Action = { type: 'pick', side: 'red', augmentId: 'a' }
  const blackPick: Action = { type: 'pick', side: 'black', augmentId: 'b' }

  it('同时选锦囊、后选完的一方步数记错时，按实际位置修正而不是丢掉', () => {
    // 黑方开始思考时是第 0 步，红方先选完，黑方的选择实际落在第 1 步
    const notes: LiveNote[] = [
      { i: 0, side: 'red', action: redPick, speech: '红' },
      { i: 0, side: 'black', action: blackPick, speech: '黑' },
    ]
    const valid = validNotes(notes, [redPick, blackPick], state, {})
    expect(valid.map((n) => [n.side, n.i])).toEqual([
      ['red', 0],
      ['black', 1],
    ])
  })

  it('悔棋撤回的操作，记录随之失效', () => {
    const notes: LiveNote[] = [
      { i: 0, side: 'red', action: redPick, speech: '红' },
      { i: 1, side: 'black', action: blackPick, speech: '黑' },
    ]
    expect(validNotes(notes, [redPick], state, {}).map((n) => n.side)).toEqual(['red'])
  })
})
