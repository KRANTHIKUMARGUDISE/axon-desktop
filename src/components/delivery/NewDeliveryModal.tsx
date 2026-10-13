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

// Same rule the Workspace Provisioner enforces in main (shared TICKET_KEY).
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/

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
  const { data: pipelines } = usePipelines(undefined)
  const createDelivery = useCreateDelivery()

  const [ticketId, setTicketId] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  // D18: one optional Workspace path (a clean git repo inside the Workspace Root). Checked in main before the delivery exists.
  const [workspacePath, setWorkspacePath] = useState('')
  const [pathError, setPathError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [inputsJson, setInputsJson] = useState('')
  const [inputsError, setInputsError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [storeFullContext, setStoreFullContext] = useState(false)

  const ticketRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setTicketId('')
      setWorkspacePath('')
      setPathError(null)
      setPipelineId(defaultPipelineId ?? '')
      setInputsJson('')
      setInputsError(null)
      setShowAdvanced(false)
      setStoreFullContext(false)
      setTimeout(() => ticketRef.current?.focus(), 50)
    }
  }, [isOpen, defaultPipelineId])

  async function handleSubmit() {
    if (!TICKET_KEY.test(ticketId.trim()) || !pipelineId) return
    if (workspacePath.trim()) {
      setChecking(true)
      const check = await window.axon.delivery.checkWorkspacePath(workspacePath.trim()).catch((e) => ({ success: false, error: String(e) }))
      setChecking(false)
      if (!check.success) {
        setPathError(check.error ?? 'Workspace path is not usable')
        return
      }
    }
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
        ticketId: ticketId.trim(),
        title: ticketId.trim(),
        pipelineId,
        repoUrl: '',
        workspaceType: 'Default',
        workspacePath: workspacePath.trim() || undefined,
        storeFullContext,
        inputs,
      })
      onClose()
      navigate(`/deliveries/${delivery.id}`)
    } catch {
      toast.error('Failed to start delivery. Please try again.')
    }
  }

  const ticketValid = TICKET_KEY.test(ticketId.trim())
  const canSubmit = ticketValid && pipelineId !== ''

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
            <p style={{ fontSize: 10, color: ticketId && !ticketValid ? 'var(--axon-red)' : 'var(--axon-t3)', marginTop: 6 }}>
              {ticketId && !ticketValid
                ? 'Use a Jira-style key such as PROJ-123 (capital letters, a dash and a number).'
                : 'Included in the context every AI agent block sees for this delivery.'}
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

          {/* Workspace path (optional, D18) */}
          <div>
            <label className="block mb-1" style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
              Workspace path <span style={{ color: 'var(--axon-t3)', fontWeight: 400 }}>(optional)</span>
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={workspacePath}
                onChange={(e) => { setWorkspacePath(e.target.value); setPathError(null) }}
                placeholder="A git repository folder inside the Workspace Root"
                className="dark:bg-[var(--axon-bg3)]"
              />
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  const picked = await window.axon.dialog.openDirectory(true)
                  if (picked) { setWorkspacePath(picked); setPathError(null) }
                }}
              >
                Browse…
              </Button>
            </div>
            {pathError ? (
              <p style={{ fontSize: 10, color: 'var(--axon-red)', marginTop: 6 }}>{pathError}</p>
            ) : (
              <p style={{ fontSize: 10, color: 'var(--axon-t3)', marginTop: 6 }}>
                Blocks run here unless an item names its own workspacePath. AXON creates the delivery branch in it and switches back when the delivery ends. Leave empty to run in the delivery folder.
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
            disabled={!canSubmit || createDelivery.isPending || checking}
          >
            {createDelivery.isPending ? 'Starting…' : 'Start Delivery →'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
