/**
 * 找宣传视频要用的镜头：规则 AI 自我对弈，到发放锦囊时强制让红方拿到目标锦囊，
 * 然后每一步都枚举合法走法，找出能触发目标效果的那一步（关键一步）。
 * 输出关键一步之前的"种子 + 操作序列"，录制时作为同屏对战存档载入，再由脚本点击走出关键一步。
 *
 *   npm run find -- huoshao zongheng     # 只找指定镜头
 *
 * 单线程、低优先级运行。
 */
import { constants, setPriority } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'
import { chooseAction } from '../../src/ai/bot'
import {
  applyAction,
  legalMoves,
  createGame,
  getPiece,
  pieceAt,
  roundOf,
  type Action,
  type GameState,
  type Move,
  type Side,
} from '../../src/engine'

setPriority(constants.priority.PRIORITY_LOW)

interface Hit {
  move: Move
  score: number
  note: string
}

interface Spec {
  /** 红方要拿到的锦囊 */
  augment: string
  /** 关键一步由哪方走 */
  mover: Side
  /** 关键一步至少在第几回合之后（让局面先展开一些） */
  minRound?: number
  /** 判断某一步是否是想要的镜头，返回 null 表示不是；score 越高越好 */
  test: (before: GameState, move: Move, after: GameState) => Hit | null
  /** 同一个镜头收集几个候选 */
  want?: number
}

const newLogs = (before: GameState, after: GameState) => after.log.slice(before.log.length)
const isCapture = (m: Move) => !!m.captureId

const SPECS: Record<string, Spec> = {
  // 天马行空：马腿被堵着照样跳过去
  tianma: {
    augment: 'tianma',
    mover: 'red',
    minRound: 3,
    test: (s, m) => {
      const p = getPiece(s, m.pieceId)
      if (p.type !== 'N' || p.side !== 'red') return null
      const dx = m.to.x - m.from.x
      const dy = m.to.y - m.from.y
      const leg = Math.abs(dx) === 2 ? { x: m.from.x + Math.sign(dx), y: m.from.y } : { x: m.from.x, y: m.from.y + Math.sign(dy) }
      if (Math.abs(dx) + Math.abs(dy) !== 3 || !pieceAt(s, leg.x, leg.y)) return null
      return { move: m, score: isCapture(m) ? 2 : 1, note: `马腿被 ${pieceAt(s, leg.x, leg.y)!.type} 堵住` }
    },
  },
  // 纵横天下：车斜着走吃子
  zongheng: {
    augment: 'zongheng',
    mover: 'red',
    test: (s, m) => {
      const p = getPiece(s, m.pieceId)
      if (p.type !== 'R' || p.side !== 'red' || m.from.x === m.to.x || m.from.y === m.to.y) return null
      if (!isCapture(m)) return null
      const victim = getPiece(s, m.captureId!)
      const value: Record<string, number> = { K: 10, R: 5, N: 4, C: 4, A: 2, B: 2, P: 1 }
      return { move: m, score: value[victim.type], note: `斜走吃${victim.type}` }
    },
  },
  // 火烧连营：炮吃子后一次烧掉多个
  huoshao: {
    augment: 'huoshao',
    mover: 'red',
    test: (s, m, after) => {
      const burned = newLogs(s, after).filter((l) => l.fx?.kind === 'burn').length
      return burned >= 2 ? { move: m, score: burned, note: `烧掉 ${burned} 个` } : null
    },
  },
  // 借尸还魂：黑方吃掉红方的车马炮，立刻复活
  jieshi: {
    augment: 'jieshi',
    mover: 'black',
    test: (s, m, after) => {
      const revived = newLogs(s, after).some((l) => l.fx?.kind === 'revive')
      if (!revived) return null
      return { move: m, score: getPiece(s, m.captureId!).type === 'R' ? 2 : 1, note: '复活' }
    },
  },
  // 护盾挡下吃子：红方的车有铁甲战车护盾，黑方去吃被挡下
  shield: {
    augment: 'tiejia',
    mover: 'black',
    test: (s, m, after) => {
      const blocked = newLogs(s, after).some((l) => l.text.includes('被护盾挡下'))
      return blocked ? { move: m, score: 1, note: '护盾挡下' } : null
    },
  },
  // 吃将获胜（局面里黑将暴露，界面会画红圈）
  kingcap: {
    augment: 'zongheng',
    mover: 'red',
    minRound: 8,
    test: (s, m, after) => {
      if (after.phase !== 'over' || after.winner !== 'red' || !isCapture(m)) return null
      return getPiece(s, m.captureId!).type === 'K' ? { move: m, score: s.pieces.filter((p) => p.alive).length, note: '吃将' } : null
    },
  },
}

function makeRng(seed: string) {
  let x = [...seed].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

interface Found {
  scene: string
  seed: string
  actions: Action[]
  key: Action
  round: number
  score: number
  note: string
  augments: Record<Side, string[]>
}

function tryGame(name: string, spec: Spec, seed: string): Found | null {
  const rng = makeRng(seed)
  let s = createGame(seed)
  const actions: Action[] = []
  const act = (a: Action) => {
    s = applyAction(s, a)
    actions.push(a)
  }
  for (let step = 0; step < 400 && s.phase !== 'over'; step++) {
    if (s.phase === 'draft') {
      const red = s.draft!.sides.red
      if (!red.done) {
        if (red.options.includes(spec.augment)) act({ type: 'pick', side: 'red', augmentId: spec.augment })
        else if (s.rerollsLeft.red > 0 && !s.augments.red.some((a) => a.id === spec.augment) && red.tier !== 'silver') act({ type: 'reroll', side: 'red' })
        else act(chooseAction(s, 'red', { depth: 1, rng, pick: 'random' })!)
        continue
      }
      act(chooseAction(s, 'black', { depth: 1, rng, pick: 'random' })!)
      continue
    }
    const has = s.augments.red.some((a) => a.id === spec.augment)
    if (has && s.turn === spec.mover && roundOf(s) >= (spec.minRound ?? 1)) {
      let best: Hit | null = null
      for (const m of legalMoves(s)) {
        let after: GameState
        try {
          after = applyAction(s, { type: 'move', side: s.turn, pieceId: m.pieceId, to: m.to })
        } catch {
          continue
        }
        const hit = spec.test(s, m, after)
        if (hit && (!best || hit.score > best.score)) best = hit
      }
      if (best) {
        return {
          scene: name,
          seed,
          actions: [...actions],
          key: { type: 'move', side: s.turn, pieceId: best.move.pieceId, to: best.move.to },
          round: roundOf(s),
          score: best.score,
          note: best.note,
          augments: { red: s.augments.red.map((a) => a.id), black: s.augments.black.map((a) => a.id) },
        }
      }
    }
    if (roundOf(s) > 40) return null
    act(chooseAction(s, s.turn, { depth: 2, rng })!)
  }
  return null
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPECS)
mkdirSync(new URL('../scenes/found/', import.meta.url), { recursive: true })
for (const name of names) {
  const spec = SPECS[name]
  if (!spec) throw new Error(`未知镜头 ${name}`)
  const results: Found[] = []
  const t0 = Date.now()
  for (let i = 0; i < 400 && results.length < (spec.want ?? 4); i++) {
    const f = tryGame(name, spec, `promo-${name}-${i}`)
    if (f) {
      results.push(f)
      console.log(`  ${name} #${results.length}: ${f.seed} 第 ${f.round} 回合，${f.note}（分数 ${f.score}，${f.actions.length} 步）`)
    }
  }
  results.sort((a, b) => b.score - a.score || a.round - b.round)
  writeFileSync(new URL(`../scenes/found/${name}.json`, import.meta.url), JSON.stringify(results, null, 1))
  console.log(`${name}: ${results.length} 个候选，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}
