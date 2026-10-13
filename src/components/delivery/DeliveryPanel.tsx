import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Ban, CheckCircle2, Circle, Code2, ExternalLink, FolderOpen, Loader2, PauseCircle, Repeat, ShieldQuestion, X, XCircle } from 'lucide-react'
import { useDelivery } from '@/hooks/useDeliveries'
import { useJiraBase } from '@/hooks/useJiraBase'
import { getBlocks } from '@/services/blocksService'
import { getBlockTypeIcon } from '@/utils/blockTypeIcons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { JiraTicketLink } from '@/components/shared/JiraTicketLink'
import type { BlockType, DeliveryStep } from '@/types'

// The right-hand summary of a delivery on the Deliveries screen: what it is, where it stands, what ran, where its files are.
// shadcn components and theme tokens only.

interface Props {
  deliveryId: string
  onClose: () => void
}

const STATUS_BADGE: Record<string, string> = {
  Completed: 'border-success/30 bg-success/10 text-success',
  Running: 'border-info/30 bg-info/10 text-info',
  Failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  Paused: 'border-warning/30 bg-warning/10 text-warning',
  Pending: 'border-border bg-muted text-muted-foreground',
  Cancelled: 'border-border bg-muted text-muted-foreground',
  Interrupted: 'border-warning/30 bg-warning/10 text-warning',
  Superseded: 'border-border bg-muted text-muted-foreground',
}

function fmt(iso?: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(startedAt?: string, completedAt?: string) {
  if (!startedAt) return '—'
  const end = completedAt ? new Date(completedAt) : new Date()
  const secs = Math.max(0, Math.floor((end.getTime() - new Date(startedAt).getTime()) / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${secs % 60}s` : `${secs}s`
}

function StepIcon({ status }: { status: DeliveryStep['status'] }) {
  switch (status) {
    case 'Completed': return <CheckCircle2 className="size-4 shrink-0 text-success" />
    case 'Running': return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
    case 'Failed': return <XCircle className="size-4 shrink-0 text-destructive" />
    case 'AwaitingApproval': return <ShieldQuestion className="size-4 shrink-0 text-warning" />
    case 'Cancelled': return <Ban className="size-4 shrink-0 text-muted-foreground" />
    case 'Interrupted': return <PauseCircle className="size-4 shrink-0 text-muted-foreground" />
    default: return <Circle className="size-4 shrink-0 text-muted-foreground/60" />
  }
}

const STEP_LABEL: Partial<Record<DeliveryStep['status'], string>> = { AwaitingApproval: 'Awaiting approval', Completed: 'Done' }

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 text-sm">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

export default function DeliveryPanel({ deliveryId, onClose }: Props) {
  const navigate = useNavigate()
  const jiraBase = useJiraBase()
  const { data: delivery, isLoading } = useDelivery(deliveryId)
  // Block roles give every step its icon (the same icons as the canvas and the block list).
  const { data: blocks } = useQuery({ queryKey: ['blocks-all'], queryFn: () => getBlocks(), staleTime: 30_000 })
  const roleOf = (blockId?: string) => (blockId ? blocks?.find((b) => b.id === blockId)?.role : undefined) as BlockType | undefined

  const { data: rules = [] } = useQuery({ queryKey: ['rules'], queryFn: () => window.axon.rules.list(), staleTime: 30_000 })
  const ruleName = delivery?.ruleId ? rules.find((r) => r.id === delivery.ruleId)?.name : undefined
  const folder = delivery?.deliveryFolder ?? delivery?.workspacePath ?? undefined

  const openFolder = async () => {
    if (!folder) return
    const res = await window.axon.shell.openPath(folder)
    if (!res.success) toast.error(res.error ? `Failed to open folder: ${res.error}` : 'Failed to open folder')
  }
  const openVSCode = async () => {
    if (!folder) return
    const res = await window.axon.shell.openInVSCode(folder)
    if (!res.success) toast.error(res.error ? `Failed to open VS Code: ${res.error}` : 'Failed to open VS Code')
  }

  const steps = delivery?.steps ?? []
  const current = steps.find((s) => s.status === 'Running' || s.status === 'AwaitingApproval')
  const done = steps.filter((s) => s.status === 'Completed').length

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col overflow-hidden border-l bg-card text-card-foreground" data-testid="delivery-panel">
      {isLoading || !delivery ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          {/* header */}
          <header className="flex flex-col gap-2 border-b px-4 py-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <JiraTicketLink ticket={delivery.ticketId} className="text-sm" />
                <Badge variant="outline" className={STATUS_BADGE[delivery.status] ?? ''}>{delivery.status}</Badge>
              </div>
              <Button onClick={onClose} variant="ghost" size="icon-sm" aria-label="Close"><X /></Button>
            </div>
            {delivery.title && delivery.title !== delivery.ticketId && (
              <h2 className="text-sm font-medium leading-snug" data-testid="delivery-title">{delivery.title}</h2>
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="text-foreground">{delivery.pipelineName}</span>
              {delivery.pipelineVersion !== undefined && <Badge variant="secondary" className="font-mono">v{delivery.pipelineVersion}</Badge>}
              {delivery.trigger === 'Watcher' && <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">Automation</Badge>}
            </div>
          </header>

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
            {/* progress */}
            {delivery.status === 'Superseded' ? (
              <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">A newer attempt replaced this delivery, so its partial progress ({done} of {steps.length} stages) no longer matters.</p>
            ) : (
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{done} of {steps.length} stages</span>
                <span className="text-muted-foreground">{delivery.progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={delivery.progress} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={`h-full rounded-full transition-[width] ${delivery.status === 'Completed' ? 'bg-success' : delivery.status === 'Failed' ? 'bg-destructive' : 'bg-primary'}`}
                  style={{ width: `${delivery.progress}%` }}
                />
              </div>
            </section>
            )}

            {/* what is happening now */}
            {current && (
              <section className="flex items-center gap-3 rounded-lg border bg-background/40 p-3" data-testid="current-stage">
                {roleOf(current.blockId)
                  ? <img src={getBlockTypeIcon(roleOf(current.blockId)!)} alt={roleOf(current.blockId)} className="size-9 shrink-0 rounded-md" />
                  : <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted"><StepIcon status={current.status} /></span>}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{current.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {current.status === 'AwaitingApproval' ? 'Waiting for a human to approve' : `Running for ${fmtDuration(current.startedAt)}`}
                  </p>
                </div>
              </section>
            )}

            {/* stages */}
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stages</h3>
              <ol className="flex flex-col divide-y rounded-lg border">
                {steps.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">Nothing has run yet</li>}
                {steps.map((step) => {
                  const role = roleOf(step.blockId)
                  return (
                    <li key={step.id} className="flex items-center gap-2.5 px-3 py-2">
                      <StepIcon status={step.status} />
                      {role
                        ? <img src={getBlockTypeIcon(role)} alt="" className="size-4 shrink-0 rounded-sm" />
                        : !step.blockId && <Repeat className="size-4 shrink-0 text-muted-foreground" aria-label="ForEach" />}
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {step.name}
                        {step.itemKey && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{step.itemKey}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{STEP_LABEL[step.status] ?? step.status}</span>
                    </li>
                  )
                })}
              </ol>
            </section>

            {/* facts */}
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</h3>
              <dl className="flex flex-col gap-2">
                <Fact label="Started">{fmt(delivery.startedAt)}</Fact>
                <Fact label="Duration">{fmtDuration(delivery.startedAt, delivery.completedAt)}</Fact>
                <Fact label="Trigger">
                  {delivery.trigger === 'Watcher' ? (
                    <span className="flex flex-col gap-0.5">
                      <span>Automation rule</span>
                      <button
                        type="button"
                        onClick={() => navigate(`/rules${delivery.ruleId ? `?rule=${delivery.ruleId}` : ''}`)}
                        className="w-fit cursor-pointer text-left text-sm font-medium text-primary hover:underline"
                        title="Show this rule on the Automation page"
                      >
                        {ruleName ?? 'Rule no longer exists'}
                      </button>
                    </span>
                  ) : 'Started manually'}
                </Fact>
                <Fact label="Triggered by">{delivery.createdByName ?? '—'}</Fact>
                <Fact label="Pipeline">
                  <button
                    type="button"
                    onClick={() => navigate(`/pipelines/${delivery.pipelineId}/edit${delivery.pipelineVersion !== undefined ? `?version=${delivery.pipelineVersion}` : ''}`)}
                    className="inline-flex cursor-pointer items-center gap-1 text-left font-medium text-primary hover:underline"
                    title="Open the pipeline version this delivery ran (read-only if a newer version exists)"
                  >
                    {delivery.pipelineName}
                    {delivery.pipelineVersion !== undefined && <span className="font-mono text-xs opacity-80">v{delivery.pipelineVersion}</span>}
                  </button>
                </Fact>
                {folder && <Fact label="Workspace"><span className="font-mono text-xs" title={folder}>{folder}</span></Fact>}
              </dl>
            </section>

            <Separator />

            {/* where to go */}
            <section className="flex flex-wrap gap-2">
              {jiraBase && (
                <Button variant="outline" size="sm" onClick={() => void window.axon.shell.openExternal(`${jiraBase}/browse/${encodeURIComponent(delivery.ticketId)}`)}>
                  <ExternalLink /> Open in Jira
                </Button>
              )}
              {folder && <Button variant="outline" size="sm" onClick={openFolder} title="Open the delivery folder in Explorer"><FolderOpen /> Explorer</Button>}
              {folder && <Button variant="outline" size="sm" onClick={openVSCode} title="Open the delivery folder in VS Code"><Code2 /> VS Code</Button>}
            </section>
          </div>

          <footer className="border-t p-3">
            <Button onClick={() => navigate(`/deliveries/${deliveryId}`)} className="w-full">View full delivery</Button>
          </footer>
        </>
      )}
    </aside>
  )
}
