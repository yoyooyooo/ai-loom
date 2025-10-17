import { Route, Routes } from 'react-router-dom'
import Explorer from './routes/explorer'
import { Toaster } from '@/components/ui/sonner'
import { useEffect } from 'react'
import { useAppStore } from '@/stores/app'

export default function App() {
  const theme = useAppStore((s) => s.theme)
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
    </div>
  )
}
