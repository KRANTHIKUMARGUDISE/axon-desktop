import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ShieldAlert } from 'lucide-react'
import type { JiraStatusInfo } from '@shared'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Separator } from '../ui/separator'
import { Checkbox } from '../ui/checkbox'
import { Label } from '../ui/label'
import { Field, FieldRow, Notice, SettingsCard, StatusBadge, cleanError } from './parts'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

// Settings → Jira. The Jira account *is* the AXON identity, so the email/site are read-only here: the token can be
// replaced (must still belong to the same email), and switching account/site runs the identity step again.
export function JiraSettings() {
  const queryClient = useQueryClient()
  const { data: jira } = useQuery<JiraStatusInfo>({ queryKey: ['jira-status'], queryFn: () => window.axon.jira.status() })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [changeOpen, setChangeOpen] = useState(false)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['jira-status'] })
    queryClient.invalidateQueries({ queryKey: ['identity'] })
  }

  async function test() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.axon.jira.test()
      setTestResult(r.ok ? { ok: true, text: 'Connected — Jira accepted the stored token.' } : { ok: false, text: r.error ?? 'Connection failed' })
      refresh()
    } catch (e) {
      setTestResult({ ok: false, text: cleanError(e) })
    } finally {
      setTesting(false)
    }
  }

  const status = !jira?.configured
    ? <StatusBadge tone="warn">Not set up</StatusBadge>
    : !jira.hasToken
      ? <StatusBadge tone="error">Token missing</StatusBadge>
      : <StatusBadge tone="ok">Verified</StatusBadge>

  return (
    <>
      <SettingsCard
        title="Jira"
        description="Your Jira Cloud account is your AXON identity — it names your registry folder and appears on approvals and audit records."
        status={status}
        footer={
          <>
            <Button variant="outline" onClick={() => setChangeOpen(true)}>Change Jira account or site…</Button>
            <Button variant="outline" onClick={() => { setTokenOpen(true) }} disabled={!jira?.configured}>Replace API token</Button>
            <Button onClick={test} disabled={testing || !jira?.configured}>{testing ? 'Testing…' : 'Test connection'}</Button>
          </>
        }
      >
        <FieldRow>
          <Field label="Jira site" htmlFor="jira-site"><Input id="jira-site" value={jira?.site ?? ''} readOnly placeholder="Not set" className="font-mono" /></Field>
          <Field label="Verified email" htmlFor="jira-email" hint={jira?.displayName ? `Signed in as ${jira.displayName}` : undefined}>
            <Input id="jira-email" value={jira?.email ?? ''} readOnly placeholder="Not set" />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Last verified" htmlFor="jira-verified"><Input id="jira-verified" value={when(jira?.verifiedAt ?? null)} readOnly /></Field>
          <Field label="API token" htmlFor="jira-token" hint="Stored encrypted on this machine; never shown.">
            <Input id="jira-token" value={jira?.hasToken ? '••••••••••••' : ''} readOnly placeholder="Not set" />
          </Field>
        </FieldRow>
        {testResult && <Notice ok={testResult.ok}>{testResult.text}</Notice>}
      </SettingsCard>

      <ReplaceTokenDialog open={tokenOpen} onOpenChange={setTokenOpen} email={jira?.email ?? ''} onDone={() => { refresh(); setTestResult(null) }} />
      <ChangeAccountDialog open={changeOpen} onOpenChange={setChangeOpen} current={jira ?? null} onDone={refresh} />
    </>
  )
}

function ReplaceTokenDialog({ open, onOpenChange, email, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; email: string; onDone: () => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function close(o: boolean) {
    if (!o) { setToken(''); setError('') }
    onOpenChange(o)
  }

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const r = await window.axon.jira.replaceToken(token)
      if (!r.ok) { setError(r.error ?? 'Could not verify the token'); return }
      toast.success('Jira API token replaced')
      onDone()
      close(false)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace API token</DialogTitle>
          <DialogDescription>
            The new token is checked with Jira first and must belong to <strong>{email}</strong>. If it doesn&apos;t, it is rejected and your current token is kept.
          </DialogDescription>
        </DialogHeader>
        <Field label="New Jira API token" htmlFor="jira-new-token">
          <Input id="jira-new-token" type="password" autoComplete="off" autoFocus value={token} onChange={(e) => { setToken(e.target.value); setError('') }} />
        </Field>
        {error && <Notice ok={false}>{error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !token.trim()}>{busy ? 'Verifying…' : 'Verify and replace'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Staged = { email: string; displayName?: string; site: string; identityChanges: boolean }

function ChangeAccountDialog({ open, onOpenChange, current, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; current: JiraStatusInfo | null; onDone: () => void }) {
  const [site, setSite] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [staged, setStaged] = useState<Staged | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function close(o: boolean) {
    if (!o) {
      void window.axon.jira.cancelChange()
      setSite(''); setEmail(''); setToken(''); setStaged(null); setUnderstood(false); setError('')
    }
    onOpenChange(o)
  }

  async function verify() {
    setBusy(true)
    setError('')
    try {
      const r = await window.axon.jira.stageChange(site.trim(), email.trim(), token)
      if (!r.ok) { setError(r.error ?? 'Verification failed'); return }
      setToken('')
      setStaged({ email: r.email as string, displayName: r.displayName, site: r.site as string, identityChanges: !!r.identityChanges })
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      const r = await window.axon.jira.commitChange()
      toast.success(r.identityChanged ? `Switched identity to ${r.email}` : 'Jira site updated')
      onDone()
      close(false)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        {!staged ? (
          <>
            <DialogHeader>
              <DialogTitle>Change Jira account or site</DialogTitle>
              <DialogDescription>
                The email is not edited in place. The new account is verified with Jira first (Jira Cloud only, <code>*.atlassian.net</code>) and nothing changes until you confirm.
              </DialogDescription>
            </DialogHeader>
            <Alert>
              <ShieldAlert />
              <AlertTitle>Your email is your AXON identity</AlertTitle>
              <AlertDescription>
                It names your registry folder (<code>users/{current?.email || 'you'}/</code>), is recorded on gate approvals and appears in the audit log.
                Switching to a different email creates a new identity with its own folder.
              </AlertDescription>
            </Alert>
            <Field label="Jira site" htmlFor="chg-site"><Input id="chg-site" value={site} onChange={(e) => setSite(e.target.value)} placeholder="yourcompany.atlassian.net" spellCheck={false} /></Field>
            <Field label="Jira account email" htmlFor="chg-email"><Input id="chg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="off" /></Field>
            <Field label="API token" htmlFor="chg-token"><Input id="chg-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></Field>
            {error && <Notice ok={false}>{error}</Notice>}
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button onClick={verify} disabled={busy || !site.trim() || !email.trim() || !token}>{busy ? 'Verifying…' : 'Verify with Jira'}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{staged.identityChanges ? 'Switch to a different identity?' : 'Update Jira site?'}</DialogTitle>
              <DialogDescription>Jira verified {staged.displayName ? `${staged.displayName} (${staged.email})` : staged.email} on {staged.site}.</DialogDescription>
            </DialogHeader>
            {staged.identityChanges ? (
              <>
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertTitle>{current?.email} → {staged.email}</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      <li>A new registry folder <code>users/{staged.email}/</code> will be used; your existing folder stays in the registry untouched.</li>
                      <li>Your personal pipelines and blocks on this machine are published under the new folder.</li>
                      <li>New approvals and audit entries are recorded as {staged.email}.</li>
                    </ul>
                  </AlertDescription>
                </Alert>
                <Separator />
                <div className="flex items-start gap-2">
                  <Checkbox id="chg-understood" checked={understood} onCheckedChange={(v) => setUnderstood(v === true)} className="mt-0.5" />
                  <Label htmlFor="chg-understood" className="leading-snug font-normal">I understand this changes who I am in AXON.</Label>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Same email, so your identity and registry folder stay the same. The new site and token will be saved.</p>
            )}
            {error && <Notice ok={false}>{error}</Notice>}
            <DialogFooter>
              <Button variant="outline" onClick={() => { void window.axon.jira.cancelChange(); setStaged(null) }}>Back</Button>
              <Button variant={staged.identityChanges ? 'destructive' : 'default'} onClick={confirm} disabled={busy || (staged.identityChanges && !understood)}>
                {busy ? 'Saving…' : staged.identityChanges ? 'Switch identity' : 'Save'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
