import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ClaudeKeyStatus } from '@shared'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, Info, Notice, SettingsCard, StatusBadge, cleanError } from './parts'

const changed = () => window.dispatchEvent(new CustomEvent('axon:claudeKeyChanged'))

// Claude: an Anthropic Console API key from exactly one source — linked to Claude Code's own config (read fresh from
// that file, only a fingerprint is stored) or entered in AXON (encrypted with the OS keychain).
export function ClaudeSettings() {
  const [status, setStatus] = useState<ClaudeKeyStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Read again every time Settings opens: a linked key is re-read from its file.
  useEffect(() => { window.axon.claudeKey.getStatus().then(setStatus).catch(() => {}) }, [])

  const apply = async (call: () => Promise<ClaudeKeyStatus>) => {
    setStatus(await call())
    changed()
  }

  function close(o: boolean) {
    if (!o) { setKey(''); setError('') }
    setOpen(o)
  }

  async function save() {
    if (!key.startsWith('sk-ant-')) { setError('Key must start with "sk-ant-"'); return }
    setBusy(true)
    try {
      await apply(() => window.axon.claudeKey.set(key))
      toast.success('Claude API key saved in AXON')
      close(false)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const badge = !status ? null
    : status.hasKey ? <StatusBadge tone="ok">Key set</StatusBadge>
    : status.problem ? <StatusBadge tone="error">{status.problem.kind === 'missing' ? 'Linked key missing' : 'Key changed'}</StatusBadge>
    : <StatusBadge tone="warn">No key</StatusBadge>

  return (
    <>
      <SettingsCard
        title="Claude"
        description="Agent runs need an Anthropic Console API key (a Claude subscription login isn't supported). Use the key from your Claude Code config, or enter one in AXON."
        status={badge}
        footer={<Button variant="outline" onClick={() => setOpen(true)}>{status?.mode === 'entered' ? 'Update key' : 'Enter key in AXON'}</Button>}
      >
        <Info
          label="Active source"
          hint={status?.mode === 'linked'
            ? <>AXON stores only your consent and a fingerprint, never the key. It reads the key from that file each time it is needed.</>
            : status?.mode === 'entered'
              ? <>Stored encrypted with your OS keychain on this machine.</>
              : <>Get a key at console.anthropic.com.</>}
        >
          {status?.source ?? 'None'}
        </Info>
        <Info label="API key" mono>{status?.hasKey ? status.masked ?? '' : ''}</Info>

        {status?.problem && <Notice ok={false}>{status.problem.message}</Notice>}

        {status?.changed && (
          <Alert>
            <AlertTitle>Use the new key found in {status.changed.source}?</AlertTitle>
            <AlertDescription>
              <span className="font-mono">{status.changed.masked}</span>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => apply(() => window.axon.claudeKey.confirmChanged())}>Use the new key</Button>
                <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Enter a different key</Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {status?.candidate && (
          <Alert>
            <AlertTitle>{status.mode === 'linked' ? 'Re-link to' : 'Link to'} the key found in {status.candidate.source}?</AlertTitle>
            <AlertDescription>
              <span className="font-mono">{status.candidate.masked}</span>
              <div className="mt-1 text-xs">AXON won&apos;t copy it: it keeps only a fingerprint and reads the key from that file each time. Linking removes any key entered in AXON.</div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => apply(() => window.axon.claudeKey.confirmDetected())}>Use this key</Button>
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
            <DialogTitle>Enter a Claude API key</DialogTitle>
            <DialogDescription>
              Saved encrypted on this machine. {status?.mode === 'linked' ? 'This replaces the link to your Claude Code config.' : ''}
            </DialogDescription>
          </DialogHeader>
          <Field label="API key" htmlFor="claude-new-key">
            <Input id="claude-new-key" type="password" autoComplete="off" autoFocus placeholder="sk-ant-…" value={key} onChange={(e) => { setKey(e.target.value); setError('') }} />
          </Field>
          {error && <Notice ok={false}>{error}</Notice>}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy || !key}>{busy ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
