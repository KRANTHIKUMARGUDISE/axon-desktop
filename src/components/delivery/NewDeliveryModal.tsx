import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [storeFullContext, setStoreFullContext] = useState(false)

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
      setShowAdvanced(false)
      setStoreFullContext(false)
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
        storeFullContext,
        inputs,
      })
      onClose()
      navigate(`/deliveries/${delivery.id}`)
    } catch {
      toast.error('Failed to start delivery. Please try again.')
    }
  }

  const canSubmit = ticketId.trim() !== '' && pipelineId !== '' && repoUrl.trim() !== ''

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
            <Input
              ref={ticketRef}
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="e.g. PROJ-2341"
              className="dark:bg-[var(--axon-bg3)]"
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
            <Select value={pipelineId} onValueChange={setPipelineId}>
              <SelectTrigger className="w-full dark:bg-[var(--axon-bg3)]">
                <SelectValue placeholder="Select a pipeline…" />
              </SelectTrigger>
              <SelectContent>
                {pipelines?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Repo URL */}
          <div>
            <label className="block mb-1" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Repository URL <span style={{ color: 'var(--axon-red)' }}>*</span>
            </label>
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              className="dark:bg-[var(--axon-bg3)]"
            />
          </div>

          {/* Workspace */}
          <div>
            <label className="block mb-1.5" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Working Directory
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                type="button"
                size="sm"
                variant={workspaceType === 'Default' ? 'secondary' : 'outline'}
                className="rounded-full"
                style={workspaceType === 'Default' ? { color: 'var(--axon-nexus2)', background: 'var(--axon-nx-glow)' } : undefined}
                onClick={() => { setWorkspaceType('Default'); setBrowsedPath(null) }}
              >
                Default
              </Button>
              <Button
                type="button"
                size="sm"
                variant={workspaceType === 'Browse' ? 'secondary' : 'outline'}
                className="rounded-full"
                style={workspaceType === 'Browse' ? { color: 'var(--axon-nexus2)', background: 'var(--axon-nx-glow)' } : undefined}
                onClick={async () => {
                  const picked = await window.axon.dialog.openDirectory()
                  if (picked) {
                    setWorkspaceType('Browse')
                    setBrowsedPath(picked)
                  }
                }}
              >
                Browse…
              </Button>
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
            <Textarea
              value={inputsJson}
              onChange={(e) => { setInputsJson(e.target.value); setInputsError(null) }}
              placeholder='{"testMessage": "hello from manual test"}'
              rows={3}
              className="resize-y font-mono text-[11px] dark:bg-[var(--axon-bg3)]"
            />
            {inputsError ? (
              <p style={{ fontSize: 10, color: 'var(--axon-red)', marginTop: 6 }}>{inputsError}</p>
            ) : (
              <p style={{ fontSize: 10, color: 'var(--axon-t3)', marginTop: 6 }}>
                Ad-hoc values merged into delivery context — used by blocks' Context Requirements.
              </p>
            )}
          </div>

          {/* Advanced */}
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto p-0 hover:bg-transparent"
              style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t3)' }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? '▾' : '▸'} Advanced
            </Button>
            {showAdvanced && (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                  <Checkbox
                    checked={storeFullContext}
                    onCheckedChange={(checked) => setStoreFullContext(checked === true)}
                    className="mt-0.5"
                  />
                  <span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)', display: 'block' }}>
                      Store full input context for every step
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--axon-t3)' }}>
                      Off by default — only field availability (available/missing/empty) is recorded, not the actual values.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2 px-6 py-4 mt-5"
          style={{ borderTop: '1px solid var(--axon-border)' }}
        >
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || createDelivery.isPending}
          >
            {createDelivery.isPending ? 'Starting…' : 'Start Delivery →'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
