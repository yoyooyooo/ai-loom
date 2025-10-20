#!/usr/bin/env node
// Save many files via REST to benchmark write path and broadcast volume.
// Usage: node scripts/save-burst.mjs [port] [count] [concurrency]
// Defaults: port from env AILOOM_PORT or 3000; count=200; concurrency=16

import fs from 'node:fs/promises'
import path from 'node:path'

const port = Number(process.argv[2] || process.env.AILOOM_PORT || 3000)
const COUNT = Number(process.argv[3] || 200)
const CONC = Number(process.argv[4] || 16)

const root = process.cwd()
const dir = path.join(root, 'tmp-save')

async function ensureFiles(n) {
  await fs.mkdir(dir, { recursive: true })
  const jobs = []
  for (let i = 1; i <= n; i++) {
    const f = path.join(dir, `f_${i}.txt`)
    jobs.push(fs.writeFile(f, `seed ${i}\n`))
  }
  await Promise.all(jobs)
}

async function putFile(p, content) {
  const url = `http://127.0.0.1:${port}/api/file`
  const body = { path: p, content }
  const t0 = performance.now()
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const t1 = performance.now()
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`HTTP_${res.status}:${txt}`)
  }
  return t1 - t0
}

async function run() {
  console.log(`[save-burst] port=${port} count=${COUNT} concurrency=${CONC}`)
  await ensureFiles(COUNT)
  const files = Array.from({ length: COUNT }, (_, i) => path.join('tmp-save', `f_${i + 1}.txt`))
  let idx = 0
  let ok = 0
  let err = 0
  const times = []
  async function worker() {
    while (true) {
      const i = idx++
      if (i >= files.length) break
      const p = files[i]
      try {
        const ms = await putFile(p, `burst ${i} ${Date.now()}\n`)
        ok++
        times.push(ms)
      } catch (e) {
        err++
        console.error('[save-burst] error', e?.message || e)
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()))
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)] || 0
  const p90 = times[Math.floor(times.length * 0.9)] || 0
  const p99 = times[Math.floor(times.length * 0.99)] || 0
  console.log(`[save-burst] done ok=${ok} err=${err} p50=${p50.toFixed(1)}ms p90=${p90.toFixed(1)}ms p99=${p99.toFixed(1)}ms`)
}

run().catch((e) => { console.error(e); process.exit(1) })

