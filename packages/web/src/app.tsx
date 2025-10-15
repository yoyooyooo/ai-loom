import { Route, Routes } from 'react-router-dom'
import Explorer from './routes/explorer'
import { Toaster } from '@/components/ui/sonner'

export default function App() {
  return (
    <div className="h-screen overflow-hidden">
      <Routes>
        <Route path="/" element={<Explorer />} />
      </Routes>
      <Toaster />
    </div>
  )
}
