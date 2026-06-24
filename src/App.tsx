import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from './components/ui/tooltip'
import { Toaster } from './components/ui/sonner'
import { AppShell } from './components/layout/AppShell'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import Deliveries from './pages/Deliveries'
import DeliveryLiveView from './pages/DeliveryLiveView'
import PipelineCreator from './pages/PipelineCreator'
import Pipelines from './pages/Pipelines'
import BuildingBlocks from './pages/BuildingBlocks'
import About from './pages/About'
import Setup from './pages/Setup'
import Settings from './pages/Settings'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
})

function AppRoutes() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    window.axon.settings.get('setupComplete').then(val => {
      setSetupComplete(val === true)
    })
  }, [])

  useEffect(() => {
    const handler = () => {
      setSetupComplete(false)
      navigate('/setup', { replace: true })
    }
    window.addEventListener('axon:auth:expired', handler)
    return () => window.removeEventListener('axon:auth:expired', handler)
  }, [navigate])

  if (setupComplete === null) {
    return (
      <div
        className="dark flex h-screen items-center justify-center"
        style={{ background: 'var(--axon-bg)' }}
      />
    )
  }

  if (!setupComplete) {
    return (
      <Routes>
        <Route path="*" element={<Setup onComplete={() => setSetupComplete(true)} />} />
      </Routes>
    )
  }

  return (
    <AppShell>
      <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/deliveries" element={<Deliveries />} />
        <Route path="/deliveries/:id" element={<DeliveryLiveView />} />
        <Route path="/pipelines" element={<Pipelines />} />
        <Route path="/pipelines/new" element={<PipelineCreator />} />
        <Route path="/pipelines/:id/edit" element={<PipelineCreator />} />
        <Route path="/blocks" element={<BuildingBlocks />} />
        <Route path="/about" element={<About />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      </ErrorBoundary>
    </AppShell>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster theme="dark" position="top-right" />
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
