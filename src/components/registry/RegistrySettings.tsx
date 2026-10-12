import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ConnectionTest } from '@shared'
import { useRegistryStatus } from '../../hooks/useRegistry'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { Field, FieldRow, Notice, SettingsCard, StatusBadge, cleanError } from '../settings/parts'

const STATE: Record<string, { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' }> = {
  Idle: { label: 'Up to date', tone: 'ok' },
  Syncing: { label: 'Syncing…', tone: 'muted' },
  Offline: { label: 'Offline', tone: 'warn' },
  NeedsAttention: { label: 'Needs attention', tone: 'error' },
  ReadOnly: { label: 'Read-only — update AXON', tone: 'warn' },
  Unconfigured: { label: 'Not configured', tone: 'muted' },
}

const REJECTION_TEXT: Record<string, string> = {
  'path-not-allowed': 'queued under a previous identity (re-published under your current one)',
}

// Settings → Registry: connection (URL / branch / interval) and sync status.
export function RegistrySettings() {
  const status = useRegistryStatus()
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [interval, setIntervalMin] = useState('5')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [conn, setConn] = useState<ConnectionTest | null>(null)

  useEffect(() => {
    Promise.all([window.axon.settings.get('registryUrl'), window.axon.settings.get('registryBranch'), window.axon.settings.get('syncIntervalMinutes')])
      .then(([u, b, i]) => { setUrl(typeof u === 'string' ? u : ''); setBranch(typeof b === 'string' ? b : ''); setIntervalMin(String(typeof i === 'number' ? i : 5)) })
      .catch(() => {})
  }, [])

  async function save() {
    setSaving(true)
    try {
      await window.axon.settings.set('registryUrl', url.trim())
      await window.axon.settings.set('registryBranch', branch.trim())
      await window.axon.settings.set('syncIntervalMinutes', Math.max(1, Math.round(Number(interval) || 5)))
      toast.success('Registry settings saved — applied from the next sync')
      setConn(null)
    } catch (e) {
      toast.error(cleanError(e, 'Could not save registry settings'))
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    setConn(null)
    try {
      setConn(await window.axon.onboarding.testRegistry(url.trim(), branch.trim()))
    } catch (e) {
      setConn({ ok: false, canRead: false, canPush: false, branchExists: false, error: cleanError(e) })
    } finally {
      setTesting(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try { await window.axon.registry.syncNow() } finally { setSyncing(false) }
  }

  const st = status ? STATE[status.state] ?? { label: status.state, tone: 'muted' as const } : null
  const busy = syncing || status?.state === 'Syncing'

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        title="Registry connection"
        description="The shared axon-registry Git repository. Leave URL and branch blank to use the built-in default."
        footer={
          <>
            <Button variant="outline" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </>
        }
      >
        <Field label="Registry URL" htmlFor="reg-url">
          <Input id="reg-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={status?.registryUrl || 'https://github.com/your-org/axon-registry.git'} spellCheck={false} className="font-mono" />
        </Field>
        <FieldRow>
          <Field label="Branch" htmlFor="reg-branch">
            <Input id="reg-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={status?.branch || 'main'} spellCheck={false} className="font-mono" />
          </Field>
          <Field label="Sync every (minutes)" htmlFor="reg-interval">
            <Input id="reg-interval" value={interval} onChange={(e) => setIntervalMin(e.target.value)} inputMode="numeric" />
          </Field>
        </FieldRow>
        {conn && (
          <Notice ok={conn.ok}>
            {conn.ok
              ? `Read and push access OK${conn.branchExists ? '' : ' (the branch will be created on the first push)'}.`
              : (conn.error ?? 'Connection failed').split('\n')[0].slice(0, 300)}
          </Notice>
        )}
      </SettingsCard>

      <SettingsCard
        title="Sync status"
        description="Your own pipelines and blocks sync to users/<your-email>/ in the registry. Changes made offline are queued and never lost."
        status={st && <StatusBadge tone={st.tone}>{st.label}</StatusBadge>}
        footer={<Button onClick={syncNow} disabled={busy || !status || status.state === 'Unconfigured'}>{busy ? 'Syncing…' : 'Sync now'}</Button>}
      >
        <FieldRow>
          <Field label="Last sync" htmlFor="reg-last"><Input id="reg-last" readOnly value={status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Never'} /></Field>
          <Field label="Queued changes" htmlFor="reg-queued"><Input id="reg-queued" readOnly value={String(status?.queued ?? 0)} /></Field>
        </FieldRow>
        {status?.lastError && status.state !== 'Idle' && <Notice ok={false}>{status.lastError.split('\n')[0].slice(0, 400)}</Notice>}
        {status && status.rejected.length > 0 && (
          <>
            <Separator />
            <Notice ok={false}>
              {status.rejected.length} change{status.rejected.length === 1 ? ' was' : 's were'} not pushed:
              <ul className="mt-1 list-disc pl-4">
                {status.rejected.slice(0, 5).map((r) => (
                  <li key={r.path + r.rule}><code className="text-xs">{r.path}</code> — {REJECTION_TEXT[r.rule] ?? `possible secret (${r.rule}); remove it and save again`}</li>
                ))}
              </ul>
            </Notice>
          </>
        )}
      </SettingsCard>
    </div>
  )
}
