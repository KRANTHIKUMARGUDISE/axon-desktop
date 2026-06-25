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

  // TEMP DIAGNOSTIC — remove once the "inputs become unfocusable during Agentic
  // execution" issue is pinned down. Logs window focus/blur, document visibility, a
  // periodic snapshot of the focused element, and every executor progress event (all
  // timestamped) to the DevTools console, so a freeze can be correlated with whatever
  // was happening in the main process at that exact moment.
  useEffect(() => {
    const log = (...args: unknown[]) => console.log('[diag]', new Date().toISOString(), ...args)
    const onFocus = () => log('window focus')
    const onBlur = () => log('window blur')
    const onVisibility = () => log('visibilitychange', document.visibilityState)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)

    const interval = setInterval(() => {
      const el = document.activeElement as HTMLElement | null
      log('activeElement', el?.tagName, el?.className?.slice(0, 60) || '')
    }, 3000)

    const progressHandler = (_event: unknown, data: unknown) => log('progress', data)
    window.axon.executor.onProgress(progressHandler)

    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(interval)
      window.axon.executor.offProgress(progressHandler)
    }
  }, [])

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
