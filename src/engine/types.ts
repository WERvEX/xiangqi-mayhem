export type Side = 'red' | 'black'

/** K 将帅 · A 士仕 · B 象相 · N 马 · R 车 · C 炮 · P 兵卒 */
export type PieceType = 'K' | 'A' | 'B' | 'N' | 'R' | 'C' | 'P'

export type Tier = 'silver' | 'gold' | 'prism'

/** x: 0..8 从左到右；y: 0..9，0 为黑方底线，9 为红方底线 */
export interface Pos {
  x: number
  y: number
}

export interface Piece {
  id: string
  type: PieceType
  side: Side
  x: number
  y: number
  alive: boolean
  home: Pos
  /** 护盾层数：被吃时消耗一层并挡下攻击 */
  shield: number
  /** 由兵升变而来 */
  promoted?: boolean
}

export interface Move {
  pieceId: string
  from: Pos
  to: Pos
  captureId?: string
  /** 与己方棋子交换位置（移形换影） */
  swapId?: string
}

/** 锦囊对走法规则的修改，可叠加 */
export interface RuleMods {
  horseNoLeg?: boolean
  elephantCrossRiver?: boolean
  advisorLeavePalace?: boolean
  kingLeavePalace?: boolean
  pawnSidewaysEarly?: boolean
  pawnRetreat?: boolean
  /** 过河兵卒可以斜向前进 */
  pawnDiagonalForward?: boolean
  /** 炮吃子时允许的最多炮架数，默认 1 */
  cannonMaxScreens?: number
  rookDiagonal?: boolean
  elephantNoEye?: boolean
  kingDiagonal?: boolean
  /** 飞将时中间可以隔一个子 */
  kingFlyThroughOne?: boolean
  /** 马也能走象步 */
  horseElephantStep?: boolean
  /** 车可以越过一个棋子 */
  rookJump?: boolean
  /** 车可以穿过己方棋子 */
  rookPassFriendly?: boolean
  /** 将帅可与相邻己方棋子换位 */
  kingSwap?: boolean
}

export interface OwnedAugment {
  id: string
  /** 锦囊自身的计数器等状态 */
  data: Record<string, number>
}

export interface DraftSide {
  tier: Tier
  options: string[]
  rerollNo: number
  done: boolean
  picked: string | null
  /** 因子力落后而提升了品质 */
  comeback: boolean
}

export interface Draft {
  index: number
  round: number
  sides: Record<Side, DraftSide>
}

/** 额外行动（回马枪、兵贵神速等） */
export interface ExtraMove {
  side: Side
  pieceId?: string
  noCapture: boolean
  source: string
}

export type Phase = 'draft' | 'play' | 'over'

export type FxKind =
  | 'capture'
  | 'shield'
  | 'protect'
  | 'revive'
  | 'promote'
  | 'burn'
  | 'summon'
  | 'convert'
  | 'swap'
  | 'extra'

export interface LogEntry {
  round: number
  side?: Side
  text: string
  /** 界面特效：在棋盘某个位置播放 */
  fx?: { kind: FxKind; pos: Pos }
}

export interface GameState {
  seed: string
  phase: Phase
  turn: Side
  /** 已完成的回合交接次数（红走完 +1，黑走完 +1） */
  turnNo: number
  pieces: Piece[]
  augments: Record<Side, OwnedAugment[]>
  rerollsLeft: Record<Side, number>
  draft: Draft | null
  draftsDone: number
  extraMoves: ExtraMove[]
  lastMove: Move | null
  positionCounts: Record<string, number>
  /** phase 为 over 且 winner 为 null 表示和棋 */
  winner: Side | null
  endReason: string | null
  log: LogEntry[]
}

export type Action =
  | { type: 'move'; side: Side; pieceId: string; to: Pos }
  | { type: 'pick'; side: Side; augmentId: string }
  | { type: 'reroll'; side: Side }
  | { type: 'skip'; side: Side }
  | { type: 'resign'; side: Side }
