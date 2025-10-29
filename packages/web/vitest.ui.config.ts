import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const r = (p: string) => resolve(dirname(fileURLToPath(import.meta.url)), p)

export default defineConfig({
  resolve: { alias: { '@': r('./src') } },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // 仅运行 __tests__/ui 下的冒烟/页面级 e2e
    include: ['src/**/__tests__/ui/**/*.{test,spec}.{ts,tsx}', 'src/pages/**/*e2e.test.tsx']
  }
})
