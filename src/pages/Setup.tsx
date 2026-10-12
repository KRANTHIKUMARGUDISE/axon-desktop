import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Checkbox } from '../components/ui/checkbox'
import { ChevronRight, FolderOpen, Check, AlertCircle } from 'lucide-react'
import axonIcon from '../assets/axon-icon.png'
import axonTitle from '../assets/axon-title.png'
import type { ConnectionTest } from '@shared'

const STEPS = ['Welcome', 'Registry', 'Jira', 'GitHub', 'Claude', 'Workspace', 'Finish']

const ACTIVITY_NOTICE =
  'AXON records when you launch the app or log in, in activity.log inside your own folder of the shared registry. ' +
  'Each entry contains your email address and this machine\'s name — nothing else. Run records contain only status, ' +
  'timings, gate approvals, versions, pull-request and repository URLs and token/cost totals — never code, ticket text or agent output.'

const cardStyle = { background: 'var(--axon-bg2)', borderColor: 'var(--axon-border)' }
const primary = { background: 'var(--axon-nexus)', color: '#fff' }

function Status({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  if (ok === null) return null
  return (
    <p className="text-xs flex items-start gap-1.5" style={{ color: ok ? 'var(--axon-green)' : 'var(--axon-red)' }}>
      {ok ? <Check size={13} className="mt-px shrink-0" /> : <AlertCircle size={13} className="mt-px shrink-0" />}
      <span>{children}</span>
    </p>
  )
}

// First-run onboarding. Identity is proven against Jira (`/myself` email must match) in the main
// process, which also stores the tokens — this screen never reads a secret back.
export default function Setup({ onComplete }: { onComplete?: () => void }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  // registry
  const [registryUrl, setRegistryUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [conn, setConn] = useState<ConnectionTest | null>(null)
  const [testing, setTesting] = useState(false)
  // jira
  const [jiraSite, setJiraSite] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraToken, setJiraToken] = useState('')
  const [jira, setJira] = useState<{ ok: boolean; message: string } | null>(null)
  const [verifyingJira, setVerifyingJira] = useState(false)
  // github
  const [ghToken, setGhToken] = useState('')
  const [gh, setGh] = useState<{ ok: boolean; message: string } | null>(null)
  const [verifyingGh, setVerifyingGh] = useState(false)
  // claude
  const [claudeKey, setClaudeKey] = useState('')
  const [keyDetected, setKeyDetected] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<{ masked: string; source: string } | null>(null)
  // workspace + finish
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [team, setTeam] = useState('')
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    window.axon.onboarding.defaults().then((d) => { setRegistryUrl(d.registryUrl); setBranch(d.branch || 'main'); setJiraSite(d.jiraSite) }).catch(() => {})
    window.axon.settings.get('workspaceRoot').then((v) => typeof v === 'string' && setWorkspaceRoot(v)).catch(() => {})
    window.axon.claudeKey.getStatus().then((s) => { if (s.hasKey) setKeyDetected(s.masked); setCandidate(s.candidate) }).catch(() => {})
  }, [])

  const clean = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong')

  async function testRegistry() {
    setTesting(true)
    setConn(null)
    try {
      setConn(await window.axon.onboarding.testRegistry(registryUrl.trim(), branch.trim()))
    } catch (e) {
      setConn({ ok: false, canRead: false, canPush: false, branchExists: false, error: clean(e) })
    } finally {
      setTesting(false)
    }
  }

  async function verifyJira() {
    setVerifyingJira(true)
    setJira(null)
    try {
      const r = await window.axon.onboarding.verifyJira(jiraSite.trim(), jiraEmail.trim(), jiraToken)
      setJira(r.ok ? { ok: true, message: `Verified${r.displayName ? ` — ${r.displayName}` : ''} (${r.email})` } : { ok: false, message: r.error ?? 'Verification failed' })
      if (r.ok) setJiraToken('')
    } catch (e) {
      setJira({ ok: false, message: clean(e) })
    } finally {
      setVerifyingJira(false)
    }
  }

  async function verifyGithub() {
    setVerifyingGh(true)
    setGh(null)
    try {
      const r = await window.axon.onboarding.verifyGithub(ghToken)
      setGh(r.ok ? { ok: true, message: `Token valid${r.login ? ` (@${r.login})` : ''}` } : { ok: false, message: r.error ?? 'Verification failed' })
      if (r.ok) setGhToken('')
    } catch (e) {
      setGh({ ok: false, message: clean(e) })
    } finally {
      setVerifyingGh(false)
    }
  }

  async function browse() {
    const dir = await window.axon.dialog.openDirectory()
    if (dir) setWorkspaceRoot(dir)
  }

  async function finish() {
    setFinishing(true)
    setError('')
    try {
      if (workspaceRoot.trim()) await window.axon.settings.set('workspaceRoot', workspaceRoot.trim())
      if (claudeKey.trim()) await window.axon.claudeKey.set(claudeKey.trim())
      await window.axon.onboarding.complete({ registryUrl: registryUrl.trim(), registryBranch: branch.trim(), team: team.trim(), activityConsent: consent })
      window.dispatchEvent(new Event('axon:claudeKeyChanged'))
      onComplete?.()
      navigate('/dashboard')
    } catch (e) {
      setError(clean(e))
      setFinishing(false)
    }
  }

  const progress = STEPS.slice(1)
  const next = (to: number) => <Button className="w-full gap-2" style={primary} onClick={() => setStep(to)}>Continue <ChevronRight size={15} /></Button>

  return (
    <div className="dark flex h-screen items-center justify-center overflow-auto py-6" style={{ background: 'var(--axon-bg)' }}>
      <div className="w-full max-w-lg rounded-2xl border p-8 my-auto" style={cardStyle}>
        <div className="flex items-center gap-2.5 mb-8">
          <img src={axonIcon} alt="AXON" className="h-9 rounded-lg" />
          <img src={axonTitle} alt="AXON" className="h-4" />
        </div>

        {step > 0 && (
          <div className="flex items-center gap-1 mb-7 flex-wrap">
            {progress.map((label, i) => {
              const idx = i + 1
              const done = step > idx
              const active = step === idx
              return (
                <div key={label} className="flex items-center gap-1">
                  <div
                    className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0"
                    style={{ background: done ? 'var(--axon-green)' : active ? 'var(--axon-nexus)' : 'var(--axon-bg4)', color: done || active ? '#fff' : 'var(--axon-t3)' }}
                  >
                    {done ? '✓' : idx}
                  </div>
                  <span className="text-[11px]" style={{ color: active ? 'var(--axon-nexus2)' : done ? 'var(--axon-t2)' : 'var(--axon-t4)' }}>{label}</span>
                  {i < progress.length - 1 && <div className="h-px w-3" style={{ background: done ? 'var(--axon-green)' : 'var(--axon-border2)' }} />}
                </div>
              )
            })}
          </div>
        )}

        {step === 0 && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--axon-t1)' }}>Welcome to AXON</h1>
              <p className="text-sm font-medium mb-4" style={{ color: 'var(--axon-nexus2)' }}>Engineering Intelligence. Automated Delivery.</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--axon-t2)' }}>
                AXON runs AI-powered delivery pipelines on your machine. Your team's shared definitions live in a registry
                repository and your own work syncs to your folder in it. Setup connects the registry, proves who you are through
                Jira, and takes a couple of minutes.
              </p>
            </div>
            <Button className="w-full gap-2" style={primary} onClick={() => setStep(1)}>Get Started <ChevronRight size={15} /></Button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Registry</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>
                The shared <code>axon-registry</code> Git repository. It needs read access and push access (you only ever write inside your own folder).
              </p>
            </div>
            <Input value={registryUrl} onChange={(e) => { setRegistryUrl(e.target.value); setConn(null) }} placeholder="https://github.com/your-org/axon-registry.git" spellCheck={false} />
            <Input value={branch} onChange={(e) => { setBranch(e.target.value); setConn(null) }} placeholder="Branch (main)" spellCheck={false} />
            <Button variant="outline" onClick={testRegistry} disabled={testing || !registryUrl.trim()}>{testing ? 'Testing…' : 'Test connection'}</Button>
            {conn && (
              <div className="space-y-1">
                <Status ok={conn.canRead}>{conn.canRead ? `Read access OK${conn.branchExists ? '' : ` (branch "${branch || 'main'}" does not exist yet — it will be created on first push)`}` : 'Cannot read the repository'}</Status>
                <Status ok={conn.canRead ? conn.canPush : null}>{conn.canPush ? 'Push access OK' : 'No push access'}</Status>
                {conn.error && <p className="text-xs" style={{ color: 'var(--axon-red)' }}>{conn.error.split('\n')[0].slice(0, 300)}</p>}
              </div>
            )}
            <Button className="w-full gap-2" style={primary} disabled={!conn?.ok} onClick={() => setStep(2)}>Continue <ChevronRight size={15} /></Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Who are you? (Jira Cloud)</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>
                Your Jira account identifies you in AXON. The email must match your Jira profile. Create an API token at{' '}
                <span style={{ color: 'var(--axon-t2)' }}>id.atlassian.com → Security → API tokens</span>. The token is stored encrypted on this machine.
              </p>
            </div>
            <Input value={jiraSite} onChange={(e) => { setJiraSite(e.target.value); setJira(null) }} placeholder="yourcompany.atlassian.net" spellCheck={false} />
            <Input value={jiraEmail} onChange={(e) => { setJiraEmail(e.target.value); setJira(null) }} placeholder="you@company.com" type="email" autoComplete="off" />
            <Input value={jiraToken} onChange={(e) => { setJiraToken(e.target.value); setJira(null) }} placeholder="Jira API token" type="password" autoComplete="off" />
            <Button variant="outline" onClick={verifyJira} disabled={verifyingJira || !jiraSite.trim() || !jiraEmail.trim() || !jiraToken}>{verifyingJira ? 'Verifying…' : 'Verify with Jira'}</Button>
            {jira && <Status ok={jira.ok}>{jira.message}</Status>}
            <Button className="w-full gap-2" style={primary} disabled={!jira?.ok} onClick={() => setStep(3)}>Continue <ChevronRight size={15} /></Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>GitHub credential</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>
                A personal access token is needed to open pull requests (promotion to Team/Org and delivery PRs). Cloning and pushing can use your
                existing Git credentials. You can skip this and add it later in Settings.
              </p>
            </div>
            <Input value={ghToken} onChange={(e) => { setGhToken(e.target.value); setGh(null) }} placeholder="ghp_… or github_pat_…" type="password" autoComplete="off" />
            <Button variant="outline" onClick={verifyGithub} disabled={verifyingGh || !ghToken.trim()}>{verifyingGh ? 'Checking…' : 'Check token'}</Button>
            {gh && <Status ok={gh.ok}>{gh.message}</Status>}
            {next(4)}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Claude API key</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>
                Agent runs need an Anthropic Console API key (a Claude subscription login is not supported). The key is kept in memory only and never written to
                disk. You can skip this and add it later in Settings.
              </p>
            </div>
            {candidate && !keyDetected && (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: 'var(--axon-t2)' }}>A key was found in {candidate.source} ({candidate.masked}). Use it?</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={async () => { const s = await window.axon.claudeKey.confirmDetected(); setKeyDetected(s.masked); setCandidate(null) }}>Use this key</Button>
                  <Button size="sm" variant="outline" onClick={async () => { await window.axon.claudeKey.rejectDetected(); setCandidate(null) }}>Don't use</Button>
                </div>
              </div>
            )}
            {keyDetected && <p className="text-xs" style={{ color: 'var(--axon-green)' }}>Using key {keyDetected}. Leave the field empty to keep it.</p>}
            <Input type="password" value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" />
            {next(5)}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Workspace folder</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>Repositories for your deliveries are cloned under this folder. Avoid cloud-synced folders such as OneDrive.</p>
            </div>
            <div className="flex gap-2">
              <Input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} placeholder="Workspace folder" />
              <Button variant="outline" onClick={browse} className="gap-1.5 shrink-0"><FolderOpen size={14} /> Browse</Button>
            </div>
            {next(6)}
          </div>
        )}

        {step === 6 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Almost done</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>Your team name appears in your registry profile (optional).</p>
            </div>
            <Input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Team (optional)" maxLength={60} />
            <div className="rounded-lg border p-3 space-y-2.5" style={{ borderColor: 'var(--axon-border)', background: 'var(--axon-bg3)' }}>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--axon-t2)' }}>{ACTIVITY_NOTICE}</p>
              <label className="flex items-start gap-2 text-xs cursor-pointer" style={{ color: 'var(--axon-t1)' }}>
                <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
                <span>I understand and agree to this activity log.</span>
              </label>
            </div>
            {error && <p className="text-xs" style={{ color: 'var(--axon-red)' }}>{error}</p>}
            <Button className="w-full gap-2" style={primary} onClick={finish} disabled={finishing || !consent}>{finishing ? 'Finishing…' : 'Finish setup'}</Button>
          </div>
        )}
      </div>
    </div>
  )
}
