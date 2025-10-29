import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const r = (p: string) => resolve(dirname(fileURLToPath(import.meta.url)), p)

export default defineConfig({
  resolve: {
    alias: { '@': r('./src') }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts']
  }
})

