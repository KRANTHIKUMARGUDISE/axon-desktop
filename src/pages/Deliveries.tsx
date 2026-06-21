import { useState, useEffect, useRef } from 'react'
import { useDeliveries } from '@/hooks/useDeliveries'
import { usePipelines } from '@/hooks/usePipelines'
import { useAuthReady } from '@/hooks/useAuthReady'
import NewDeliveryModal, { useNewDeliveryModal } from '@/components/delivery/NewDeliveryModal'
import DeliveryPanel from '@/components/delivery/DeliveryPanel'
import type { DeliveryStatus } from '@/types'

// ── helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  Running: 'var(--axon-nexus2)',
  Completed: 'var(--axon-green)',
  Failed: 'var(--axon-red)',
  Paused: 'var(--axon-amber)',
  Pending: 'var(--axon-t3)',
  Cancelled: 'var(--axon-t3)',
  Waiting: 'var(--axon-amber)',
}

const STATUS_BG: Record<string, string> = {
  Running: 'var(--axon-nx-glow)',
  Completed: 'var(--axon-green-d)',
  Failed: 'var(--axon-red-d)',
  Paused: 'var(--axon-amber-d)',
  Pending: 'var(--axon-bg4)',
  Cancelled: 'var(--axon-bg4)',
}

const PROGRESS_COLOR: Record<string, string> = {
  Running: 'var(--axon-nexus2)',
  Completed: 'var(--axon-green)',
  Failed: 'var(--axon-red)',
  Paused: 'var(--axon-amber)',
  Pending: 'var(--axon-t3)',
  Waiting: 'var(--axon-amber)',
  Cancelled: 'var(--axon-t3)',
}

const STATUS_TABS = ['All', 'Running', 'Waiting', 'Completed', 'Failed', 'Cancelled'] as const
type TabStatus = typeof STATUS_TABS[number]

function fmtStarted(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (diffDays === 0) return `Today ${time}`
  if (diffDays === 1) return `Yesterday ${time}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
}

function initials(name: string | undefined | null) {
  return (name ?? '?').slice(0, 2).toUpperCase()
}

// ── skeleton row ───────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <tr>
      {[200, 120, 70, 100, 90, 70, 50].map((w, i) => (
        <td key={i} style={{ padding: '12px 14px' }}>
          <div style={{ height: 12, width: w, borderRadius: 4, background: 'var(--axon-bg4)' }} />
        </td>
      ))}
    </tr>
  )
}

// ── main component ─────────────────────────────────────────────────────────────
export default function Deliveries() {
  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — Deliveries')
    }
  }, [])

  const modal = useNewDeliveryModal()

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activeStatus, setActiveStatus] = useState<TabStatus>('All')
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null)
  const [activeTeam, setActiveTeam] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const authReady = useAuthReady()
  const { data: paged, isLoading, isError, error } = useDeliveries({ page, pageSize: 5 }, authReady)
  const { data: pipelines = [] } = usePipelines(undefined, authReady)

  const allItems = paged?.items ?? []
  const total = paged?.total ?? 0
  const pageSize = paged?.pageSize ?? 5

  // Extract distinct teams from current result set
  const allTeams = Array.from(new Set(allItems.map(d => d.ownerTeam).filter(Boolean))) as string[]

  // client-side filter (mock data doesn't paginate by status/search)
  const filtered = allItems.filter(d => {
    if (activeStatus !== 'All') {
      const matchWaiting = activeStatus === 'Waiting' && (d.status === 'Pending' || d.status === 'Paused')
      const matchDirect = d.status === activeStatus
      if (!matchWaiting && !matchDirect) return false
    }
    if (activePipelineId && d.pipelineId !== activePipelineId) return false
    if (activeTeam && d.ownerTeam !== activeTeam) return false
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      if (!(d.ticketId ?? '').toLowerCase().includes(q) && !(d.title ?? '').toLowerCase().includes(q) && !(d.pipelineName ?? '').toLowerCase().includes(q)) return false
    }
    return true
  })

  // status counts
  const counts: Record<TabStatus, number> = {
    All: allItems.length,
    Running: allItems.filter(d => d.status === 'Running').length,
    Waiting: allItems.filter(d => d.status === 'Pending' || d.status === 'Paused').length,
    Completed: allItems.filter(d => d.status === 'Completed').length,
    Failed: allItems.filter(d => d.status === 'Failed').length,
    Cancelled: allItems.filter(d => d.status === 'Cancelled').length,
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const showFrom = (page - 1) * pageSize + 1
  const showTo = Math.min(page * pageSize, total)

  function handleRowClick(id: string) {
    setSelectedDeliveryId(prev => prev === id ? null : id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', overflow: 'hidden', background: 'var(--axon-bg)' }}>
      {/* ── List side ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          padding: '0 22px', height: 52,
          background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)',
          display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)' }}>Deliveries</div>
            <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 1 }}>Track and manage all pipeline executions</div>
          </div>
          <button
            onClick={() => modal.open()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '6px 13px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', border: 'none', background: 'var(--axon-nexus)', color: '#fff',
              fontFamily: 'inherit',
            }}
          >
            + New Delivery
          </button>
        </div>

        {/* Filter row */}
        <div style={{
          padding: '10px 22px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)', flexShrink: 0,
        }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by ticket ID, title, pipeline…"
            style={{
              flex: 1, minWidth: 0, background: 'var(--axon-bg3)', border: '1px solid var(--axon-border2)',
              borderRadius: 8, padding: '7px 10px', fontSize: 12, color: 'var(--axon-t1)',
              outline: 'none', fontFamily: 'inherit',
            }}
            onFocus={e => (e.target.style.borderColor = 'rgba(111,95,232,0.5)')}
            onBlur={e => (e.target.style.borderColor = 'var(--axon-border2)')}
          />
          <select
            value={activePipelineId ?? ''}
            onChange={e => { setActivePipelineId(e.target.value || null); setPage(1) }}
            style={{
              background: 'var(--axon-bg3)', border: '1px solid var(--axon-border2)', borderRadius: 8,
              padding: '7px 10px', fontSize: 12, color: activePipelineId ? 'var(--axon-t1)' : 'var(--axon-t3)',
              outline: 'none', cursor: 'pointer', fontFamily: 'inherit', appearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 26,
            }}
          >
            <option value="">All Pipelines</option>
            {pipelines.map(p => (
              <option key={p.id} value={p.id} style={{ background: 'var(--axon-bg3)', color: 'var(--axon-t1)' }}>{p.name}</option>
            ))}
          </select>
          {allTeams.length > 0 && (
            <select
              value={activeTeam ?? ''}
              onChange={e => { setActiveTeam(e.target.value || null); setPage(1) }}
              style={{
                background: 'var(--axon-bg3)', border: '1px solid var(--axon-border2)', borderRadius: 8,
                padding: '7px 10px', fontSize: 12, color: activeTeam ? 'var(--axon-t1)' : 'var(--axon-t3)',
                outline: 'none', cursor: 'pointer', fontFamily: 'inherit', appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 26,
              }}
            >
              <option value="">All Teams</option>
              {allTeams.map(t => (
                <option key={t} value={t} style={{ background: 'var(--axon-bg3)', color: 'var(--axon-t1)' }}>{t}</option>
              ))}
            </select>
          )}
        </div>

        {/* Status tabs */}
        <div style={{
          display: 'flex', gap: 0, padding: '0 22px',
          background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)', flexShrink: 0,
        }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveStatus(tab); setPage(1) }}
              style={{
                padding: '9px 14px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: 'transparent', border: 'none', fontFamily: 'inherit',
                color: activeStatus === tab ? 'var(--axon-nexus2)' : 'var(--axon-t3)',
                borderBottom: activeStatus === tab ? '2px solid var(--axon-nexus2)' : '2px solid transparent',
                marginBottom: -1, display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              {tab}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 10,
                background: activeStatus === tab ? 'var(--axon-nx-glow)' : 'var(--axon-bg4)',
                color: activeStatus === tab ? 'var(--axon-nexus2)' : 'var(--axon-t4)',
              }}>
                {counts[tab]}
              </span>
            </button>
          ))}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--axon-bg2)', position: 'sticky', top: 0, zIndex: 1 }}>
                {['Job', 'Delivery', 'Pipeline', 'Status', 'Progress', 'Started', 'Duration', 'Triggered by'].map(col => (
                  <th key={col} style={{
                    padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600,
                    color: 'var(--axon-t3)', borderBottom: '1px solid var(--axon-border)',
                    whiteSpace: 'nowrap',
                  }}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
              ) : isError ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px 14px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--axon-red)', fontSize: 12, marginBottom: 4 }}>Failed to load deliveries</div>
                    <div style={{ color: 'var(--axon-t4)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                      {error instanceof Error ? error.message : String(error)}
                    </div>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--axon-t3)', fontSize: 12 }}>
                    No deliveries found
                  </td>
                </tr>
              ) : (
                filtered.map(d => {
                  const isSelected = selectedDeliveryId === d.id
                  // Debug: check if status colors are found
                  if (!STATUS_COLOR[d.status]) {
                    console.warn(`Status "${d.status}" not found in STATUS_COLOR. Available keys:`, Object.keys(STATUS_COLOR))
                  }
                  return (
                    <tr
                      key={d.id}
                      onClick={() => handleRowClick(d.id)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(111,95,232,0.07)' : 'transparent',
                        borderBottom: '1px solid var(--axon-border)',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--axon-bg2)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isSelected ? 'rgba(111,95,232,0.07)' : 'transparent' }}
                    >
                      {/* Job */}
                      <td style={{ padding: '11px 14px', color: 'var(--axon-t2)', fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {d.jobNumber ? `#${d.jobNumber}` : '—'}
                      </td>
                      {/* Delivery */}
                      <td style={{ padding: '11px 14px' }}>
                        <div style={{ fontWeight: 600, color: 'var(--axon-t1)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{d.ticketId}</div>
                        {d.title && d.title !== d.ticketId && (
                          <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 2, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
                        )}
                      </td>
                      {/* Pipeline */}
                      <td style={{ padding: '11px 14px', color: 'var(--axon-t2)', whiteSpace: 'nowrap' }}>{d.pipelineName}</td>
                      {/* Status */}
                      <td style={{ padding: '11px 14px' }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                          color: STATUS_COLOR[d.status] || 'var(--axon-t3)',
                          background: STATUS_BG[d.status] || 'var(--axon-bg4)',
                          border: `1px solid ${STATUS_COLOR[d.status] || 'var(--axon-t3)'}33`,
                          whiteSpace: 'nowrap',
                        }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%',
                            background: STATUS_COLOR[d.status] || 'var(--axon-t3)',
                            flexShrink: 0
                          }} />
                          {d.status}
                        </span>
                      </td>
                      {/* Progress */}
                      <td style={{ padding: '11px 14px', minWidth: 110 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--axon-bg4)', overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: 2,
                              width: `${d.progress}%`,
                              background: PROGRESS_COLOR[d.status] || 'var(--axon-t3)',
                              transition: 'width 0.3s',
                            }} />
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--axon-t3)', minWidth: 28, textAlign: 'right' }}>{d.progress}%</span>
                        </div>
                      </td>
                      {/* Started */}
                      <td style={{ padding: '11px 14px', color: 'var(--axon-t2)', whiteSpace: 'nowrap', fontSize: 11 }}>{fmtStarted(d.startedAt)}</td>
                      {/* Duration */}
                      <td style={{ padding: '11px 14px', color: 'var(--axon-t2)', whiteSpace: 'nowrap', fontSize: 11 }}>{d.duration ?? '—'}</td>
                      {/* Triggered by */}
                      <td style={{ padding: '11px 14px' }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: '50%',
                          background: 'var(--axon-nx-glow)', border: '1px solid rgba(111,95,232,0.3)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 700, color: 'var(--axon-nexus2)',
                        }}>
                          {initials(d.createdByName)}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div style={{
          padding: '10px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--axon-bg2)', borderTop: '1px solid var(--axon-border)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>
            Showing {showFrom}–{showTo} of {total} deliveries
          </span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <PageBtn label="←" disabled={page === 1} onClick={() => setPage(p => p - 1)} />
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
              <PageBtn key={p} label={String(p)} active={page === p} onClick={() => setPage(p)} />
            ))}
            {totalPages > 5 && <span style={{ color: 'var(--axon-t4)', fontSize: 11, padding: '0 2px' }}>…</span>}
            {totalPages > 5 && <PageBtn label={String(totalPages)} active={page === totalPages} onClick={() => setPage(totalPages)} />}
            <PageBtn label="→" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} />
          </div>
        </div>
      </div>

      {/* ── Slide-out panel ── */}
      {selectedDeliveryId && (
        <DeliveryPanel
          deliveryId={selectedDeliveryId}
          onClose={() => setSelectedDeliveryId(null)}
        />
      )}

      <NewDeliveryModal
        isOpen={modal.isOpen}
        onClose={modal.close}
        defaultPipelineId={modal.defaultPipelineId}
      />
    </div>
  )
}

function PageBtn({ label, onClick, disabled, active }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 28, height: 28, padding: '0 6px', borderRadius: 6,
        border: active ? '1px solid var(--axon-nexus2)' : '1px solid var(--axon-border2)',
        background: active ? 'var(--axon-nx-glow)' : 'transparent',
        color: active ? 'var(--axon-nexus2)' : disabled ? 'var(--axon-t4)' : 'var(--axon-t2)',
        fontSize: 11, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  )
}
