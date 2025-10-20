import { Route, Routes } from 'react-router-dom'
import Explorer from './routes/explorer'
import { Toaster } from '@/components/ui/sonner'
import { useEffect } from 'react'
import { useAppStore } from '@/stores/app'
import { useExplorerSubscriptions } from '@/features/explorer/subscriptions'
import { WsDebugPanel } from '@/lib/ws/ws-debug-panel'

export default function App() {
  const theme = useAppStore((s) => s.theme)
  // 基于 UI 状态维护订阅（不处理事件）
  useExplorerSubscriptions()
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    // 同步 Monaco Editor 主题
    ;(async () => {
      try {
        const monaco = await import('monaco-editor')
        monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
      } catch {}
    })()
  }, [theme])
  return (
    <div className="h-screen overflow-hidden">
      <Routes>
        <Route path="/" element={<Explorer />} />
      </Routes>
      <Toaster />
      {Boolean((import.meta as any).env?.VITE_WS_DEBUG) && <WsDebugPanel />}
    </div>
  )
}
