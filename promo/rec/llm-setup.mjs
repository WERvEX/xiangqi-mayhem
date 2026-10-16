// 打开录屏专用浏览器（独立配置，保存在 out/llm-profile），停在游戏的设置页，由用户本人填写 API 密钥。
// 如果还没有配置，会先建好两个火山方舟的配置（除密钥外都已填好），用户只需要编辑、粘贴密钥、测试连接。
// 关掉这个浏览器窗口后脚本结束。之后录大模型镜头时会复用这个配置（无头运行）。
import { chromium } from 'playwright-core'

const ARK = {
  protocol: 'openai',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: '',
  reasoning: 'off',
  proxy: 'http://localhost:5173/__llm_proxy',
}
const PROFILES = [
  { ...ARK, id: 'promo-deepseek', name: 'DeepSeek', model: 'deepseek-v4-1-flash-260910' },
  { ...ARK, id: 'promo-glm', name: 'GLM', model: 'glm-5-3-flash-260828' },
]

const context = await chromium.launchPersistentContext('out/llm-profile', {
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  viewport: null,
  locale: 'zh-CN',
  args: ['--window-size=1200,1000'],
})
const page = context.pages()[0] ?? (await context.newPage())
await page.goto('http://localhost:5173/')
const seeded = await page.evaluate((profiles) => {
  if (JSON.parse(localStorage.getItem('xqm-llm-profiles') ?? '[]').length) return false
  localStorage.setItem('xqm-llm-profiles', JSON.stringify(profiles))
  return true
}, PROFILES)
if (seeded) await page.reload()
await page.getByRole('button', { name: '⚙ 设置' }).click()
console.log('浏览器已打开。逐个编辑两个配置，粘贴 API 密钥，点「测试连接」，成功后保存；都好了直接关闭窗口。')
await new Promise((resolve) => context.on('close', resolve))
console.log('已关闭，配置已保存。')
