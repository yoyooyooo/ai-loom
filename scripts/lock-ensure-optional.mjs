#!/usr/bin/env node
/**
 * 将 packages/npm/ai-loom/package.json 中的 optionalDependencies
 * 补全/对齐到 pnpm-lock.yaml 的对应 importer 节点（specifiers + version）。
 *
 * 目的：避免因不同平台生成的锁文件未包含全部可选依赖 specifiers，
 *      在 CI 的 frozen 模式下被判定为“锁过期”。
 *
 * 说明：采用最小侵入的行级编辑，保持现有 YAML 结构与缩进风格；
 *      若不存在 optionalDependencies 块则新增；存在则仅补缺。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const lockPath = path.join(repoRoot, 'pnpm-lock.yaml')
const pkgPath = path.join(repoRoot, 'packages/npm/ai-loom/package.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const opt = pkg.optionalDependencies || {}
const wantedKeys = Object.keys(opt)
if (wantedKeys.length === 0) {
  console.log('[lock-ensure-optional] 无 optionalDependencies，跳过')
  process.exit(0)
}

let text = readFileSync(lockPath, 'utf8')
const lines = text.split(/\r?\n/)

// 用于判断 packages 映射中是否存在某个 "name@version" 的条目
function hasPackagesEntry(pkgName, version) {
  const needle = `  '${pkgName}@${version}':`
  return lines.some(l => l.trimEnd() === needle)
}

// 定位 importer 节点：`  packages/npm/ai-loom:`
const importerHeader = '  packages/npm/ai-loom:'
const importerIdx = lines.findIndex(l => l.trimEnd() === importerHeader.trimEnd())
if (importerIdx === -1) {
  console.error('[lock-ensure-optional] 未在 pnpm-lock.yaml 中找到 importer 节点: packages/npm/ai-loom')
  process.exit(1)
}

// 计算该 importer 块的结束行（下一个以2空格缩进的顶级 importer 或文件结束）
let endIdx = lines.length
for (let i = importerIdx + 1; i < lines.length; i++) {
  const m = lines[i].match(/^(\s*)\S/)
  if (!m) continue
  const indent = m[1].length
  // importer 顶层是2空格，遇到下一个2空格且不是本节点内部（i > importerIdx）即为结束
  if (indent === 2 && i > importerIdx) { endIdx = i; break }
}

// 查找是否已有 optionalDependencies 块
let optionalIdx = -1
for (let i = importerIdx + 1; i < endIdx; i++) {
  if (lines[i].trim() === 'optionalDependencies:') { optionalIdx = i; break }
  if (lines[i].trim() === 'dependencies:' || lines[i].trim() === 'devDependencies:') {
    // 这些块名在 YAML 中通常带有4空格缩进；我们使用 trim 比较即可。
    // 不做处理，只是为了遍历继续。
  }
}

// 若无 optionalDependencies 块，确定插入位置：优先放在 dependencies 块之后，否则在 importer 头后空一行插入
let insertPos = -1
if (optionalIdx === -1) {
  // 尝试定位 dependencies 块的结束位置
  let depsIdx = -1
  for (let i = importerIdx + 1; i < endIdx; i++) {
    if (lines[i].trim() === 'dependencies:') { depsIdx = i; break }
  }
  if (depsIdx !== -1) {
    // 结束位置：遇到下一个 缩进为4空格 的块名或到 importer 结束
    let afterDeps = endIdx
    for (let i = depsIdx + 1; i < endIdx; i++) {
      const m = lines[i].match(/^(\s*)([A-Za-z@'"\[])/)
      if (m && m[1].length === 4 && (lines[i].trim().endsWith(':'))) { afterDeps = i; break }
    }
    insertPos = afterDeps
  } else {
    insertPos = importerIdx + 1
  }

  const block = []
  block.push('    optionalDependencies:')
  for (const key of wantedKeys) {
    const v = String(opt[key])
    const q = key.includes(':') || key.includes('@') || key.includes('/') ? `'${key}'` : key
    block.push(`      ${q}:`)
    block.push(`        specifier: ${v}`)
    // 只有在 packages 区域存在对应解析时才写入 version，避免产生“缺失依赖”错误
    if (hasPackagesEntry(key, v)) block.push(`        version: ${v}`)
  }
  lines.splice(insertPos, 0, ...block)
} else {
  // 已有 optionalDependencies 块：收集已有 keys，并补缺
  const existing = new Map() // name -> startLineIndex
  let i = optionalIdx + 1
  while (i < endIdx) {
    const line = lines[i]
    const m = line.match(/^\s{6}(.+?):\s*$/)
    if (m) {
      let name = m[1]
      if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith('\'') && name.endsWith('\''))) {
        name = name.slice(1, -1)
      } else if (name.startsWith("'") && name.endsWith("'")) {
        name = name.slice(1, -1)
      }
      existing.set(name, i)
      i += 1
      continue
    }
    // 当遇到缩进减少到4空格（下一个块名）或2空格（下一个 importer）即结束
    const m2 = line.match(/^(\s*)\S/)
    if (m2) {
      const indent = m2[1].length
      if (indent <= 4) break
    }
    i += 1
  }

  // 先对已有条目做一次“version 合法性”修正：若无 packages 条目则移除 version 行
  for (const [name, start] of existing) {
    const vLine = lines[start + 1]?.trim() === 'specifier:' ? lines[start + 2] : lines[start + 1]
    // 在 importer 结构中通常是：name: / specifier: X / version: X
    // 我们定位 specifier 行读取值，再判断是否保留 version 行
    let specVal = null
    for (let k = start + 1; k < Math.min(endIdx, start + 6); k++) {
      const lm = lines[k].match(/^\s{8}specifier:\s*(.+)\s*$/)
      if (lm) { specVal = lm[1]; break }
      const stop = lines[k].match(/^\s{6}.+?:\s*$/)
      if (stop) break
    }
    if (specVal) {
      // 去掉可能的引号
      specVal = specVal.replace(/^['"]|['"]$/g, '')
      if (!hasPackagesEntry(name, specVal)) {
        // 删除紧随其后的 version 行（若存在）
        for (let k = start + 1; k < Math.min(endIdx, start + 6); k++) {
          if (/^\s{8}version:\s*/.test(lines[k] || '')) { lines.splice(k, 1); endIdx--; break }
        }
      }
    }
  }

  const toAdd = wantedKeys.filter(k => !existing.has(k))
  if (toAdd.length > 0) {
    const block = []
    for (const key of toAdd) {
      const v = String(opt[key])
      const q = key.includes(':') || key.includes('@') || key.includes('/') ? `'${key}'` : key
      block.push(`      ${q}:`)
      block.push(`        specifier: ${v}`)
      if (hasPackagesEntry(key, v)) block.push(`        version: ${v}`)
    }
    lines.splice(i, 0, ...block)
  }
}

const out = lines.join('\n')
writeFileSync(lockPath, out, 'utf8')
console.log('[lock-ensure-optional] 已确保 pnpm-lock.yaml 中包含所有 optionalDependencies specifiers')
