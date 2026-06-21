import type { DeliverySummary } from '@/types'

interface StatCardsProps {
  deliveries: DeliverySummary[]
}

interface StatCardProps {
  label: string
  value: React.ReactNode
  sub: React.ReactNode
  accentColor: string
}

function StatCard({ label, value, sub, accentColor }: StatCardProps) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        background: 'var(--axon-bg2)',
        border: '1px solid var(--axon-border)',
        borderRadius: 12,
        padding: '16px 18px',
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--axon-t3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--axon-t1)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-1px', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 5 }}>
        {sub}
      </div>
      <div style={{ height: 2, background: accentColor, borderRadius: 1, marginTop: 10, opacity: 0.5 }} />
    </div>
  )
}

export default function StatCards({ deliveries }: StatCardsProps) {
  const today = new Date().toDateString()

  const active = deliveries.filter(d =>
    d.status === 'Running' || d.status === 'Paused' || d.status === 'Pending'
  )
  const running = deliveries.filter(d => d.status === 'Running').length
  const waiting = deliveries.filter(d => d.status === 'Paused' || d.status === 'Pending').length

  const completedToday = deliveries.filter(
    d => d.status === 'Completed' && d.completedAt && new Date(d.completedAt).toDateString() === today
  ).length

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 16 }}>
      <StatCard
        label="Active Deliveries"
        value={active.length}
        sub={`${running} running · ${waiting} waiting`}
        accentColor="var(--axon-nexus2)"
      />
      <StatCard
        label="Completed Today"
        value={completedToday}
        sub={<span style={{ color: 'var(--axon-green)', fontWeight: 600 }}>↑ 20% vs yesterday</span>}
        accentColor="var(--axon-green)"
      />
      <StatCard
        label="Autonomous Rate"
        value={<>78<span style={{ fontSize: 14, color: 'var(--axon-t3)' }}>%</span></>}
        sub={<span style={{ color: 'var(--axon-green)', fontWeight: 600 }}>↑ 12% this sprint</span>}
        accentColor="var(--axon-blue)"
      />
      <StatCard
        label="Team Maturity"
        value={<span style={{ color: 'var(--axon-nexus2)' }}>S₂</span>}
        sub={<span style={{ color: 'var(--axon-nexus2)', fontWeight: 600 }}>Improving</span>}
        accentColor="var(--axon-nexus2)"
      />
    </div>
  )
}
