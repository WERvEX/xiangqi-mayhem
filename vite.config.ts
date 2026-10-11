import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { handleProxy } from './scripts/llm-proxy-core.ts'

/** 开发服务器上的大模型转发：/__llm_proxy/https://目标地址（见 scripts/llm-proxy-core.ts） */
const llmProxy = (): Plugin => ({
  name: 'llm-proxy',
  configureServer(server) {
    server.middlewares.use('/__llm_proxy', (req, res) => {
      void handleProxy(req, res, (req.url ?? '/').slice(1))
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  // 相对路径，部署到 GitHub Pages 子路径也能正常加载
  base: './',
  plugins: [react(), llmProxy()],
})
