import type { DeliverySummary, DeliveryStatus } from '@/types'

interface RecentActivityProps {
  deliveries: DeliverySummary[]
}

const DOT_COLORS: Record<DeliveryStatus, string> = {
  Running:   'var(--axon-nexus2)',
  Paused:    'var(--axon-blue)',
  Pending:   'var(--axon-amber)',
  Completed: 'var(--axon-green)',
  Failed:    'var(--axon-red)',
  Cancelled: 'var(--axon-t3)',
  Interrupted: 'var(--axon-amber)',
}

function describe(d: DeliverySummary): string {
  switch (d.status) {
    case 'Running':   return `${d.ticketId} is running — ${d.pipelineName}`
    case 'Completed': return `${d.ticketId} completed successfully`
    case 'Failed':    return `${d.ticketId} failed`
    case 'Paused':    return `${d.ticketId} waiting for approval`
    default:          return `${d.ticketId} is ${d.status.toLowerCase()}`
  }
}

function timeAgo(iso?: string): string {
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

export default function RecentActivity({ deliveries }: RecentActivityProps) {
  const sorted = [...deliveries]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 5)

  return (
    <>
      {sorted.map(d => (
        <div
          key={d.id}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--axon-border)', fontSize: 11 }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: '50%', background: DOT_COLORS[d.status], flexShrink: 0, marginTop: 3 }}
          />
          <span style={{ color: 'var(--axon-t2)', flex: 1, lineHeight: 1.5 }}>
            {describe(d)}
          </span>
          <span style={{ color: 'var(--axon-t4)', whiteSpace: 'nowrap' }}>
            {timeAgo(d.startedAt)}
          </span>
        </div>
      ))}
    </>
  )
}
