import { Route, Routes } from 'react-router-dom'
import Explorer from './routes/explorer'

export default function App() {
  return (
    <div className="h-screen overflow-hidden">
      <Routes>
        <Route path="/" element={<Explorer />} />
      </Routes>
    </div>
  )
}
