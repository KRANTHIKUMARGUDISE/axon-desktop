import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { RERUN_REASONS } from '@shared'
import type { RerunReason } from '@shared'

const LABELS: Record<RerunReason, { title: string; hint: string }> = {
  RequirementUpdated: { title: 'Requirement updated', hint: 'The ticket or its acceptance criteria changed.' },
  AgentUpdated: { title: 'Agent updated', hint: 'A block or skill was changed to fix the problem.' },
  PlatformRetry: { title: 'Platform retry', hint: 'A transient problem (network, rate limit, tooling).' },
  Other: { title: 'Other', hint: 'Anything else.' },
}

/** Asks why a delivery is being re-run. The old delivery becomes Superseded; the new one links back to it. */
export default function RerunDialog({
  open, ticketId, busy, onCancel, onConfirm,
}: { open: boolean; ticketId: string; busy: boolean; onCancel: () => void; onConfirm: (reason: RerunReason) => void }) {
  const [reason, setReason] = useState<RerunReason>('RequirementUpdated')
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent data-testid="rerun-dialog">
        <DialogHeader>
          <DialogTitle>Rerun this delivery as a new run?</DialogTitle>
          <DialogDescription>
            Starts a fresh delivery for {ticketId} from the first step. This delivery is marked Superseded and linked to the new one;
            its folders are kept until the 14-day cleanup. To continue the same delivery from the failed step, use Resume instead.
          </DialogDescription>
        </DialogHeader>
        <fieldset style={{ display: 'flex', flexDirection: 'column', gap: 8, border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Why are you re-running it?</legend>
          {RERUN_REASONS.map((r) => (
            <label key={r} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="radio" name="rerun-reason" value={r} checked={reason === r} onChange={() => setReason(r)} style={{ marginTop: 3 }} />
              <span>
                <strong>{LABELS[r].title}</strong>
                <br />
                <span style={{ fontSize: 12, opacity: 0.75 }}>{LABELS[r].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={() => onConfirm(reason)} disabled={busy}>{busy ? 'Starting…' : 'Rerun'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
