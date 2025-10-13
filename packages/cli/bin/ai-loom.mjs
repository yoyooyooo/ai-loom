#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv) {
  const args = { root: '.', db: null, noOpen: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root' && argv[i+1]) { args.root = argv[++i]; continue }
    if ((a === '--db' || a === '--db-path') && argv[i+1]) { args.db = argv[++i]; continue }
    if (a === '--no-open') { args.noOpen = true; continue }
    if (a === '-h' || a === '--help') { args.help = true; continue }
  }
  return args
}

function printHelp() {
  console.log(`ai-loom - local dev runner\n\nUsage:\n  ai-loom [--root <dir>] [--db <path>] [--no-open]\n\nSteps:\n  1) build web if dist missing\n  2) run cargo server, open browser when ready\n`)
}

function run(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts })
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
  })
}

function runCapture(cmd, args, opts={}) {
  const child = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'], shell: false, ...opts })
  return child
}

async function openUrl(url) {
  const platform = process.platform
  if (platform === 'darwin') spawn('open', [url])
  else if (platform === 'win32') spawn('cmd', ['/c','start','',url], { windowsHide: true })
  else spawn('xdg-open', [url])
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) return printHelp()

  const webDist = join(process.cwd(), 'packages/web/dist')
  if (!existsSync(webDist) || !existsSync(join(webDist,'index.html'))) {
    console.log('[ai-loom] building web...')
    await run('pnpm', ['-C','packages/web','build'])
  }

  const serverArgs = ['run','-p','ailoom-server','--','--root', args.root, '--web-dist', 'packages/web/dist']
  if (args.db) { serverArgs.push('--db-path', args.db) }

  console.log('[ai-loom] starting server...')
  const child = runCapture('cargo', serverArgs)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (data) => {
    process.stdout.write(data)
    const s = String(data)
    const m = s.match(/AILOOM_PORT=(\d{2,5})/)
    if (m && !args.noOpen) {
      const url = `http://127.0.0.1:${m[1]}`
      console.log('[ai-loom] opening', url)
      openUrl(url)
    }
  })
  child.stderr.on('data', (data)=>process.stderr.write(data))

  const onExit = () => { try { child.kill('SIGTERM') } catch(e) {} process.exit(0) }
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)
}

main().catch((e)=>{ console.error(e); process.exit(1) })
