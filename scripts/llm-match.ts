/**
 * 命令行：大模型对规则 AI，用于调提示词、观察模型的合法率和兜底率。
 *
 * 模型配置从环境变量读取（密钥不要写进任何文件）：
 *   XQM_LLM_PROTOCOL  anthropic | openai
 *   XQM_LLM_BASE      接口地址，如 https://api.deepseek.com
 *   XQM_LLM_KEY       API 密钥
 *   XQM_LLM_MODEL     模型名
 *   XQM_LLM_REASONING default | off | low | medium | high（可选）
 *
 *   npm run llm-match -- --bot beginner --side red --max-steps 40
 *   npm run llm-match -- --assist off --no-comment     # 辅助等级：off | facts | tactics（默认）| engine
 *   npm run llm-match -- --eve --hear                   # 模型对战模型（黑方可用 XQM_LLM2_* 指定另一个模型），对喷模式
 *
 * 对局结束后把回放（含发言和思考）写到 .sim/ 目录。
 * 每一步都是网络请求，CPU 占用很低；规则 AI 只用一个线程。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chooseAction, scoreMoves, type Difficulty } from '../src/ai/bot'
import { applyAction, createGame, randomSeed, roundOf, type Action, type GameState, type Side } from '../src/engine'
import type { LlmProfile, Protocol, Reasoning, Usage } from '../src/llm/client'
import { addUsage, comment, decide, ZERO_USAGE } from '../src/llm/player'
import { ASSIST_LEVELS, describeAction, needsEngine, PERSONAS, type AssistLevel, type TurnRecord } from '../src/llm/prompt'
import { makeReplay, replayToFile, type ReplayNote } from '../src/replay/replay'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const env = (k: string) => {
  const v = process.env[k]
  if (!v) {
    console.error(`缺少环境变量 ${k}`)
    process.exit(1)
  }
  return v
}

const profile: LlmProfile = {
  id: 'cli',
  name: 'cli',
  protocol: env('XQM_LLM_PROTOCOL') as Protocol,
  baseUrl: env('XQM_LLM_BASE'),
  apiKey: env('XQM_LLM_KEY'),
  model: env('XQM_LLM_MODEL'),
  reasoning: (process.env.XQM_LLM_REASONING ?? 'default') as Reasoning,
  timeoutSec: 180,
}

const botLevel = opt('bot', 'beginner') as Difficulty
const llmSide = opt('side', 'red') as Side
const eve = flag('eve')
const hear = flag('hear')
const maxSteps = Number(opt('max-steps', '1000'))
const assist = opt('assist', 'tactics') as AssistLevel
const speak = !flag('no-comment')
const seed = opt('seed', randomSeed())

/** 模型对战模型时，黑方可以用另一套环境变量（XQM_LLM2_*）指定另一个模型，不指定就自己打自己 */
const profile2: LlmProfile = process.env.XQM_LLM2_KEY
  ? {
      ...profile,
      id: 'cli2',
      protocol: (process.env.XQM_LLM2_PROTOCOL ?? profile.protocol) as Protocol,
      baseUrl: process.env.XQM_LLM2_BASE ?? profile.baseUrl,
      apiKey: process.env.XQM_LLM2_KEY,
      model: process.env.XQM_LLM2_MODEL ?? profile.model,
      reasoning: (process.env.XQM_LLM2_REASONING ?? profile.reasoning) as Reasoning,
    }
  : profile

interface Seat {
  profile: LlmProfile
  persona: string
  memo: string
  /** 最近几步的决策和理由 */
  decisions: string[]
  usage: Usage
  steps: number
  fallbacks: number
  reconfirms: number
  requests: number
  /** 这一方上次行动的操作序号 */
  last: number
}

const seat = (p: LlmProfile, persona: string): Seat => ({
  profile: p,
  persona,
  memo: '',
  decisions: [],
  usage: ZERO_USAGE,
  steps: 0,
  fallbacks: 0,
  reconfirms: 0,
  requests: 0,
  last: -1,
})

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\n/g, ' ')

async function main() {
  let state: GameState = createGame(seed)
  const actions: Action[] = []
  const history: TurnRecord[] = []
  const notes: ReplayNote[] = []
  // 模型对战模型：双方都是模型；否则 llmSide 是模型，另一方是规则 AI
  const seats: Partial<Record<Side, Seat>> = eve
    ? { red: seat(profile, PERSONAS.cocky.prompt), black: seat(profile2, PERSONAS.strategist.prompt) }
    : { [llmSide]: seat(profile, PERSONAS.cocky.prompt) }
  const t0 = Date.now()

  const apply = (a: Action) => {
    const next = applyAction(state, a)
    history.push(describeAction(state, a, next))
    actions.push(a)
    state = next
  }

  const sideName = (side: Side) => (seats[side] ? seats[side]!.profile.model : `规则 AI「${botLevel}」`)
  console.log(
    `种子 ${seed}，红：${sideName('red')}，黑：${sideName('black')}，辅助「${ASSIST_LEVELS[assist].name}」${hear ? '，对喷模式' : ''}`,
  )

  for (let step = 0; step < 3000 && state.phase !== 'over'; step++) {
    // 轮到谁：走棋看 turn；选锦囊时先红后黑
    const side: Side =
      state.phase === 'draft' ? (state.draft!.sides.red.done ? 'black' : 'red') : state.turn
    const me = seats[side]
    if (!me) {
      const a = chooseAction(state, side, { difficulty: botLevel })
      if (!a) break
      apply(a)
      continue
    }
    if (me.steps >= maxSteps) break
    me.steps++

    const index = actions.length
    const theirs = history.slice(me.last + 1).filter((r) => r.side !== side)
    // 开局先自我介绍，之后只在对方走了棋时点评（只选了锦囊不算）
    const moved = actions.slice(me.last + 1).some((a) => a.side !== side && a.type === 'move')
    // 对喷模式：对方最近一句话
    const heard = hear ? notes.filter((n) => n.side !== side && n.speech).at(-1)?.speech : undefined
    const speech =
      speak && (moved || me.last < 0)
        ? comment(me.profile, {
            state,
            side,
            opponentActions: theirs,
            moment: me.last < 0 ? 'opening' : 'reply',
            persona: me.persona,
            opponentSpeech: heard,
          }).catch((e) => ({ text: '', usage: ZERO_USAGE, error: String(e) }))
        : null

    const started = Date.now()
    const engine = needsEngine(assist) && state.phase === 'play' ? scoreMoves(state, { maxDepth: 4, timeMs: 1200 }) : null
    const d = await decide(me.profile, { state, side, history, memo: me.memo, decisions: me.decisions, assist, engine })
    const said = speech ? await speech : null
    me.requests += d.requests + (said ? 1 : 0)
    me.usage = addUsage(me.usage, d.usage)
    if (said) me.usage = addUsage(me.usage, said.usage)

    if (d.analysis.includes('【再确认】')) me.reconfirms++
    let action: Action
    if (d.ok) {
      action = d.action
      if (d.memo !== null) me.memo = d.memo
    } else {
      me.fallbacks++
      action = chooseAction(state, side, { difficulty: 'hard' })!
    }
    const before = state
    apply(action)
    me.last = actions.length - 1
    if (d.ok && d.reason) {
      const rec = history[history.length - 1]
      me.decisions = [...me.decisions, `第 ${rec.round} 回合 ${rec.text}：${d.reason}`].slice(-3)
    }
    notes.push({
      i: index,
      side,
      speech: said?.text || undefined,
      thought: [d.analysis, d.ok && d.memo, d.reasoning && `【推理过程】\n${d.reasoning}`].filter(Boolean).join('\n\n'),
      fallback: d.ok ? undefined : d.reason,
    })
    const rec = history[history.length - 1]
    const tag = eve ? (side === 'red' ? '红' : '黑') : ''
    console.log(
      `#${roundOf(before)}${tag} ${rec.text}${rec.events.length ? ` (${rec.events.join('；')})` : ''}` +
        `  [${((Date.now() - started) / 1000).toFixed(1)}s${d.ok ? '' : ` 兜底：${d.reason}`}]`,
    )
    if (said?.text) console.log(`   💬 ${said.text}`)
    if ('error' in (said ?? {})) console.log(`   💬 发言失败：${(said as { error: string }).error}`)
    if (d.analysis) console.log(`   🧠 ${short(d.analysis, 160)}`)
    if (d.ok && d.memo) console.log(`   📒 ${short(d.memo, 160)}`)
    if (d.analysis.includes('【再确认】')) console.log(`   🔁 ${short(d.analysis.slice(d.analysis.indexOf('【再确认】')), 120)}`)
  }

  const result =
    state.phase === 'over'
      ? `${state.winner ? `${state.winner === 'red' ? '红' : '黑'}方（${sideName(state.winner)}）胜` : '和棋'}（${state.endReason}）`
      : '未下完'
  console.log(`\n结果：${result}，第 ${roundOf(state)} 回合，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`)
  for (const side of ['red', 'black'] as Side[]) {
    const me = seats[side]
    if (!me) continue
    console.log(
      `${side === 'red' ? '红' : '黑'}方 ${me.profile.model}：行动 ${me.steps} 次，兜底 ${me.fallbacks} 次，再确认 ${me.reconfirms} 次，` +
        `请求 ${me.requests} 次，token 输入 ${me.usage.input}（缓存 ${me.usage.cached}），输出 ${me.usage.output}`,
    )
  }

  mkdirSync('.sim', { recursive: true })
  const file = `.sim/llm-match-${seed}.json`
  const replay = makeReplay(seed, actions, { mode: eve ? 'eve' : 'llm', red: sideName('red'), black: sideName('black') }, notes)
  writeFileSync(file, replayToFile(replay))
  console.log(`回放：${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
