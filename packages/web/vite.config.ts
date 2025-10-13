import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'
import tailwindcss from '@tailwindcss/vite'

// 兼容 CJS 默认导出：有的版本导出在 default 属性下
const monaco = (monacoEditorPlugin as any).default ?? (monacoEditorPlugin as any)

export default defineConfig({
  plugins: [react(), tailwindcss(), monaco({
    languageWorkers: ['editorWorkerService','typescript','json','css','html'],
  })],
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
