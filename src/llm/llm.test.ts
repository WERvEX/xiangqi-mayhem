import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAction, createGame, legalMoves, type GameState, type Piece, type PieceType, type Side } from '../engine'
import { moveTags } from './annotate'
import { scoreMoves } from '../ai/bot'
import { endpoint, LlmError, thinkingOffParams, type LlmProfile } from './client'
import { parseSquare, square } from './notation'
import { cleanSpeech, extractJson, parseDraftReply, parseMoveReply } from './parse'
import { decide } from './player'
import { describeAction, moveOptions, movePrompt, renderPosition } from './prompt'

type Spec = [Side, PieceType, number, number]

function position(specs: Spec[], turn: Side = 'red'): GameState {
  const s = createGame('llm-test')
  s.phase = 'play'
  s.draft = null
  s.draftsDone = 99
  s.turn = turn
  s.pieces = specs.map(
    ([side, type, x, y], i): Piece => ({ id: `${side[0]}${type}${i}`, type, side, x, y, alive: true, home: { x, y }, shield: 0 }),
  )
  return s
}

/** 跳过开局的锦囊选择 */
function started(seed = 'llm-test'): GameState {
  let s = createGame(seed)
  while (s.phase === 'draft') {
    const side: Side = s.draft!.sides.red.done ? 'black' : 'red'
    s = applyAction(s, { type: 'pick', side, augmentId: s.draft!.sides[side].options[0] })
  }
  return s
}

describe('坐标', () => {
  it('红帅开局在 e0，黑将在 e9', () => {
    const s = createGame('x')
    const king = (side: Side) => s.pieces.find((p) => p.side === side && p.type === 'K')!
    expect(square(king('red'))).toBe('e0')
    expect(square(king('black'))).toBe('e9')
  })
  it('解析与输出互逆', () => {
    for (const sq of ['a0', 'e4', 'i9']) expect(square(parseSquare(sq)!)).toBe(sq)
    expect(parseSquare('j3')).toBeNull()
  })
})

describe('解析回复', () => {
  it('纯 JSON、代码块、前后有说明的 JSON', () => {
    expect(extractJson('{"move": 3}')).toEqual({ move: 3 })
    expect(extractJson('```json\n{"move": 3, "memo": "x"}\n```')).toEqual({ move: 3, memo: 'x' })
    expect(extractJson('我想了想。\n{"analysis": "a {b}", "move": 7}\n就这样')).toEqual({ analysis: 'a {b}', move: 7 })
    expect(extractJson('<think>{"move": 1}</think>{"move": 2}')).toEqual({ move: 2 })
  })
  it('走法编号：JSON、字符串数字、正则兜底、越界', () => {
    expect(parseMoveReply('{"analysis":"a","memo":"m","move":5}', 10)).toMatchObject({ ok: true, value: 4, memo: 'm' })
    expect(parseMoveReply('{"move":"5"}', 10)).toMatchObject({ ok: true, value: 4 })
    expect(parseMoveReply('分析了一下……\n走法：8', 10)).toMatchObject({ ok: true, value: 7 })
    expect(parseMoveReply('{"move": 11}', 10)).toMatchObject({ ok: false })
    expect(parseMoveReply('', 10)).toMatchObject({ ok: false })
  })
  it('锦囊选择：编号、刷新、没有刷新机会时拒绝刷新', () => {
    expect(parseDraftReply('{"choice": 2}', 3, true)).toMatchObject({ ok: true, value: 1 })
    expect(parseDraftReply('{"choice": "reroll"}', 3, true)).toMatchObject({ ok: true, value: 'reroll' })
    expect(parseDraftReply('{"choice": "reroll"}', 3, false)).toMatchObject({ ok: false })
  })
  it('发言去掉引号和推理', () => {
    expect(cleanSpeech('<think>嗯</think>“就这？”')).toBe('就这？')
  })
})

describe('提示词', () => {
  it('走法列表覆盖全部合法走法，编号从 1 开始', () => {
    const s = started()
    const opts = moveOptions(s, 'facts')
    expect(opts).toHaveLength(legalMoves(s).length)
    const text = movePrompt({ state: s, side: s.turn, history: [], memo: '', assist: 'facts' }, opts)
    expect(text).toContain(`1. ${opts[0].label}`)
    expect(text).toContain(`${opts.length}. ${opts[opts.length - 1].label}`)
  })
  it('局面里列出双方棋子和护盾', () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['black', 'K', 4, 0],
      ['red', 'R', 0, 9],
    ])
    s.pieces[2].shield = 1
    const text = renderPosition(s, 'red')
    expect(text).toContain('俥 a0[盾]')
    expect(text).toContain('將 e9')
  })
  it('操作记录写明走法和吃子', () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['black', 'K', 3, 0],
      ['red', 'R', 0, 9],
      ['black', 'N', 0, 2],
    ])
    const a = { type: 'move', side: 'red', pieceId: 'rR2', to: { x: 0, y: 2 } } as const
    const r = describeAction(s, a, applyAction(s, a))
    expect(r.text).toBe('俥 a0→a7 吃 馬')
  })
})

describe('辅助标注', () => {
  it('送将、将军', () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['black', 'K', 3, 0],
      ['black', 'R', 0, 8],
      ['red', 'R', 8, 5],
    ])
    const find = (id: string, x: number, y: number) =>
      legalMoves(s).find((m) => m.pieceId === id && m.to.x === x && m.to.y === y)!
    expect(moveTags(s, find('rK0', 4, 8))).toContain('⚠走后己方将帅可被吃')
    expect(moveTags(s, find('rR3', 3, 5))).toContain('将军')
  })
  it('走完这步要先选锦囊时，仍然标出送将', () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['black', 'K', 3, 0],
      ['black', 'R', 0, 8],
    ])
    // 第 5 回合黑方走棋前发放锦囊：红方这步走完就进入锦囊选择
    s.draftsDone = 1
    s.turnNo = 8
    const m = legalMoves(s).find((mv) => mv.to.x === 4 && mv.to.y === 8)!
    expect(applyAction(s, { type: 'move', side: 'red', pieceId: m.pieceId, to: m.to }).phase).toBe('draft')
    expect(moveTags(s, m)).toContain('⚠走后己方将帅可被吃')
  })
})

describe('战术检查', () => {
  // 黑将 d9（x=3,y=0）被红车 a8 + 红车 b7 双车错叫杀：黑方不处理就会被吃将
  const threatened = () =>
    position(
      [
        ['red', 'K', 4, 9],
        ['black', 'K', 3, 0],
        ['red', 'R', 0, 1],
        ['red', 'R', 1, 2],
        ['black', 'P', 8, 3],
        ['black', 'R', 8, 0],
      ],
      'black',
    )

  it('引擎打分覆盖全部走法，并标出会被强制吃将的走法', () => {
    const s = threatened()
    const scores = scoreMoves(s, { maxDepth: 3, timeMs: 5000 })
    expect(scores).toHaveLength(legalMoves(s).length)
    expect(scores.some((x) => x.loss)).toBe(true)
    expect(scores.some((x) => !x.loss)).toBe(true)
  })

  it('被叫杀时，提示词点明能解杀的走法', () => {
    const s = threatened()
    const engine = scoreMoves(s, { maxDepth: 3, timeMs: 5000 })
    const opts = moveOptions(s, 'tactics', engine)
    const text = movePrompt({ state: s, side: 'black', history: [], memo: '', assist: 'tactics', engine }, opts)
    // 只有車 i9→e9（把车横到将的旁边、同时威胁吃帅）能解杀
    const safe = opts.flatMap((o, i) => (o.loss === false ? [i + 1] : []))
    expect(safe).toHaveLength(1)
    expect(opts[safe[0] - 1].label).toContain('車 i9→e9')
    expect(text).toContain(`只有这些走法能避免被强制吃将：编号 ${safe[0]}`)
  })

  it('能杀棋时提示，裸考时不加任何标注', () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['black', 'K', 3, 0],
      ['red', 'R', 3, 5],
    ])
    const engine = scoreMoves(s, { maxDepth: 2 })
    const opts = moveOptions(s, 'tactics', engine)
    expect(opts.some((o) => o.win)).toBe(true)
    expect(moveOptions(s, 'off', engine).every((o) => !o.label.includes('〔'))).toBe(true)
  })

  it('引擎推荐等级标出前三步', () => {
    const s = started()
    const engine = scoreMoves(s, { maxDepth: 2 })
    const labels = moveOptions(s, 'engine', engine).map((o) => o.label)
    for (const n of [1, 2, 3]) expect(labels.filter((l) => l.includes(`引擎推荐 ${n}`))).toHaveLength(1)
  })
})

describe('接入层', () => {
  it('按服务商选择关闭思考的参数', () => {
    expect(thinkingOffParams('https://ark.cn-beijing.volces.com/api/plan/v3')).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingOffParams('https://dashscope.aliyuncs.com/compatible-mode/v1')).toEqual({ enable_thinking: false })
    expect(thinkingOffParams('https://api.openai.com/v1')).toEqual({ reasoning_effort: 'none' })
    expect(thinkingOffParams('http://localhost:11434/v1')).toHaveProperty('enable_thinking', false)
  })

  const profile: LlmProfile = {
    id: 't',
    name: 't',
    protocol: 'anthropic',
    baseUrl: 'https://api.example.com/',
    apiKey: 'k',
    model: 'm',
    reasoning: 'default',
  }

  it('拼接地址与转发', () => {
    expect(endpoint(profile, '/messages')).toBe('https://api.example.com/v1/messages')
    expect(endpoint({ ...profile, protocol: 'openai', baseUrl: 'https://x.com/v1' }, '/models')).toBe('https://x.com/v1/models')
    expect(endpoint({ ...profile, proxy: 'http://127.0.0.1:8787/' }, '/messages')).toBe(
      'http://127.0.0.1:8787/https://api.example.com/v1/messages',
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  const reply = (text: string, status = 200) =>
    new Response(
      JSON.stringify(
        status === 200
          ? { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' }
          : { error: { message: text } },
      ),
      { status },
    )

  it('服务商不接受关闭思考的参数时，自动去掉再试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'unknown field enable_thinking' } }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"move": 1}' } }], usage: {} }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const p: LlmProfile = { ...profile, protocol: 'openai', baseUrl: 'https://llm.example.com/v1', reasoning: 'off' }
    const s = started()
    const d = await decide(p, { state: s, side: s.turn, history: [], memo: '', assist: 'off' })
    expect(d.ok).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveProperty('enable_thinking', false)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('enable_thinking')
  })

  it('选了送将的走法时请模型再确认一次，坚持就按它的走', async () => {
    const s = position([
      ['red', 'K', 4, 9],
      ['black', 'K', 3, 0],
      ['black', 'R', 0, 8],
      ['red', 'R', 8, 5],
    ])
    const opts = moveOptions(s, 'facts')
    const bad = opts.findIndex((o) => o.exposes) + 1
    const good = opts.findIndex((o) => !o.exposes) + 1
    const input = { state: s, side: 'red' as const, history: [], memo: '', assist: 'facts' as const }

    // 改主意
    let fetchMock = vi.fn().mockResolvedValueOnce(reply(`{"move": ${bad}}`)).mockResolvedValueOnce(reply(`{"move": ${good}}`))
    vi.stubGlobal('fetch', fetchMock)
    let d = await decide(profile, input)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[0].content).toContain('如果你确定要这么走')
    expect(d.ok && d.action).toEqual(opts[good - 1].action)

    // 坚持
    fetchMock = vi.fn().mockImplementation(async () => reply(`{"move": ${bad}}`))
    vi.stubGlobal('fetch', fetchMock)
    d = await decide(profile, input)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(d.ok && d.action).toEqual(opts[bad - 1].action)
  })

  it('格式错误时带着错误原因重试一次', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply('我选第一百号')).mockResolvedValueOnce(reply('{"move": 1, "memo": "m"}'))
    vi.stubGlobal('fetch', fetchMock)
    const s = started()
    const d = await decide(profile, { state: s, side: s.turn, history: [], memo: '', assist: 'off' })
    expect(d.ok).toBe(true)
    expect(d.requests).toBe(2)
    expect(d.usage.input).toBe(20)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[0].content).toContain('无法使用')
  })

  it('一直答不对就返回失败，由调用方兜底', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply('不知道')))
    const s = started()
    const d = await decide(profile, { state: s, side: s.turn, history: [], memo: '', assist: 'off' })
    expect(d.ok).toBe(false)
  })

  it('密钥错误直接抛出，不重试', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply('invalid x-api-key', 401))
    vi.stubGlobal('fetch', fetchMock)
    const s = started()
    await expect(decide(profile, { state: s, side: s.turn, history: [], memo: '', assist: 'off' })).rejects.toSatisfy(
      (e) => e instanceof LlmError && e.kind === 'auth',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('锦囊阶段返回选锦囊的操作', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply('{"choice": 2}')))
    const s = createGame('llm-test')
    const side: Side = s.draft!.sides.red.done ? 'black' : 'red'
    const d = await decide(profile, { state: s, side, history: [], memo: '', assist: 'facts' })
    expect(d.ok && d.action).toEqual({ type: 'pick', side, augmentId: s.draft!.sides[side].options[1] })
  })
})
