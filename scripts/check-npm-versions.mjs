#!/usr/bin/env node
/**
 * 版本一致性检查（CI 用）
 *
 * 校验点：
 * 1) 元包 ai-loom 的 version 与推送的 Tag（形如 vX.Y.Z）一致
 * 2) 所有平台子包（packages/npm/server-*）的 version 与元包一致
 * 3) 元包 optionalDependencies 中列出的平台子包名与版本与扫描到的子包一致
 *
 * 用法：
 *   node scripts/check-npm-versions.mjs --tag v1.2.3
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const args = { tag: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if ((a === '--tag' || a === '-t') && argv[i + 1]) { args.tag = argv[++i]; continue }
    if (a === '--help' || a === '-h') { args.help = true }
  }
  return args
}

function isSemver(v) { return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v) }
function extractTagVersion(tag) {
  const m = tag.match(/^(?:release-)?v(\d+\.\d+\.\d+)$/)
  return m ? m[1] : null
}
function loadJSON(p) { return JSON.parse(readFileSync(p, 'utf8')) }

function findPackages(baseDir) {
  const base = path.join(baseDir, 'packages', 'npm')
  const entries = readdirSync(base)
  const list = []
  for (const name of entries) {
    const dir = path.join(base, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const pj = path.join(dir, 'package.json')
      const pkg = loadJSON(pj)
      list.push({ dir, pj, pkg })
    } catch { /* ignore */ }
  }
  return list
}

function fail(msg) {
  console.error('[versions:fail]', msg)
  process.exit(1)
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log('用法: node scripts/check-npm-versions.mjs --tag vX.Y.Z')
    process.exit(0)
  }

  const tag = args.tag || process.env.GITHUB_REF_NAME || ''
  const tagVersion = extractTagVersion(tag)
  if (!tag || !tagVersion) fail(`缺少或非法的 tag: ${tag}，应为 release-vX.Y.Z 或 vX.Y.Z`)
  if (tagVersion === '0.0.0') fail('禁止发布 0.0.0 版本，请在发布分支对齐为实际版本后再打 Tag')

  const pkgs = findPackages(process.cwd())
  const core = pkgs.find(p => p.pkg?.name === 'ai-loom')
  if (!core) fail('未找到元包 ai-loom（packages/npm/ai-loom）')

  const coreVersion = core.pkg?.version
  if (!isSemver(coreVersion)) fail(`元包 version 非法: ${coreVersion}`)
  if (coreVersion !== tagVersion) fail(`Tag 与元包 version 不一致：tag=${tagVersion}, ai-loom=${coreVersion}`)

  const platformPkgs = pkgs.filter(p => /^@ai-loom\/server-/.test(p.pkg?.name || '') || /^ai-loom-server-/.test(p.pkg?.name || ''))
  if (platformPkgs.length === 0) fail('未扫描到任何平台子包（packages/npm/server-*）')

  // 2) 平台子包版本一致
  const badVers = platformPkgs.filter(p => p.pkg?.version !== coreVersion)
  if (badVers.length > 0) {
    for (const b of badVers) console.error('[versions:mismatch]', b.pkg?.name, '!=', coreVersion, '(实际:', b.pkg?.version, ')')
    fail('平台子包 version 与元包不一致')
  }

  // 3) optionalDependencies 一致
  const optional = core.pkg?.optionalDependencies || {}
  const platformNames = platformPkgs.map(p => p.pkg.name).sort()
  const optionalNames = Object.keys(optional).sort()

  const missInOptional = platformNames.filter(n => !optionalNames.includes(n))
  const extraInOptional = optionalNames.filter(n => !platformNames.includes(n))
  const versionMismatch = platformNames.filter(n => optional[n] !== coreVersion)

  if (missInOptional.length) {
    console.error('[optional:missing]', missInOptional.join(', '))
    fail('optionalDependencies 缺少平台子包项')
  }
  if (extraInOptional.length) {
    console.error('[optional:extra]', extraInOptional.join(', '))
    fail('optionalDependencies 包含额外未扫描到的子包项')
  }
  if (versionMismatch.length) {
    console.error('[optional:version-mismatch]', versionMismatch.map(n => `${n}@${optional[n]}!=${coreVersion}`).join(', '))
    fail('optionalDependencies 中的版本与元包不一致')
  }

  console.log('[versions:ok] tag =', tag, 'version =', coreVersion)
  console.log('[versions:ok] 平台子包：', platformNames.join(', '))
}

main()
