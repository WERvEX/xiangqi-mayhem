import type { Action } from '../engine'
import { complete, LlmError, type LlmProfile, type Usage } from './client'
import { cleanSpeech, parseDraftReply, parseMoveReply } from './parse'
import {
  blunderWarning,
  commentPrompt,
  draftPrompt,
  moveOptions,
  movePrompt,
  systemPrompt,
  type CommentPromptInput,
  type MovePromptInput,
} from './prompt'

/**
 * 大模型棋手：不依赖界面，浏览器和命令行脚本共用。
 * 本身不保存状态，备忘和历史由调用方传入，这样悔棋时只要丢掉对应的记录即可。
 */

export const ZERO_USAGE: Usage = { input: 0, output: 0, cached: 0 }

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cached: a.cached + b.cached,
})

/** 一个请求最多试几次（包括格式错误后的重试） */
const MAX_ATTEMPTS = 2

/** 走棋输出：分析 + 备忘 + 编号，留足余量给默认开启思考的模型 */
const DECIDE_MAX_TOKENS = 8192
const COMMENT_MAX_TOKENS = 2048

const TRUNCATED = '模型思考太长，用完了输出上限，没来得及给出答案。建议把「思考强度」调低或关闭'

interface DecideBase {
  analysis: string
  /** 模型自带推理的内容 */
  reasoning: string
  usage: Usage
  requests: number
}

export type DecideResult =
  | (DecideBase & { ok: true; action: Action; memo: string | null; reason: string })
  | (DecideBase & { ok: false; reason: string })

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new LlmError('aborted', '已取消'))
    })
  })

/**
 * 让模型决定这一步（走子，或者在锦囊阶段选锦囊）。
 * 致命错误（密钥、余额、网络等）和取消会抛出 LlmError；
 * 其余失败（格式错误、超时、服务商临时出错）重试后仍不行，返回 ok: false，由调用方兜底。
 */
export async function decide(
  profile: LlmProfile,
  input: MovePromptInput,
  signal?: AbortSignal,
  /** 提供时用流式输出，实时回调模型到目前为止输出的思考和回答 */
  onDelta?: (so: { reasoning: string; text: string }) => void,
): Promise<DecideResult> {
  const { state, side } = input
  const isDraft = state.phase === 'draft'
  const options = isDraft ? [] : moveOptions(state, input.assist, input.engine)
  const user = isDraft ? draftPrompt(input) : movePrompt(input, options)
  const ds = isDraft ? state.draft!.sides[side] : null

  let usage = ZERO_USAGE
  let requests = 0
  let analysis = ''
  let reasoning = ''
  let feedback = ''
  let reason = ''
  /** 选了坏棋、正在请它再确认时，记下第一次的选择：确认请求失败就按第一次的走 */
  let first: { index: number; analysis: string; memo: string | null; reason: string } | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let text: string
    let truncated = false
    try {
      const res = await complete(profile, {
        system: systemPrompt(),
        user: user + feedback,
        maxTokens: DECIDE_MAX_TOKENS,
        json: true,
        signal,
        onDelta,
      })
      requests++
      usage = addUsage(usage, res.usage)
      text = res.text
      reasoning = res.reasoning
      truncated = res.truncated
    } catch (e) {
      if (!(e instanceof LlmError) || e.fatal || e.kind === 'aborted') throw e
      // 超时不重试：再等一轮通常也是一样慢，直接兜底
      if (e.kind === 'timeout') {
        reason = `模型思考超时（${profile.timeoutSec ?? 120} 秒）。可以把思考强度设为「关闭」，或者在模型设置里调整超时`
        break
      }
      reason = e.message
      if (attempt + 1 < MAX_ATTEMPTS) await sleep(e.kind === 'rate' ? (e.retryAfter ?? 5) * 1000 : 1000, signal)
      continue
    }

    if (ds) {
      const r = parseDraftReply(text, ds.options.length, state.rerollsLeft[side] > 0)
      analysis = r.analysis
      if (r.ok) {
        const action: Action =
          r.value === 'reroll'
            ? { type: 'reroll', side }
            : { type: 'pick', side, augmentId: ds.options[r.value] }
        return { ok: true, action, analysis, memo: r.memo, reason: r.reason, reasoning, usage, requests }
      }
      reason = r.error
    } else {
      const r = parseMoveReply(text, options.length)
      analysis = first ? `${first.analysis}
【再确认】${r.analysis}` : r.analysis
      if (r.ok) {
        const warning = first ? null : blunderWarning(options, r.value)
        if (warning) {
          // 再问一次，这次不算重试次数
          first = { index: r.value, analysis: r.analysis, memo: r.memo, reason: r.reason }
          feedback = `

注意：${warning}
你上一次的分析是：${r.analysis || '（无）'}`
          attempt--
          continue
        }
        return { ok: true, action: options[r.value].action, analysis, memo: r.memo, reason: r.reason, reasoning, usage, requests }
      }
      reason = r.error
    }
    if (truncated && !text.trim()) reason = TRUNCATED
    feedback = `\n\n注意：你上一次的回复无法使用（${reason}）。请严格按要求只输出一个 JSON 对象。`
  }
  if (first) {
    return { ok: true, action: options[first.index].action, analysis, memo: first.memo, reason: first.reason, reasoning, usage, requests }
  }
  return { ok: false, reason, analysis, reasoning, usage, requests }
}

/** 发言。任何错误都抛出，调用方可以直接忽略（发言是锦上添花） */
export async function comment(
  profile: LlmProfile,
  input: CommentPromptInput,
  signal?: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
  const res = await complete(profile, {
    system: systemPrompt(),
    user: commentPrompt({ ...input, model: profile.model }),
    maxTokens: COMMENT_MAX_TOKENS,
    signal,
  })
  return { text: cleanSpeech(res.text), usage: res.usage }
}
