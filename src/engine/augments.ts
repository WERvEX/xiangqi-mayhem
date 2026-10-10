import { addLog, crossedRiver, enemyBaseline, other, pieceAt, pieceName, SIDE_NAMES } from './board'
import { rngFor } from './rng'
import type { GameState, Move, Piece, Pos, RuleMods, Side, Tier } from './types'

export interface MoveEvent {
  move: Move
  /** 走子的棋子（已在新位置） */
  piece: Piece
  captured: Piece | null
  /** 攻击被护盾或锦囊挡下，棋子没有移动 */
  blocked: boolean
  /** 这一步本身是额外行动 */
  isExtra: boolean
}

type Data = Record<string, number>

export interface AugmentDef {
  id: string
  name: string
  tier: Tier
  /** 图标用的单字 */
  glyph: string
  desc: string
  mods?: RuleMods
  /** 选中时立即生效 */
  onPick?(s: GameState, side: Side, data: Data): void
  /** 拥有者每走一步之后 */
  onAfterMove?(s: GameState, side: Side, ev: MoveEvent, data: Data): void
  /** 拥有者的棋子被吃掉时 */
  onOwnCaptured?(s: GameState, side: Side, piece: Piece, data: Data): void
  /** 拥有者的棋子将被吃时，返回 true 表示这次吃子会被挡下（不能修改状态） */
  protects?(s: GameState, side: Side, target: Piece, data: Data): boolean
  /** protects 返回 true 后实际挡下时调用 */
  onProtect?(s: GameState, side: Side, target: Piece, data: Data): void
  /** 界面上显示的状态，例如计数器；也参与重复局面判定 */
  status?(data: Data): string | null
}

const at = (p: { x: number; y: number }): Pos => ({ x: p.x, y: p.y })

const addShield = (s: GameState, side: Side, filter: (p: Piece) => boolean) => {
  for (const p of s.pieces) if (p.alive && p.side === side && filter(p)) p.shield++
}

const promote = (s: GameState, p: Piece) => {
  p.type = 'R'
  p.promoted = true
  addLog(s, `黄袍加身！${SIDE_NAMES[p.side]}的兵卒变为${pieceName(p)}`, p.side, {
    kind: 'promote',
    pos: at(p),
  })
}

/** 离 targets 最近的空位，可限定只在己方半场 */
function nearestEmpty(s: GameState, targets: Pos[], filter: (x: number, y: number) => boolean): Pos | null {
  let best: Pos | null = null
  let bestDist = Infinity
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) {
      if (!filter(x, y) || pieceAt(s, x, y)) continue
      const d = Math.min(...targets.map((t) => Math.abs(x - t.x) * 1.01 + Math.abs(y - t.y)))
      if (d < bestDist) {
        bestDist = d
        best = { x, y }
      }
    }
  }
  return best
}

function findReviveSpot(s: GameState, p: Piece): Pos | null {
  const candidates = [p.home, { x: 8 - p.home.x, y: p.home.y }]
  for (const c of candidates) if (!pieceAt(s, c.x, c.y)) return c
  // 士象只能回到标准位置，其余棋子可在己方半场找最近空位
  if (p.type === 'A' || p.type === 'B') return null
  return nearestEmpty(s, [p.home], (_, y) => !crossedRiver(p.side, y))
}

const neighbors8 = (s: GameState, p: Piece) =>
  s.pieces.filter((q) => q.alive && q !== p && Math.abs(q.x - p.x) <= 1 && Math.abs(q.y - p.y) <= 1)

export const AUGMENT_LIST: AugmentDef[] = [
  // ───── 白银 ─────
  {
    id: 'tianma',
    name: '天马行空',
    tier: 'silver',
    glyph: '驰',
    desc: '你的马不会被蹩马腿，你现有的马各获得 1 层护盾。',
    mods: { horseNoLeg: true },
    onPick: (s, side) => addShield(s, side, (p) => p.type === 'N'),
  },
  {
    id: 'feixiang',
    name: '飞象过河',
    tier: 'silver',
    glyph: '飞',
    desc: '你的象可以过河，并且不会被塞象眼。',
    mods: { elephantCrossRiver: true, elephantNoEye: true },
  },
  {
    id: 'changtong',
    name: '畅通无阻',
    tier: 'gold',
    glyph: '畅',
    desc: '你的车可以穿过己方棋子继续直行。',
    mods: { rookPassFriendly: true },
  },
  {
    id: 'xianfeng',
    name: '先锋营',
    tier: 'silver',
    glyph: '锋',
    desc: '你的兵在过河前也可以横着走。',
    mods: { pawnSidewaysEarly: true },
  },
  {
    id: 'huitou',
    name: '回头是岸',
    tier: 'silver',
    glyph: '回',
    desc: '你的兵卒可以后退一格；过河后还可以斜着前进一格。',
    mods: { pawnRetreat: true, pawnDiagonalForward: true },
  },
  {
    id: 'chugong',
    name: '士出九宫',
    tier: 'silver',
    glyph: '出',
    desc: '你的士可以离开九宫，在己方半场斜走。',
    mods: { advisorLeavePalace: true },
  },
  {
    id: 'xiexing',
    name: '暗度陈仓',
    tier: 'silver',
    glyph: '暗',
    desc: '你的将帅可以斜走一格（仍不能离开九宫）。',
    mods: { kingDiagonal: true },
  },
  {
    id: 'tiejia',
    name: '铁甲战车',
    tier: 'gold',
    glyph: '甲',
    desc: '你最靠前的一个车获得 2 层护盾。护盾会挡下一次吃子，攻击者原地不动。',
    onPick: (s, side) => {
      const rooks = s.pieces.filter((p) => p.alive && p.side === side && p.type === 'R')
      rooks.sort((a, b) => Math.abs(a.y - enemyBaseline(side)) - Math.abs(b.y - enemyBaseline(side)))
      if (rooks[0]) rooks[0].shield += 2
    },
  },
  {
    id: 'zhongzhi',
    name: '众志成城',
    tier: 'silver',
    glyph: '众',
    desc: '你现有的兵卒各获得 2 层护盾。',
    onPick: (s, side) => {
      addShield(s, side, (p) => p.type === 'P')
      addShield(s, side, (p) => p.type === 'P')
    },
  },
  {
    id: 'yulin',
    name: '御林军',
    tier: 'silver',
    glyph: '林',
    desc: '你现有的士和象各获得 1 层护盾；之后你每损失一个士或象，你的将帅获得 1 层护盾。',
    onPick: (s, side) => addShield(s, side, (p) => p.type === 'A' || p.type === 'B'),
    onOwnCaptured: (s, side, piece) => {
      if (piece.type !== 'A' && piece.type !== 'B') return
      const king = s.pieces.find((p) => p.alive && p.side === side && p.type === 'K')
      if (!king) return
      king.shield++
      addLog(s, `御林军！${pieceName(king)}获得了 1 层护盾`, side, { kind: 'shield', pos: at(king) })
    },
  },
  {
    id: 'liangcao',
    name: '粮草先行',
    tier: 'silver',
    glyph: '粮',
    desc: '立即获得 2 次刷新机会，并且你的下一次锦囊品质提升一档。',
    onPick: (s, side, data) => {
      s.rerollsLeft[side] += 2
      data.boost = 1
    },
    status: (data) => (data.boost ? '待升档' : null),
  },
  // ───── 黄金 ─────
  {
    id: 'lianzhu',
    name: '连珠炮',
    tier: 'gold',
    glyph: '连',
    desc: '你的炮吃子时可以隔一个或两个棋子。',
    mods: { cannonMaxScreens: 2 },
  },
  {
    id: 'huoshao',
    name: '火烧连营',
    tier: 'gold',
    glyph: '火',
    desc: '你的炮吃子后，被吃位置周围一圈（8 格）的敌方棋子（将帅除外）一并烧掉，护盾可以抵挡。',
    onAfterMove: (s, side, ev) => {
      if (ev.piece.type !== 'C' || !ev.captured) return
      const { x, y } = ev.move.to
      for (const p of s.pieces) {
        if (!p.alive || p.side === side || p.type === 'K') continue
        if (Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) !== 1) continue
        if (p.shield > 0) {
          p.shield--
          addLog(s, `火烧连营！${pieceName(p)}的护盾挡下了火焰`, side, { kind: 'shield', pos: at(p) })
        } else {
          p.alive = false
          addLog(s, `火烧连营！烧掉了${pieceName(p)}`, side, { kind: 'burn', pos: at(p) })
        }
      }
    },
  },
  {
    id: 'huima',
    name: '回马枪',
    tier: 'gold',
    glyph: '枪',
    desc: '你的马吃子后获得 1 层护盾，并且可以再走一步（可以吃子，但不会再次触发），也可以选择跳过。',
    onAfterMove: (s, side, ev) => {
      if (ev.piece.type === 'N' && ev.captured && !ev.isExtra) {
        ev.piece.shield++
        s.extraMoves.push({ side, pieceId: ev.piece.id, noCapture: false, source: 'huima' })
      }
    },
  },
  {
    id: 'longma',
    name: '龙马精神',
    tier: 'gold',
    glyph: '龙',
    desc: '你的马也可以像象一样走"田"字（不会被塞象眼，不受河界限制）。',
    mods: { horseElephantStep: true },
  },
  {
    id: 'yujia',
    name: '御驾亲征',
    tier: 'gold',
    glyph: '御',
    desc: '你的将帅可以离开九宫，在己方半场内直线行走，一次最多两格。',
    mods: { kingLeavePalace: true },
  },
  {
    id: 'geshan',
    name: '隔山飞将',
    tier: 'gold',
    glyph: '隔',
    desc: '你的将帅飞将时，中间隔着一个棋子也能直接吃掉对方将帅。',
    mods: { kingFlyThroughOne: true },
  },
  {
    id: 'yixing',
    name: '移形换影',
    tier: 'gold',
    glyph: '移',
    desc: '你的将帅可以和上下左右相邻的己方棋子交换位置（算作一步）。',
    mods: { kingSwap: true },
  },
  {
    id: 'jinzhong',
    name: '金钟罩',
    tier: 'gold',
    glyph: '钟',
    desc: '你的将帅获得 1 层护盾。',
    onPick: (s, side) => addShield(s, side, (p) => p.type === 'K'),
  },
  {
    id: 'jinchan',
    name: '金蝉脱壳',
    tier: 'gold',
    glyph: '蝉',
    desc: '你的将帅将被吃掉时，若你还有士，则由一个士代替它被吃，将帅安然无恙。',
    protects: (s, side, target) =>
      target.type === 'K' && s.pieces.some((p) => p.alive && p.side === side && p.type === 'A'),
    onProtect: (s, side, target) => {
      const guards = s.pieces.filter((p) => p.alive && p.side === side && p.type === 'A')
      guards.sort((a, b) => Math.abs(a.x - target.x) + Math.abs(a.y - target.y) - (Math.abs(b.x - target.x) + Math.abs(b.y - target.y)))
      const guard = guards[0]
      guard.alive = false
      addLog(s, `金蝉脱壳！${pieceName(guard)}替${pieceName(target)}挡下了致命一击`, side, {
        kind: 'protect',
        pos: at(target),
      })
    },
  },
  {
    id: 'kongcheng',
    name: '空城计',
    tier: 'gold',
    glyph: '空',
    desc: '你的将帅周围一圈（8 格）没有己方棋子时，挡下对它的攻击。每局最多生效 2 次。',
    protects: (s, side, target, data) =>
      target.type === 'K' && (data.used ?? 0) < 2 && !neighbors8(s, target).some((p) => p.side === side),
    onProtect: (s, side, target, data) => {
      data.used = (data.used ?? 0) + 1
      addLog(s, `空城计！${pieceName(target)}稳坐城中，攻击无功而返`, side, { kind: 'protect', pos: at(target) })
    },
    status: (data) => `剩 ${2 - (data.used ?? 0)} 次`,
  },
  {
    id: 'jieshi',
    name: '借尸还魂',
    tier: 'gold',
    glyph: '魂',
    desc: '你接下来被吃掉的两个车、马或炮会立刻在开局位置复活；若位置被占，则就近复活。',
    onOwnCaptured: (s, side, piece, data) => {
      if ((data.used ?? 0) >= 2 || !['R', 'N', 'C'].includes(piece.type)) return
      const spot = findReviveSpot(s, piece)
      if (!spot) return
      data.used = (data.used ?? 0) + 1
      if (piece.promoted) {
        piece.type = 'P'
        piece.promoted = false
      }
      piece.alive = true
      piece.x = spot.x
      piece.y = spot.y
      piece.shield = 0
      addLog(s, `借尸还魂！${SIDE_NAMES[side]}的${pieceName(piece)}复活了`, side, { kind: 'revive', pos: spot })
    },
    status: (data) => `剩 ${2 - (data.used ?? 0)} 次`,
  },
  {
    id: 'fanjian',
    name: '反间计',
    tier: 'gold',
    glyph: '间',
    desc: '选中时，随机策反对方至多两个还没过河的兵卒，让它们成为你的兵卒。',
    onPick: (s, side) => {
      const enemy = other(side)
      const pool = s.pieces.filter((p) => p.alive && p.side === enemy && p.type === 'P' && !crossedRiver(enemy, p.y))
      if (pool.length === 0) {
        addLog(s, '反间计：对方没有可以策反的兵卒', side)
        return
      }
      const rng = rngFor(s.seed, 'fanjian', side, s.turnNo)
      for (let i = 0; i < 2 && pool.length > 0; i++) {
        const [p] = pool.splice(Math.floor(rng() * pool.length), 1)
        p.side = side
        p.home = at(p)
        addLog(s, `反间计！对方的一个兵卒倒戈成了${pieceName(p)}`, side, { kind: 'convert', pos: at(p) })
      }
    },
  },
  // ───── 棱彩 ─────
  {
    id: 'shensu',
    name: '兵贵神速',
    tier: 'prism',
    glyph: '速',
    desc: '你每走满 2 个回合，可以立刻额外再走一步（不能吃子）。',
    onAfterMove: (s, side, ev, data) => {
      if (ev.isExtra) return
      data.count = (data.count ?? 0) + 1
      if (data.count % 2 === 0) s.extraMoves.push({ side, noCapture: true, source: 'shensu' })
    },
    status: (data) => `${(data.count ?? 0) % 2}/2`,
  },
  {
    id: 'huangpao',
    name: '黄袍加身',
    tier: 'prism',
    glyph: '袍',
    desc: '选中时，你最靠前的两个兵卒立刻变为车；之后你的兵卒到达对方底线时也会变为车。',
    onPick: (s, side) => {
      const pawns = s.pieces.filter((p) => p.alive && p.side === side && p.type === 'P')
      const dist = (p: Piece) => Math.abs(p.y - enemyBaseline(side))
      pawns.sort((a, b) => dist(a) - dist(b) || Math.abs(a.x - 4) - Math.abs(b.x - 4))
      for (const p of pawns.slice(0, 2)) promote(s, p)
    },
    onAfterMove: (s, side, ev) => {
      const p = ev.piece
      if (!ev.blocked && p.type === 'P' && p.y === enemyBaseline(side)) promote(s, p)
    },
  },
  {
    id: 'huangjinjia',
    name: '满城尽带黄金甲',
    tier: 'prism',
    glyph: '金',
    desc: '你现有的车、马、炮、士、象各获得 1 层护盾。',
    onPick: (s, side) => addShield(s, side, (p) => p.type !== 'K' && p.type !== 'P'),
  },
  {
    id: 'zongheng',
    name: '纵横天下',
    tier: 'prism',
    glyph: '纵',
    desc: '你的车也可以斜着走，最多两格；斜走时只能吃紧挨着的棋子。',
    mods: { rookDiagonal: true },
  },
  {
    id: 'mantian',
    name: '瞒天过海',
    tier: 'prism',
    glyph: '瞒',
    desc: '你的车可以越过一个棋子，继续移动或吃掉后面的棋子。',
    mods: { rookJump: true },
  },
  {
    id: 'tianjiang',
    name: '天降神兵',
    tier: 'prism',
    glyph: '降',
    desc: '立即在你的底线召唤一个带 1 层护盾的车（优先放在车的开局位置附近）。',
    onPick: (s, side) => {
      const base = side === 'red' ? 9 : 0
      const spot = nearestEmpty(s, [{ x: 0, y: base }, { x: 8, y: base }], (_, y) => !crossedRiver(side, y))
      if (!spot) return
      const n = s.pieces.filter((p) => p.id.startsWith(`${side[0]}R+`)).length + 1
      s.pieces.push({
        id: `${side[0]}R+${n}`,
        type: 'R',
        side,
        x: spot.x,
        y: spot.y,
        alive: true,
        home: spot,
        shield: 1,
      })
      addLog(s, `天降神兵！${SIDE_NAMES[side]}召唤了一个车`, side, { kind: 'summon', pos: spot })
    },
  },
]

export const AUGMENTS: Record<string, AugmentDef> = Object.fromEntries(
  AUGMENT_LIST.map((a) => [a.id, a]),
)

export const TIER_NAMES: Record<Tier, string> = { silver: '白银', gold: '黄金', prism: '棱彩' }
