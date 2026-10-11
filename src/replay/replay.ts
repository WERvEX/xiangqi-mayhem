import { applyAction, createGame, legalMoves, RULES_VERSION, type Action, type GameState, type Side } from '../engine'

/**
 * 回放：一局棋由"种子 + 操作序列"完整决定。
 *
 * 为了能放进链接，操作被编码成很短的记号：
 *   走子   → 它在 legalMoves(当前局面) 中的序号（36 进制，只含数字和小写字母）
 *   选锦囊 → P + 方 + 选项序号，如 Pr1
 *   刷新   → R + 方，如 Rb
 *   跳过额外行动 → S
 *   认输   → X + 方
 * 特殊操作用大写字母开头，避免和 36 进制序号混淆。
 * 记号之间用 "." 分隔。序号依赖走法生成的顺序，所以回放会记录规则版本。
 */

export type ReplayMode = 'hotseat' | 'ai' | 'online' | 'llm' | 'eve'

/** 大模型在某一步的发言与思考，只保存在回放文件里（链接里放不下） */
export interface ReplayNote {
  /** 对应的操作序号：发言和思考发生在第 i 个操作之前 */
  i: number
  side: Side
  speech?: string
  thought?: string
  /** 这一步模型失败、由程序代走时的原因 */
  fallback?: string
  /** 代走的是哪一步，如"炮 h2→e2" */
  fallbackMove?: string
}

export interface ReplayMeta {
  mode: ReplayMode
  /** 双方的称呼，如"玩家""AI·困难" */
  red?: string
  black?: string
  /** ISO 时间 */
  date: string
}

export interface Replay {
  rules: number
  seed: string
  actions: Action[]
  meta: ReplayMeta
  notes?: ReplayNote[]
}

export class ReplayError extends Error {}

const sideChar = (s: Side) => (s === 'red' ? 'r' : 'b')
const charSide = (c: string): Side => {
  if (c === 'r') return 'red'
  if (c === 'b') return 'black'
  throw new ReplayError(`无效的一方：${c}`)
}

export function encodeActions(seed: string, actions: Action[]): string {
  let s = createGame(seed)
  const tokens: string[] = []
  for (const a of actions) {
    switch (a.type) {
      case 'move': {
        const i = legalMoves(s).findIndex((m) => m.pieceId === a.pieceId && m.to.x === a.to.x && m.to.y === a.to.y)
        if (i < 0) throw new ReplayError('回放中有不合法的走法')
        tokens.push(i.toString(36))
        break
      }
      case 'pick': {
        const i = s.draft?.sides[a.side].options.indexOf(a.augmentId) ?? -1
        if (i < 0) throw new ReplayError('回放中有不合法的锦囊选择')
        tokens.push(`P${sideChar(a.side)}${i}`)
        break
      }
      case 'reroll':
        tokens.push(`R${sideChar(a.side)}`)
        break
      case 'skip':
        tokens.push('S')
        break
      case 'resign':
        tokens.push(`X${sideChar(a.side)}`)
        break
    }
    s = applyAction(s, a)
  }
  return tokens.join('.')
}

/** 解码并重放，返回操作序列和每一步之后的局面（states[0] 为开局） */
export function decodeActions(seed: string, encoded: string): { actions: Action[]; states: GameState[] } {
  let s = createGame(seed)
  const actions: Action[] = []
  const states = [s]
  for (const t of encoded ? encoded.split('.') : []) {
    let a: Action
    if (t[0] === 'P') {
      const side = charSide(t[1])
      const id = s.draft?.sides[side].options[Number(t.slice(2))]
      if (!id) throw new ReplayError('回放数据损坏（锦囊选择）')
      a = { type: 'pick', side, augmentId: id }
    } else if (t[0] === 'R') a = { type: 'reroll', side: charSide(t[1]) }
    else if (t === 'S') a = { type: 'skip', side: s.turn }
    else if (t[0] === 'X') a = { type: 'resign', side: charSide(t[1]) }
    else {
      const m = legalMoves(s)[parseInt(t, 36)]
      if (!m) throw new ReplayError('回放数据损坏（走法）')
      a = { type: 'move', side: s.turn, pieceId: m.pieceId, to: m.to }
    }
    try {
      s = applyAction(s, a)
    } catch {
      throw new ReplayError('回放数据与当前规则不匹配')
    }
    actions.push(a)
    states.push(s)
  }
  return { actions, states }
}

// ───────────── 序列化 ─────────────

interface Payload {
  v: 1
  rules: number
  seed: string
  a: string
  m: ReplayMeta
  /** 大模型的发言与思考，只在回放文件里 */
  n?: ReplayNote[]
}

const FILE_FORMAT = 'xiangqi-mayhem-replay'

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

function toPayload(r: Replay): Payload {
  return { v: 1, rules: r.rules, seed: r.seed, a: encodeActions(r.seed, r.actions), m: r.meta }
}

export function makeReplay(
  seed: string,
  actions: Action[],
  meta: Omit<ReplayMeta, 'date'>,
  notes?: ReplayNote[],
): Replay {
  const r: Replay = { rules: RULES_VERSION, seed, actions, meta: { ...meta, date: new Date().toISOString() } }
  if (notes?.length) r.notes = notes
  return r
}

/** 回放里有链接放不下的内容（大模型的发言与思考），只能用文件分享 */
export const hasNotes = (r: Replay) => !!r.notes?.length

/** 链接中 #replay= 之后的部分 */
export function replayToCode(r: Replay): string {
  return toBase64Url(JSON.stringify(toPayload(r)))
}

export function replayToFile(r: Replay): string {
  const payload: Payload & { format: string } = { format: FILE_FORMAT, ...toPayload(r) }
  if (r.notes?.length) payload.n = r.notes
  return JSON.stringify(payload, null, 2)
}

export interface LoadedReplay extends Replay {
  states: GameState[]
  /** 回放的规则版本与当前不同 */
  outdated: boolean
}

const isNote = (x: unknown): x is ReplayNote => {
  const n = x as ReplayNote
  return !!n && typeof n.i === 'number' && (n.side === 'red' || n.side === 'black')
}

function load(p: Payload): LoadedReplay {
  if (p.v !== 1 || typeof p.seed !== 'string' || typeof p.a !== 'string') throw new ReplayError('无法识别的回放格式')
  const outdated = p.rules !== RULES_VERSION
  try {
    const { actions, states } = decodeActions(p.seed, p.a)
    const notes = Array.isArray(p.n) ? p.n.filter(isNote) : undefined
    return { rules: p.rules, seed: p.seed, actions, states, meta: p.m, outdated, notes }
  } catch (e) {
    if (outdated) throw new ReplayError(`这个回放来自旧版本规则（v${p.rules}，当前 v${RULES_VERSION}），已无法播放`)
    throw e
  }
}

/** 本局刚结束、直接在本机查看回放时用：不经过编码，直接重放 */
export function loadReplay(r: Replay): LoadedReplay {
  const states = [createGame(r.seed)]
  for (const a of r.actions) states.push(applyAction(states[states.length - 1], a))
  return { ...r, states, outdated: r.rules !== RULES_VERSION }
}

/** 支持：完整链接、#replay=… 片段、单独的回放码、回放文件内容 */
export function parseReplay(input: string): LoadedReplay {
  const text = input.trim()
  if (text.startsWith('{')) {
    let data: Payload & { format?: string }
    try {
      data = JSON.parse(text)
    } catch {
      throw new ReplayError('回放文件不是有效的 JSON')
    }
    if (data.format !== FILE_FORMAT) throw new ReplayError('这不是象棋大乱斗的回放文件')
    return load(data)
  }
  const code = /replay=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? text
  let payload: Payload
  try {
    payload = JSON.parse(fromBase64Url(code))
  } catch {
    throw new ReplayError('无法识别的回放链接')
  }
  return load(payload)
}
