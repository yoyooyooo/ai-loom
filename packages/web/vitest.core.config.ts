import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const r = (p: string) => resolve(dirname(fileURLToPath(import.meta.url)), p)

export default defineConfig({
  resolve: { alias: { '@': r('./src') } },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // 仅运行 __tests__/core 下的聚合/核心用例
    include: ['src/**/__tests__/core/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/**/__tests__/ui/**', 'src/pages/**']
  }
})
