/**
 * 大模型接入层：Anthropic 接口和 OpenAI 兼容接口，均用 fetch 手写。
 *
 * 不用官方 SDK：SDK 会附带一批 x-stainless-* 请求头，很多第三方兼容接口的跨域设置不允许这些头，
 * 浏览器会直接拦截请求。我们只需要"发一条消息、拿一段文本"，手写更可控。
 */

export type Protocol = 'anthropic' | 'openai'

/** 思考强度：default 不传参数，由服务商决定 */
export type Reasoning = 'default' | 'off' | 'low' | 'medium' | 'high'

export interface LlmProfile {
  id: string
  /** 显示名，如"DeepSeek" */
  name: string
  protocol: Protocol
  /** 如 https://api.anthropic.com 或 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  reasoning: Reasoning
  /** 可选的转发地址：请求会发到 `${proxy}/${完整目标地址}`，用于不支持浏览器直连的服务商 */
  proxy?: string
  /** 合并进请求体的额外参数（JSON），用于各家特有的开关，如 {"enable_thinking": false} */
  extraBody?: string
  /** 单次请求超时（秒） */
  timeoutSec?: number
}

export interface LlmRequest {
  system: string
  user: string
  maxTokens: number
  /** 希望返回 JSON。OpenAI 兼容接口会尝试开启 JSON 模式 */
  json?: boolean
  signal?: AbortSignal
  /** 提供时用流式输出：模型边想边返回，每收到一段就回调一次（参数是到目前为止的全部内容） */
  onDelta?: (so: { reasoning: string; text: string }) => void
}

export interface Usage {
  input: number
  output: number
  /** 命中缓存的输入 token */
  cached: number
}

export interface LlmResponse {
  text: string
  /** 模型自带推理的内容（如果接口返回了） */
  reasoning: string
  usage: Usage
  /** 输出达到上限被截断 */
  truncated: boolean
}

export type LlmErrorKind =
  | 'auth' // 密钥错误、没有权限
  | 'quota' // 余额不足
  | 'model' // 模型不存在
  | 'rate' // 限流
  | 'bad-request' // 参数不被接受
  | 'server' // 服务商出错
  | 'network' // 连不上，包括被浏览器跨域拦截
  | 'timeout'
  | 'aborted'

export class LlmError extends Error {
  kind: LlmErrorKind
  status?: number
  /** 限流时建议等待的秒数 */
  retryAfter?: number
  constructor(kind: LlmErrorKind, message: string, status?: number, retryAfter?: number) {
    super(message)
    this.kind = kind
    this.status = status
    this.retryAfter = retryAfter
  }

  /** 重试也没用、需要玩家处理的错误 */
  get fatal() {
    return ['auth', 'quota', 'model', 'network', 'bad-request'].includes(this.kind)
  }
}

export const ERROR_HINTS: Record<LlmErrorKind, string> = {
  auth: '密钥无效或没有权限',
  quota: '余额或额度不足',
  model: '模型名不存在，或者这个密钥不能用这个模型',
  rate: '请求太频繁，被服务商限流',
  'bad-request': '服务商不接受请求参数',
  server: '服务商出错',
  network: '连不上服务商。可能是网络问题，也可能是服务商不允许网页直接调用（跨域），可以试试填写转发地址',
  timeout: '等待超时',
  aborted: '已取消',
}

/** 给玩家看的错误说明 */
export const errorText = (e: unknown) =>
  e instanceof LlmError ? (e.kind === 'network' ? ERROR_HINTS.network : `${ERROR_HINTS[e.kind]}。${e.message}`) : String(e)

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '')

/** 拼出实际请求的地址（考虑转发） */
export function endpoint(p: Pick<LlmProfile, 'baseUrl' | 'proxy' | 'protocol'>, path: string): string {
  let base = trimSlash(p.baseUrl)
  // Anthropic 的地址习惯不带 /v1，OpenAI 兼容的地址习惯带上版本号
  if (p.protocol === 'anthropic' && !/\/v1$/.test(base)) base += '/v1'
  const url = base + path
  return p.proxy?.trim() ? `${trimSlash(p.proxy)}/${url}` : url
}

function headers(p: LlmProfile): Record<string, string> {
  if (p.protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': p.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey.trim()}` }
}

const THINKING_BUDGET = { low: 2048, medium: 6000, high: 16000 }

function parseExtra(p: LlmProfile): Record<string, unknown> {
  if (!p.extraBody?.trim()) return {}
  try {
    const v = JSON.parse(p.extraBody)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    throw new LlmError('bad-request', '「额外参数」不是有效的 JSON')
  }
}

/**
 * 「关闭思考」的参数各家、甚至同一家的不同模型都不一样。实测火山方舟上 DeepSeek 认 `thinking: disabled`，
 * GLM 不认、只认 `reasoning_effort: minimal`（而 DeepSeek 对 minimal 照样思考）。
 * 所以按地址给出几种候选写法，从第一种开始试；服务商返回参数错误就换下一种，并记住对这个模型有效的写法。
 */
export function thinkingOffCandidates(p: Pick<LlmProfile, 'protocol' | 'baseUrl'>): Record<string, unknown>[] {
  if (p.protocol === 'anthropic') return [{ thinking: { type: 'disabled' } }]
  let host = ''
  try {
    host = new URL(p.baseUrl.trim()).hostname
  } catch {
    // 地址不合法，下面按"不认识"处理
  }
  if (/volces\.com|bigmodel\.cn|deepseek\.com|z\.ai/.test(host)) {
    return [{ thinking: { type: 'disabled' } }, { reasoning_effort: 'minimal' }]
  }
  if (/aliyuncs\.com|siliconflow/.test(host)) return [{ enable_thinking: false }]
  if (/openrouter\.ai/.test(host)) return [{ reasoning: { enabled: false } }]
  if (/openai\.com|googleapis\.com/.test(host)) return [{ reasoning_effort: 'none' }, { reasoning_effort: 'minimal' }]
  return [{ thinking: { type: 'disabled' } }, { enable_thinking: false }, { reasoning_effort: 'minimal' }]
}

interface BodyFlags {
  json: boolean
  /** 关闭思考用的参数；没选「关闭」或者所有写法都不被接受时为 null */
  off: Record<string, unknown> | null
}

function buildBody(p: LlmProfile, req: LlmRequest, flags: BodyFlags): Record<string, unknown> {
  if (p.protocol === 'anthropic') {
    const body: Record<string, unknown> = {
      model: p.model.trim(),
      max_tokens: req.maxTokens,
      // 系统提示词整局不变，标记缓存
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
    }
    if (flags.off) Object.assign(body, flags.off)
    else if (p.reasoning !== 'default' && p.reasoning !== 'off') {
      const budget = THINKING_BUDGET[p.reasoning]
      body.thinking = { type: 'enabled', budget_tokens: budget }
      body.max_tokens = req.maxTokens + budget
    }
    return { ...body, ...parseExtra(p) }
  }
  const body: Record<string, unknown> = {
    model: p.model.trim(),
    max_tokens: req.maxTokens,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  }
  if (flags.json) body.response_format = { type: 'json_object' }
  if (flags.off) Object.assign(body, flags.off)
  if (p.reasoning === 'low' || p.reasoning === 'medium' || p.reasoning === 'high') {
    body.reasoning_effort = p.reasoning
    // 推理模型的 max_tokens 包含推理部分，留足余量
    body.max_tokens = req.maxTokens + THINKING_BUDGET[p.reasoning]
  }
  return { ...body, ...parseExtra(p) }
}

function classify(status: number, message: string): LlmErrorKind {
  const m = message.toLowerCase()
  if (status === 401 || status === 403) {
    return /balance|quota|insufficient|credit|余额|欠费/.test(m) ? 'quota' : 'auth'
  }
  if (status === 402) return 'quota'
  if (status === 404) return 'model'
  if (status === 429) return /quota|balance|insufficient|余额/.test(m) ? 'quota' : 'rate'
  if (status === 400 || status === 422) {
    if (/model/.test(m) && /not (found|exist)|invalid|不存在|does not/.test(m)) return 'model'
    if (/balance|insufficient|余额|欠费/.test(m)) return 'quota'
    return 'bad-request'
  }
  return 'server'
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const e = (data as { error?: unknown; message?: unknown }).error ?? data
    if (typeof e === 'string') return e
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      return (e as { message: string }).message
    }
    if (typeof (data as { message?: unknown }).message === 'string') return (data as { message: string }).message
  }
  return fallback
}

/** 发请求并处理超时、取消、HTTP 错误；正常的响应交给 read 读取（普通 JSON，或者流式输出） */
async function send<T = unknown>(
  p: LlmProfile,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  read?: (res: Response) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController()
  const timeout = (p.timeoutSec ?? 120) * 1000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, timeout)
  const onAbort = () => ctl.abort()
  signal?.addEventListener('abort', onAbort)
  const aborted = () => {
    if (signal?.aborted) return new LlmError('aborted', ERROR_HINTS.aborted)
    if (timedOut) return new LlmError('timeout', `${ERROR_HINTS.timeout}（${timeout / 1000} 秒）`)
    return null
  }
  try {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: ctl.signal })
    } catch {
      throw aborted() ?? new LlmError('network', ERROR_HINTS.network)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let data: unknown = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        // 非 JSON 响应
      }
      const msg = errorMessage(data, text.slice(0, 300) || res.statusText)
      const retry = Number(res.headers.get('retry-after'))
      throw new LlmError(classify(res.status, msg), `HTTP ${res.status}：${msg}`, res.status, retry > 0 ? retry : undefined)
    }
    if (read) return await read(res)
    const text = await res.text().catch(() => '')
    try {
      return JSON.parse(text) as T
    } catch {
      throw new LlmError('server', `服务商返回的不是 JSON：${text.slice(0, 200)}`)
    }
  } catch (e) {
    if (e instanceof LlmError) throw e
    throw aborted() ?? new LlmError('network', String(e))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 逐条读出 SSE（服务器推送）流里的 data 内容 */
async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = done ? '' : events.pop()!
    for (const ev of events) {
      const data = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) yield data
    }
    if (done) return
  }
}

/** 读取流式输出，边读边回调；读完拼成和普通响应一样的结果 */
async function readStream(p: LlmProfile, res: Response, onDelta: NonNullable<LlmRequest['onDelta']>): Promise<LlmResponse> {
  const out: LlmResponse = { text: '', reasoning: '', usage: { input: 0, output: 0, cached: 0 }, truncated: false }
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    let changed = false
    if (p.protocol === 'anthropic') {
      const e = ev as {
        type?: string
        delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string }
        message?: { usage?: AnthropicReply['usage'] }
        usage?: { output_tokens?: number }
        error?: { message?: string }
      }
      if (e.type === 'error') throw new LlmError('server', e.error?.message ?? '流式输出出错')
      if (e.type === 'message_start') {
        const u = e.message?.usage
        out.usage.cached = u?.cache_read_input_tokens ?? 0
        out.usage.input = (u?.input_tokens ?? 0) + out.usage.cached
      } else if (e.type === 'content_block_delta') {
        if (e.delta?.type === 'thinking_delta' && e.delta.thinking) out.reasoning += e.delta.thinking
        if (e.delta?.type === 'text_delta' && e.delta.text) out.text += e.delta.text
        changed = true
      } else if (e.type === 'message_delta') {
        if (e.usage?.output_tokens) out.usage.output = e.usage.output_tokens
        if (e.delta?.stop_reason === 'max_tokens') out.truncated = true
      }
    } else {
      const e = ev as {
        choices?: { delta?: { content?: string | null; reasoning_content?: string; reasoning?: string }; finish_reason?: string }[]
        usage?: OpenAiReply['usage']
      }
      const c = e.choices?.[0]
      const reasoning = c?.delta?.reasoning_content ?? c?.delta?.reasoning
      if (reasoning) out.reasoning += reasoning
      if (c?.delta?.content) out.text += c.delta.content
      if (reasoning || c?.delta?.content) changed = true
      if (c?.finish_reason === 'length') out.truncated = true
      if (e.usage) {
        out.usage = {
          input: e.usage.prompt_tokens ?? 0,
          output: e.usage.completion_tokens ?? 0,
          cached: e.usage.prompt_tokens_details?.cached_tokens ?? 0,
        }
      }
    }
    if (changed) onDelta({ reasoning: out.reasoning, text: out.text })
  }
  return out
}

interface AnthropicReply {
  stop_reason?: string
  content?: { type: string; text?: string; thinking?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
}

interface OpenAiReply {
  choices?: { finish_reason?: string; message?: { content?: string | null; reasoning_content?: string; reasoning?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

/** 不支持 JSON 模式的配置（按地址 + 模型记住，避免每次都先失败一次） */
const noJsonMode = new Set<string>()
/** 不支持流式输出的配置：退回普通请求 */
const noStream = new Set<string>()
/** 关闭思考用第几种写法（见 thinkingOffCandidates）；等于候选数量表示都不被接受 */
const offChoice = new Map<string, number>()

const configKey = (p: LlmProfile) => `${p.protocol}|${p.baseUrl}|${p.model}`

/** 这个配置选了「关闭思考」，但服务商不接受任何一种写法（已自动去掉，模型会照常思考） */
export const thinkingOffRejected = (p: LlmProfile) =>
  p.reasoning === 'off' && (offChoice.get(configKey(p)) ?? 0) >= thinkingOffCandidates(p).length

function parseReply(p: LlmProfile, raw: unknown): LlmResponse {
  if (p.protocol === 'anthropic') {
    const data = raw as AnthropicReply
    const blocks = data.content ?? []
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      reasoning: blocks
        .filter((b) => b.type === 'thinking')
        .map((b) => b.thinking ?? '')
        .join('\n'),
      usage: {
        input: (data.usage?.input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0),
        output: data.usage?.output_tokens ?? 0,
        cached: data.usage?.cache_read_input_tokens ?? 0,
      },
      truncated: data.stop_reason === 'max_tokens',
    }
  }
  const data = raw as OpenAiReply
  const msg = data.choices?.[0]?.message
  return {
    text: msg?.content ?? '',
    reasoning: msg?.reasoning_content ?? msg?.reasoning ?? '',
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cached: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    truncated: data.choices?.[0]?.finish_reason === 'length',
  }
}

export async function complete(p: LlmProfile, req: LlmRequest): Promise<LlmResponse> {
  const key = configKey(p)
  const useJson = p.protocol === 'openai' && !!req.json && !noJsonMode.has(key)
  const candidates = thinkingOffCandidates(p)
  const offIndex = offChoice.get(key) ?? 0
  const off = p.reasoning === 'off' && offIndex < candidates.length ? candidates[offIndex] : null
  const body = buildBody(p, req, { json: useJson, off })
  const onDelta = noStream.has(key) ? undefined : req.onDelta
  if (onDelta) {
    body.stream = true
    // OpenAI 兼容接口要显式要求在流的最后返回用量
    if (p.protocol === 'openai') body.stream_options = { include_usage: true }
  }
  const url = endpoint(p, p.protocol === 'anthropic' ? '/messages' : '/chat/completions')
  const init = { method: 'POST', headers: headers(p), body: JSON.stringify(body) }
  try {
    if (onDelta) return await send(p, url, init, req.signal, (res) => readStream(p, res, onDelta))
    return parseReply(p, await send(p, url, init, req.signal))
  } catch (e) {
    // 流式输出的参数不被接受：退回普通请求，并记住
    if (onDelta && e instanceof LlmError && e.kind === 'bad-request' && /stream/i.test(e.message)) {
      noStream.add(key)
      return complete(p, req)
    }
    // JSON 模式或关闭思考的参数不被接受：去掉 JSON 模式，或者换下一种关闭思考的写法，再试一次，并记住。
    // 错误信息里提到 response_format 就先去掉 JSON 模式，否则先换关闭思考的写法
    if (e instanceof LlmError && e.kind === 'bad-request' && (useJson || off)) {
      const blameJson = useJson && (!off || /response_format|json/i.test(e.message))
      if (blameJson) noJsonMode.add(key)
      else offChoice.set(key, offIndex + 1)
      return complete(p, req)
    }
    throw e
  }
}

/** 获取可用的模型列表。很多兼容接口不支持，失败时抛出错误，界面改为手动输入 */
export async function listModels(p: LlmProfile, signal?: AbortSignal): Promise<string[]> {
  const h = headers(p)
  delete h['content-type']
  const data = (await send({ ...p, timeoutSec: 20 }, endpoint(p, '/models'), { headers: h }, signal)) as {
    data?: { id?: string }[]
  }
  const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) throw new LlmError('server', '服务商没有返回模型列表')
  return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}
