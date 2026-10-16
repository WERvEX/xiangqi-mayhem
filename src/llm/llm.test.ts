import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAction, createGame, legalMoves, type GameState, type Piece, type PieceType, type Side } from '../engine'
import { moveTags } from './annotate'
import { scoreMoves } from '../ai/bot'
import { endpoint, LlmError, thinkingOffCandidates, thinkingOffRejected, type LlmProfile } from './client'
import { parseSquare, square } from './notation'
import { cleanSpeech, extractJson, parseDraftReply, parseMoveReply } from './parse'
import { decide } from './player'
import { commentPrompt, describeAction, moveOptions, movePrompt, renderPosition } from './prompt'

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
  it('结构化回复：局面、理由进分析，策略、计划、提防进作战笔记', () => {
    const r = parseMoveReply(
      '{"situation":"红方子力领先","strategy":"稳步进攻","move":2,"reason":"出车占肋道","plan":"车炮压中路","watch":"对方马跳卧槽"}',
      5,
    )
    expect(r).toMatchObject({ ok: true, value: 1, reason: '出车占肋道' })
    if (!r.ok) return
    expect(r.analysis).toBe('局面：红方子力领先\n这步：出车占肋道')
    expect(r.memo).toBe('策略：稳步进攻\n计划：车炮压中路\n提防：对方马跳卧槽')
    // 旧格式仍然兼容
    expect(parseMoveReply('{"analysis":"a","memo":"m","move":1}', 3)).toMatchObject({ ok: true, analysis: 'a', memo: 'm' })
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
  it('作战笔记和最近的决策放回提示词', () => {
    const s = started()
    const text = movePrompt(
      { state: s, side: s.turn, history: [], memo: '策略：稳步进攻', decisions: ['第 3 回合 俥 a0→a2：出车'], assist: 'off' },
      moveOptions(s, 'off'),
    )
    expect(text).toContain('你的作战笔记（上一步写的）：\n策略：稳步进攻')
    expect(text).toContain('- 第 3 回合 俥 a0→a2：出车')
    expect(text).toContain('"strategy"')
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

describe('模型对战的隔离', () => {
  it('对喷模式下发言请求带上对方的话，走棋请求里永远没有', () => {
    const s = started()
    const said = '你这步棋臭得很'
    const talk = commentPrompt({ state: s, side: s.turn, opponentActions: [], moment: 'reply', persona: 'x', opponentSpeech: said })
    expect(talk).toContain(said)
    expect(commentPrompt({ state: s, side: s.turn, opponentActions: [], moment: 'reply', persona: 'x' })).not.toContain('对方刚才对你说')
    // 走棋请求的输入里根本没有发言字段
    const move = movePrompt({ state: s, side: s.turn, history: [], memo: '', assist: 'facts' }, moveOptions(s, 'facts'))
    expect(move).not.toContain(said)
  })

  it('开场发言是自我介绍，不带棋盘', () => {
    const s = started()
    const intro = commentPrompt({ state: s, side: 'black', opponentActions: [], moment: 'opening', persona: 'x' })
    expect(intro).toContain('自我介绍')
    expect(intro).toContain('黑方')
    expect(intro).not.toContain(renderPosition(s, 'black'))
  })

  it('开场告诉模型实际调用的模型 ID，之后的发言不带', () => {
    const s = started()
    const input = { state: s, side: 'black' as const, opponentActions: [], persona: 'x', model: 'glm-5-3-flash' }
    expect(commentPrompt({ ...input, moment: 'opening' })).toContain('glm-5-3-flash')
    expect(commentPrompt({ ...input, moment: 'reply' })).not.toContain('glm-5-3-flash')
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
  it('按服务商给出关闭思考的候选写法', () => {
    const openai = (baseUrl: string) => thinkingOffCandidates({ protocol: 'openai', baseUrl })
    // 火山方舟：DeepSeek 认第一种，GLM 只认第二种
    expect(openai('https://ark.cn-beijing.volces.com/api/plan/v3')).toEqual([
      { thinking: { type: 'disabled' } },
      { reasoning_effort: 'minimal' },
    ])
    expect(openai('https://dashscope.aliyuncs.com/compatible-mode/v1')).toEqual([{ enable_thinking: false }])
    expect(openai('https://api.openai.com/v1')[0]).toEqual({ reasoning_effort: 'none' })
    expect(openai('http://localhost:11434/v1').length).toBeGreaterThan(1)
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

  it('关闭思考的写法不被接受时换下一种，并记住有效的写法', async () => {
    const ok = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"move": 1}' } }], usage: {} }), { status: 200 })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'thinking.type `disabled` is not supported by this model' } }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    const p: LlmProfile = { ...profile, protocol: 'openai', baseUrl: 'https://llm.example.com/v1', reasoning: 'off' }
    const s = started()
    const input = { state: s, side: s.turn, history: [], memo: '', assist: 'off' as const }
    expect((await decide(p, input)).ok).toBe(true)
    const body = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body)
    expect(body(0)).toHaveProperty('thinking', { type: 'disabled' })
    expect(body(1)).not.toHaveProperty('thinking')
    expect(body(1)).toHaveProperty('enable_thinking', false)
    // 下一次直接用有效的写法
    await decide(p, input)
    expect(body(2)).toHaveProperty('enable_thinking', false)
    expect(thinkingOffRejected(p)).toBe(false)
  })

  it('所有关闭思考的写法都不被接受时去掉参数，并提示', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply('thinking.type `disabled` is not supported by this model', 400))
      .mockResolvedValueOnce(reply('{"move": 1}'))
    vi.stubGlobal('fetch', fetchMock)
    const p: LlmProfile = { ...profile, baseUrl: 'https://glm.example.com', reasoning: 'off' }
    const s = started()
    expect((await decide(p, { state: s, side: s.turn, history: [], memo: '', assist: 'off' })).ok).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('thinking')
    expect(thinkingOffRejected(p)).toBe(true)
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

  const sse = (events: unknown[]) => {
    const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
    // 故意切成小块，检查跨块拼接
    const bytes = new TextEncoder().encode(text)
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
          c.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }

  it('流式输出：Anthropic 格式边收边回调，最后拼成完整结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先看看' } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '局面' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"move": ' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: '1}' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
        ]),
      ),
    )
    const seen: string[] = []
    const s = started()
    const d = await decide(profile, { state: s, side: s.turn, history: [], memo: '', assist: 'off' }, undefined, (x) =>
      seen.push(x.reasoning + '|' + x.text),
    )
    expect(d.ok).toBe(true)
    expect(d.reasoning).toBe('先看看局面')
    expect(d.usage).toEqual({ input: 60, output: 12, cached: 10 })
    expect(seen.at(-1)).toBe('先看看局面|{"move": 1}')
    expect(seen.length).toBeGreaterThan(1)
  })

  it('流式输出：OpenAI 兼容格式，带推理内容和最后的用量', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sse([
        { choices: [{ delta: { reasoning_content: '想一下' } }] },
        { choices: [{ delta: { content: '{"move": 2}' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 8 } },
        '[DONE]',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p: LlmProfile = { ...profile, protocol: 'openai', baseUrl: 'https://stream.example.com/v1' }
    const s = started()
    const d = await decide(p, { state: s, side: s.turn, history: [], memo: '', assist: 'off' }, undefined, () => {})
    expect(d.ok).toBe(true)
    expect(d.reasoning).toBe('想一下')
    expect(d.usage.output).toBe(8)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
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
