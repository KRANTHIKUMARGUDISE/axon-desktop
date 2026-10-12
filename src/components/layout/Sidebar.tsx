import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { LayoutGrid, Play, GitBranch, Box, Info, Workflow, Settings, KeyRound, BarChart2 } from 'lucide-react'
import { useDeliveries } from '@/hooks/useDeliveries'
import type { ClaudeKeyStatus } from '@/types'

const workspaceItems = [
  { to: '/dashboard', icon: LayoutGrid, label: 'Dashboard', end: true },
  { to: '/deliveries', icon: Play, label: 'Deliveries' },
  { to: '/intelligence', icon: BarChart2, label: 'Intelligence' },
]

const designItems = [
  { to: '/pipelines', icon: Workflow, label: 'Pipelines' },
  { to: '/pipelines/new', icon: GitBranch, label: 'Pipeline Creator' },
  { to: '/blocks', icon: Box, label: 'Building Blocks' },
]

const systemItems = [
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/about', icon: Info, label: 'About' },
]

export function Sidebar() {
  const { data: paged } = useDeliveries({ pageSize: 100 })
  const runningCount = (paged?.items ?? []).filter(d => d.status === 'Running').length

  const [userName, setUserName] = useState('')
  useEffect(() => {
    window.axon.settings.get('userName').then((v) => setUserName(typeof v === 'string' ? v : '')).catch(() => {})
  }, [])

  const [claudeKeyStatus, setClaudeKeyStatus] = useState<ClaudeKeyStatus | null>(null)
  useEffect(() => {
    function load() {
      window.axon.claudeKey.getStatus().then(setClaudeKeyStatus).catch(() => {})
    }
    load()
    window.addEventListener('axon:claudeKeyChanged', load)
    return () => window.removeEventListener('axon:claudeKeyChanged', load)
  }, [])

  return (
    <aside
      className="flex flex-col shrink-0 h-full border-r"
      style={{
        width: 216,
        background: 'var(--axon-bg2)',
        borderColor: 'var(--axon-border)',
      }}
    >
      {/* Nav */}
      <nav className="flex-1 px-2 py-2.5 flex flex-col gap-px overflow-y-auto">
        <span
          className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.8px]"
          style={{ color: 'var(--axon-t4)' }}
        >
          Workspace
        </span>

        {workspaceItems.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              [
                'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] border transition-all duration-[130ms] cursor-pointer select-none',
                isActive
                  ? 'border-[rgba(111,95,232,0.18)] text-[var(--axon-nexus2)]'
                  : 'border-transparent text-[var(--axon-t2)] hover:text-[var(--axon-t1)]',
              ].join(' ')
            }
            style={({ isActive }) =>
              isActive ? { background: 'var(--axon-nx-glow)' } : undefined
            }
          >
            <Icon size={14} className="shrink-0" />
            {label}
            {to === '/deliveries' && runningCount > 0 && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 10,
                  background: 'var(--axon-nexus2)',
                  color: '#fff',
                  minWidth: 18,
                  textAlign: 'center',
                }}
              >
                {runningCount}
              </span>
            )}
          </NavLink>
        ))}

        <span
          className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.8px]"
          style={{ color: 'var(--axon-t4)' }}
        >
          Design
        </span>

        {designItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/pipelines'}
            className={({ isActive }) =>
              [
                'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] border transition-all duration-[130ms] cursor-pointer select-none',
                isActive
                  ? 'border-[rgba(111,95,232,0.18)] text-[var(--axon-nexus2)]'
                  : 'border-transparent text-[var(--axon-t2)] hover:text-[var(--axon-t1)]',
              ].join(' ')
            }
            style={({ isActive }) =>
              isActive ? { background: 'var(--axon-nx-glow)' } : undefined
            }
          >
            <Icon size={14} className="shrink-0" />
            {label}
          </NavLink>
        ))}

        <span
          className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.8px]"
          style={{ color: 'var(--axon-t4)' }}
        >
          System
        </span>

        {systemItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              [
                'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12.5px] border transition-all duration-[130ms] cursor-pointer select-none',
                isActive
                  ? 'border-[rgba(111,95,232,0.18)] text-[var(--axon-nexus2)]'
                  : 'border-transparent text-[var(--axon-t2)] hover:text-[var(--axon-t1)]',
              ].join(' ')
            }
            style={({ isActive }) =>
              isActive ? { background: 'var(--axon-nx-glow)' } : undefined
            }
          >
            <Icon size={14} className="shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User area */}
      <div
        className="px-2 py-2.5 border-t shrink-0"
        style={{ borderColor: 'var(--axon-border)' }}
      >
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer">
          <div
            className="flex items-center justify-center w-[26px] h-[26px] rounded-full text-[10px] font-bold text-white shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--axon-teal), var(--axon-blue))' }}
          >
            KG
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium" style={{ color: 'var(--axon-t1)' }}>
              {userName || 'Local user'}
            </div>
            <div className="text-[10px]" style={{ color: 'var(--axon-t3)' }}>
              Local workspace
            </div>
          </div>
          <KeyRound
            size={13}
            className="shrink-0"
            style={{
              color: claudeKeyStatus === null
                ? 'var(--axon-t4)'
                : claudeKeyStatus.hasKey
                ? 'var(--axon-green)'
                : claudeKeyStatus.conflict
                  ? 'var(--axon-amber)'
                  : 'var(--axon-red)',
            }}
          >
            <title>{claudeKeyStatus === null
                ? 'Checking Claude key…'
                : claudeKeyStatus.hasKey
                  ? `Claude key resolved (${claudeKeyStatus.source ?? 'unknown source'})`
                  : claudeKeyStatus.conflict
                    ? 'Conflicting Claude keys detected — resolve in Settings'
                    : 'No Claude key resolved — set one in Settings'}</title>
          </KeyRound>
        </div>
      </div>
    </aside>
  )
}
