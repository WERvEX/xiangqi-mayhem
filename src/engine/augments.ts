import { addLog, crossedRiver, enemyBaseline, pieceAt, pieceName, SIDE_NAMES } from './board'
import type { GameState, Move, Piece, RuleMods, Side, Tier } from './types'

export interface MoveEvent {
  move: Move
  /** 走子的棋子（已在新位置） */
  piece: Piece
  captured: Piece | null
  /** 攻击被护盾挡下，棋子没有移动 */
  blocked: boolean
  /** 这一步本身是额外行动 */
  isExtra: boolean
}

export interface AugmentDef {
  id: string
  name: string
  tier: Tier
  /** 图标用的单字 */
  glyph: string
  desc: string
  mods?: RuleMods
  /** 选中时立即生效 */
  onPick?(s: GameState, side: Side, data: Record<string, number>): void
  /** 拥有者每走一步之后 */
  onAfterMove?(s: GameState, side: Side, ev: MoveEvent, data: Record<string, number>): void
  /** 拥有者的棋子被吃掉时 */
  onOwnCaptured?(s: GameState, side: Side, piece: Piece, data: Record<string, number>): void
  /** 界面上显示的状态，例如计数器；也参与重复局面判定 */
  status?(data: Record<string, number>): string | null
}

const addShield = (s: GameState, side: Side, filter: (p: Piece) => boolean) => {
  for (const p of s.pieces) if (p.alive && p.side === side && filter(p)) p.shield++
}

const promote = (s: GameState, p: Piece) => {
  p.type = 'R'
  p.promoted = true
  addLog(s, `${SIDE_NAMES[p.side]}的兵卒抵达底线，黄袍加身变为${pieceName(p)}！`, p.side)
}

function findReviveSpot(s: GameState, p: Piece): { x: number; y: number } | null {
  const candidates = [p.home, { x: 8 - p.home.x, y: p.home.y }]
  for (const c of candidates) if (!pieceAt(s, c.x, c.y)) return c
  // 士象只能回到标准位置，其余棋子可在己方半场找最近空位
  if (p.type === 'A' || p.type === 'B') return null
  let best: { x: number; y: number } | null = null
  let bestDist = Infinity
  for (let y = 0; y < 10; y++) {
    if (crossedRiver(p.side, y)) continue
    for (let x = 0; x < 9; x++) {
      if (pieceAt(s, x, y)) continue
      const d = Math.abs(x - p.home.x) + Math.abs(y - p.home.y)
      if (d < bestDist) {
        bestDist = d
        best = { x, y }
      }
    }
  }
  return best
}

export const AUGMENT_LIST: AugmentDef[] = [
  // ───── 银 ─────
  {
    id: 'tianma',
    name: '天马行空',
    tier: 'silver',
    glyph: '驰',
    desc: '你的马不会被蹩马腿。',
    mods: { horseNoLeg: true },
  },
  {
    id: 'feixiang',
    name: '飞象过河',
    tier: 'silver',
    glyph: '飞',
    desc: '你的象可以过河（仍会被塞象眼）。',
    mods: { elephantCrossRiver: true },
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
    desc: '你的过河兵可以后退一格。',
    mods: { pawnRetreat: true },
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
    id: 'tiejia',
    name: '铁甲战车',
    tier: 'silver',
    glyph: '甲',
    desc: '你现有的车各获得 1 层护盾。护盾会挡下一次吃子，攻击者原地不动。',
    onPick: (s, side) => addShield(s, side, (p) => p.type === 'R'),
  },
  // ───── 金 ─────
  {
    id: 'lianzhu',
    name: '连珠炮',
    tier: 'gold',
    glyph: '连',
    desc: '你的炮吃子时可以隔一个或两个棋子。',
    mods: { cannonMaxScreens: 2 },
  },
  {
    id: 'huima',
    name: '回马枪',
    tier: 'gold',
    glyph: '枪',
    desc: '你的马吃子后，可以让这匹马再走一步（不能吃子），也可以选择跳过。',
    onAfterMove: (s, side, ev) => {
      if (ev.piece.type === 'N' && ev.captured && !ev.isExtra) {
        s.extraMoves.push({ side, pieceId: ev.piece.id, noCapture: true, source: 'huima' })
      }
    },
  },
  {
    id: 'yujia',
    name: '御驾亲征',
    tier: 'gold',
    glyph: '御',
    desc: '你的将帅可以离开九宫，在己方半场内行走。',
    mods: { kingLeavePalace: true },
  },
  {
    id: 'jieshi',
    name: '借尸还魂',
    tier: 'gold',
    glyph: '魂',
    desc: '你下一个被吃掉的棋子（将帅除外）会立刻在开局位置复活；若位置被占，则就近复活。',
    onOwnCaptured: (s, side, piece, data) => {
      if (data.used || piece.type === 'K') return
      const spot = findReviveSpot(s, piece)
      if (!spot) return
      data.used = 1
      if (piece.promoted) {
        piece.type = 'P'
        piece.promoted = false
      }
      piece.alive = true
      piece.x = spot.x
      piece.y = spot.y
      piece.shield = 0
      addLog(s, `借尸还魂！${SIDE_NAMES[side]}的${pieceName(piece)}复活了`, side)
    },
    status: (data) => (data.used ? '已用' : '待命'),
  },
  {
    id: 'jinzhong',
    name: '金钟罩',
    tier: 'gold',
    glyph: '钟',
    desc: '你的将帅获得 1 层护盾。',
    onPick: (s, side) => addShield(s, side, (p) => p.type === 'K'),
  },
  // ───── 棱彩 ─────
  {
    id: 'shensu',
    name: '兵贵神速',
    tier: 'prism',
    glyph: '速',
    desc: '你每走满 3 个回合，可以立刻额外再走一步（不能吃子）。',
    onAfterMove: (s, side, ev, data) => {
      if (ev.isExtra) return
      data.count = (data.count ?? 0) + 1
      if (data.count % 3 === 0) s.extraMoves.push({ side, noCapture: true, source: 'shensu' })
    },
    status: (data) => `${(data.count ?? 0) % 3}/3`,
  },
  {
    id: 'huangpao',
    name: '黄袍加身',
    tier: 'prism',
    glyph: '袍',
    desc: '你的兵卒到达对方底线时，立刻变为车。',
    onPick: (s, side) => {
      for (const p of s.pieces) {
        if (p.alive && p.side === side && p.type === 'P' && p.y === enemyBaseline(side)) promote(s, p)
      }
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
    desc: '你现有的所有棋子（将帅除外）各获得 1 层护盾。',
    onPick: (s, side) => addShield(s, side, (p) => p.type !== 'K'),
  },
  {
    id: 'zongheng',
    name: '纵横天下',
    tier: 'prism',
    glyph: '纵',
    desc: '你的车也可以沿斜线任意移动。',
    mods: { rookDiagonal: true },
  },
]

export const AUGMENTS: Record<string, AugmentDef> = Object.fromEntries(
  AUGMENT_LIST.map((a) => [a.id, a]),
)

export const TIER_NAMES: Record<Tier, string> = { silver: '白银', gold: '黄金', prism: '棱彩' }
