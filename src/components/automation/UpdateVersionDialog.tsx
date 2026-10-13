import { useQuery } from '@tanstack/react-query'
import { Minus, Pencil, Plus } from 'lucide-react'
import type { DeliveryRule, PipelineDiff } from '@shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Notice, cleanError } from '@/components/settings/parts'

// "What changes if this rule moves to the newer pipeline version": the differences in plain words, then Update.

const ICON = { added: Plus, removed: Minus, changed: Pencil } as const
const TONE = { added: 'text-success', removed: 'text-destructive', changed: 'text-warning' } as const

export function UpdateVersionDialog({ rule, toVersion, busy, onClose, onConfirm }: {
  rule: DeliveryRule | null
  toVersion: number | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const open = !!rule && toVersion !== null
  const { data, isLoading, error } = useQuery<PipelineDiff>({
    queryKey: ['pipeline-diff', rule?.pipelineId, rule?.pipelineVersion, toVersion],
    queryFn: () => window.axon.rules.compareVersions(rule!.pipelineId, rule!.pipelineVersion, toVersion!),
    enabled: open,
    staleTime: 0,
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update “{rule?.name}” to v{toVersion}?</DialogTitle>
          <DialogDescription>This rule runs v{rule?.pipelineVersion} now. Here is what changes in v{toVersion}.</DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Comparing the versions…</p>}
        {error && <Notice ok={false}>{cleanError(error)}</Notice>}

        {data && (
          <div className="flex flex-col gap-4" data-testid="version-diff">
            {(data.versionLabel || data.changeNote) && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                {data.versionLabel && <p className="font-medium">{data.versionLabel}</p>}
                {data.changeNote && <p className="text-muted-foreground">{data.changeNote}</p>}
              </div>
            )}

            {data.ruleEffect.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Effect on Jira and your rules</h4>
                <ul className="flex flex-col gap-1 text-sm">{data.ruleEffect.map((t) => <li key={t}>{t}</li>)}</ul>
              </section>
            )}

            <section className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Changes in the pipeline</h4>
              {data.items.length === 0
                ? <p className="text-sm text-muted-foreground">Nothing visible changed in the steps, connections or settings.</p>
                : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {data.items.map((i, k) => {
                      const Icon = ICON[i.kind]
                      return <li key={k} className="flex items-start gap-2"><Icon className={`mt-0.5 size-3.5 shrink-0 ${TONE[i.kind]}`} /><span>{i.text}</span></li>
                    })}
                  </ul>
                )}
            </section>
            <p className="text-xs text-muted-foreground">The rule keeps its on/off state. Deliveries already running or finished are not affected.</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy || !data}>{busy ? 'Updating…' : `Update to v${toVersion}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
