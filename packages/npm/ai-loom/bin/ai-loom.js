#!/usr/bin/env node
/* eslint-disable no-console */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
let familySync = null, MUSL = 'musl'
try {
  const dl = require('detect-libc')
  familySync = typeof dl.familySync === 'function' ? dl.familySync : null
  MUSL = dl.MUSL || 'musl'
} catch (_) {}

function pickPackage() {
  const plat = process.platform
  const arch = process.arch
  if (plat === 'darwin') {
    if (arch === 'arm64') return '@ai-loom/server-darwin-arm64'
    if (arch === 'x64') return '@ai-loom/server-darwin-x64'
  }
  if (plat === 'linux') {
    const isMusl = familySync ? (familySync() === MUSL) : false
    if (arch === 'x64') return isMusl ? '@ai-loom/server-linux-x64-musl' : '@ai-loom/server-linux-x64-gnu'
    if (arch === 'arm64') return isMusl ? '@ai-loom/server-linux-arm64-musl' : '@ai-loom/server-linux-arm64-gnu'
  }
  if (plat === 'win32' && arch === 'x64') return '@ai-loom/server-win32-x64-msvc'
  const msg = `暂不支持的平台：${plat} ${arch}。请为该平台添加对应的二进制子包。`
  throw new Error(msg)
}

function resolveBin(pkg) {
  const pkgJson = require.resolve(`${pkg}/package.json`)
  const dir = path.dirname(pkgJson)
  const exe = process.platform === 'win32' ? 'ailoom-server.exe' : 'ailoom-server'
  const bin = path.join(dir, 'bin', exe)
  if (!fs.existsSync(bin)) {
    throw new Error(`未找到二进制：${bin}（包：${pkg}）。请确认安装成功或设置 AILOOM_SERVER_BIN 环境变量覆盖路径。`)
  }
  return bin
}

async function main() {
  const override = process.env.AILOOM_SERVER_BIN
  const bin = override || resolveBin(pickPackage())
  const web = path.join(__dirname, '..', 'web')
  const hasArg = (flag) => process.argv.includes(flag)
  const args = []
  if (!hasArg('--root')) { args.push('--root', process.cwd()) }
  if (!hasArg('--web-dist')) { args.push('--web-dist', web) }
  args.push(...process.argv.slice(2))
  const child = spawn(bin, args, { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}

main().catch((e)=>{ console.error('[ai-loom]', e.message); process.exit(1) })
