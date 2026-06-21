import { useEffect, useState } from 'react'
import { ExternalLink, Clock } from 'lucide-react'
import axonIcon from '@/assets/axon-icon.png'
import axonTitle from '@/assets/axon-title.png'

interface SystemInfo {
  electronVersion: string
  nodeVersion: string
  platform: string
  appVersion: string
}

interface HealthStatus {
  latency: number | null
  isHealthy: boolean
  error: string | null
}

interface UserInfo {
  name?: string
  email?: string
  team?: string
  role?: string
}

export default function About() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null)
  const [userInfo, setUserInfo] = useState<UserInfo>({})
  const [backendUrl, setBackendUrl] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<string>('Checking...')
  const [loading, setLoading] = useState(true)

  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — About')
    }
  }, [])

  useEffect(() => {
    async function loadData() {
      try {
        if (!window.axon?.system || !window.axon?.settings) {
          setLoading(false)
          return
        }

        // Get system info
        const info = await window.axon.system.getInfo()
        setSystemInfo(info)

        // Get backend URL
        const url = await window.axon.settings.get('backendUrl')
        setBackendUrl(url)

        // Get user info from settings
        const [name, email, team, role] = await Promise.all([
          window.axon.settings.get('userName'),
          window.axon.settings.get('userEmail'),
          window.axon.settings.get('team'),
          window.axon.settings.get('userRole'),
        ])
        setUserInfo({ name: name || undefined, email: email || undefined, team: team || undefined, role: role || undefined })

        // Check health status
        if (url) {
          const status = await window.axon.system.getLatency(url)
          setHealthStatus(status)
        }

        // Check for updates
        const updates = await window.axon.system.checkForUpdates()
        setUpdateStatus(updates.message)
      } catch (err) {
        console.error('Failed to load about data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [])

  const getHealthColor = () => {
    if (!healthStatus) return 'var(--axon-t4)'
    if (healthStatus.isHealthy) return 'var(--axon-green)'
    return 'var(--axon-red)'
  }

  const getHealthLabel = () => {
    if (!healthStatus) return 'Unknown'
    if (healthStatus.isHealthy) return 'Connected'
    return 'Disconnected'
  }

  if (loading) {
    return (
      <div style={{ padding: '24px', color: 'var(--axon-t3)' }}>
        Loading system information...
      </div>
    )
  }

  return (
    <div style={{ padding: '24px', background: 'var(--axon-bg)', minHeight: '100%' }}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <div style={{ marginBottom: 12 }}>
            <img src={axonIcon} alt="AXON" style={{ height: 64, marginBottom: 8, display: 'inline-block' }} />
            <div>
              <img src={axonTitle} alt="AXON" style={{ height: 20, display: 'inline-block' }} />
            </div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--axon-t3)', margin: '16px 0 0' }}>
            Version {systemInfo?.appVersion || 'unknown'}
          </p>
        </div>

        {/* Connection Status */}
        <div style={{
          background: 'var(--axon-bg2)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: getHealthColor(),
              }}
            />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--axon-t1)' }}>
              {getHealthLabel()}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--axon-t3)', marginBottom: 8 }}>
            Backend: <code style={{ fontSize: 11, color: 'var(--axon-t2)' }}>{backendUrl || 'Not configured'}</code>
          </div>
          {healthStatus && healthStatus.latency !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--axon-t3)' }}>
              <Clock size={14} />
              {healthStatus.latency}ms latency
            </div>
          )}
          {healthStatus && healthStatus.error && (
            <div style={{ fontSize: 12, color: 'var(--axon-red)', marginTop: 8 }}>
              {healthStatus.error}
            </div>
          )}
        </div>

        {/* Current User Card */}
        <div style={{
          background: 'var(--axon-bg2)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
        }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t3)', margin: '0 0 12px', textTransform: 'uppercase' }}>
            Current User
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {userInfo.name && (
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, var(--axon-teal), var(--axon-blue))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#fff',
                  flexShrink: 0,
                }}
              >
                {userInfo.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              {userInfo.name && (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)' }}>
                  {userInfo.name}
                </div>
              )}
              {userInfo.email && (
                <div style={{ fontSize: 12, color: 'var(--axon-t3)', marginTop: 2 }}>
                  {userInfo.email}
                </div>
              )}
              {userInfo.team && (
                <div style={{ fontSize: 11, color: 'var(--axon-t4)', marginTop: 2 }}>
                  Team: {userInfo.team}
                  {userInfo.role && ` • ${userInfo.role}`}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* System Info */}
        <div style={{
          background: 'var(--axon-bg2)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
        }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t3)', margin: '0 0 12px', textTransform: 'uppercase' }}>
            System Information
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              { label: 'Electron', value: systemInfo?.electronVersion },
              { label: 'Node.js', value: systemInfo?.nodeVersion },
              { label: 'Platform', value: systemInfo?.platform },
            ].map((item) => (
              <div key={item.label}>
                <div style={{ fontSize: 11, color: 'var(--axon-t4)', marginBottom: 4 }}>
                  {item.label}
                </div>
                <code style={{ fontSize: 12, color: 'var(--axon-t2)', fontFamily: 'monospace' }}>
                  {item.value || '—'}
                </code>
              </div>
            ))}
          </div>
        </div>

        {/* Check for Updates */}
        <div style={{
          background: 'var(--axon-bg2)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 4 }}>
              Updates
            </div>
            <div style={{ fontSize: 12, color: 'var(--axon-t3)' }}>
              {updateStatus}
            </div>
          </div>
          <button
            onClick={() => window.axon.system.checkForUpdates().then(u => setUpdateStatus(u.message))}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid var(--axon-border2)',
              background: 'var(--axon-bg3)',
              color: 'var(--axon-t2)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Check Now
          </button>
        </div>

        {/* Links */}
        <div style={{
          background: 'var(--axon-bg2)',
          border: '1px solid var(--axon-border)',
          borderRadius: 10,
          padding: 0,
          overflow: 'hidden',
          marginBottom: 32,
        }}>
          {[
            { label: 'Documentation', url: 'https://docs.axon.dev', external: true },
            { label: 'Report Issue', url: 'https://github.com/anthropics/axon-desktop/issues', external: true },
          ].map((link) => (
            <button
              key={link.label}
              onClick={() => window.axon.shell.openExternal(link.url)}
              style={{
                width: '100%',
                padding: '12px 16px',
                border: 'none',
                background: 'transparent',
                borderBottom: '1px solid var(--axon-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--axon-t2)',
                fontFamily: 'inherit',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--axon-bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <span>{link.label}</span>
              <ExternalLink size={14} style={{ color: 'var(--axon-t4)' }} />
            </button>
          ))}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--axon-t4)' }}>
          <p style={{ margin: 0 }}>
            AXON Desktop • AI-powered delivery pipelines
          </p>
          <p style={{ margin: '4px 0 0' }}>
            © {new Date().getFullYear()} Anthropic. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  )
}
