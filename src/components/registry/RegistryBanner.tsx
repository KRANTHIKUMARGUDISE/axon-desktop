import { useState } from 'react'
import { useRegistryStatus } from '../../hooks/useRegistry'

const COPY: Record<string, { color: string; text: (q: number) => string } | undefined> = {
  Offline: {
    color: 'var(--axon-amber, #fbbf24)',
    text: (q) => `Offline — the registry can't be reached. Everything still works; ${q} change${q === 1 ? '' : 's'} will sync when you're back online.`,
  },
  NeedsAttention: {
    color: 'var(--axon-red, #f87171)',
    text: (q) => `Registry sync needs attention — ${q} change${q === 1 ? ' is' : 's are'} queued and nothing is lost.`,
  },
  ReadOnly: {
    color: 'var(--axon-amber, #fbbf24)',
    text: () => 'This registry needs a newer version of AXON — syncing your changes is paused (nothing is lost).',
  },
}

// Global offline / attention banner (always mounted in the app shell).
export function RegistryBanner() {
  const status = useRegistryStatus()
  const [busy, setBusy] = useState(false)
  const copy = status ? COPY[status.state] : undefined
  if (!status || !copy) return null
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '6px 16px', fontSize: 12,
        background: 'var(--axon-bg3, #161b2e)', borderBottom: `1px solid ${copy.color}`, color: 'var(--axon-t2)',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: copy.color, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        {copy.text(status.queued)}
        {status.lastError && status.state !== 'Offline' ? <span style={{ color: 'var(--axon-t3)' }}> — {status.lastError.split('\n')[0].slice(0, 160)}</span> : null}
      </span>
      {status.state !== 'ReadOnly' && (
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); try { await window.axon.registry.syncNow() } finally { setBusy(false) } }}
          style={{ fontSize: 12, color: 'var(--axon-nexus2, #a78bfa)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          {busy ? 'Syncing…' : 'Retry now'}
        </button>
      )}
    </div>
  )
}
