const COLORS: Record<string, { bg: string; fg: string }> = {
  Personal: { bg: 'rgba(148,163,184,0.12)', fg: 'var(--axon-t3)' },
  Team: { bg: 'rgba(56,189,248,0.14)', fg: '#38bdf8' },
  Org: { bg: 'rgba(111,95,232,0.18)', fg: '#a78bfa' },
}
const STATUS_COLORS: Record<string, string> = { Draft: '#fbbf24', Published: '#34d399', Deprecated: '#f87171' }

export function ScopeBadge({ scope, team }: { scope?: string; team?: string }) {
  const s = scope ?? 'Personal'
  const c = COLORS[s] ?? COLORS.Personal
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: c.bg, color: c.fg }}>
      {s === 'Team' && team ? `Team · ${team}` : s}
    </span>
  )
}

export function StatusBadge({ status }: { status?: string }) {
  if (!status) return null
  const color = STATUS_COLORS[status] ?? 'var(--axon-t3)'
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, border: `1px solid ${color}`, color }}>
      {status}
    </span>
  )
}
