import { describe, expect, it } from 'vitest'
import {
  AUGMENT_LIST,
  applyAction,
  canAttackKing,
  createGame,
  exposesKing,
  generateMoves,
  getMods,
  legalMoves,
  type Action,
  type GameState,
  type Piece,
  type PieceType,
  type Side,
} from './index'

/** 跳过开局锦囊，直接进入走棋 */
function freshGame(seed = 'test'): GameState {
  let s = createGame(seed)
  for (const side of ['red', 'black'] as Side[]) {
    s = applyAction(s, { type: 'pick', side, augmentId: s.draft!.sides[side].options[0] })
  }
  s.augments = { red: [], black: [] }
  for (const p of s.pieces) p.shield = 0
  return s
}

type Spec = [Side, PieceType, number, number]

/** 自定义局面；未给出将帅时自动放在默认位置 */
function position(specs: Spec[], augments: Partial<Record<Side, string[]>> = {}): GameState {
  const s = freshGame()
  const all = [...specs]
  if (!all.some(([side, t]) => side === 'red' && t === 'K')) all.push(['red', 'K', 4, 9])
  if (!all.some(([side, t]) => side === 'black' && t === 'K')) all.push(['black', 'K', 3, 0])
  s.pieces = all.map(
    ([side, type, x, y], i): Piece => ({
      id: `${side[0]}${type}${i}`,
      type,
      side,
      x,
      y,
      alive: true,
      home: { x, y },
      shield: 0,
    }),
  )
  s.augments = {
    red: (augments.red ?? []).map((id) => ({ id, data: {} })),
    black: (augments.black ?? []).map((id) => ({ id, data: {} })),
  }
  s.positionCounts = {}
  return s
}

const targets = (s: GameState, x: number, y: number, side: Side = s.turn) => {
  const p = s.pieces.find((q) => q.alive && q.x === x && q.y === y)!
  return generateMoves(s, side, getMods(s, side))
    .filter((m) => m.pieceId === p.id)
    .map((m) => `${m.to.x},${m.to.y}`)
    .sort()
}

const move = (s: GameState, from: [number, number], to: [number, number]): GameState => {
  const p = s.pieces.find((q) => q.alive && q.x === from[0] && q.y === from[1])!
  return applyAction(s, { type: 'move', side: s.turn, pieceId: p.id, to: { x: to[0], y: to[1] } })
}

describe('标准规则', () => {
  it('开局红方有 44 种走法', () => {
    expect(legalMoves(freshGame())).toHaveLength(44)
  })

  it('马会被蹩腿', () => {
    const s = position([
      ['red', 'N', 4, 5],
      ['red', 'P', 4, 4],
    ])
    expect(targets(s, 4, 5)).toEqual(['2,4', '2,6', '3,7', '5,7', '6,4', '6,6'])
  })

  it('象不能过河、会被塞象眼', () => {
    const s = position([
      ['red', 'B', 2, 5],
      ['black', 'P', 3, 6],
    ])
    expect(targets(s, 2, 5)).toEqual(['0,7'])
  })

  it('炮需要隔一子吃子', () => {
    const s = position([
      ['red', 'C', 1, 7],
      ['red', 'P', 1, 5],
      ['black', 'N', 1, 2],
      ['black', 'R', 1, 0],
    ])
    const t = targets(s, 1, 7)
    expect(t).toContain('1,6')
    expect(t).toContain('1,2')
    expect(t).not.toContain('1,0')
    expect(t).not.toContain('1,4')
  })

  it('兵过河前只能前进，过河后可以横走', () => {
    expect(targets(position([['red', 'P', 2, 6]]), 2, 6)).toEqual(['2,5'])
    expect(targets(position([['red', 'P', 2, 4]]), 2, 4)).toEqual(['1,4', '2,3', '3,4'])
  })

  it('士和将不能离开九宫', () => {
    const s = position([['red', 'A', 3, 7]])
    expect(targets(s, 3, 7)).toEqual(['4,8'])
  })

  it('将帅照面时可以飞将', () => {
    const s = position([['black', 'K', 4, 0]])
    expect(targets(s, 4, 9)).toContain('4,0')
    const next = move(s, [4, 9], [4, 0])
    expect(next.phase).toBe('over')
    expect(next.winner).toBe('red')
  })

  it('吃掉将帅获胜', () => {
    const s = position([['red', 'R', 3, 5]])
    const next = move(s, [3, 5], [3, 0])
    expect(next.winner).toBe('red')
  })

  it('三次重复局面判和', () => {
    let s = position([
      ['red', 'R', 0, 9],
      ['black', 'R', 8, 0],
    ])
    const cycle: [[number, number], [number, number]][] = [
      [[0, 9], [0, 8]],
      [[8, 0], [8, 1]],
      [[0, 8], [0, 9]],
      [[8, 1], [8, 0]],
    ]
    let n = 0
    while (s.phase !== 'over' && n < 20) s = move(s, ...cycle[n++ % 4])
    expect(n).toBe(9) // 测试局面未计入初始局面，第 9 步时某局面第三次出现
    expect(s.winner).toBeNull()
  })

  it('送将检测', () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['red', 'R', 4, 5],
      ['black', 'K', 4, 0],
      ['black', 'R', 4, 2],
    ])
    const leave = legalMoves(s).find((m) => m.from.x === 4 && m.from.y === 5 && m.to.x === 3)!
    expect(exposesKing(s, leave)).toBe(true)
    expect(canAttackKing(s, 'black')).toBe(false)
  })
})

describe('锦囊', () => {
  it('天马行空：马不被蹩腿', () => {
    const s = position(
      [
        ['red', 'N', 4, 5],
        ['red', 'P', 4, 4],
      ],
      { red: ['tianma'] },
    )
    expect(targets(s, 4, 5)).toHaveLength(8)
  })

  it('飞象过河', () => {
    const s = position([['red', 'B', 2, 5]], { red: ['feixiang'] })
    expect(targets(s, 2, 5)).toContain('0,3')
  })

  it('先锋营 / 回头是岸', () => {
    expect(targets(position([['red', 'P', 2, 6]], { red: ['xianfeng'] }), 2, 6)).toEqual(['1,6', '2,5', '3,6'])
    expect(targets(position([['red', 'P', 2, 4]], { red: ['huitou'] }), 2, 4)).toContain('2,5')
  })

  it('士出九宫 / 御驾亲征', () => {
    expect(targets(position([['red', 'A', 3, 7]], { red: ['chugong'] }), 3, 7)).toContain('2,6')
    expect(targets(position([['red', 'K', 3, 7]], { red: ['yujia'] }), 3, 7)).toContain('2,7')
  })

  it('连珠炮：隔两子吃', () => {
    const s = position(
      [
        ['red', 'C', 1, 7],
        ['red', 'P', 1, 5],
        ['black', 'N', 1, 2],
        ['black', 'R', 1, 0],
      ],
      { red: ['lianzhu'] },
    )
    expect(targets(s, 1, 7)).toContain('1,0')
  })

  it('纵横天下：车可斜走', () => {
    const s = position([['red', 'R', 0, 9]], { red: ['zongheng'] })
    expect(targets(s, 0, 9)).toContain('5,4')
  })

  it('护盾挡下吃子，攻击者原地不动', () => {
    let s = position([
      ['red', 'R', 0, 9],
      ['black', 'N', 0, 3],
    ])
    s.pieces.find((p) => p.type === 'N')!.shield = 1
    s = move(s, [0, 9], [0, 3])
    const rook = s.pieces.find((p) => p.type === 'R')!
    const horse = s.pieces.find((p) => p.type === 'N')!
    expect([rook.x, rook.y]).toEqual([0, 9])
    expect(horse.alive).toBe(true)
    expect(horse.shield).toBe(0)
    expect(s.turn).toBe('black')
  })

  it('金钟罩：将帅挡下一次攻击', () => {
    let s = createGame('jz')
    s = applyAction(s, { type: 'pick', side: 'black', augmentId: s.draft!.sides.black.options[0] })
    s.draft!.sides.red.options = ['jinzhong']
    s = applyAction(s, { type: 'pick', side: 'red', augmentId: 'jinzhong' })
    expect(s.pieces.find((p) => p.side === 'red' && p.type === 'K')!.shield).toBe(1)
  })

  it('回马枪：吃子后同一匹马可以再走一步', () => {
    let s = position(
      [
        ['red', 'N', 2, 5],
        ['black', 'P', 3, 3],
      ],
      { red: ['huima'] },
    )
    s = move(s, [2, 5], [3, 3])
    expect(s.turn).toBe('red')
    expect(legalMoves(s).every((m) => m.from.x === 3 && m.from.y === 3 && !m.captureId)).toBe(true)
    s = applyAction(s, { type: 'skip', side: 'red' })
    expect(s.turn).toBe('black')
  })

  it('兵贵神速：每 3 回合额外一步', () => {
    let s = position(
      [
        ['red', 'R', 0, 9],
        ['black', 'R', 8, 0],
      ],
      { red: ['shensu'] },
    )
    const steps: [number, number][] = [
      [0, 8],
      [0, 7],
      [0, 6],
    ]
    let from: [number, number] = [0, 9]
    let bFrom: [number, number] = [8, 0]
    for (const to of steps) {
      s = move(s, from, to)
      from = to
      if (s.turn === 'black') {
        const bTo: [number, number] = [8, bFrom[1] + 1]
        s = move(s, bFrom, bTo)
        bFrom = bTo
      }
    }
    expect(s.turn).toBe('red')
    expect(s.extraMoves).toHaveLength(1)
  })

  it('黄袍加身：兵到底线变车', () => {
    let s = position([['red', 'P', 0, 1]], { red: ['huangpao'] })
    s = move(s, [0, 1], [0, 0])
    const p = s.pieces.find((q) => q.side === 'red' && q.promoted)!
    expect(p.type).toBe('R')
  })

  it('借尸还魂：被吃的子在开局位置复活', () => {
    let s = position(
      [
        ['red', 'R', 0, 3],
        ['black', 'N', 0, 0],
      ],
      { black: ['jieshi'] },
    )
    const horse = s.pieces.find((p) => p.type === 'N')!
    horse.home = { x: 1, y: 0 }
    s = move(s, [0, 3], [0, 0])
    const revived = s.pieces.find((p) => p.type === 'N')!
    expect(revived.alive).toBe(true)
    expect([revived.x, revived.y]).toEqual([1, 0])
  })
})

describe('锦囊发放', () => {
  it('开局双方各有 3 个不重复选项', () => {
    const s = createGame('draft')
    expect(s.phase).toBe('draft')
    for (const side of ['red', 'black'] as Side[]) {
      const opts = s.draft!.sides[side].options
      expect(new Set(opts).size).toBe(3)
    }
  })

  it('同一种子结果完全一致，与操作顺序无关', () => {
    const a0 = createGame('same')
    const b0 = createGame('same')
    expect(a0.draft).toEqual(b0.draft)
    const a = applyAction(applyAction(a0, { type: 'reroll', side: 'red' }), { type: 'reroll', side: 'black' })
    const b = applyAction(applyAction(b0, { type: 'reroll', side: 'black' }), { type: 'reroll', side: 'red' })
    expect(a.draft).toEqual(b.draft)
  })

  it('刷新会换掉选项，且次数有限', () => {
    const s = createGame('reroll')
    const before = s.draft!.sides.red.options
    const after = applyAction(s, { type: 'reroll', side: 'red' })
    expect(after.draft!.sides.red.options).not.toEqual(before)
    expect(() => applyAction(after, { type: 'reroll', side: 'red' })).toThrow()
  })

  it('第 10 回合再次发放', () => {
    let s = position([
      ['red', 'R', 0, 9],
      ['black', 'R', 8, 0],
    ])
    s.turnNo = 17
    s.turn = 'black'
    s = move(s, [8, 0], [8, 1])
    expect(s.phase).toBe('draft')
    expect(s.draft!.round).toBe(10)
  })
})

describe('随机对局压力测试', () => {
  it('随机锦囊 + 随机走子 200 局不出错、状态始终合法', () => {
    for (let g = 0; g < 200; g++) {
      let s = createGame(`fuzz${g}`)
      let rng = g * 7919 + 1
      const rand = (n: number) => {
        rng = (rng * 48271) % 2147483647
        return rng % n
      }
      for (let step = 0; step < 400 && s.phase !== 'over'; step++) {
        let action: Action
        if (s.phase === 'draft') {
          const side: Side = s.draft!.sides.red.done ? 'black' : 'red'
          const opts = s.draft!.sides[side].options
          action =
            rand(5) === 0 && s.rerollsLeft[side] > 0
              ? { type: 'reroll', side }
              : { type: 'pick', side, augmentId: opts[rand(opts.length)] }
        } else {
          const moves = legalMoves(s)
          if (s.extraMoves.length && rand(4) === 0) action = { type: 'skip', side: s.turn }
          else {
            // 偏向吃子，让对局更快推进
            const caps = moves.filter((m) => m.captureId)
            const pool = caps.length && rand(2) === 0 ? caps : moves
            const m = pool[rand(pool.length)]
            action = { type: 'move', side: s.turn, pieceId: m.pieceId, to: m.to }
          }
        }
        s = applyAction(s, action)
        const alive = s.pieces.filter((p) => p.alive)
        const squares = new Set(alive.map((p) => `${p.x},${p.y}`))
        expect(squares.size).toBe(alive.length)
        for (const p of alive) {
          expect(p.x >= 0 && p.x < 9 && p.y >= 0 && p.y < 10).toBe(true)
        }
      }
    }
  })

  it('锦囊 id 唯一', () => {
    expect(new Set(AUGMENT_LIST.map((a) => a.id)).size).toBe(AUGMENT_LIST.length)
  })
})
