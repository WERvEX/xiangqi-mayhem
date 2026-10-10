import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // 相对路径，部署到 GitHub Pages 子路径也能正常加载
  base: './',
  plugins: [react()],
})
