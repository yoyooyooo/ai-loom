import { useEffect } from 'react'
import { ws } from '@/lib/ws/singleton'
import { useAppStore } from '@/stores/app'

// 探索器特性订阅桥：集中维护与 Explorer 相关的 WS 订阅
export function useExplorerSubscriptions() {
  const currentDir = useAppStore((s) => s.currentDir)
  const selectedPath = useAppStore((s) => s.selectedPath)

  useEffect(() => {
    if (!ws.enabled) return
    const subscriptions: Array<{ unsubscribe: () => void }> = []
    // 目录树相关事件
    // 当前目录为 '.' 时，传空 dir 以匹配“任意目录”的订阅，避免根目录无法匹配 impactedPaths
    const dirFilter = currentDir === '.' ? '' : currentDir
    subscriptions.push(ws.subscribeTopic$('tree', { dir: dirFilter }).subscribe(() => ({}) as any))
    // 批注（全局）
    subscriptions.push(ws.subscribeTopic$('annotations', {}).subscribe(() => ({}) as any))
    // 文件前缀订阅：
    // 1) 全局订阅（prefix:'' → 匹配所有文件变化，保障多标签页一致刷新）
    subscriptions.push(ws.subscribeTopic$('file', { prefix: '' }).subscribe(() => ({}) as any))
    // 2) 当前目录前缀（保留更精细的局部优化）
    if (currentDir && currentDir !== '.') {
      const filePrefix = currentDir.endsWith('/') ? currentDir : currentDir + '/'
      subscriptions.push(
        ws.subscribeTopic$('file', { prefix: filePrefix }).subscribe(() => ({}) as any)
      )
    }
    // 当前文件精确事件（编辑器）
    if (selectedPath) {
      subscriptions.push(
        ws.subscribeTopic$('file', { path: selectedPath }).subscribe(() => ({}) as any)
      )
    }
    return () => {
      for (const s of subscriptions) {
        try {
          s.unsubscribe()
        } catch {}
      }
    }
  }, [currentDir, selectedPath])
}
