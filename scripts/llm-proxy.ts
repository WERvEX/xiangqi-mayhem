/**
 * 本地转发：让网页版也能使用不支持浏览器直连的服务商（如火山方舟）。
 *
 *   npm run llm-proxy              # 默认监听 http://127.0.0.1:8787
 *   npm run llm-proxy -- --port 9000
 *
 * 然后在游戏的模型设置里把「转发地址」填成 http://127.0.0.1:8787 。
 * 只监听本机，只转发到 https 地址；请求和密钥直接从你的电脑发给服务商，不经过其他服务器。
 */
import { createServer } from 'node:http'
import { handleProxy } from './llm-proxy-core.ts'

const i = process.argv.indexOf('--port')
const port = i >= 0 ? Number(process.argv[i + 1]) : 8787

createServer((req, res) => {
  void handleProxy(req, res, (req.url ?? '/').slice(1))
}).listen(port, '127.0.0.1', () => {
  console.log(`大模型转发已启动：http://127.0.0.1:${port}`)
  console.log('在游戏的模型设置里把「转发地址」填成上面的地址。按 Ctrl+C 停止。')
})
