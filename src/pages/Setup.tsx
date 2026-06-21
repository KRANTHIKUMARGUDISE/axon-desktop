import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { CheckCircle, XCircle, Loader2, ChevronRight } from 'lucide-react'
import axonIcon from '../assets/axon-icon.png'
import axonTitle from '../assets/axon-title.png'

const STEPS = [
  'Welcome',
  'Backend',
  'Login',
  'Claude API',
  'Workspace',
  'Git',
  'Done',
]

type ConnectionStatus = 'idle' | 'loading' | 'ok' | 'error'

export default function Setup({ onComplete }: { onComplete?: () => void }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  // Step 2 — Backend
  const [backendUrl, setBackendUrl] = useState('https://localhost:7027')
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('idle')
  const [connError, setConnError] = useState('')

  // Step 3 — Login
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginStatus, setLoginStatus] = useState<ConnectionStatus>('idle')
  const [loginError, setLoginError] = useState('')

  // Step 4 — Claude API
  const [claudeKey, setClaudeKey] = useState('')
  const [claudeStatus, setClaudeStatus] = useState<ConnectionStatus>('idle')
  const [claudeError, setClaudeError] = useState('')

  // Step 5 — Workspace
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceExists, setWorkspaceExists] = useState<boolean | null>(null)

  // Step 6 — Git
  const [gitProvider, setGitProvider] = useState<'github' | 'azure'>('github')
  const [gitToken, setGitToken] = useState('')
  const [gitSkipped, setGitSkipped] = useState(false)

  async function testConnection() {
    setConnStatus('loading')
    setConnError('')
    try {
      const url = backendUrl.replace(/\/$/, '')
      const res = await fetch(`${url}/api/health`)
      if (res.ok) {
        setConnStatus('ok')
        await window.axon.settings.set('backendUrl', url)
      } else {
        setConnStatus('error')
        setConnError(`Server responded with ${res.status}`)
      }
    } catch (e: unknown) {
      setConnStatus('error')
      setConnError(e instanceof Error ? e.message : 'Connection failed')
    }
  }

  async function handleLogin() {
    setLoginStatus('loading')
    setLoginError('')
    try {
      const url = (await window.axon.settings.get('backendUrl') as string)
      const res = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setLoginStatus('error')
        setLoginError(data.message || 'Login failed')
        return
      }
      if (data.accessToken) {
        await window.axon.auth.storeSecure('axon-access-token', data.accessToken)
      }
      if (data.refreshToken) {
        await window.axon.auth.storeSecure('axon-refresh-token', data.refreshToken)
      }
      await window.axon.settings.set('userEmail', data.user?.email || email)
      await window.axon.settings.set('userName', data.user?.name || '')
      if (data.user?.id) {
        await window.axon.settings.set('userId', data.user.id)
      }
      setLoginStatus('ok')
    } catch (e: unknown) {
      setLoginStatus('error')
      setLoginError(e instanceof Error ? e.message : 'Login failed')
    }
  }

  async function verifyClaudeKey() {
    setClaudeStatus('loading')
    setClaudeError('')
    if (!claudeKey.startsWith('sk-ant-')) {
      setClaudeStatus('error')
      setClaudeError('API key must start with "sk-ant-"')
      return
    }
    await window.axon.auth.storeSecure('axon-claude-key', claudeKey)
    setClaudeStatus('ok')
  }

  async function browseWorkspace() {
    const selected = await window.axon.dialog.openDirectory()
    if (selected) {
      setWorkspacePath(selected)
      const exists = await window.axon.workspace.exists(selected)
      setWorkspaceExists(exists)
    }
  }

  async function confirmWorkspace() {
    await window.axon.settings.set('workspaceRoot', workspacePath)
  }

  async function saveGitConfig() {
    await window.axon.settings.set('gitProvider', gitProvider)
    if (gitToken) {
      await window.axon.auth.storeSecure('axon-git-token', gitToken)
    }
  }

  async function finishSetup() {
    await window.axon.settings.set('setupComplete', true)
    onComplete?.()
    navigate('/dashboard')
  }

  function next() {
    setStep(s => s + 1)
  }

  const progressSteps = STEPS.slice(1, -1) // exclude Welcome and Done

  return (
    <div
      className="dark flex h-screen items-center justify-center"
      style={{ background: 'var(--axon-bg)' }}
    >
      <div
        className="w-full max-w-lg rounded-2xl border p-8"
        style={{
          background: 'var(--axon-bg2)',
          borderColor: 'var(--axon-border)',
        }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-8">
          <img src={axonIcon} alt="AXON" className="h-9 rounded-lg" />
          <img src={axonTitle} alt="AXON" className="h-4" />
        </div>

        {/* Progress indicator (shown on steps 1–5) */}
        {step > 0 && step < STEPS.length - 1 && (
          <div className="flex items-center gap-1.5 mb-8">
            {progressSteps.map((label, i) => {
              const stepIndex = i + 1
              const done = step > stepIndex
              const active = step === stepIndex
              return (
                <div key={label} className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <div
                      className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0"
                      style={{
                        background: done
                          ? 'var(--axon-green)'
                          : active
                          ? 'var(--axon-nexus)'
                          : 'var(--axon-bg4)',
                        color: done || active ? '#fff' : 'var(--axon-t3)',
                      }}
                    >
                      {done ? '✓' : stepIndex}
                    </div>
                    <span
                      className="text-[11px] hidden sm:block"
                      style={{
                        color: active
                          ? 'var(--axon-nexus2)'
                          : done
                          ? 'var(--axon-t2)'
                          : 'var(--axon-t4)',
                      }}
                    >
                      {label}
                    </span>
                  </div>
                  {i < progressSteps.length - 1 && (
                    <div
                      className="h-px flex-1 min-w-[12px]"
                      style={{
                        background: done ? 'var(--axon-green)' : 'var(--axon-border2)',
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Step 0 — Welcome */}
        {step === 0 && (
          <div className="space-y-6">
            <div>
              <h1
                className="text-2xl font-bold mb-2"
                style={{ color: 'var(--axon-t1)' }}
              >
                Welcome to AXON
              </h1>
              <p className="text-sm font-medium mb-4" style={{ color: 'var(--axon-nexus2)' }}>
                Engineering Intelligence. Automated Delivery.
              </p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--axon-t2)' }}>
                AXON runs AI-powered delivery pipelines locally on your machine. In the next
                few steps we'll connect to your backend, sign you in, and configure your
                development environment.
              </p>
            </div>
            <Button
              className="w-full gap-2"
              style={{ background: 'var(--axon-nexus)', color: '#fff' }}
              onClick={next}
            >
              Get Started <ChevronRight size={15} />
            </Button>
          </div>
        )}

        {/* Step 1 — Backend Connection */}
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>
                Backend Connection
              </h2>
              <p className="text-sm" style={{ color: 'var(--axon-t2)' }}>
                Enter the URL of your AXON backend API.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                Backend URL
              </label>
              <Input
                value={backendUrl}
                onChange={e => { setBackendUrl(e.target.value); setConnStatus('idle') }}
                placeholder="https://localhost:7027"
                className="bg-[var(--axon-bg4)] border-[var(--axon-border2)] text-[var(--axon-t1)]"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={testConnection}
                disabled={connStatus === 'loading' || !backendUrl}
                className="gap-2 border-[var(--axon-border2)] text-[var(--axon-t1)] hover:bg-[var(--axon-bg4)]"
              >
                {connStatus === 'loading' && <Loader2 size={14} className="animate-spin" />}
                Test Connection
              </Button>
              {connStatus === 'ok' && (
                <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--axon-green)' }}>
                  <CheckCircle size={14} /> Connected
                </span>
              )}
              {connStatus === 'error' && (
                <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--axon-red)' }}>
                  <XCircle size={14} /> {connError}
                </span>
              )}
            </div>
            <Button
              className="w-full"
              disabled={connStatus !== 'ok'}
              style={{ background: connStatus === 'ok' ? 'var(--axon-nexus)' : undefined, color: '#fff' }}
              onClick={next}
            >
              Next
            </Button>
          </div>
        )}

        {/* Step 2 — Login */}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>
                Sign In
              </h2>
              <p className="text-sm" style={{ color: 'var(--axon-t2)' }}>
                Sign in with your AXON account credentials.
              </p>
            </div>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                  Email
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setLoginStatus('idle') }}
                  placeholder="you@company.com"
                  className="bg-[var(--axon-bg4)] border-[var(--axon-border2)] text-[var(--axon-t1)]"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                  Password
                </label>
                <Input
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setLoginStatus('idle') }}
                  placeholder="••••••••"
                  className="bg-[var(--axon-bg4)] border-[var(--axon-border2)] text-[var(--axon-t1)]"
                />
              </div>
            </div>
            {loginStatus === 'error' && (
              <p className="text-sm flex items-center gap-1.5" style={{ color: 'var(--axon-red)' }}>
                <XCircle size={14} /> {loginError}
              </p>
            )}
            {loginStatus === 'ok' && (
              <p className="text-sm flex items-center gap-1.5" style={{ color: 'var(--axon-green)' }}>
                <CheckCircle size={14} /> Signed in successfully
              </p>
            )}
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={handleLogin}
                disabled={loginStatus === 'loading' || !email || !password}
                className="flex-1 gap-2 border-[var(--axon-border2)] text-[var(--axon-t1)] hover:bg-[var(--axon-bg4)]"
              >
                {loginStatus === 'loading' && <Loader2 size={14} className="animate-spin" />}
                Sign In
              </Button>
              <Button
                className="flex-1"
                disabled={loginStatus !== 'ok'}
                style={{ background: loginStatus === 'ok' ? 'var(--axon-nexus)' : undefined, color: '#fff' }}
                onClick={next}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 3 — Claude API Key */}
        {step === 3 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>
                Claude API Key
              </h2>
              <p className="text-sm" style={{ color: 'var(--axon-t2)' }}>
                AXON uses Claude to power its AI pipeline steps.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                API Key
              </label>
              <Input
                type="password"
                value={claudeKey}
                onChange={e => { setClaudeKey(e.target.value); setClaudeStatus('idle') }}
                placeholder="sk-ant-..."
                className="bg-[var(--axon-bg4)] border-[var(--axon-border2)] text-[var(--axon-t1)]"
              />
              <a
                href="https://console.anthropic.com"
                target="_blank"
                rel="noreferrer"
                className="text-xs hover:underline"
                style={{ color: 'var(--axon-nexus2)' }}
              >
                Get your API key at console.anthropic.com
              </a>
            </div>
            {claudeStatus === 'error' && (
              <p className="text-sm flex items-center gap-1.5" style={{ color: 'var(--axon-red)' }}>
                <XCircle size={14} /> {claudeError}
              </p>
            )}
            {claudeStatus === 'ok' && (
              <p className="text-sm flex items-center gap-1.5" style={{ color: 'var(--axon-green)' }}>
                <CheckCircle size={14} /> Key saved to keychain
              </p>
            )}
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={verifyClaudeKey}
                disabled={claudeStatus === 'loading' || !claudeKey}
                className="flex-1 gap-2 border-[var(--axon-border2)] text-[var(--axon-t1)] hover:bg-[var(--axon-bg4)]"
              >
                {claudeStatus === 'loading' && <Loader2 size={14} className="animate-spin" />}
                Verify Key
              </Button>
              <Button
                className="flex-1"
                disabled={claudeStatus !== 'ok'}
                style={{ background: claudeStatus === 'ok' ? 'var(--axon-nexus)' : undefined, color: '#fff' }}
                onClick={next}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 4 — Workspace Root */}
        {step === 4 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>
                Workspace Root
              </h2>
              <p className="text-sm" style={{ color: 'var(--axon-t2)' }}>
                Choose the directory where AXON will clone and manage repositories.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                Directory Path
              </label>
              <div className="flex gap-2">
                <Input
                  value={workspacePath}
                  onChange={e => { setWorkspacePath(e.target.value); setWorkspaceExists(null) }}
                  placeholder="C:/dev or ~/code"
                  className="bg-[var(--axon-bg4)] border-[var(--axon-border2)] text-[var(--axon-t1)]"
                />
                <Button
                  variant="outline"
                  onClick={browseWorkspace}
                  className="shrink-0 border-[var(--axon-border2)] text-[var(--axon-t1)] hover:bg-[var(--axon-bg4)]"
                >
                  Browse
                </Button>
              </div>
              {workspaceExists === true && (
                <p className="text-xs flex items-center gap-1" style={{ color: 'var(--axon-green)' }}>
                  <CheckCircle size={12} /> Directory exists and is accessible
                </p>
              )}
              {workspaceExists === false && (
                <p className="text-xs flex items-center gap-1" style={{ color: 'var(--axon-amber)' }}>
                  Directory not found — it will be created
                </p>
              )}
            </div>
            <Button
              className="w-full"
              disabled={!workspacePath}
              style={{ background: workspacePath ? 'var(--axon-nexus)' : undefined, color: '#fff' }}
              onClick={async () => { await confirmWorkspace(); next() }}
            >
              Next
            </Button>
          </div>
        )}

        {/* Step 5 — Git Configuration */}
        {step === 5 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>
                Git Configuration
              </h2>
              <p className="text-sm" style={{ color: 'var(--axon-t2)' }}>
                Connect AXON to your Git provider so it can clone repos and push branches.
              </p>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                  Git Provider
                </label>
                <div className="flex gap-2">
                  {(['github', 'azure'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => setGitProvider(p)}
                      className="flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all"
                      style={{
                        background: gitProvider === p ? 'var(--axon-nx-glow)' : 'var(--axon-bg4)',
                        borderColor: gitProvider === p ? 'var(--axon-nexus)' : 'var(--axon-border2)',
                        color: gitProvider === p ? 'var(--axon-nexus2)' : 'var(--axon-t2)',
                      }}
                    >
                      {p === 'github' ? 'GitHub' : 'Azure DevOps'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium" style={{ color: 'var(--axon-t2)' }}>
                  Personal Access Token
                </label>
                <Input
                  type="password"
                  value={gitToken}
                  onChange={e => setGitToken(e.target.value)}
                  placeholder="ghp_... or azure PAT"
                  disabled={gitSkipped}
                  className="bg-[var(--axon-bg4)] border-[var(--axon-border2)] text-[var(--axon-t1)]"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={async () => { setGitSkipped(true); next() }}
                className="flex-1 border-[var(--axon-border2)] text-[var(--axon-t2)] hover:bg-[var(--axon-bg4)]"
              >
                Skip for now
              </Button>
              <Button
                className="flex-1"
                disabled={!gitToken}
                style={{ background: gitToken ? 'var(--axon-nexus)' : undefined, color: '#fff' }}
                onClick={async () => { await saveGitConfig(); next() }}
              >
                Save & Continue
              </Button>
            </div>
          </div>
        )}

        {/* Step 6 — Done */}
        {step === 6 && (
          <div className="space-y-6 text-center">
            <div
              className="flex items-center justify-center w-16 h-16 rounded-full mx-auto"
              style={{ background: 'var(--axon-green-d)', border: '1px solid var(--axon-green)' }}
            >
              <CheckCircle size={32} style={{ color: 'var(--axon-green)' }} />
            </div>
            <div>
              <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--axon-t1)' }}>
                Setup complete. AXON is ready.
              </h2>
              <p className="text-sm" style={{ color: 'var(--axon-t2)' }}>
                Your environment is configured. You can update any settings later from the
                Settings page.
              </p>
            </div>
            <Button
              className="w-full text-base py-5"
              style={{ background: 'var(--axon-nexus)', color: '#fff' }}
              onClick={finishSetup}
            >
              Open AXON
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
