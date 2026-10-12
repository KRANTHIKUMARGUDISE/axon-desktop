import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, Notice, SettingsCard, StatusBadge, cleanError } from './parts'

// GitHub is the only supported git host in v1 (Azure DevOps was removed). The token is validated with GitHub
// before it is stored (main-side, encrypted) and is never read back.
export function GithubSettings() {
  const [hasToken, setHasToken] = useState(false)
  const [suffix, setSuffix] = useState('')
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setHasToken(await window.axon.secrets.hasGitToken())
    const s = await window.axon.settings.get('gitTokenSuffix')
    setSuffix(typeof s === 'string' ? s : '')
  }
  useEffect(() => { void load().catch(() => {}) }, [])

  function close(o: boolean) {
    if (!o) { setToken(''); setError('') }
    setOpen(o)
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const r = await window.axon.onboarding.verifyGithub(token)
      if (!r.ok) { setError(r.error ?? 'GitHub rejected this token'); return }
      toast.success(`GitHub token saved${r.login ? ` (@${r.login})` : ''}`)
      await load()
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
        title="GitHub"
        description="Used to open pull requests — promoting to Team/Org and delivery PRs. Cloning and pushing can also use your existing Git credentials."
        status={hasToken ? <StatusBadge tone="ok">Token set</StatusBadge> : <StatusBadge tone="warn">No token</StatusBadge>}
        footer={<Button variant="outline" onClick={() => setOpen(true)}>{hasToken ? 'Replace token' : 'Add token'}</Button>}
      >
        <Field label="Personal access token" htmlFor="gh-token" hint="Needs the repo scope (or fine-grained: contents + pull requests on the registry and your repositories).">
          <Input id="gh-token" readOnly value={hasToken ? `••••••••${suffix}` : ''} placeholder="Not set" className="font-mono" />
        </Field>
      </SettingsCard>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hasToken ? 'Replace GitHub token' : 'Add GitHub token'}</DialogTitle>
            <DialogDescription>The token is checked with GitHub, then stored encrypted on this machine.</DialogDescription>
          </DialogHeader>
          <Field label="Personal access token" htmlFor="gh-new-token">
            <Input id="gh-new-token" type="password" autoComplete="off" autoFocus placeholder="ghp_… or github_pat_…" value={token} onChange={(e) => { setToken(e.target.value); setError('') }} />
          </Field>
          {error && <Notice ok={false}>{error}</Notice>}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Verify and save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
