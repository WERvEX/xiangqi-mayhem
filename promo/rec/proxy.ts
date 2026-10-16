/**
 * 录屏用的大模型转发：和 scripts/llm-proxy.ts 一样，只是连接失败时自动重试。
 * 本机到火山方舟偶尔会连接超时（约一成），游戏会因此改由规则 AI 代走，画面上留下警告。
 * 连接阶段的失败说明请求还没发出去，重试不会重复计费。
 *
 *   npx tsx promo/rec/proxy.ts --port 8788
 */
import { createServer } from 'node:http'
import { handleProxy } from '../../scripts/llm-proxy-core.ts'

const RETRYABLE = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET'])
const rawFetch = globalThis.fetch

globalThis.fetch = async (input, init) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rawFetch(input, init)
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? ''
      if (init?.signal?.aborted || attempt >= 4 || !RETRYABLE.has(code)) throw e
      console.log(`连接失败（${code}），第 ${attempt} 次重试`)
    }
  }
}

const i = process.argv.indexOf('--port')
const port = i >= 0 ? Number(process.argv[i + 1]) : 8788

createServer((req, res) => {
  void handleProxy(req, res, (req.url ?? '/').slice(1))
}).listen(port, '127.0.0.1', () => console.log(`录屏用大模型转发：http://127.0.0.1:${port}`))
