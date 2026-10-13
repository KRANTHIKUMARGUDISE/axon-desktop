import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ChevronRight, ExternalLink, Workflow } from 'lucide-react'
import type { DeliveryRule, WatcherInfo } from '@shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { Notice } from '@/components/settings/parts'

// One rule as an expandable row: the header shows what matters at a glance (name, trigger → pipeline, state, last delivery,
// a newer version) and the switch; the details, its deliveries and the actions are inside.

export interface RuleDelivery { id: string; ticketId: string; status: string; startedAt: string; localSeq?: number }

interface Props {
  rule: DeliveryRule
  pipelineName?: string
  latest: number | null
  status?: WatcherInfo['rules'][number]
  chain?: WatcherInfo['chains']['rules'][number]
  effects?: WatcherInfo['chains']['effects'][string]
  deliveries: RuleDelivery[]
  paused: boolean
  activeHere: boolean
  busy: boolean
  nameOf: (ruleId: string) => string
  ago: (iso: string | null) => string
  inMinutes: (iso: string | null) => string
  onToggle: (enabled: boolean) => void
  onCheck: () => void
  onEdit: () => void
  onDelete: () => void
  onUpdateVersion: (version: number) => void
  onOpenDelivery: (id: string) => void
  onViewAll: () => void
  onOpenPipeline: () => void
  /** Coming from a delivery: open this rule, scroll to it and flash it once. */
  highlight?: boolean
  /** https://<site>.atlassian.net, or null while Jira is not configured. */
  jiraBase: string | null
  onOpenJira: (url: string) => void
}

const STATUS_TONE: Record<string, string> = {
  Completed: 'text-success', Failed: 'text-destructive', Running: 'text-info', Paused: 'text-warning', Pending: 'text-muted-foreground',
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm">{children || '—'}</span>
    </div>
  )
}

/** The ticket id as a link to the ticket in Jira. It must not trigger the delivery row it sits in. */
function JiraTicketLink({ ticket, url, onOpen }: { ticket: string; url: string; onOpen: (url: string) => void }) {
  return (
    <span
      role="link"
      tabIndex={0}
      title={`Open ${ticket} in Jira`}
      aria-label={`Open ${ticket} in Jira`}
      className="inline-flex cursor-pointer items-center gap-1 font-medium text-primary hover:underline"
      onClick={(e) => { e.stopPropagation(); onOpen(url) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpen(url) } }}
    >
      {ticket}<ExternalLink className="size-3" />
    </span>
  )
}

export function RuleRow(p: Props) {
  const { rule, status, chain, effects, deliveries } = p
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!p.highlight) return
    setOpen(true)
    setFlash(true)
    const scroll = setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120)
    const stop = setTimeout(() => setFlash(false), 2800)
    return () => { clearTimeout(scroll); clearTimeout(stop) }
  }, [p.highlight])
  const last = deliveries[0]
  const newer = p.latest !== null && p.latest > rule.pipelineVersion
  // The left edge says at a glance how the rule is doing: red = its last delivery failed, green = on, grey = off.
  const accent = last?.status === 'Failed' ? 'border-l-destructive' : rule.enabled ? (p.paused ? 'border-l-warning' : 'border-l-success') : 'border-l-border'
  const setsInJira = effects ? [
    effects.transitions.length ? `status ${effects.transitions.join(', ')}` : '',
    effects.addLabels.length ? `adds ${effects.addLabels.join(', ')}` : '',
    effects.removeLabels.length ? `removes ${effects.removeLabels.join(', ')}` : '',
  ].filter(Boolean).join(' · ') : ''

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      ref={ref}
      className={`rounded-xl border border-l-4 bg-card text-card-foreground shadow-sm transition-all duration-500 ${accent} ${flash ? 'ring-2 ring-primary shadow-lg shadow-primary/25' : open ? 'ring-1 ring-primary/30' : ''}`}
      data-testid="rule-row"
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={open ? 'Collapse rule' : 'Expand rule'}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
        className="flex cursor-pointer items-start gap-3 rounded-r-xl px-4 py-3.5 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* row 1: the rule's name, state and switch */}
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-base font-semibold leading-tight">{rule.name}</span>
            <div className="flex shrink-0 items-center gap-2.5">
              {newer && <Badge variant="outline" className="border-warning/40 text-warning" title={`This rule runs v${rule.pipelineVersion}; open the rule to see the changes`} data-testid="newer-pipeline-version">v{p.latest} available</Badge>}
              <span className="text-xs text-muted-foreground">{rule.enabled ? (p.paused ? 'Paused' : 'On') : 'Off'}</span>
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex">
                <Switch checked={rule.enabled} disabled={p.busy} onCheckedChange={p.onToggle} aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'} />
              </span>
            </div>
          </div>

          {/* row 2: what starts it and what runs, each in its own colour */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" data-testid="rule-summary">
            <Badge className="border-transparent bg-project/15 font-mono text-project" title="Jira project">{rule.jiraProjectKey}</Badge>
            <span className="text-muted-foreground">when</span>
            <Badge className="border-transparent bg-trigger/15 text-trigger" title={rule.readyStatus ? 'Ticket enters this status' : 'Ticket gets this label'}>
              {rule.readyStatus ? 'status' : 'label'} <span className="font-mono">{rule.readyStatus ?? rule.readyLabel}</span>
            </Badge>
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <Badge className="border-transparent bg-pipeline/15 text-pipeline" title="Pipeline and pinned version">
              {p.pipelineName ?? 'missing pipeline'} <span className="font-mono opacity-70">v{rule.pipelineVersion}</span>
            </Badge>
          </div>

          {/* row 3: how it last went */}
          <div className="text-xs text-muted-foreground">
            {last
              ? <>Last delivery <span className="font-mono">{last.localSeq ? `#${last.localSeq}` : ''}</span> · {last.ticketId} · <span className={STATUS_TONE[last.status] ?? ''}>{last.status}</span> · {p.ago(last.startedAt)}</>
              : 'No deliveries yet'}
          </div>
        </div>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-4 border-t py-4 pl-11 pr-4">
          {newer && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
              <span>Newer pipeline version available: v{p.latest} (this rule runs v{rule.pipelineVersion})</span>
              <Button size="sm" variant="outline" disabled={p.busy} onClick={() => p.onUpdateVersion(p.latest!)}>See changes and update</Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Fact label="Checks Jira every">{`${rule.pollIntervalMinutes} min`}</Fact>
            <Fact label="Last Jira check">{p.ago(status?.lastPollAt ?? null)}</Fact>
            <Fact label="Next Jira check">{rule.enabled ? (p.paused ? 'paused' : p.inMinutes(status?.nextCheckAt ?? null)) : 'disabled'}</Fact>
            <Fact label="Last match">
              {status?.lastMatchKey
                ? <span className="inline-flex items-center gap-1.5">{p.jiraBase ? <JiraTicketLink ticket={status.lastMatchKey} url={`${p.jiraBase}/browse/${status.lastMatchKey}`} onOpen={p.onOpenJira} /> : status.lastMatchKey} · {p.ago(status.lastMatchAt)}</span>
                : 'none yet'}
            </Fact>
            <Fact label="Sets in Jira">{setsInJira}</Fact>
            <Fact label="Chain">
              {chain && (chain.next.length || chain.previous.length)
                ? [chain.previous.length ? `after ${chain.previous.map(p.nameOf).join(', ')}` : '', chain.next.length ? `then ${chain.next.map(p.nameOf).join(', ')}` : ''].filter(Boolean).join(' · ')
                : ''}
            </Fact>
            {rule.defaultWorkspacePath && <Fact label="Default workspace path">{rule.defaultWorkspacePath}</Fact>}
          </div>

          <div className="flex flex-col gap-1.5" data-testid="rule-deliveries">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Deliveries started by this rule</span>
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={p.onViewAll}>View all ({deliveries.length})</Button>
            </div>
            {deliveries.length === 0
              ? <span className="text-sm text-muted-foreground">None yet</span>
              : deliveries.slice(0, 3).map((d) => (
                <div
                  key={d.id}
                  role="button"
                  tabIndex={0}
                  title="Open this delivery"
                  onClick={() => p.onOpenDelivery(d.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') p.onOpenDelivery(d.id) }}
                  className="grid cursor-pointer grid-cols-[3.25rem_minmax(0,1fr)_5.5rem_4.5rem_1rem] items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
                >
                  <span>{d.localSeq ? <Badge variant="secondary" className="font-mono" title="Delivery number">#{d.localSeq}</Badge> : null}</span>
                  <span className="min-w-0 truncate">
                    {p.jiraBase
                      ? <JiraTicketLink ticket={d.ticketId} url={`${p.jiraBase}/browse/${d.ticketId}`} onOpen={p.onOpenJira} />
                      : <span className="font-medium">{d.ticketId}</span>}
                  </span>
                  <span className={`text-xs ${STATUS_TONE[d.status] ?? 'text-muted-foreground'}`}>{d.status}</span>
                  <span className="text-right text-xs text-muted-foreground">{p.ago(d.startedAt)}</span>
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </div>
              ))}
          </div>

          {status?.lastError && <Notice ok={false}>{status.lastError}</Notice>}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={p.onOpenPipeline} title={`Open the version this rule runs (v${rule.pipelineVersion}); read-only if a newer version exists`}><Workflow /> Open pipeline v{rule.pipelineVersion}</Button>
            <Button variant="outline" size="sm" disabled={p.busy || !rule.enabled || p.paused || !p.activeHere} title="Look in Jira right now for tickets this rule matches and start a delivery for each new one (instead of waiting for the next scheduled check)" onClick={p.onCheck}>Check Jira now</Button>
            <Button variant="outline" size="sm" disabled={p.busy} onClick={p.onEdit}>Edit</Button>
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={p.busy} onClick={p.onDelete}>Delete</Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
