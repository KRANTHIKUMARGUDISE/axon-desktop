import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { describeResume } from '@shared'
import type { ResumePreview } from '@shared'

/** In-app Resume confirmation. The text depends on what Resume can do for the step (see describeResume). */
export default function ResumeDialog({
  preview, busy, onCancel, onConfirm,
}: { preview: ResumePreview | null; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const text = preview ? describeResume(preview) : null
  return (
    <Dialog open={!!preview} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent data-testid="resume-dialog">
        <DialogHeader>
          <DialogTitle>{text?.title ?? 'Resume delivery'}</DialogTitle>
          <DialogDescription asChild>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {text?.lines.map((l, i) => <span key={i} data-testid="resume-line">{l}</span>)}
            </div>
          </DialogDescription>
        </DialogHeader>
        {preview?.failureReason && (
          <div data-testid="resume-failure" style={{ fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'var(--axon-red-d)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            <strong>Why it stopped:</strong> {preview.failureReason}
          </div>
        )}
        {text?.warning && (
          <div data-testid="resume-warning" style={{ fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.3)', background: 'var(--axon-amber-d)' }}>
            ⚠ {text.warning}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy}>{busy ? 'Resuming…' : 'Resume'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
