import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ClaudeKeyStatus } from '@shared'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, Notice, SettingsCard, StatusBadge, cleanError } from './parts'

const changed = () => window.dispatchEvent(new CustomEvent('axon:claudeKeyChanged'))

// Claude: an Anthropic Console API key, held in memory only (detected from ~/.claude.json on launch, or entered here).
export function ClaudeSettings() {
  const [status, setStatus] = useState<ClaudeKeyStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { window.axon.claudeKey.getStatus().then(setStatus).catch(() => {}) }, [])

  function close(o: boolean) {
    if (!o) { setKey(''); setError('') }
    setOpen(o)
  }

  async function save() {
    if (!key.startsWith('sk-ant-')) { setError('Key must start with "sk-ant-"'); return }
    setBusy(true)
    try {
      setStatus(await window.axon.claudeKey.set(key))
      changed()
      toast.success('Claude API key updated for this session')
      close(false)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsCard
        title="Claude"
        description="Agent runs need an Anthropic Console API key (a Claude subscription login isn't supported). The key is kept in memory only — never written to disk."
        status={status?.hasKey ? <StatusBadge tone="ok">Key set</StatusBadge> : <StatusBadge tone="warn">No key</StatusBadge>}
        footer={<Button variant="outline" onClick={() => setOpen(true)}>{status?.hasKey ? 'Update key' : 'Enter key'}</Button>}
      >
        <Field
          label="API key"
          htmlFor="claude-key"
          hint={status?.hasKey && status.source
            ? <>Resolved from <span className="text-foreground">{status.source}</span>; re-detected on every launch.</>
            : <>Get a key at console.anthropic.com.</>}
        >
          <Input id="claude-key" readOnly value={status?.hasKey ? status.masked ?? '' : ''} placeholder="Not set" className="font-mono" />
        </Field>

        {status?.candidate && (
          <Alert>
            <AlertTitle>Use the key found in {status.candidate.source}?</AlertTitle>
            <AlertDescription>
              <span className="font-mono">{status.candidate.masked}</span>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={async () => { setStatus(await window.axon.claudeKey.confirmDetected()); changed() }}>Use this key</Button>
                <Button size="sm" variant="outline" onClick={async () => setStatus(await window.axon.claudeKey.rejectDetected())}>Don&apos;t use</Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {status?.conflict && (
          <Alert variant="destructive">
            <AlertTitle>Conflicting keys detected — pick one manually</AlertTitle>
            <AlertDescription>
              <div className="font-mono text-xs">~/.claude.json: {status.conflict.claudeJson}</div>
              <div className="font-mono text-xs">~/.claude/config.json: {status.conflict.configJson}</div>
            </AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">Prompt-mode model: claude-haiku-4-5</p>
      </SettingsCard>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Claude API key</DialogTitle>
            <DialogDescription>Applies to this session and is re-detected from your Claude config on the next launch.</DialogDescription>
          </DialogHeader>
          <Field label="New API key" htmlFor="claude-new-key">
            <Input id="claude-new-key" type="password" autoComplete="off" autoFocus placeholder="sk-ant-…" value={key} onChange={(e) => { setKey(e.target.value); setError('') }} />
          </Field>
          {error && <Notice ok={false}>{error}</Notice>}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy || !key}>{busy ? 'Saving…' : 'Update'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
