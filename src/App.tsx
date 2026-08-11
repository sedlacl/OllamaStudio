import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Models from './pages/Models'
import Server from './pages/Server'
import Logs from './pages/Logs'

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="models" element={<Models />} />
        <Route path="server" element={<Server />} />
        <Route path="logs" element={<Logs />} />
      </Route>
    </Routes>
  )
}
