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
import Intelligence from './pages/Intelligence'
import Rules from './pages/Rules'
import About from './pages/About'
import Setup from './pages/Setup'
import { useFeatures } from './hooks/useFeatures'
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
  const { features, loaded: featuresLoaded } = useFeatures()
  const navigate = useNavigate()

  // Clicking an OS notification (gate reached / completed / failed) opens that delivery's Live View.
  useEffect(() => window.axon.events.onOpenDelivery((deliveryId) => navigate(`/deliveries/${deliveryId}`)), [navigate])

  useEffect(() => {
    // Onboarded = a Jira-verified identity exists (set in main by the onboarding flow).
    window.axon.identity.get().then((id) => setSetupComplete(id.onboarded)).catch(() => setSetupComplete(false))
  }, [])

  // One typed event channel from the main process (D2): keep every list/detail query fresh.
  useEffect(() => {
    return window.axon.events.onDeliveryEvent((event) => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
      queryClient.invalidateQueries({ queryKey: ['delivery', event.deliveryId] })
    })
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
        <Route path="/rules" element={<Rules />} />
        <Route path="/pipelines" element={<Pipelines />} />
        <Route path="/pipelines/new" element={<PipelineCreator />} />
        <Route path="/pipelines/:id/edit" element={<PipelineCreator />} />
        <Route path="/blocks" element={<BuildingBlocks />} />
        {/* D6: only routable when the flag is on; otherwise the URL falls through to the dashboard. */}
        {features.intelligence && <Route path="/intelligence" element={<Intelligence />} />}
        {!featuresLoaded && <Route path="/intelligence" element={null} />}
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
        {/* offset.top clears the native Windows titleBarOverlay (minimize/maximize/close),
            which is drawn by the OS above the window's height:44 title bar — not part of
            the DOM, so no z-index here can raise toasts above it. Pushing toasts to start
            below y=44 avoids the overlap entirely. */}
        <Toaster theme="dark" position="top-right" offset={{ top: 56 }} />
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
