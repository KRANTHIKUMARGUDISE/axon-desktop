import { useNavigate } from 'react-router-dom'
import { ALL_STATUS_KEYS, statusBg, statusColor, statusColorMap } from '../../utils/statusColors'
import type { DeliverySummary, DeliveryStatus } from '@/types'

interface ActiveDeliveriesProps {
  deliveries: DeliverySummary[]
  isLoading: boolean
  isError: boolean
}

const STATUS_COLORS: Record<DeliveryStatus, { bg: string; color: string; dot: string }> = Object.fromEntries(
  ALL_STATUS_KEYS.map((k) => [k, { bg: statusBg(k), color: statusColor(k), dot: statusColor(k) }]),
) as Record<DeliveryStatus, { bg: string; color: string; dot: string }>

const PROG_COLORS = statusColorMap(ALL_STATUS_KEYS) as Record<DeliveryStatus, string>

function timeAgo(iso?: string) {
  if (!iso) return '—'
  const timestamp = new Date(iso).getTime()
  if (isNaN(timestamp)) return '—'
  const mins = Math.floor((Date.now() - timestamp) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function SkeletonRow() {
  return (
    <tr>
      {[140, 90, 70, 90, 70].map((w, i) => (
        <td key={i} style={{ padding: '10px', borderBottom: '1px solid var(--axon-border)' }}>
          <div style={{ height: 12, width: w, borderRadius: 4, background: 'var(--axon-bg3)', animation: 'pulse 1.5s infinite' }} />
        </td>
      ))}
    </tr>
  )
}

export default function ActiveDeliveries({ deliveries, isLoading, isError }: ActiveDeliveriesProps) {
  const navigate = useNavigate()

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8" style={{ color: 'var(--axon-t3)', fontSize: 12 }}>
        <span>Failed to load deliveries</span>
        <button onClick={() => window.location.reload()} style={{ color: 'var(--axon-nexus2)', fontSize: 11, cursor: 'pointer', background: 'none', border: 'none' }}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Delivery', 'Pipeline', 'Status', 'Progress', 'Started'].map(h => (
              <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--axon-t4)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '7px 10px', borderBottom: '1px solid var(--axon-border)', whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>
          ) : deliveries.map(d => {
            const c = STATUS_COLORS[d.status]
            return (
              <tr
                key={d.id}
                onClick={() => navigate(`/deliveries/${d.id}`)}
                className="transition-colors"
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--axon-bg3)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '10px', borderBottom: '1px solid var(--axon-border)' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 2 }}>{d.ticketId}</div>
                  {d.title && d.title !== d.ticketId && (
                    <div style={{ fontSize: 11, color: 'var(--axon-t3)' }}>{d.title}</div>
                  )}
                </td>
                <td style={{ padding: '10px', borderBottom: '1px solid var(--axon-border)' }}>
                  <span style={{ fontSize: 11, color: 'var(--axon-t2)' }}>{d.pipelineName}</span>
                </td>
                <td style={{ padding: '10px', borderBottom: '1px solid var(--axon-border)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: '0.3px', background: c.bg, color: c.color, border: `1px solid ${c.color}33` }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
                    {d.status}
                  </span>
                </td>
                <td style={{ padding: '10px', borderBottom: '1px solid var(--axon-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 80, height: 3, background: 'var(--axon-border2)', borderRadius: 2 }}>
                      <div style={{ width: `${d.progress}%`, height: '100%', borderRadius: 2, background: PROG_COLORS[d.status] }} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--axon-t2)' }}>{d.progress}%</span>
                  </div>
                </td>
                <td style={{ padding: '10px', borderBottom: '1px solid var(--axon-border)' }}>
                  <span style={{ fontSize: 11, color: 'var(--axon-t2)' }}>{timeAgo(d.startedAt)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
