import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation()

  // Set window title to "AXON" by default, or specific page titles
  // Pages set their own titles in their useEffect hooks
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      // These paths have their own title-setting logic; don't override
      const hasOwnTitle = /\/(pipelines|deliveries|blocks|about|settings)/.test(location.pathname)
      if (!hasOwnTitle) {
        window.axon.window.setTitle('AXON')
      }
    }
  }, [location.pathname])

  return (
    <div className="dark flex flex-col h-screen overflow-hidden" style={{ background: 'var(--axon-bg)' }}>
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}
