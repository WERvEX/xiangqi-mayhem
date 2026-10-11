import {
  AUGMENT_LIST,
  AUGMENTS,
  CONFIG,
  findKing,
  getPiece,
  kingThreat,
  legalMoves,
  material,
  nextDraftRound,
  other,
  PIECE_CHARS,
  pieceName,
  roundOf,
  SIDE_NAMES,
  TIER_NAMES,
  type Action,
  type GameState,
  type Move,
  type Piece,
  type Side,
} from '../engine'
import type { MoveScore } from '../ai/bot'
import { moveTags, threatsAgainst } from './annotate'
import { FILES, moveText, square } from './notation'

/**
 * 提示词构造。
 *
 * 每次请求都独立构造完整的提示词，不累积对话：
 * - 系统提示词整局不变（规则 + 全部锦囊），可以命中各家的前缀缓存
 * - 用户消息放当前局面、最近几步、合法走法列表和模型给自己留的备忘
 * 走棋请求和发言请求共用同一个系统提示词，人设只放在发言请求的用户消息里。
 */

/** 一次操作的文字记录，用于"最近的走法"和发言请求里的"对方做了什么" */
export interface TurnRecord {
  round: number
  side: Side
  text: string
  /** 这次操作触发的事件（护盾挡下、复活等），取自对局日志 */
  events: string[]
}

export function describeAction(prev: GameState, action: Action, next: GameState): TurnRecord {
  let text: string
  switch (action.type) {
    case 'move': {
      const m = legalMoves(prev).find(
        (mv) => mv.pieceId === action.pieceId && mv.to.x === action.to.x && mv.to.y === action.to.y,
      )
      text = m ? moveText(prev, m) : `${pieceName(getPiece(prev, action.pieceId))} → ${square(action.to)}`
      break
    }
    case 'pick':
      // 双方都选完才揭晓，揭晓的内容在 events 里（取自对局日志）
      text = '选好了锦囊'
      break
    case 'reroll':
      text = '刷新了锦囊选项'
      break
    case 'skip':
      text = '放弃了这次额外行动'
      break
    case 'resign':
      text = '认输'
      break
  }
  const events = next.log
    .slice(prev.log.length)
    .map((e) => e.text)
    // 普通吃子在走法文字里已经写了
    .filter((t) => !/^\S+吃掉了\S+$/.test(t))
  return { round: roundOf(prev), side: action.side, text, events }
}

// ───────────── 系统提示词 ─────────────

const augmentGlossary = () =>
  (['silver', 'gold', 'prism'] as const)
    .map(
      (tier) =>
        `【${TIER_NAMES[tier]}】\n` +
        AUGMENT_LIST.filter((a) => a.tier === tier)
          .map((a) => `- ${a.name}：${a.desc}`)
          .join('\n'),
    )
    .join('\n')

let cachedSystem: string | null = null

export function systemPrompt(): string {
  cachedSystem ??= `你是一名「象棋大乱斗」棋手。象棋大乱斗是加入了「锦囊」机制的中国象棋变体，你的目标是吃掉对方的将（帅）。

# 基本规则
- 棋子走法与中国象棋相同：车直线任意格；马走日、会被蹩马腿；炮移动同车，吃子时必须隔一个棋子（炮架）；相/象走田、会被塞象眼、不能过河；仕/士在九宫内斜走一格；帅/将在九宫内直走一格；兵/卒只能前进一格，过河后还可以横走一格。
- 胜负：吃掉对方的将帅即获胜。没有"被将军必须应将"的限制，允许走出让自己将帅被吃的棋，但那样对方下一步就会吃掉你的将帅，你就输了。
- 飞将：双方将帅在同一列、中间没有任何棋子时，轮到的一方可以直接吃掉对方将帅。
- 无棋可走判负；同一局面出现三次，或超过 ${CONFIG.maxRounds} 回合，判和。
- 每个回合红方先走、黑方后走。

# 坐标
- 列 a–i 从左到右，行 0–9 从红方底线往上数。
- 红方在下：帥开局在 e0，第 0 行是红方底线，红方"前进"是行号变大。
- 黑方在上：將开局在 e9，第 9 行是黑方底线，黑方"前进"是行号变小。
- 河界在第 4 行和第 5 行之间；九宫是 d–f 列，红方 0–2 行、黑方 7–9 行。
- 棋子符号：红方 ${Object.values(PIECE_CHARS.red).join(' ')}；黑方 ${Object.values(PIECE_CHARS.black).join(' ')}（依次为帅、仕、相、马、车、炮、兵）。

# 锦囊
- 第 ${CONFIG.draftRounds.join('、')} 回合，双方各从 3 个随机锦囊中选 1 个，也可以花一次刷新机会换一批。锦囊永久生效，双方的锦囊互相公开。
- 品质分白银、黄金、棱彩三档，越往后品质越高。
- 护盾：挡下一次吃子，攻击者原地不动，护盾消失，攻击方这一步就用掉了。每个棋子最多 1 层护盾；带护盾的棋子主动吃子时也会消耗护盾。

全部锦囊：
${augmentGlossary()}

# 下棋要点
- 每一步都会给你一份「合法走法」列表，它已经列出了你所有能走的棋，能吃子的走法会写明"吃 某子"。列表里没有的走法就是走不了、吃不到。不要自己推算某个子能不能走到某处，直接查列表。
- 子力大致价值：车 9，炮 4.5，马 4，仕/相 2，兵 1（过河后 2）。
- 每一步先检查：对方下一步能不能吃掉你的将帅？你能不能直接吃掉对方的将帅？
- 留意双方锦囊带来的特殊走法，对方的车、马、炮可能不按常规行动。
- 不要白白送子；吃子前想想对方能不能吃回来。`
  return cachedSystem
}

// ───────────── 局面 ─────────────

const TYPE_ORDER = 'KRNCBAP'

function pieceList(state: GameState, side: Side): string {
  const pieces = state.pieces
    .filter((p) => p.alive && p.side === side)
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.x - b.x || a.y - b.y)
  return pieces.map((p) => `${pieceName(p)} ${square(p)}${p.shield ? '[盾]' : ''}`).join('、')
}

function augmentList(state: GameState, side: Side): string {
  const owned = state.augments[side]
  if (owned.length === 0) return '无'
  return owned
    .map((a) => {
      const st = AUGMENTS[a.id].status?.(a.data)
      return `${AUGMENTS[a.id].name}${st ? `（${st}）` : ''}`
    })
    .join('、')
}

function boardDiagram(state: GameState): string {
  const grid: (Piece | null)[][] = Array.from({ length: 10 }, () => Array<Piece | null>(9).fill(null))
  for (const p of state.pieces) if (p.alive) grid[p.y][p.x] = p
  // 等宽字体下，一个汉字占两个字母宽，所以格子之间空一格、列标之间空两格
  const header = `   ${[...FILES].join('  ')}`
  const rows = grid.map((row, y) => `${9 - y}  ${row.map((p) => (p ? pieceName(p) : '＋')).join(' ')}`)
  rows.splice(5, 0, '   ～～～～ 河 界 ～～～～')
  return [header, ...rows].join('\n')
}

/** 局面描述，me 为模型执的一方 */
export function renderPosition(state: GameState, me: Side): string {
  const opp = other(me)
  const next = nextDraftRound(state)
  const diff = material(state, me) - material(state, opp)
  const lines = [
    `你执${SIDE_NAMES[me]}（${me === 'red' ? '在下方，第 0 行是你的底线' : '在上方，第 9 行是你的底线'}）。`,
    `当前第 ${roundOf(state)} 回合${next !== null ? `，下次锦囊在第 ${next} 回合` : '，之后没有锦囊了'}。`,
    '',
    '棋盘：',
    boardDiagram(state),
    '',
    `红方棋子：${pieceList(state, 'red')}`,
    `黑方棋子：${pieceList(state, 'black')}`,
    '（[盾] 表示带 1 层护盾）',
    `红方锦囊：${augmentList(state, 'red')}`,
    `黑方锦囊：${augmentList(state, 'black')}`,
    `刷新次数：红 ${state.rerollsLeft.red}，黑 ${state.rerollsLeft.black}`,
    `子力：你 ${material(state, me)}，对方 ${material(state, opp)}（${diff === 0 ? '持平' : diff > 0 ? `你领先 ${diff}` : `你落后 ${-diff}`}）`,
  ]
  return lines.join('\n')
}

function recentMoves(history: TurnRecord[], count = 6): string {
  const recent = history.slice(-count)
  if (recent.length === 0) return '（还没有人行动）'
  return recent
    .map((r) => {
      const ev = r.events.length ? `（${r.events.join('；')}）` : ''
      return `第 ${r.round} 回合 ${SIDE_NAMES[r.side]}：${r.text}${ev}`
    })
    .join('\n')
}

// ───────────── 走棋请求 ─────────────

/**
 * 辅助等级：
 * - off：不标注（裸考）
 * - facts：标出能直接算出来的事实（送将、将军、走后可被吃、重复局面）
 * - tactics：再加上规则引擎的战术检查（会被强制吃将、明显吃亏、能强制吃将）
 * - engine：再标出引擎推荐的三步
 */
export type AssistLevel = 'off' | 'facts' | 'tactics' | 'engine'

export const ASSIST_LEVELS: Record<AssistLevel, { name: string; desc: string }> = {
  off: { name: '裸考', desc: '不给任何提示，看模型的真实棋力' },
  facts: { name: '基础标注', desc: '标出送将、将军、走后会被吃的走法' },
  tactics: { name: '战术检查', desc: '引擎再往后算几步，标出会被杀、会吃亏的走法（推荐）' },
  engine: { name: '引擎推荐', desc: '再标出引擎推荐的三步，模型主要负责挑选和发言' },
}

/** 这个辅助等级需要引擎给每个走法打分 */
export const needsEngine = (level: AssistLevel) => level === 'tactics' || level === 'engine'

/** 比最好的走法差这么多分以上，才标"吃亏" */
const BLUNDER_MARGIN = 2.5

const EXPOSE_TAG = '⚠走后己方将帅可被吃'

/** 选项编号 → 操作；走棋时还可能有"跳过额外行动" */
export interface MoveOption {
  action: Action
  label: string
  /** 引擎判断：走这步会被强制吃将 */
  loss?: boolean
  /** 引擎判断：走这步能强制吃将 */
  win?: boolean
  /** 走完之后对方能直接吃将（送将） */
  exposes?: boolean
  /** 引擎判断：比最好的走法少多少分 */
  lossPoints?: number
}

/** 吃亏这么多分以上算"大亏"，选了会请模型再确认一次 */
const BIG_BLUNDER = 4

const isBlunder = (o: MoveOption) => !!(o.loss || o.exposes || (o.lossPoints ?? 0) >= BIG_BLUNDER)

/**
 * 模型选了一步明显的坏棋（送将、会被强制吃将、大亏）而且还有别的走法时，返回请它再确认的话；否则返回 null。
 * 模型想得少时经常看到了标注还照样走，问一次就能挡住大部分失误，坚持的话仍然按它的走。
 */
export function blunderWarning(options: MoveOption[], index: number): string | null {
  const o = options[index]
  if (!o || !isBlunder(o) || !options.some((x) => x.action.type === 'move' && !isBlunder(x))) return null
  const why = o.exposes
    ? '走完之后你的将帅会被对方直接吃掉'
    : o.loss
      ? '引擎算出走这步之后，对方能强制吃掉你的将帅'
      : `引擎算出这步比最好的走法少约 ${Math.round(o.lossPoints!)} 分子力`
  return `你选的是编号 ${index + 1}（${o.label}）。${why}。如果你确定要这么走，就再回复一次同样的编号；否则请换一步。`
}

const sameMove = (a: Move, b: Move) => a.pieceId === b.pieceId && a.to.x === b.to.x && a.to.y === b.to.y

export function moveOptions(state: GameState, level: AssistLevel, engine?: MoveScore[] | null): MoveOption[] {
  const side = state.turn
  const moves = [...legalMoves(state)].sort((a, b) => {
    const pa = getPiece(state, a.pieceId)
    const pb = getPiece(state, b.pieceId)
    return (
      TYPE_ORDER.indexOf(pa.type) - TYPE_ORDER.indexOf(pb.type) ||
      pa.x - pb.x ||
      pb.y - pa.y ||
      a.to.x - b.to.x ||
      b.to.y - a.to.y
    )
  })

  const scores = needsEngine(level) && engine?.length ? engine : null
  const anyWin = !!scores?.some((s) => s.win)
  const normal = scores?.filter((s) => !s.win && !s.loss) ?? []
  const best = normal.length ? Math.max(...normal.map((s) => s.score)) : 0
  const top = level === 'engine' && scores ? scores.filter((s) => !s.loss).sort((a, b) => b.score - a.score).slice(0, 3) : []

  const opts: MoveOption[] = moves.map((m: Move) => {
    const tags = level === 'off' ? [] : moveTags(state, m)
    const sc = scores?.find((s) => sameMove(s.move, m))
    if (sc?.win) tags.unshift('★能强制吃将')
    else if (sc?.loss) {
      if (!tags.includes(EXPOSE_TAG)) tags.push('⚠会被强制吃将')
    } else if (sc && !anyWin && best - sc.score >= BLUNDER_MARGIN) {
      tags.push(`吃亏约 ${Math.round(best - sc.score)} 分`)
    }
    const lossPoints = sc && !sc.win && !sc.loss && !anyWin ? best - sc.score : undefined
    const rank = sc ? top.indexOf(sc) : -1
    if (rank >= 0) tags.push(`引擎推荐 ${rank + 1}`)
    return {
      action: { type: 'move', side, pieceId: m.pieceId, to: m.to },
      label: moveText(state, m) + (tags.length ? `  〔${tags.join('，')}〕` : ''),
      loss: sc?.loss,
      win: sc?.win,
      exposes: tags.includes(EXPOSE_TAG),
      lossPoints,
    }
  })
  const extra = state.extraMoves[0]
  if (extra) opts.push({ action: { type: 'skip', side }, label: `跳过（放弃【${AUGMENTS[extra.source].name}】的额外行动）` })
  return opts
}

export interface MovePromptInput {
  state: GameState
  side: Side
  history: TurnRecord[]
  /** 作战笔记：上一步写下的策略、计划、要提防的威胁 */
  memo: string
  assist: AssistLevel
  /** 引擎对每个走法的打分（战术检查、引擎推荐时需要） */
  engine?: MoveScore[] | null
  /** 自己最近几步的决策和理由，如"第 10 回合 炮 h2→e2：控制中路" */
  decisions?: string[]
}

/**
 * 连贯推理：每步独立请求，但把模型自己的"作战笔记"和最近几步的决策放回提示词，
 * 让它先检查计划还成不成立，再决定下一步。这样上下文长度固定，不会越下越长。
 */
function notebook(memo: string, decisions: string[] | undefined): string[] {
  const parts = ['', '你的作战笔记（上一步写的）：', memo.trim() || '（还没有，这是你的第一步）']
  if (decisions?.length) parts.push('', '你最近几步的决策：', ...decisions.map((d) => `- ${d}`))
  if (memo.trim()) parts.push('先想一想：对方刚才的行动有没有打乱你的计划？计划还成立就继续执行，不成立就调整。')
  return parts
}

/** 走棋回复的结构：前后一致的结构化思考，便于连贯推理，也便于玩家看懂 */
const MOVE_FORMAT = [
  '只输出一个 JSON 对象，不要输出其他内容。各字段都用简短的中文：',
  '{',
  '  "situation": "局面判断：谁占优，关键的威胁和机会（不超过 80 字）",',
  '  "strategy": "你这一阶段的策略（不超过 50 字，没变就沿用）",',
  '  "move": 走法编号,',
  '  "reason": "为什么走这一步（不超过 50 字）",',
  '  "plan": "接下来两三步的打算（不超过 60 字）",',
  '  "watch": "需要提防的威胁（不超过 40 字，没有就写“无”）"',
  '}',
]

const numbers = (opts: MoveOption[], pick: (o: MoveOption) => boolean | undefined) =>
  opts.flatMap((o, i) => (pick(o) ? [i + 1] : []))

export function movePrompt(
  { state, side, history, memo, assist, decisions }: MovePromptInput,
  options: MoveOption[],
): string {
  const extra = state.extraMoves[0]
  const parts = [renderPosition(state, side), '', '最近的行动：', recentMoves(history)]
  if (extra) {
    parts.push(
      '',
      `【${AUGMENTS[extra.source].name}】让你可以再走一步${extra.pieceId ? '（只能走刚才那个棋子）' : ''}${extra.noCapture ? '（不能吃子）' : ''}，也可以跳过。`,
    )
  }
  const threats = threatsAgainst(state, side)
  parts.push('', '你的棋子正受到的攻击：', threats.length ? threats.join('\n') : '无')
  if (kingThreat(state, other(side)) === 'lethal') parts.push('⚠ 你的将帅现在可以被对方直接吃掉！这一步必须化解，否则立刻输棋。')
  if (findKing(state, other(side)) && kingThreat(state, side) === 'lethal') parts.push('★ 你现在可以直接吃掉对方的将帅，获胜！')

  // 引擎的整体判断：有杀棋、被叫杀时直接点明
  const wins = numbers(options, (o) => o.win)
  const losses = numbers(options, (o) => o.loss)
  const safe = numbers(options, (o) => o.loss === false)
  if (wins.length) parts.push(`★ 你有能强制吃掉对方将帅的走法：编号 ${wins.join('、')}。`)
  else if (losses.length && safe.length === 0) parts.push('⚠ 引擎判断已经无法避免被吃将，选一步尽量拖延。')
  else if (losses.length > 0 && losses.length >= safe.length && safe.length <= 8) {
    parts.push(`⚠ 对方正在威胁杀棋！只有这些走法能避免被强制吃将：编号 ${safe.join('、')}。其他走法都会输。`)
  }

  parts.push(...notebook(memo, decisions))
  parts.push('', `合法走法（共 ${options.length} 个，只能从中选一个）：`, ...options.map((o, i) => `${i + 1}. ${o.label}`))
  if (assist !== 'off') {
    const notes = [
      '将军 = 走后能直接吃对方将帅',
      '走后可被吃 = 走到的位置会被对方吃掉且没有护盾',
      `${EXPOSE_TAG} = 送将，几乎必输`,
    ]
    if (needsEngine(assist)) {
      notes.push('⚠会被强制吃将 = 引擎算出走这步之后对方能杀棋', '吃亏约 N 分 = 比最好的走法少 N 分子力（车 9 分）')
    }
    if (assist === 'engine') notes.push('引擎推荐 = 规则引擎认为最好的几步，仅供参考')
    parts.push('', `〔〕里是程序给出的标注：${notes.join('；')}。`)
  }
  if (needsEngine(assist)) {
    parts.push('程序已经替你检查了战术风险，不需要长时间推演：先避开带 ⚠ 和"吃亏"的走法，再从剩下的走法里选一个符合你计划的。')
  }
  parts.push('', ...MOVE_FORMAT)
  return parts.join('\n')
}

// ───────────── 选锦囊请求 ─────────────

export function draftPrompt({ state, side, history, memo, decisions }: Omit<MovePromptInput, 'assist'>): string {
  const ds = state.draft!.sides[side]
  const parts = [
    renderPosition(state, side),
    '',
    '最近的行动：',
    recentMoves(history),
    ...notebook(memo, decisions),
    '',
    `现在轮到你选择锦囊（${TIER_NAMES[ds.tier]}${ds.comeback ? '，因为子力落后品质提升了一档' : ''}）：`,
    ...ds.options.map((id, i) => `${i + 1}. ${AUGMENTS[id].name}：${AUGMENTS[id].desc}`),
    '',
    state.rerollsLeft[side] > 0
      ? `你还有 ${state.rerollsLeft[side]} 次刷新机会，可以放弃这三个换一批（choice 填 "reroll"）。`
      : '你没有刷新机会了，只能三选一。',
    '',
    '请结合局面和双方已有的锦囊做出选择，并更新你的作战笔记。',
    '只输出一个 JSON 对象，不要输出其他内容。各字段都用简短的中文：',
    '{',
    '  "situation": "局面判断（不超过 80 字）",',
    '  "choice": 选项编号或 "reroll",',
    '  "reason": "为什么选它（不超过 50 字）",',
    '  "strategy": "拿到这个锦囊之后的策略（不超过 50 字）",',
    '  "plan": "接下来两三步的打算（不超过 60 字）",',
    '  "watch": "需要提防的威胁，包括对方锦囊带来的（不超过 40 字）"',
    '}',
  ]
  return parts.join('\n')
}

// ───────────── 发言请求 ─────────────

export const PERSONAS = {
  calm: { name: '冷静解说', prompt: '语气冷静、客观、专业，像电视上的象棋解说员，偶尔冒出一句冷幽默。' },
  cocky: { name: '嘴硬棋手', prompt: '自信、嘴硬，喜欢调侃两句；局面落后时也不服输，会给自己找理由。调侃点到为止，不人身攻击。' },
  strategist: { name: '古风谋士', prompt: '说话半文半白，像三国时期的谋士，喜欢引用兵法和成语。' },
  rookie: { name: '热血新人', prompt: '热情、一惊一乍，容易被对手的好棋吓到，也会为自己的小优势欢呼，喜欢用感叹号。' },
} as const

export type PersonaId = keyof typeof PERSONAS | 'custom'

export type CommentMoment = 'opening' | 'reply' | 'win' | 'lose' | 'draw'

export interface CommentPromptInput {
  state: GameState
  side: Side
  /** 上次模型行动之后，对方做了什么 */
  opponentActions: TurnRecord[]
  moment: CommentMoment
  persona: string
  /** 对喷模式（模型对战时可选）：对方上一句说了什么。走棋请求里永远没有这个 */
  opponentSpeech?: string
}

export function commentPrompt({
  state,
  side,
  opponentActions,
  moment,
  persona,
  opponentSpeech,
}: CommentPromptInput): string {
  const opening = moment === 'opening'
  // 开场是自我介绍，用不着棋盘
  const parts = opening ? [`你执${SIDE_NAMES[side]}，这是一局带锦囊的中国象棋（象棋大乱斗），对局刚开始。`, ''] : [renderPosition(state, side), '']
  if (opponentActions.length && !opening) {
    parts.push(
      '上次你行动之后，对方：',
      ...opponentActions.map((r) => `- ${r.text}${r.events.length ? `（${r.events.join('；')}）` : ''}`),
      '',
    )
  }
  if (moment === 'reply') {
    const threats = threatsAgainst(state, side)
    if (threats.length) parts.push('目前你的棋子受到的攻击：', ...threats, '')
  }
  if (opponentSpeech) parts.push(`对方刚才对你说：「${opponentSpeech}」`, '')
  parts.push(`你的说话风格：${persona}`, '')
  const task: Record<CommentMoment, string> = {
    opening:
      '向你的对手做个简短的自我介绍：你是谁（你是哪个大模型、哪家公司做的，如果你清楚的话），再用一句话亮出你这局的态度。不用分析局面。',
    reply:
      '用一两句话点评对方刚才这步棋和当前局势，重点说棋盘上发生了什么：吃子、威胁、攻守形势。锦囊只在它刚刚改变了局面时才提。只评论已经发生的事，不要提你接下来打算怎么走。',
    win: '对局结束，你赢了。对你的对手说一句结束语。',
    lose: '对局结束，你输了。对你的对手说一句结束语。',
    draw: '对局结束，双方和棋。对你的对手说一句结束语。',
  }
  parts.push(task[moment])
  if (!opening) parts.push('像棋手对局时随口说的一句话：以评棋为主，不必每句都冲着对手说。')
  if (opponentSpeech) parts.push('对方的话可以简短接一句，也可以不理；重点仍是点评棋局，不要变成吵架，也不要透露你的打算。')
  parts.push('直接输出你要说的话（不超过 60 个字），不要加引号、不要任何格式或解释。')
  return parts.join('\n')
}
