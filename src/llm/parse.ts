/**
 * 解析模型的回复。模型的输出五花八门：纯 JSON、包在 ```json 代码块里、JSON 前后带解释、
 * 夹着 <think> 推理、只写一句"走法：12"……尽量都认出来。
 */

/** 去掉部分模型夹在正文里的推理内容 */
export const stripThink = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

/** 从文本中找出一个 JSON 对象 */
export function extractJson(text: string): Record<string, unknown> | null {
  const clean = stripThink(text).replace(/```(?:json)?/gi, '')
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const whole = tryParse(clean.trim())
  if (whole) return whole
  // 从最后一个 { 往前试，找到能解析的最短后缀
  const end = clean.lastIndexOf('}')
  if (end < 0) return null
  for (let start = clean.lastIndexOf('{', end); start >= 0; start = clean.lastIndexOf('{', start - 1)) {
    const v = tryParse(clean.slice(start, end + 1))
    if (v) return v
    if (start === 0) break
  }
  return null
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v)
  return null
}

export interface ParsedReply<T> {
  value: T
  analysis: string
  memo: string | null
}

export type ParseResult<T> = ({ ok: true } & ParsedReply<T>) | { ok: false; error: string; analysis: string }

/** 走法回复：返回选项序号（从 0 开始） */
export function parseMoveReply(text: string, count: number): ParseResult<number> {
  const json = extractJson(text)
  const analysis = json ? str(json.analysis) : stripThink(text).slice(0, 500)
  let n = json ? toInt(json.move) : null
  if (n === null) {
    const m = /(?:"?move"?|走法|编号)\s*[:：=]?\s*(\d+)/i.exec(stripThink(text))
    if (m) n = Number(m[1])
  }
  if (n === null) {
    return { ok: false, error: text.trim() ? '没有找到走法编号' : '回复是空的（可能被截断了）', analysis }
  }
  if (n < 1 || n > count) return { ok: false, error: `编号 ${n} 不存在，有效范围是 1–${count}`, analysis }
  return { ok: true, value: n - 1, analysis, memo: json ? str(json.memo) || null : null }
}

/** 选锦囊回复：返回选项序号（从 0 开始）或 reroll */
export function parseDraftReply(text: string, count: number, canReroll: boolean): ParseResult<number | 'reroll'> {
  const json = extractJson(text)
  const analysis = json ? str(json.analysis) : stripThink(text).slice(0, 500)
  const memo = json ? str(json.memo) || null : null
  const raw = json?.choice
  if (typeof raw === 'string' && /reroll|刷新/i.test(raw)) {
    if (!canReroll) return { ok: false, error: '你没有刷新机会了，只能从选项里选一个', analysis }
    return { ok: true, value: 'reroll', analysis, memo }
  }
  let n = toInt(raw)
  if (n === null) {
    const m = /(?:"?choice"?|选择|选项)\s*[:：=]?\s*(\d+)/i.exec(stripThink(text))
    if (m) n = Number(m[1])
  }
  if (n === null) return { ok: false, error: '没有找到选项编号', analysis }
  if (n < 1 || n > count) return { ok: false, error: `选项 ${n} 不存在，有效范围是 1–${count}`, analysis }
  return { ok: true, value: n - 1, analysis, memo }
}

/** 发言：去掉推理、引号和多余的格式 */
export function cleanSpeech(text: string): string {
  let s = stripThink(text)
    .replace(/^["“'「『]+|["”'」』]+$/g, '')
    .trim()
  // 有的模型会加"发言："之类的前缀
  s = s.replace(/^(发言|回复|我说)[:：]\s*/, '')
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}
