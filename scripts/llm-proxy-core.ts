import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 大模型请求转发：给不支持浏览器直连（跨域）的服务商用。
 * 请求 `${转发地址}/https://目标地址` 会被原样转发到目标地址，并在响应上加上允许跨域的头。
 *
 * 只转发到 https 地址；只接受来自本机页面和正式站点的请求，避免被别的网站当作跳板。
 */

const ALLOWED_ORIGINS = [/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/, /^https:\/\/wervex\.github\.io$/]

/** 不转发给目标服务器的请求头 */
const DROP_HEADERS = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'accept-encoding'])

export async function handleProxy(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
  const origin = req.headers.origin
  if (origin && !ALLOWED_ORIGINS.some((re) => re.test(origin))) {
    res.writeHead(403).end('origin not allowed')
    return
  }
  const cors = {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end()
    return
  }
  if (!/^https:\/\/[^/]+/.test(target)) {
    res.writeHead(400, cors).end('only https targets are allowed')
    return
  }

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && !DROP_HEADERS.has(k) && !k.startsWith('sec-') && !k.startsWith('access-control-')) {
      headers[k] = v
    }
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    const out: Record<string, string> = { ...cors }
    const type = upstream.headers.get('content-type')
    if (type) out['content-type'] = type
    const retry = upstream.headers.get('retry-after')
    if (retry) {
      out['retry-after'] = retry
      out['access-control-expose-headers'] = 'retry-after'
    }
    res.writeHead(upstream.status, out).end(body)
  } catch (e) {
    res.writeHead(502, cors).end(JSON.stringify({ error: { message: `转发失败：${String(e)}` } }))
  }
}
