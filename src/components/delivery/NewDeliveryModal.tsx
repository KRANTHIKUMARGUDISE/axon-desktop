import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { usePipelines } from '@/hooks/usePipelines'
import { useCreateDelivery } from '@/hooks/useDeliveries'
import { useAuthReady } from '@/hooks/useAuthReady'
import type { WorkspaceType } from '@/types'

// ── hook ──────────────────────────────────────────────────────────────────────
export function useNewDeliveryModal() {
  const [isOpen, setIsOpen] = useState(false)
  const [defaultPipelineId, setDefaultPipelineId] = useState<string | undefined>()

  return {
    isOpen,
    defaultPipelineId,
    open: (pipelineId?: string) => {
      setDefaultPipelineId(pipelineId)
      setIsOpen(true)
    },
    close: () => setIsOpen(false),
  }
}

// ── component ─────────────────────────────────────────────────────────────────
interface NewDeliveryModalProps {
  isOpen: boolean
  onClose: () => void
  defaultPipelineId?: string
}

export default function NewDeliveryModal({
  isOpen,
  onClose,
  defaultPipelineId,
}: NewDeliveryModalProps) {
  const navigate = useNavigate()
  const authReady = useAuthReady()
  const { data: pipelines } = usePipelines(undefined, authReady)
  const createDelivery = useCreateDelivery()

  const [ticketId, setTicketId] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>('Default')
  const [browsedPath, setBrowsedPath] = useState<string | null>(null)
  const [inputsJson, setInputsJson] = useState('')
  const [inputsError, setInputsError] = useState<string | null>(null)

  const ticketRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setTicketId('')
      setRepoUrl('')
      setWorkspaceType('Default')
      setBrowsedPath(null)
      setPipelineId(defaultPipelineId ?? '')
      setInputsJson('')
      setInputsError(null)
      setTimeout(() => ticketRef.current?.focus(), 50)
    }
  }, [isOpen, defaultPipelineId])

  async function handleSubmit() {
    if (!ticketId || !pipelineId || !repoUrl) return
    let inputs: Record<string, unknown> | undefined
    if (inputsJson.trim()) {
      try {
        inputs = JSON.parse(inputsJson)
      } catch {
        setInputsError('Invalid JSON')
        return
      }
    }
    try {
      const delivery = await createDelivery.mutateAsync({
        ticketId,
        title: ticketId,
        pipelineId,
        repoUrl,
        workspaceType,
        inputs,
      })
      onClose()
      navigate(`/deliveries/${delivery.id}`)
    } catch {
      toast.error('Failed to start delivery. Please try again.')
    }
  }

  const canSubmit = ticketId.trim() !== '' && pipelineId !== '' && repoUrl.trim() !== ''

  const inputStyle: React.CSSProperties = {
    background: 'var(--axon-bg3)',
    border: '1px solid var(--axon-border2)',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    color: 'var(--axon-t1)',
    fontFamily: 'inherit',
    width: '100%',
    outline: 'none',
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="p-0 border gap-0"
        style={{
          background: 'var(--axon-bg2)',
          borderColor: 'var(--axon-border2)',
          borderRadius: 16,
          width: 480,
          maxWidth: '94vw',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle style={{ fontSize: 16, fontWeight: 700, color: 'var(--axon-t1)' }}>
            New Delivery
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 pt-4 pb-0 flex flex-col gap-3.5">
          {/* Ticket ID */}
          <div>
            <label className="block mb-1" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Ticket ID <span style={{ color: 'var(--axon-red)' }}>*</span>
            </label>
            <input
              ref={ticketRef}
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="e.g. PROJ-2341"
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(111,95,232,0.5)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--axon-border2)')}
            />
            <p style={{ fontSize: 10, color: 'var(--axon-t3)', marginTop: 6 }}>
              Included in the context every AI agent block sees for this delivery.
            </p>
          </div>

          {/* Pipeline */}
          <div>
            <label className="block mb-1" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Pipeline <span style={{ color: 'var(--axon-red)' }}>*</span>
            </label>
            <select
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              className="w-full outline-none cursor-pointer appearance-none"
              style={{
                ...inputStyle,
                color: pipelineId ? 'var(--axon-t1)' : 'var(--axon-t3)',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 10px center',
              }}
            >
              <option value="" disabled>Select a pipeline…</option>
              {pipelines?.map((p) => (
                <option key={p.id} value={p.id} style={{ background: 'var(--axon-bg3)', color: 'var(--axon-t1)' }}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Repo URL */}
          <div>
            <label className="block mb-1" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Repository URL <span style={{ color: 'var(--axon-red)' }}>*</span>
            </label>
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(111,95,232,0.5)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--axon-border2)')}
            />
          </div>

          {/* Workspace */}
          <div>
            <label className="block mb-1.5" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Working Directory
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => { setWorkspaceType('Default'); setBrowsedPath(null) }}
                style={{
                  padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  border: workspaceType === 'Default' ? '1.5px solid var(--axon-nexus2)' : '1.5px solid var(--axon-border2)',
                  color: workspaceType === 'Default' ? 'var(--axon-nexus2)' : 'var(--axon-t2)',
                  background: workspaceType === 'Default' ? 'var(--axon-nx-glow)' : 'var(--axon-bg3)',
                }}
              >
                Default
              </button>
              <button
                onClick={async () => {
                  const picked = await window.axon.dialog.openDirectory()
                  if (picked) {
                    setWorkspaceType('Browse')
                    setBrowsedPath(picked)
                  }
                }}
                style={{
                  padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                  border: workspaceType === 'Browse' ? '1.5px solid var(--axon-nexus2)' : '1.5px solid var(--axon-border2)',
                  color: workspaceType === 'Browse' ? 'var(--axon-nexus2)' : 'var(--axon-t2)',
                  background: workspaceType === 'Browse' ? 'var(--axon-nx-glow)' : 'var(--axon-bg3)',
                }}
              >
                Browse…
              </button>
            </div>
            <p style={{ fontSize: 10, color: 'var(--axon-t3)', marginTop: 6 }}>
              {workspaceType === 'Default'
                ? 'Clone repo into {workspaceRoot}/{ticketId}/'
                : browsedPath
                  ? browsedPath
                  : 'No folder selected'}
            </p>
          </div>

          {/* Inputs */}
          <div>
            <label className="block mb-1" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Inputs (JSON, optional)
            </label>
            <textarea
              value={inputsJson}
              onChange={(e) => { setInputsJson(e.target.value); setInputsError(null) }}
              placeholder='{"testMessage": "hello from manual test"}'
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              onFocus={(e) => (e.target.style.borderColor = 'rgba(111,95,232,0.5)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--axon-border2)')}
            />
            {inputsError ? (
              <p style={{ fontSize: 10, color: 'var(--axon-red)', marginTop: 6 }}>{inputsError}</p>
            ) : (
              <p style={{ fontSize: 10, color: 'var(--axon-t3)', marginTop: 6 }}>
                Ad-hoc values merged into delivery context — used by blocks' Context Requirements.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2 px-6 py-4 mt-5"
          style={{ borderTop: '1px solid var(--axon-border)' }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '6px 13px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: '1px solid var(--axon-border2)',
              color: 'var(--axon-t2)',
              background: 'transparent',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || createDelivery.isPending}
            style={{
              padding: '6px 13px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              border: 'none',
              color: '#fff',
              background: canSubmit ? 'var(--axon-nexus)' : 'rgba(111,95,232,0.35)',
              fontFamily: 'inherit',
              opacity: createDelivery.isPending ? 0.7 : 1,
            }}
          >
            {createDelivery.isPending ? 'Starting…' : 'Start Delivery →'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
