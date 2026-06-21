import { useNavigate } from 'react-router-dom'
import type { Pipeline } from '@/types'

interface QuickLaunchProps {
  pipelines: Pipeline[]
  onLaunch: (pipelineId?: string) => void
}

const CARDS = [
  { key: 'sdlc',  label: 'SDLC Delivery',  sub: 'Ticket → PR',       icon: '⚡', bg: 'var(--axon-nx-glow)',   match: 'SDLC' },
  { key: 'rra',   label: 'RRA Assessment', sub: 'Readiness check',    icon: '🔍', bg: 'var(--axon-pink-d)',   match: 'RRA' },
  { key: 'qa',    label: 'QA Automation',  sub: 'Test generation',    icon: '🧪', bg: 'var(--axon-blue-d)',   match: 'QA' },
]

export default function QuickLaunch({ pipelines, onLaunch }: QuickLaunchProps) {
  const navigate = useNavigate()

  function findPipeline(match: string) {
    return pipelines.find(p => p.name.toLowerCase().includes(match.toLowerCase()))?.id
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {CARDS.map(c => (
        <button
          key={c.key}
          onClick={() => onLaunch(findPipeline(c.match))}
          className="text-left transition-all"
          style={{
            background: 'var(--axon-bg3)',
            border: '1px solid var(--axon-border)',
            borderRadius: 8,
            padding: '12px 14px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: 'inherit',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'var(--axon-nexus2)'
            e.currentTarget.style.background = 'var(--axon-nx-glow)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = 'var(--axon-border)'
            e.currentTarget.style.background = 'var(--axon-bg3)'
          }}
        >
          <div style={{ width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0, background: c.bg }}>
            {c.icon}
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 1 }}>{c.label}</div>
            <div style={{ fontSize: 10, color: 'var(--axon-t3)' }}>{c.sub}</div>
          </div>
        </button>
      ))}

      <button
        onClick={() => navigate('/pipelines/new')}
        className="text-left transition-all"
        style={{
          background: 'var(--axon-bg3)',
          border: '1px solid var(--axon-border)',
          borderRadius: 8,
          padding: '12px 14px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontFamily: 'inherit',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--axon-nexus2)'
          e.currentTarget.style.background = 'var(--axon-nx-glow)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--axon-border)'
          e.currentTarget.style.background = 'var(--axon-bg3)'
        }}
      >
        <div style={{ width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, flexShrink: 0, background: 'var(--axon-teal-d)', color: 'var(--axon-teal)' }}>
          +
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)', marginBottom: 1 }}>New Pipeline</div>
          <div style={{ fontSize: 10, color: 'var(--axon-t3)' }}>Design a flow</div>
        </div>
      </button>
    </div>
  )
}
