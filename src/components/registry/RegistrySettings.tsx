import { useEffect, useState } from 'react'
import { useRegistryStatus } from '../../hooks/useRegistry'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

const STATE_COLORS: Record<string, string> = {
  Idle: 'var(--axon-green, #34d399)', Syncing: 'var(--axon-nexus2, #a78bfa)', Offline: '#fbbf24',
  NeedsAttention: 'var(--axon-red, #f87171)', ReadOnly: '#fbbf24', Unconfigured: 'var(--axon-t3)',
}
const STATE_LABEL: Record<string, string> = {
  Idle: 'Up to date', Syncing: 'Syncing…', Offline: 'Offline', NeedsAttention: 'Needs attention', ReadOnly: 'Read-only (update AXON)', Unconfigured: 'Not configured',
}

const label = { fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 6 } as const
const err = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Failed')

// Settings → Registry: URL/branch override, sync interval, last sync status, queued writes.
export function RegistrySettings() {
  const status = useRegistryStatus()
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [interval, setIntervalMin] = useState('5')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    Promise.all([window.axon.settings.get('registryUrl'), window.axon.settings.get('registryBranch'), window.axon.settings.get('syncIntervalMinutes')])
      .then(([u, b, i]) => { setUrl(typeof u === 'string' ? u : ''); setBranch(typeof b === 'string' ? b : ''); setIntervalMin(String(typeof i === 'number' ? i : 5)) })
      .catch(() => {})
  }, [])

  async function save() {
    setMsg(null)
    try {
      await window.axon.settings.set('registryUrl', url.trim())
      await window.axon.settings.set('registryBranch', branch.trim())
      await window.axon.settings.set('syncIntervalMinutes', Math.max(1, Math.round(Number(interval) || 5)))
      setMsg({ ok: true, text: 'Saved — applies from the next sync.' })
    } catch (e) {
      setMsg({ ok: false, text: err(e) })
    }
  }

  async function syncNow() {
    setSyncing(true)
    try { await window.axon.registry.syncNow() } finally { setSyncing(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {status && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', fontSize: 12, color: 'var(--axon-t2)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLORS[status.state] }} />
            <strong style={{ color: 'var(--axon-t1)' }}>{STATE_LABEL[status.state] ?? status.state}</strong>
          </span>
          <span>Last sync: {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'never'}</span>
          <span>Queued changes: <strong style={{ color: status.queued ? '#fbbf24' : 'var(--axon-t1)' }}>{status.queued}</strong></span>
          <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing || status.state === 'Syncing' || status.state === 'Unconfigured'} className="ml-auto">
            {syncing || status.state === 'Syncing' ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
      )}
      {status?.lastError && status.state !== 'Idle' && (
        <p style={{ fontSize: 12, color: 'var(--axon-red)', margin: 0 }}>{status.lastError.split('\n')[0].slice(0, 400)}</p>
      )}
      {status && status.rejected.length > 0 && (
        <div style={{ fontSize: 12, color: '#fbbf24' }}>
          {status.rejected.length} change{status.rejected.length === 1 ? ' was' : 's were'} not pushed because the secret scan found possible credentials:
          <ul style={{ margin: '4px 0 0 16px' }}>
            {status.rejected.slice(0, 5).map((r) => <li key={r.path + r.rule}><code>{r.path}</code> — {r.rule}</li>)}
          </ul>
          Remove the secret and save the document again.
        </div>
      )}

      <div>
        <label style={label}>Registry URL <span style={{ color: 'var(--axon-t4)' }}>(blank = built-in default)</span></label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={status?.registryUrl || 'https://github.com/your-org/axon-registry.git'} spellCheck={false} />
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={label}>Branch <span style={{ color: 'var(--axon-t4)' }}>(blank = main)</span></label>
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={status?.branch || 'main'} spellCheck={false} />
        </div>
        <div style={{ width: 160 }}>
          <label style={label}>Sync every (minutes)</label>
          <Input value={interval} onChange={(e) => setIntervalMin(e.target.value)} inputMode="numeric" />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button size="sm" onClick={save}>Save registry settings</Button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--axon-green)' : 'var(--axon-red)' }}>{msg.text}</span>}
      </div>
    </div>
  )
}
