import { useState, useEffect } from 'react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { CheckCircle, XCircle, Loader2, Save, ExternalLink, Eye, EyeOff } from 'lucide-react'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface CurrentUser {
  name?: string
  email?: string
  team?: string
}

export default function Settings() {
  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — Settings')
    }
  }, [])

  // Connection
  const [backendUrl, setBackendUrl] = useState('')
  const [connStatus, setConnStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [connError, setConnError] = useState('')
  const [currentUser, setCurrentUser] = useState<CurrentUser>({})

  // Claude
  const [claudeKey, setClaudeKey] = useState('')
  const [claudeKeySuffix, setClaudeKeySuffix] = useState('')
  const [claudeSaved, setClaudeSaved] = useState<SaveStatus>('idle')
  const [claudeKeySet, setClaudeKeySet] = useState(false)
  const [showClaudeKey, setShowClaudeKey] = useState(false)
  const [showClaudeModal, setShowClaudeModal] = useState(false)
  const [newClaudeKey, setNewClaudeKey] = useState('')

  // Workspace
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceSaved, setWorkspaceSaved] = useState<SaveStatus>('idle')

  // Git
  const [gitProvider, setGitProvider] = useState<'github' | 'azure'>('github')
  const [gitToken, setGitToken] = useState('')
  const [gitTokenSuffix, setGitTokenSuffix] = useState('')
  const [gitSaved, setGitSaved] = useState<SaveStatus>('idle')
  const [gitTokenSet, setGitTokenSet] = useState(false)
  const [showGitToken, setShowGitToken] = useState(false)
  const [showGitModal, setShowGitModal] = useState(false)
  const [newGitToken, setNewGitToken] = useState('')

  // Preferences
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('dark')
  const [themeSaved, setThemeSaved] = useState<SaveStatus>('idle')
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.75)
  const [confidenceSaved, setConfidenceSaved] = useState<SaveStatus>('idle')

  useEffect(() => {
    async function load() {
      const all = await window.axon.settings.getAll()
      setBackendUrl((all.backendUrl as string) || '')
      setWorkspacePath((all.workspaceRoot as string) || '')
      setGitProvider(((all.gitProvider as string) || 'github') as 'github' | 'azure')
      setTheme(((all.theme as string) || 'dark') as 'dark' | 'light' | 'system')
      setConfidenceThreshold((all.confidenceThreshold as number) || 0.75)

      // Check if keys are set and load their suffixes
      const claudeKey = await window.axon.auth.getSecure('axon-claude-key')
      setClaudeKeySet(!!claudeKey)
      const claudeSuffix = await window.axon.settings.get('claudeKeySuffix')
      if (claudeSuffix) setClaudeKeySuffix(claudeSuffix as string)

      const gitToken = await window.axon.auth.getSecure('axon-git-token')
      setGitTokenSet(!!gitToken)
      const gitSuffix = await window.axon.settings.get('gitTokenSuffix')
      if (gitSuffix) setGitTokenSuffix(gitSuffix as string)

      // Fetch current user info
      await fetchCurrentUser(all.backendUrl as string)
    }
    load()
  }, [])

  async function fetchCurrentUser(url: string) {
    try {
      const token = await window.axon.auth.getSecure('axon-access-token')
      if (!token || !url) return

      const res = await fetch(`${url}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setCurrentUser(data)
      }
    } catch {
      // Silently fail
    }
  }

  async function testConnection() {
    setConnStatus('loading')
    setConnError('')
    try {
      const url = backendUrl.replace(/\/$/, '')
      const res = await fetch(`${url}/api/health`)
      if (res.ok) {
        setConnStatus('ok')
        await window.axon.settings.set('backendUrl', url)
        await fetchCurrentUser(url)
      } else {
        setConnStatus('error')
        setConnError(`Server responded with ${res.status}`)
      }
    } catch (e: unknown) {
      setConnStatus('error')
      setConnError(e instanceof Error ? e.message : 'Connection failed')
    }
  }

  async function saveClaudeKey() {
    setClaudeSaved('saving')
    if (!newClaudeKey.startsWith('sk-ant-')) {
      setClaudeSaved('error')
      return
    }
    await window.axon.auth.storeSecure('axon-claude-key', newClaudeKey)
    const suffix = newClaudeKey.slice(-4)
    await window.axon.settings.set('claudeKeySuffix', suffix)
    setClaudeKeySuffix(suffix)
    setClaudeKeySet(true)
    setClaudeSaved('saved')
    setNewClaudeKey('')
    setShowClaudeModal(false)
    setTimeout(() => setClaudeSaved('idle'), 2000)
  }

  async function browseWorkspace() {
    const selected = await window.axon.dialog.openDirectory()
    if (selected) setWorkspacePath(selected)
  }

  async function saveWorkspace() {
    setWorkspaceSaved('saving')
    await window.axon.settings.set('workspaceRoot', workspacePath)
    setWorkspaceSaved('saved')
    setTimeout(() => setWorkspaceSaved('idle'), 2000)
  }

  async function openWorkspaceFolder() {
    if (workspacePath) {
      window.axon.shell.openExternal(workspacePath)
    }
  }

  async function saveGitConfig() {
    setGitSaved('saving')
    await window.axon.settings.set('gitProvider', gitProvider)
    if (newGitToken) {
      await window.axon.auth.storeSecure('axon-git-token', newGitToken)
      const suffix = newGitToken.slice(-4)
      await window.axon.settings.set('gitTokenSuffix', suffix)
      setGitTokenSuffix(suffix)
      setGitTokenSet(true)
    }
    setGitSaved('saved')
    setNewGitToken('')
    setShowGitModal(false)
    setTimeout(() => setGitSaved('idle'), 2000)
  }

  async function saveTheme() {
    setThemeSaved('saving')
    await window.axon.settings.set('theme', theme)
    setThemeSaved('saved')
    setTimeout(() => setThemeSaved('idle'), 2000)
  }


  async function saveConfidence() {
    setConfidenceSaved('saving')
    await window.axon.settings.set('confidenceThreshold', confidenceThreshold)
    setConfidenceSaved('saved')
    setTimeout(() => setConfidenceSaved('idle'), 2000)
  }

  const maskToken = (token: string) => {
    if (!token || token.length < 4) return '••••'
    return '•'.repeat(Math.max(0, token.length - 4)) + token.slice(-4)
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1000, background: 'var(--axon-bg)', minHeight: '100vh' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--axon-t1)', margin: '0 0 8px 0' }}>Settings</h1>
        <p style={{ fontSize: 14, color: 'var(--axon-t3)', margin: 0 }}>
          Configure your AXON desktop environment
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* ===== CONNECTION ===== */}
        <Section title="Connection">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Backend URL */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Backend URL
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={backendUrl}
                  onChange={e => { setBackendUrl(e.target.value); setConnStatus('idle') }}
                  placeholder="https://localhost:7027"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, outline: 'none',
                  }}
                />
                <button
                  onClick={testConnection}
                  disabled={connStatus === 'loading'}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: connStatus === 'loading' ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                    opacity: connStatus === 'loading' ? 0.7 : 1,
                  }}
                >
                  {connStatus === 'loading' && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                  Test & Save
                </button>
              </div>
              {connStatus === 'ok' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#22c55e' }}>
                  <CheckCircle size={14} /> Connection successful
                </div>
              )}
              {connStatus === 'error' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#ef4444' }}>
                  <XCircle size={14} /> {connError}
                </div>
              )}
            </div>

            {/* Current User Info */}
            {(currentUser.email || currentUser.name) && (
              <div style={{ padding: 12, borderRadius: 6, background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)' }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', marginBottom: 8 }}>Current User</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {currentUser.name && (
                    <div style={{ fontSize: 13, color: 'var(--axon-t1)' }}>
                      <span style={{ fontWeight: 500 }}>Name:</span> {currentUser.name}
                    </div>
                  )}
                  {currentUser.email && (
                    <div style={{ fontSize: 13, color: 'var(--axon-t1)' }}>
                      <span style={{ fontWeight: 500 }}>Email:</span> {currentUser.email}
                    </div>
                  )}
                  {currentUser.team && (
                    <div style={{ fontSize: 13, color: 'var(--axon-t1)' }}>
                      <span style={{ fontWeight: 500 }}>Team:</span> {currentUser.team}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ===== CLAUDE ===== */}
        <Section title="Claude">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                API Key
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: claudeKeySet ? 'var(--axon-t2)' : 'var(--axon-t4)', fontSize: 13,
                  fontStyle: claudeKeySet ? 'normal' : 'italic', fontFamily: 'monospace',
                }}>
                  {claudeKeySet && showClaudeKey ? `sk-ant-...${claudeKeySuffix}` : claudeKeySet ? '••••' : 'Not set'}
                </div>
                {claudeKeySet && (
                  <button
                    onClick={() => setShowClaudeKey(!showClaudeKey)}
                    style={{
                      padding: '8px 10px', borderRadius: 6, border: '1px solid var(--axon-border)',
                      background: 'transparent', color: 'var(--axon-t2)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center',
                    }}
                    title={showClaudeKey ? 'Hide' : 'Show'}
                  >
                    {showClaudeKey ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                )}
                <button
                  onClick={() => { setShowClaudeModal(true); setNewClaudeKey('') }}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Update Key
                </button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '8px 0 0 0' }}>
                Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: 'var(--axon-nexus2)', textDecoration: 'none' }}>console.anthropic.com</a>
              </p>
            </div>
            <div style={{ padding: 12, borderRadius: 6, background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)' }}>
              <div style={{ fontSize: 12, color: 'var(--axon-t3)' }}>
                <span style={{ fontWeight: 500, color: 'var(--axon-t2)' }}>Model:</span> claude-sonnet-4-5
              </div>
            </div>
          </div>
        </Section>

        {/* ===== WORKSPACE ===== */}
        <Section title="Workspace">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Root Directory
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={workspacePath}
                  onChange={e => { setWorkspacePath(e.target.value); setWorkspaceSaved('idle') }}
                  placeholder="C:/dev"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, outline: 'none',
                  }}
                />
                <button
                  onClick={browseWorkspace}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Browse
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={saveWorkspace}
                disabled={!workspacePath || workspaceSaved === 'saving'}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                  cursor: !workspacePath || workspaceSaved === 'saving' ? 'not-allowed' : 'pointer',
                  opacity: !workspacePath || workspaceSaved === 'saving' ? 0.5 : 1,
                }}
              >
                <Save size={14} style={{ display: 'inline', marginRight: 6 }} /> Save
              </button>
              {workspaceSaved === 'saved' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#22c55e' }}>
                  <CheckCircle size={14} /> Saved
                </div>
              )}
              {workspacePath && (
                <button
                  onClick={openWorkspaceFolder}
                  style={{
                    padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'transparent', color: 'var(--axon-nexus2)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
                  }}
                >
                  <ExternalLink size={12} /> Open in Explorer
                </button>
              )}
            </div>
          </div>
        </Section>

        {/* ===== GIT ===== */}
        <Section title="Git">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Provider */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Provider
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['github', 'azure'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => { setGitProvider(p); setGitSaved('idle') }}
                    style={{
                      flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                      background: gitProvider === p ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg2)',
                      color: gitProvider === p ? '#a78bfa' : 'var(--axon-t2)',
                      borderColor: gitProvider === p ? 'rgba(111,95,232,0.35)' : 'var(--axon-border)',
                      fontSize: 13, fontWeight: 500, cursor: 'pointer',
                    }}
                  >
                    {p === 'github' ? 'GitHub' : 'Azure DevOps'}
                  </button>
                ))}
              </div>
            </div>

            {/* Personal Access Token */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Personal Access Token
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {gitTokenSet ? (
                  <div style={{
                    flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t2)', fontSize: 13, fontFamily: 'monospace',
                  }}>
                    {showGitToken ? `••••...${gitTokenSuffix}` : '••••'}
                  </div>
                ) : (
                  <div style={{
                    flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t4)', fontSize: 13, fontStyle: 'italic',
                  }}>
                    Not set
                  </div>
                )}
                {gitTokenSet && (
                  <button
                    onClick={() => setShowGitToken(!showGitToken)}
                    style={{
                      padding: '8px 10px', borderRadius: 6, border: '1px solid var(--axon-border)',
                      background: 'transparent', color: 'var(--axon-t2)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center',
                    }}
                    title={showGitToken ? 'Hide' : 'Show'}
                  >
                    {showGitToken ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                )}
                <button
                  onClick={() => { setShowGitModal(true); setNewGitToken('') }}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Update Token
                </button>
              </div>
            </div>


            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={saveGitConfig}
                disabled={gitSaved === 'saving'}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                  cursor: gitSaved === 'saving' ? 'not-allowed' : 'pointer',
                  opacity: gitSaved === 'saving' ? 0.7 : 1,
                }}
              >
                <Save size={14} style={{ display: 'inline', marginRight: 6 }} /> Save
              </button>
              {gitSaved === 'saved' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#22c55e' }}>
                  <CheckCircle size={14} /> Saved
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* ===== PREFERENCES ===== */}
        <Section title="Preferences">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* Theme */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Theme
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['dark', 'light', 'system'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => { setTheme(t); setThemeSaved('idle') }}
                    style={{
                      flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                      background: theme === t ? 'rgba(111,95,232,0.15)' : 'var(--axon-bg2)',
                      color: theme === t ? '#a78bfa' : 'var(--axon-t2)',
                      borderColor: theme === t ? 'rgba(111,95,232,0.35)' : 'var(--axon-border)',
                      fontSize: 13, fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize',
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {themeSaved === 'saved' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#22c55e' }}>
                  <CheckCircle size={14} /> Saved
                </div>
              )}
              {themeSaved === 'saving' && (
                <button
                  onClick={saveTheme}
                  disabled={true}
                  style={{ marginTop: 8, padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)', background: 'var(--axon-bg2)', opacity: 0.5 }}
                />
              )}
              {themeSaved === 'idle' && (
                <button
                  onClick={saveTheme}
                  style={{
                    marginTop: 8, padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <Save size={14} /> Save
                </button>
              )}
            </div>


            {/* Confidence Threshold */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Confidence Threshold
              </label>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <input
                  type="range"
                  min={0.5}
                  max={0.95}
                  step={0.05}
                  value={confidenceThreshold}
                  onChange={e => { setConfidenceThreshold(parseFloat(e.target.value)); setConfidenceSaved('idle') }}
                  style={{ flex: 1, cursor: 'pointer' }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--axon-t1)', minWidth: 50, textAlign: 'right' }}>
                  {confidenceThreshold.toFixed(2)}
                </span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '8px 0 0 0' }}>
                Minimum confidence for autonomous actions (0.50 - 0.95)
              </p>
              {confidenceSaved === 'saved' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#22c55e' }}>
                  <CheckCircle size={14} /> Saved
                </div>
              )}
              {confidenceSaved === 'saving' && (
                <button
                  onClick={saveConfidence}
                  disabled={true}
                  style={{ marginTop: 8, padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)', background: 'var(--axon-bg2)', opacity: 0.5 }}
                />
              )}
              {confidenceSaved === 'idle' && (
                <button
                  onClick={saveConfidence}
                  style={{
                    marginTop: 8, padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <Save size={14} /> Save
                </button>
              )}
            </div>
          </div>
        </Section>

        {/* ===== ABOUT ===== */}
        <Section title="About">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', marginBottom: 4 }}>Version</div>
              <div style={{ fontSize: 13, color: 'var(--axon-t1)' }}>AXON 1.0.0</div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', marginBottom: 4 }}>Build Date</div>
              <div style={{ fontSize: 13, color: 'var(--axon-t1)' }}>{new Date().toLocaleDateString()}</div>
            </div>
            <div style={{ borderTop: '1px solid var(--axon-border)', paddingTop: 12 }}>
              <button
                disabled={true}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t3)', fontSize: 13, fontWeight: 500,
                  cursor: 'not-allowed', opacity: 0.5,
                }}
              >
                Check for Updates (Phase 2)
              </button>
            </div>
            <div style={{ borderTop: '1px solid var(--axon-border)', paddingTop: 12, display: 'flex', gap: 12 }}>
              <a
                href="https://github.com/anthropics/axon-desktop"
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13, color: 'var(--axon-nexus2)', textDecoration: 'none', cursor: 'pointer' }}
              >
                Documentation ↗
              </a>
              <a
                href="https://github.com/anthropics/axon-desktop/issues"
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13, color: 'var(--axon-nexus2)', textDecoration: 'none', cursor: 'pointer' }}
              >
                Feedback ↗
              </a>
            </div>
          </div>
        </Section>
      </div>

      {/* Claude Key Modal */}
      {showClaudeModal && (
        <Modal onClose={() => setShowClaudeModal(false)} title="Update Claude API Key">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                New API Key
              </label>
              <input
                type="password"
                value={newClaudeKey}
                onChange={e => { setNewClaudeKey(e.target.value); setClaudeSaved('idle') }}
                placeholder="sk-ant-..."
                autoFocus
                style={{
                  width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, outline: 'none',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setShowClaudeModal(false)}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveClaudeKey}
                disabled={!newClaudeKey || claudeSaved === 'saving'}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none',
                  background: !newClaudeKey ? 'rgba(111,95,232,0.5)' : 'rgba(111,95,232,0.9)',
                  color: '#fff', fontSize: 13, fontWeight: 500,
                  cursor: !newClaudeKey ? 'not-allowed' : 'pointer',
                }}
              >
                {claudeSaved === 'saving' ? 'Saving...' : 'Update'}
              </button>
            </div>
            {claudeSaved === 'error' && (
              <div style={{ fontSize: 12, color: '#ef4444' }}>
                Key must start with "sk-ant-"
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Git Token Modal */}
      {showGitModal && (
        <Modal onClose={() => setShowGitModal(false)} title="Update Git Personal Access Token">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                New Personal Access Token
              </label>
              <input
                type="password"
                value={newGitToken}
                onChange={e => { setNewGitToken(e.target.value); setGitSaved('idle') }}
                placeholder="ghp_... or pat..."
                autoFocus
                style={{
                  width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, outline: 'none',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setShowGitModal(false)}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveGitConfig}
                disabled={gitSaved === 'saving'}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none',
                  background: 'rgba(111,95,232,0.9)',
                  color: '#fff', fontSize: 13, fontWeight: 500,
                  cursor: gitSaved === 'saving' ? 'not-allowed' : 'pointer',
                }}
              >
                {gitSaved === 'saving' ? 'Saving...' : 'Update'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
      borderRadius: 10, padding: 20,
    }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--axon-t1)', margin: '0 0 16px 0' }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--axon-bg2)', border: '1px solid var(--axon-border)',
          borderRadius: 10, padding: 24, maxWidth: 400, width: '90%',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)', margin: '0 0 20px 0' }}>
          {title}
        </h3>
        {children}
      </div>
    </div>
  )
}
