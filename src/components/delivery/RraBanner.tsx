import type { DeliveryStep } from '../../types'

interface RraBannerProps {
  steps: DeliveryStep[]
}

export default function RraBanner({ steps }: RraBannerProps) {
  const rraStep = steps.find(
    (s) => s.name.includes('RRA') || s.nodeName?.includes('RRA')
  )

  const noRraStep = !rraStep
  const score =
    rraStep?.status === 'Completed' ? (rraStep.agentOutput?.result?.score ?? null) : null
  const missingFields = rraStep?.agentOutput?.missingFields ?? []

  const circumference = 2 * Math.PI * 30
  const dashArray = score != null ? `${(score / 100) * circumference} ${circumference}` : `0 ${circumference}`

  const scoreColor =
    score == null ? 'var(--axon-t3)'
    : score >= 80 ? 'var(--axon-green)'
    : score >= 50 ? 'var(--axon-amber)'
    : 'var(--axon-red)'

  const badgeStyle =
    score == null ? null
    : score >= 80
    ? { background: 'var(--axon-green-d)', color: 'var(--axon-green)', border: '1px solid rgba(16,185,129,0.2)' }
    : score >= 50
    ? { background: 'var(--axon-amber-d)', color: 'var(--axon-amber)', border: '1px solid rgba(245,158,11,0.2)' }
    : { background: 'var(--axon-red-d)', color: 'var(--axon-red)', border: '1px solid rgba(239,68,68,0.2)' }

  const badgeLabel =
    score == null ? null
    : score >= 80 ? '✓ Requirement Ready'
    : score >= 50 ? '⚠ Needs Review'
    : '✕ Not Ready'

  return (
    <div style={{
      background: 'var(--axon-bg2)',
      border: '1px solid var(--axon-border)',
      borderRadius: 12,
      padding: '14px 18px',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 16,
    }}>
      {/* Score ring */}
      <div style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
        <svg width="72" height="72" viewBox="0 0 72 72" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="7" />
          <circle
            cx="36" cy="36" r="30" fill="none"
            stroke={scoreColor} strokeWidth="7"
            strokeDasharray={dashArray}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.5s ease' }}
          />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{
            fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color: score != null ? scoreColor : 'var(--axon-t3)', lineHeight: 1,
          }}>
            {score != null ? score : '…'}
          </span>
          <span style={{ fontSize: 8, color: 'var(--axon-t4)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            RRA
          </span>
        </div>
      </div>

      {/* Detail */}
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 6 }}>
          {score != null
            ? `Requirement Readiness — ${score >= 80 ? 'Passed' : score >= 50 ? 'Needs Review' : 'Not Ready'}`
            : noRraStep
            ? 'RRA Assessment — Not applicable'
            : 'RRA Assessment — loading…'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {badgeLabel && badgeStyle && (
            <span style={{
              ...badgeStyle,
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: 10, fontWeight: 600, padding: '2px 7px',
              borderRadius: 20, letterSpacing: '0.3px',
            }}>
              {badgeLabel}
            </span>
          )}
          {missingFields.map((f) => (
            <span key={f} style={{
              background: 'var(--axon-amber-d)', color: 'var(--axon-amber)',
              border: '1px solid rgba(245,158,11,0.2)',
              display: 'inline-flex', alignItems: 'center',
              fontSize: 10, fontWeight: 600, padding: '2px 7px',
              borderRadius: 20, letterSpacing: '0.3px',
            }}>
              ⚠ {f}
            </span>
          ))}
        </div>
      </div>

    </div>
  )
}
