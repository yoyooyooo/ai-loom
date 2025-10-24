import { useEffect, useMemo } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import ChatPage from '@/pages/chat-page'
import Explorer from '@/routes/explorer'
import { Toaster } from '@/components/ui/sonner'
import { useAppStore } from '@/stores/app'
import { useExplorerSubscriptions } from '@/features/explorer/subscriptions'
import { WsDebugPanel } from '@/lib/ws/ws-debug-panel'
import { AppSidebar } from '@/components/app-sidebar'
import { AppSidebarMobileTrigger } from '@/components/app-sidebar-mobile-trigger'
import type { SidebarModuleConfig } from '@/components/app-sidebar-config'

const APP_MODULES: SidebarModuleConfig = [
  { id: 'chat', label: 'Chat', path: '/chat', enabled: true },
  { id: 'explore', label: 'Explore', path: '/explore', enabled: true }
]

function AppShell() {
  const theme = useAppStore((s) => s.theme)
  const location = useLocation()
  const navigate = useNavigate()

  useExplorerSubscriptions()

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    ;(async () => {
      try {
        const monaco = await import('monaco-editor')
        monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
      } catch {
        // ignore load failure in non-editor context
      }
    })()
  }, [theme])

  const activeModuleId = useMemo(() => {
    if (location.pathname.startsWith('/explore')) return 'explore'
    return 'chat'
  }, [location.pathname])

  return (
    <AppSidebar
      modules={APP_MODULES}
      activeModuleId={activeModuleId}
      onNavigate={(path) => {
        if (path !== location.pathname) navigate(path)
      }}
      className="h-full"
    >
      <AppSidebarMobileTrigger />
      <div className="flex-1 min-h-0">
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route path="/explore" element={<Explorer />} />
          <Route path="/" element={<Navigate to="/chat" replace />} />
        </Routes>
      </div>
      <Toaster />
      {Boolean((import.meta as any).env?.VITE_WS_DEBUG) && <WsDebugPanel />}
    </AppSidebar>
  )
}

export default function App() {
  return (
    <div className="h-screen overflow-hidden">
      <AppShell />
    </div>
  )
}
