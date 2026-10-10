import { describe, expect, it } from 'vitest'
import {
  applyAction,
  canAttackKing,
  createGame,
  legalMoves,
  type Action,
  type GameState,
  type Piece,
  type PieceType,
  type Side,
} from '../engine'
import { chooseAction, DIFFICULTIES, evaluateV2, type Difficulty } from './bot'

type Spec = [Side, PieceType, number, number]

/** 自定义局面（跳过锦囊发放），未给出将帅时放在默认位置 */
function position(specs: Spec[], turn: Side = 'red'): GameState {
  const s = createGame('bot-test')
  s.phase = 'play'
  s.draft = null
  s.draftsDone = 99
  s.turn = turn
  const all = [...specs]
  if (!all.some(([side, t]) => side === 'red' && t === 'K')) all.push(['red', 'K', 4, 9])
  if (!all.some(([side, t]) => side === 'black' && t === 'K')) all.push(['black', 'K', 3, 0])
  s.pieces = all.map(
    ([side, type, x, y], i): Piece => ({ id: `${side[0]}${type}${i}`, type, side, x, y, alive: true, home: { x, y }, shield: 0 }),
  )
  return s
}

const isLegal = (s: GameState, a: Action) =>
  a.type === 'move' && legalMoves(s).some((m) => m.pieceId === a.pieceId && m.to.x === a.to.x && m.to.y === a.to.y)

describe('规则 AI', () => {
  it('能吃将时直接吃将', () => {
    const s = position([['red', 'R', 3, 5]])
    for (const difficulty of Object.keys(DIFFICULTIES) as Difficulty[]) {
      const a = chooseAction(s, 'red', { difficulty, rng: () => 0.99 })!
      expect(a).toMatchObject({ type: 'move', to: { x: 3, y: 0 } })
    }
  })

  it('困难及以上不吃有保护的"毒卒"', () => {
    // 红车吃 (0,3) 的卒后会被黑车吃回
    const s = position([
      ['red', 'R', 0, 9],
      ['red', 'P', 8, 6],
      ['black', 'P', 0, 3],
      ['black', 'R', 0, 0],
    ])
    for (const difficulty of ['hard', 'master'] as Difficulty[]) {
      const a = chooseAction(s, 'red', { difficulty, rng: () => 0.5 })!
      expect(isLegal(s, a)).toBe(true)
      expect(a).not.toMatchObject({ to: { x: 0, y: 3 } })
    }
  })

  it('将帅被攻击时会解围', () => {
    // 黑车沿 4 路直指红帅
    const s = position([
      ['red', 'R', 0, 5],
      ['red', 'P', 8, 6],
      ['black', 'R', 4, 2],
    ])
    expect(canAttackKing(s, 'black')).toBe(true)
    for (const difficulty of Object.keys(DIFFICULTIES) as Difficulty[]) {
      const a = chooseAction(s, 'red', { difficulty, rng: () => 0.3 })!
      expect(canAttackKing(applyAction(s, a), 'black')).toBe(false)
    }
  })

  it('各难度在随机中局里都给出合法走法，且不超时太多', () => {
    let s = createGame('midgame')
    let step = 0
    while (s.phase !== 'play' || step < 20) {
      const side: Side = s.phase === 'draft' ? (s.draft!.sides.red.done ? 'black' : 'red') : s.turn
      s = applyAction(s, chooseAction(s, side, { depth: 1, pick: 'random', rng: () => (step * 0.37) % 1 })!)
      step++
      if (s.phase === 'over') s = createGame(`midgame${step}`)
    }
    for (const difficulty of Object.keys(DIFFICULTIES) as Difficulty[]) {
      const t0 = performance.now()
      const a = chooseAction(s, s.turn, { difficulty })!
      const elapsed = performance.now() - t0
      expect(isLegal(s, a)).toBe(true)
      expect(elapsed).toBeLessThan(DIFFICULTIES[difficulty].timeMs + 1500)
    }
  })

  it('选锦囊：从选项中选，激进型偏好进攻锦囊', () => {
    const s = createGame('pick')
    s.draft!.sides.red.options = ['tiejia', 'shensu', 'feixiang']
    const solid = chooseAction(s, 'red', { difficulty: 'normal', personality: 'solid' })!
    const aggressive = chooseAction(s, 'red', { difficulty: 'normal', personality: 'aggressive' })!
    expect(solid).toEqual({ type: 'pick', side: 'red', augmentId: 'tiejia' })
    expect(aggressive).toEqual({ type: 'pick', side: 'red', augmentId: 'shensu' })
  })

  it('不是自己行动时返回 null', () => {
    const s = position([['red', 'R', 0, 9]], 'black')
    expect(chooseAction(s, 'red', { difficulty: 'normal' })).toBeNull()
  })

  describe('第二版评估', () => {
    it('出动的车比困在底线的车分高', () => {
      const home = position([['red', 'R', 0, 9]])
      const out = position([['red', 'R', 0, 5]])
      expect(evaluateV2(out, 'red')).toBeGreaterThan(evaluateV2(home, 'red'))
    })

    it('开局出子评分：车马在原位时开局扣分，中局后不扣', () => {
      const early = position([['red', 'R', 0, 9]])
      const late = position([['red', 'R', 0, 9]])
      late.turnNo = 40 // 第 21 回合
      const dev = (s: typeof early) => evaluateV2(s, 'red', undefined, true, true) - evaluateV2(s, 'red')
      expect(dev(early)).toBeLessThan(-0.3)
      expect(dev(late)).toBe(0)
    })

    it('被攻击又没保护的子扣分，有保护时扣得少', () => {
      // 黑车攻击 (4,5) 的红马；第二个局面里红炮在 (4,7) 隔着兵保护它
      const loose = position([
        ['red', 'N', 4, 5],
        ['black', 'R', 4, 2],
        ['red', 'P', 0, 6],
      ], 'black')
      const guarded = position([
        ['red', 'N', 4, 5],
        ['black', 'R', 4, 2],
        ['red', 'R', 0, 5],
      ], 'black')
      // 去掉保护者自身的价值差异：比较"马被扣的分"
      const lossLoose = evaluateV2(position([['red', 'N', 4, 5], ['red', 'P', 0, 6]], 'black'), 'red') - evaluateV2(loose, 'red')
      const lossGuarded = evaluateV2(position([['red', 'N', 4, 5], ['red', 'R', 0, 5]], 'black'), 'red') - evaluateV2(guarded, 'red')
      expect(lossLoose).toBeGreaterThan(lossGuarded)
    })
  })
})

