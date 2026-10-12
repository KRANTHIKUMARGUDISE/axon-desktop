import { useState, useEffect } from 'react'
import { CheckCircle, Save, ExternalLink, Eye, EyeOff } from 'lucide-react'
import type { ClaudeKeyStatus } from '../types'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export default function Settings() {
  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — Settings')
    }
  }, [])

  // Claude — resolved in-memory only (detected from ~/.claude.json /
  // ~/.claude/config.json on launch, or manually overridden for this session).
  // Never persisted to disk; see CLAUDE.md "BUILD — Claude key resolution".
  const [claudeKeyStatus, setClaudeKeyStatus] = useState<ClaudeKeyStatus | null>(null)
  const [claudeSaved, setClaudeSaved] = useState<SaveStatus>('idle')
  const [showClaudeModal, setShowClaudeModal] = useState(false)
  const [newClaudeKey, setNewClaudeKey] = useState('')

  // Workspace
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceSaved, setWorkspaceSaved] = useState<SaveStatus>('idle')

  // Git
  const [gitProvider, setGitProvider] = useState<'github' | 'azure'>('github')
  const [gitTokenSuffix, setGitTokenSuffix] = useState('')
  const [gitSaved, setGitSaved] = useState<SaveStatus>('idle')
  const [gitTokenSet, setGitTokenSet] = useState(false)
  const [showGitToken, setShowGitToken] = useState(false)
  const [showGitModal, setShowGitModal] = useState(false)
  const [newGitToken, setNewGitToken] = useState('')

  // Preferences
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('dark')
  const [themeSaved, setThemeSaved] = useState<SaveStatus>('idle')
  const [maxContextSnapshotSizeKb, setMaxContextSnapshotSizeKb] = useState(50)
  const [maxContextSnapshotSaved, setMaxContextSnapshotSaved] = useState<SaveStatus>('idle')

  useEffect(() => {
    async function load() {
      const all = await window.axon.settings.getAll()
      setWorkspacePath((all.workspaceRoot as string) || '')
      setGitProvider(((all.gitProvider as string) || 'github') as 'github' | 'azure')
      setTheme(((all.theme as string) || 'dark') as 'dark' | 'light' | 'system')
      setMaxContextSnapshotSizeKb((all.maxContextSnapshotSizeKb as number) || 50)

      const claudeStatus = await window.axon.claudeKey.getStatus()
      setClaudeKeyStatus(claudeStatus)

      setGitTokenSet(await window.axon.secrets.hasGitToken())
      const gitSuffix = await window.axon.settings.get('gitTokenSuffix')
      if (gitSuffix) setGitTokenSuffix(gitSuffix as string)
    }
    load()
  }, [])

  async function saveClaudeKey() {
    setClaudeSaved('saving')
    if (!newClaudeKey.startsWith('sk-ant-')) {
      setClaudeSaved('error')
      return
    }
    const status = await window.axon.claudeKey.set(newClaudeKey)
    setClaudeKeyStatus(status)
    setClaudeSaved('saved')
    setNewClaudeKey('')
    setShowClaudeModal(false)
    setTimeout(() => setClaudeSaved('idle'), 2000)
    window.dispatchEvent(new CustomEvent('axon:claudeKeyChanged'))
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
      await window.axon.secrets.setGitToken(newGitToken)
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


  async function saveMaxContextSnapshotSize() {
    setMaxContextSnapshotSaved('saving')
    await window.axon.settings.set('maxContextSnapshotSizeKb', maxContextSnapshotSizeKb)
    setMaxContextSnapshotSaved('saved')
    setTimeout(() => setMaxContextSnapshotSaved('idle'), 2000)
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
                  background: 'var(--axon-bg2)', color: claudeKeyStatus?.hasKey ? 'var(--axon-t2)' : 'var(--axon-t4)', fontSize: 13,
                  fontStyle: claudeKeyStatus?.hasKey ? 'normal' : 'italic', fontFamily: 'monospace',
                }}>
                  {claudeKeyStatus?.hasKey ? claudeKeyStatus.masked : 'Not set'}
                </div>
                <button
                  onClick={() => { setShowClaudeModal(true); setNewClaudeKey('') }}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)',
                    background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {claudeKeyStatus?.hasKey ? 'Update Key' : 'Enter Key'}
                </button>
              </div>
              {claudeKeyStatus?.hasKey && claudeKeyStatus.source && (
                <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '8px 0 0 0' }}>
                  Resolved from <span style={{ color: 'var(--axon-t2)' }}>{claudeKeyStatus.source}</span> — not stored on disk, re-detected on every launch.
                </p>
              )}
              {claudeKeyStatus?.conflict && (
                <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: 'rgba(217,119,6,0.1)', border: '1px solid var(--axon-amber)' }}>
                  <p style={{ fontSize: 12, color: 'var(--axon-amber)', margin: 0, fontWeight: 500 }}>
                    Conflicting keys detected — pick one manually below
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '6px 0 0 0', fontFamily: 'monospace' }}>
                    ~/.claude.json: {claudeKeyStatus.conflict.claudeJson}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '2px 0 0 0', fontFamily: 'monospace' }}>
                    ~/.claude/config.json: {claudeKeyStatus.conflict.configJson}
                  </p>
                </div>
              )}
              {!claudeKeyStatus?.hasKey && !claudeKeyStatus?.conflict && (
                <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '8px 0 0 0' }}>
                  Get your key at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: 'var(--axon-nexus2)', textDecoration: 'none' }}>console.anthropic.com</a>
                </p>
              )}
            </div>
            <div style={{ padding: 12, borderRadius: 6, background: 'var(--axon-bg3)', border: '1px solid var(--axon-border)' }}>
              <div style={{ fontSize: 12, color: 'var(--axon-t3)' }}>
                <span style={{ fontWeight: 500, color: 'var(--axon-t2)' }}>Prompt-mode model:</span> claude-haiku-4-5
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



            {/* Max Context Snapshot Size */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--axon-t2)', display: 'block', marginBottom: 8 }}>
                Max Inline Snapshot Size (KB)
              </label>
              <input
                type="number"
                min={1}
                value={maxContextSnapshotSizeKb}
                onChange={e => { setMaxContextSnapshotSizeKb(Math.max(1, parseInt(e.target.value, 10) || 1)); setMaxContextSnapshotSaved('idle') }}
                style={{
                  width: 120, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--axon-border)',
                  background: 'var(--axon-bg2)', color: 'var(--axon-t1)', fontSize: 13, outline: 'none',
                }}
              />
              <p style={{ fontSize: 11, color: 'var(--axon-t3)', margin: '8px 0 0 0' }}>
                Step input/output above this size is written to a workspace file instead of stored inline.
              </p>
              {maxContextSnapshotSaved === 'saved' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: '#22c55e' }}>
                  <CheckCircle size={14} /> Saved
                </div>
              )}
              {maxContextSnapshotSaved === 'saving' && (
                <button
                  onClick={saveMaxContextSnapshotSize}
                  disabled={true}
                  style={{ marginTop: 8, padding: '8px 16px', borderRadius: 6, border: '1px solid var(--axon-border)', background: 'var(--axon-bg2)', opacity: 0.5 }}
                />
              )}
              {maxContextSnapshotSaved === 'idle' && (
                <button
                  onClick={saveMaxContextSnapshotSize}
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
