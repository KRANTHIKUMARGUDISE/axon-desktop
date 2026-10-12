import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { ChevronRight, FolderOpen } from 'lucide-react'
import axonIcon from '../assets/axon-icon.png'
import axonTitle from '../assets/axon-title.png'

const STEPS = ['Welcome', 'Workspace', 'Claude']

// Temporary local setup (workspace root + Claude key) until the full onboarding lands in S3.
export default function Setup({ onComplete }: { onComplete?: () => void }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [claudeKey, setClaudeKey] = useState('')
  const [keyDetected, setKeyDetected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    window.axon.settings.get('workspaceRoot').then((v) => typeof v === 'string' && setWorkspaceRoot(v)).catch(() => {})
    window.axon.claudeKey.getStatus().then((s) => s.hasKey && setKeyDetected(s.masked)).catch(() => {})
  }, [])

  async function browse() {
    const dir = await window.axon.dialog.openDirectory()
    if (dir) setWorkspaceRoot(dir)
  }

  async function finishSetup() {
    setFinishing(true)
    setError('')
    try {
      if (workspaceRoot.trim()) await window.axon.settings.set('workspaceRoot', workspaceRoot.trim())
      if (claudeKey.trim()) await window.axon.claudeKey.set(claudeKey.trim())
      await window.axon.settings.set('setupComplete', true)
      window.dispatchEvent(new Event('axon:claudeKeyChanged'))
      onComplete?.()
      navigate('/dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed')
      setFinishing(false)
    }
  }

  const progressSteps = STEPS.slice(1)

  return (
    <div className="dark flex h-screen items-center justify-center" style={{ background: 'var(--axon-bg)' }}>
      <div
        className="w-full max-w-lg rounded-2xl border p-8"
        style={{ background: 'var(--axon-bg2)', borderColor: 'var(--axon-border)' }}
      >
        <div className="flex items-center gap-2.5 mb-8">
          <img src={axonIcon} alt="AXON" className="h-9 rounded-lg" />
          <img src={axonTitle} alt="AXON" className="h-4" />
        </div>

        {step > 0 && (
          <div className="flex items-center gap-1.5 mb-8">
            {progressSteps.map((label, i) => {
              const stepIndex = i + 1
              const done = step > stepIndex
              const active = step === stepIndex
              return (
                <div key={label} className="flex items-center gap-1.5">
                  <div
                    className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0"
                    style={{
                      background: done ? 'var(--axon-green)' : active ? 'var(--axon-nexus)' : 'var(--axon-bg4)',
                      color: done || active ? '#fff' : 'var(--axon-t3)',
                    }}
                  >
                    {done ? '✓' : stepIndex}
                  </div>
                  <span
                    className="text-[11px]"
                    style={{ color: active ? 'var(--axon-nexus2)' : done ? 'var(--axon-t2)' : 'var(--axon-t4)' }}
                  >
                    {label}
                  </span>
                  {i < progressSteps.length - 1 && (
                    <div className="h-px flex-1 min-w-[12px]" style={{ background: done ? 'var(--axon-green)' : 'var(--axon-border2)' }} />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {step === 0 && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--axon-t1)' }}>Welcome to AXON</h1>
              <p className="text-sm font-medium mb-4" style={{ color: 'var(--axon-nexus2)' }}>
                Engineering Intelligence. Automated Delivery.
              </p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--axon-t2)' }}>
                AXON runs AI-powered delivery pipelines locally on your machine. Everything — blocks,
                pipelines and delivery history — is stored on this computer. Two quick settings and you're ready.
              </p>
            </div>
            <Button className="w-full gap-2" style={{ background: 'var(--axon-nexus)', color: '#fff' }} onClick={() => setStep(1)}>
              Get Started <ChevronRight size={15} />
            </Button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Workspace folder</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>
                Repositories for your deliveries are cloned under this folder. Avoid cloud-synced folders such as OneDrive.
              </p>
            </div>
            <div className="flex gap-2">
              <Input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} placeholder="Workspace folder" />
              <Button variant="outline" onClick={browse} className="gap-1.5 shrink-0">
                <FolderOpen size={14} /> Browse
              </Button>
            </div>
            <Button className="w-full gap-2" style={{ background: 'var(--axon-nexus)', color: '#fff' }} onClick={() => setStep(2)}>
              Continue <ChevronRight size={15} />
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--axon-t1)' }}>Claude API key</h2>
              <p className="text-sm" style={{ color: 'var(--axon-t3)' }}>
                Agent runs need an Anthropic Console API key (a Claude subscription login is not supported).
                The key is kept in memory only and is never written to disk. You can skip this and add it later in Settings.
              </p>
            </div>
            {keyDetected && (
              <p className="text-xs" style={{ color: 'var(--axon-green)' }}>
                A key was detected on this machine ({keyDetected}). Leave the field empty to use it.
              </p>
            )}
            <Input
              type="password"
              value={claudeKey}
              onChange={(e) => setClaudeKey(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
            />
            {error && <p className="text-xs" style={{ color: 'var(--axon-red)' }}>{error}</p>}
            <Button
              className="w-full gap-2"
              style={{ background: 'var(--axon-nexus)', color: '#fff' }}
              onClick={finishSetup}
              disabled={finishing}
            >
              {finishing ? 'Finishing…' : 'Finish setup'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
