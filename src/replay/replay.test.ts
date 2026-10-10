import { describe, expect, it } from 'vitest'
import { chooseAction } from '../ai/bot'
import { applyAction, createGame, RULES_VERSION, type Action, type Side } from '../engine'
import { decodeActions, encodeActions, makeReplay, parseReplay, replayToCode, replayToFile } from './replay'

/** 用简单 AI 下一局（含刷新、额外行动、认输等各种操作） */
function playGame(seed: string, maxSteps = 300): Action[] {
  let s = createGame(seed)
  const actions: Action[] = []
  let n = 0
  const rng = () => ((n++ * 0.6180339) % 1)
  while (s.phase !== 'over' && actions.length < maxSteps) {
    let a: Action
    if (s.phase === 'draft') {
      const side: Side = s.draft!.sides.red.done ? 'black' : 'red'
      a = s.rerollsLeft[side] > 0 && rng() < 0.3 ? { type: 'reroll', side } : chooseAction(s, side, { pick: 'random', rng })!
    } else if (s.extraMoves.length && rng() < 0.3) {
      a = { type: 'skip', side: s.turn }
    } else {
      a = chooseAction(s, s.turn, { depth: 1, rng, noise: 2 })!
    }
    actions.push(a)
    s = applyAction(s, a)
  }
  if (s.phase !== 'over') {
    const a: Action = { type: 'resign', side: s.turn }
    actions.push(a)
  }
  return actions
}

describe('回放', () => {
  it('编码后解码得到完全相同的操作和局面', () => {
    for (let g = 0; g < 8; g++) {
      const seed = `replay-${g}`
      const actions = playGame(seed)
      const encoded = encodeActions(seed, actions)
      const { actions: back, states } = decodeActions(seed, encoded)
      expect(back).toEqual(actions)
      let s = createGame(seed)
      for (const a of actions) s = applyAction(s, a)
      expect(states.at(-1)).toEqual(s)
    }
  })

  it('链接和文件都能还原，且足够短', () => {
    const seed = 'share'
    const replay = makeReplay(seed, playGame(seed), { mode: 'ai', red: '玩家', black: 'AI·困难' })
    const code = replayToCode(replay)
    expect(code.length).toBeLessThan(2000)
    for (const input of [code, `https://example.com/x/#replay=${code}`, replayToFile(replay)]) {
      const loaded = parseReplay(input)
      expect(loaded.actions).toEqual(replay.actions)
      expect(loaded.meta).toEqual(replay.meta)
      expect(loaded.outdated).toBe(false)
    }
  })

  it('无效输入给出友好的错误', () => {
    expect(() => parseReplay('not a replay!!')).toThrow()
    expect(() => parseReplay('{"format":"other"}')).toThrow('这不是象棋大乱斗的回放文件')
  })

  it('旧规则版本的回放会被标记', () => {
    const replay = makeReplay('old', [], { mode: 'hotseat' })
    replay.rules = RULES_VERSION - 1
    expect(parseReplay(replayToCode(replay)).outdated).toBe(true)
  })
})
