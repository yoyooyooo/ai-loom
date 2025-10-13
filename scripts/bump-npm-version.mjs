#!/usr/bin/env node
/**
 * 同步对齐 npm 包版本（ai-loom 元包 + 平台子包）
 *
 * 用法：
 *   node scripts/bump-npm-version.mjs --version 0.1.1 [--dry-run]
 *   node scripts/bump-npm-version.mjs --type patch|minor|major [--dry-run]
 *
 * 行为：
 * - 扫描 packages/npm 下的包：元包（ai-loom）与平台子包（@ai-loom/server-* 或 ai-loom-server-*）。
 * - 统一将所有包的 version 更新为目标版本。
 * - 重建并写回元包的 optionalDependencies（用扫描到的平台子包名 -> 目标版本）。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const args = { version: null, type: null, dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if ((a === '--version' || a === '-v') && argv[i+1]) { args.version = argv[++i]; continue }
    if (a === '--type' && argv[i+1]) { args.type = argv[++i]; continue }
    if (a === '--dry-run') { args.dryRun = true; continue }
    if (a === '-h' || a === '--help') { args.help = true; }
  }
  return args
}

function loadJSON(p) { return JSON.parse(readFileSync(p, 'utf8')) }
function saveJSON(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8') }

function isSemver(v) { return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v) }
function bump(base, type) {
  const m = base.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
  if (!m) throw new Error('无法解析版本号：' + base)
  let [ , a, b, c, rest ] = m
  let major = parseInt(a,10), minor = parseInt(b,10), patch = parseInt(c,10)
  if (type === 'major') { major++; minor = 0; patch = 0 }
  else if (type === 'minor') { minor++; patch = 0 }
  else if (type === 'patch') { patch++ }
  else throw new Error('未知的 type：' + type)
  return `${major}.${minor}.${patch}`
}

function findPackages(rootDir) {
  const base = path.join(rootDir, 'packages/npm')
  const items = readdirSync(base)
  const result = []
  for (const name of items) {
    const dir = path.join(base, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const pj = path.join(dir, 'package.json')
      const pkg = loadJSON(pj)
      result.push({ dir, pj, pkg })
    } catch { /* ignore */ }
  }
  return result
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('用法:\n  node scripts/bump-npm-version.mjs --version 0.1.1 [--dry-run]\n  node scripts/bump-npm-version.mjs --type patch|minor|major [--dry-run]')
    process.exit(0)
  }

  const pkgs = findPackages(process.cwd())
  const core = pkgs.find(p => p.pkg?.name === 'ai-loom')
  if (!core) throw new Error('未找到元包 ai-loom（packages/npm/ai-loom）')

  let targetVersion = args.version
  if (!targetVersion && args.type) {
    targetVersion = bump(core.pkg.version, args.type)
  }
  if (!targetVersion || !isSemver(targetVersion)) {
    throw new Error('请提供有效版本：--version x.y.z 或 --type patch|minor|major')
  }

  // 平台子包：名称匹配 @ai-loom/server-* 或 ai-loom-server-*
  const platformPkgs = pkgs.filter(p => {
    const n = p.pkg?.name || ''
    return /^@ai-loom\/server-/.test(n) || /^ai-loom-server-/.test(n)
  })

  // 预览
  console.log('[bump] 目标版本：', targetVersion)
  console.log('[bump] 元包：', core.dir)
  console.log('[bump] 平台子包：', platformPkgs.map(p=>p.pkg.name).join(', ') || '(无)')

  // 1) 更新元包 version
  const newCore = { ...core.pkg, version: targetVersion }

  // 2) 重建 optionalDependencies（来自扫描到的平台子包）
  const optional = {}
  for (const p of platformPkgs) optional[p.pkg.name] = targetVersion
  newCore.optionalDependencies = optional

  // 3) 更新平台子包 version
  const newPlatforms = platformPkgs.map(p => ({ obj: { ...p.pkg, version: targetVersion }, pj: p.pj }))

  if (args.dryRun) {
    console.log('\n[bump] dry-run 预览：')
    console.log('- 更新', core.pj)
    for (const np of newPlatforms) console.log('- 更新', np.pj)
    process.exit(0)
  }

  // 写回
  saveJSON(core.pj, newCore)
  for (const np of newPlatforms) saveJSON(np.pj, np.obj)

  console.log('[bump] 已更新：')
  console.log('-', core.pj)
  for (const np of newPlatforms) console.log('-', np.pj)
}

main()

