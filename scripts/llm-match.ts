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
 *
 * 对局结束后把回放（含发言和思考）写到 .sim/ 目录。
 * 每一步都是网络请求，CPU 占用很低；规则 AI 只用一个线程。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chooseAction, scoreMoves, type Difficulty } from '../src/ai/bot'
import { applyAction, createGame, other, randomSeed, roundOf, type Action, type GameState, type Side } from '../src/engine'
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
const maxSteps = Number(opt('max-steps', '1000'))
const assist = opt('assist', 'tactics') as AssistLevel
const speak = !flag('no-comment')
const seed = opt('seed', randomSeed())

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\n/g, ' ')

async function main() {
  let state: GameState = createGame(seed)
  const actions: Action[] = []
  const history: TurnRecord[] = []
  const notes: ReplayNote[] = []
  let memo = ''
  let usage: Usage = ZERO_USAGE
  let llmSteps = 0
  let fallbacks = 0
  let reconfirms = 0
  let requests = 0
  let lastLlmIndex = -1
  const t0 = Date.now()

  const apply = (a: Action) => {
    const next = applyAction(state, a)
    history.push(describeAction(state, a, next))
    actions.push(a)
    state = next
  }

  console.log(`种子 ${seed}，模型执${llmSide === 'red' ? '红' : '黑'}，对手规则 AI「${botLevel}」，辅助「${ASSIST_LEVELS[assist].name}」`)

  for (let step = 0; step < 3000 && state.phase !== 'over'; step++) {
    const llmActs =
      (state.phase === 'play' && state.turn === llmSide) ||
      (state.phase === 'draft' && !state.draft!.sides[llmSide].done)
    if (!llmActs) {
      const side: Side = state.phase === 'draft' ? other(llmSide) : state.turn
      const a = chooseAction(state, side, { difficulty: botLevel })
      if (!a) break
      apply(a)
      continue
    }
    if (llmSteps >= maxSteps) break
    llmSteps++

    const index = actions.length
    const theirs = history.slice(lastLlmIndex + 1).filter((r) => r.side !== llmSide)
    const speech =
      speak && (theirs.length > 0 || lastLlmIndex < 0)
        ? comment(profile, {
            state,
            side: llmSide,
            opponentActions: theirs,
            moment: theirs.length ? 'reply' : 'opening',
            persona: PERSONAS.cocky.prompt,
          }).catch((e) => ({ text: '', usage: ZERO_USAGE, error: String(e) }))
        : null

    const started = Date.now()
    const engine = needsEngine(assist) && state.phase === 'play' ? scoreMoves(state, { maxDepth: 4, timeMs: 1200 }) : null
    const d = await decide(profile, { state, side: llmSide, history, memo, assist, engine })
    const said = speech ? await speech : null
    requests += d.requests + (said ? 1 : 0)
    usage = addUsage(usage, d.usage)
    if (said) usage = addUsage(usage, said.usage)

    if (d.analysis.includes('【再确认】')) reconfirms++
    let action: Action
    if (d.ok) {
      action = d.action
      if (d.memo !== null) memo = d.memo
    } else {
      fallbacks++
      action = chooseAction(state, llmSide, { difficulty: 'hard' })!
    }
    const before = state
    apply(action)
    lastLlmIndex = actions.length - 1
    notes.push({
      i: index,
      side: llmSide,
      speech: said?.text || undefined,
      thought: [d.reasoning, d.analysis && `【分析】${d.analysis}`, memo && `【备忘】${memo}`]
        .filter(Boolean)
        .join('\n\n'),
      fallback: d.ok ? undefined : d.reason,
    })
    const rec = history[history.length - 1]
    console.log(
      `#${roundOf(before)} ${rec.text}${rec.events.length ? ` (${rec.events.join('；')})` : ''}` +
        `  [${((Date.now() - started) / 1000).toFixed(1)}s${d.ok ? '' : ` 兜底：${d.reason}`}]`,
    )
    if (said?.text) console.log(`   💬 ${said.text}`)
    if ('error' in (said ?? {})) console.log(`   💬 发言失败：${(said as { error: string }).error}`)
    if (d.analysis) console.log(`   🧠 ${short(d.analysis, 120)}`)
    if (d.analysis.includes('【再确认】')) console.log(`   🔁 ${short(d.analysis.slice(d.analysis.indexOf('【再确认】')), 120)}`)
  }

  const result = state.phase === 'over' ? `${state.winner ? (state.winner === llmSide ? '模型胜' : '模型负') : '和棋'}（${state.endReason}）` : '未下完'
  console.log(`\n结果：${result}，第 ${roundOf(state)} 回合`)
  console.log(`模型行动 ${llmSteps} 次，兜底 ${fallbacks} 次，再确认 ${reconfirms} 次，请求 ${requests} 次，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`)
  console.log(`token：输入 ${usage.input}（缓存命中 ${usage.cached}），输出 ${usage.output}`)

  mkdirSync('.sim', { recursive: true })
  const file = `.sim/llm-match-${seed}.json`
  const replay = makeReplay(
    seed,
    actions,
    { mode: 'llm', [llmSide]: profile.model, [other(llmSide)]: `规则 AI·${botLevel}` },
    notes,
  )
  writeFileSync(file, replayToFile(replay))
  console.log(`回放：${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
