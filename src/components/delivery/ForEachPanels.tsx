import type { ForEachProgress, ItemLane, LaneState } from '@shared'
import { statusColor } from '../../utils/statusColors'
import type { DeliveryStep } from '../../types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from '../ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { X } from 'lucide-react'

// Live View pieces for a ForEach: the compact chip row under the canvas container, the item panel, the item
// switcher shown above a body node's step, and the items table shown when the ForEach header is clicked.
// Everything is keyed by (nodeId, itemKey): outputs of different items are never merged. Built from shadcn
// primitives; long keys are truncated (full key in the tooltip) and many items scroll or fall back to a Select.

export type UIStep = DeliveryStep & { nodeId: string }
export type UIProgress = ForEachProgress<UIStep>
export type UILane = ItemLane<UIStep>

const COLOR: Record<LaneState, string> = {
  pending: statusColor('Pending'), running: statusColor('Running'), done: statusColor('Completed'),
  failed: statusColor('Failed'), cancelled: statusColor('Cancelled'), interrupted: statusColor('Interrupted'),
}
const ICON: Record<LaneState, string> = { pending: '○', running: '●', done: '✓', failed: '✕', cancelled: '■', interrupted: '⏸' }
const LABEL: Record<LaneState, string> = { pending: 'Pending', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' }

export function stepDuration(s: Pick<DeliveryStep, 'startedAt' | 'completedAt'>): string {
  if (!s.startedAt) return '—'
  const end = s.completedAt ? Date.parse(s.completedAt) : Date.now()
  const secs = Math.max(0, Math.round((end - Date.parse(s.startedAt)) / 1000))
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
}

export function laneDuration(lane: UILane): string {
  const started = lane.steps.map((s) => s.startedAt).filter((x): x is string => !!x).sort()[0]
  if (!started) return '—'
  const ended = lane.state === 'done' || lane.state === 'failed' || lane.state === 'cancelled' || lane.state === 'interrupted'
    ? lane.steps.map((s) => s.completedAt).filter((x): x is string => !!x).sort().slice(-1)[0]
    : undefined
  return stepDuration({ startedAt: started, completedAt: ended })
}

/** "12.3k tokens · $0.04" summed over steps, or "—" when no step reported usage. */
export function usageLabel(steps: UIStep[]): string {
  let tokens = 0
  let cost = 0
  let any = false
  for (const s of steps) {
    const u = s.agentOutput?.usage
    if (!u) continue
    any = true
    tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
    cost += u.costUsd ?? 0
  }
  if (!any) return '—'
  const t = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  return `${t} tok${cost > 0 ? ` · $${cost.toFixed(2)}` : ''}`
}

/** Default item shown for a ForEach: the running one, else the last. */
export function defaultLane(p: UIProgress): UILane | undefined {
  return p.lanes.find((l) => l.state === 'running') ?? p.lanes[p.lanes.length - 1]
}

function StateIcon({ state }: { state: LaneState }) {
  return (
    <span className="shrink-0" style={{ color: COLOR[state], animation: state === 'running' ? 'axon-node-pulse 1.6s infinite' : undefined }}>
      {ICON[state]}
    </span>
  )
}

function StateBadge({ state }: { state: LaneState }) {
  return (
    <Badge variant="outline" className="gap-1 font-medium" style={{ color: COLOR[state], borderColor: `${COLOR[state]}66` }}>
      {ICON[state]} {LABEL[state]}
    </Badge>
  )
}

// ---------------------------------------------------------------- canvas: compact chip row (rendered under the container)

export function ForEachChips({ progress, selectedKey, onSelectItem }: {
  progress: UIProgress
  selectedKey: string | null
  onSelectItem: (key: string) => void
}) {
  return (
    <div className="nodrag nopan nowheel flex w-full gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}>
      {progress.lanes.map((lane) => {
        const selected = lane.key === selectedKey
        return (
          <button
            key={lane.key}
            type="button"
            title={`${lane.key} — ${LABEL[lane.state]}`}
            onClick={(e) => { e.stopPropagation(); onSelectItem(lane.key) }}
            className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] text-slate-200 transition-colors hover:bg-slate-800"
            style={{ borderColor: selected ? COLOR[lane.state] : '#334155', background: selected ? `${COLOR[lane.state]}33` : '#0f1117e6' }}
          >
            <StateIcon state={lane.state} />
            <span className="max-w-[9rem] truncate">{lane.key}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- side panel pieces

/**
 * Item picker above a body node's step: a single dropdown (the item chips on the canvas are the quick way to switch).
 * Works with any number of items and long keys, and does not look like the Overview / Input / Output tabs below it.
 */
export function ItemSwitcher({ progress, activeKey, onSelect }: { progress: UIProgress; activeKey: string | undefined; onSelect: (key: string) => void }) {
  const lanes = progress.lanes
  const idx = lanes.findIndex((l) => l.key === activeKey)
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Item {idx >= 0 ? `${idx + 1} of ${lanes.length}` : ''} · {progress.label}
      </span>
      <Select value={activeKey} onValueChange={onSelect}>
        <SelectTrigger className="h-8 w-full font-mono text-xs"><SelectValue placeholder="Choose an item" /></SelectTrigger>
        <SelectContent position="popper" sideOffset={4}>
          {lanes.map((l) => (
            <SelectItem key={l.key} value={l.key} className="font-mono text-xs">
              <span style={{ color: COLOR[l.state] }}>{ICON[l.state]}</span> {l.key}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export interface RepoRow { name: string; path: string; branch: string; prUrl?: string }

const sameOrInside = (child: string, parent: string) => {
  const c = child.replace(/\\/g, '/').toLowerCase()
  const p = parent.replace(/\\/g, '/').toLowerCase()
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  )
}

/** Panel for one ForEach item (chip click): status, timings, folder, branch, usage and its body steps. */
export function ItemPanel({ progress, itemKey, repos, onClose, onSelectStep, onView }: {
  progress: UIProgress
  itemKey: string
  repos: RepoRow[]
  onClose: () => void
  onSelectStep: (step: UIStep) => void
  onView: (kind: 'context' | 'output', step: UIStep) => void
}) {
  const lane = progress.lanes.find((l) => l.key === itemKey)
  if (!lane) return null
  const cwd = lane.steps.find((s) => s.cwd)?.cwd
  const repo = cwd ? repos.find((r) => sameOrInside(cwd, r.path)) : undefined
  const started = lane.steps.map((s) => s.startedAt).filter((x): x is string => !!x).sort()[0]
  return (
    <Card className="mb-4 gap-3 py-4">
      <CardHeader className="px-4">
        <CardDescription className="text-[10px] uppercase tracking-wider">Item · {progress.label}</CardDescription>
        <CardTitle className="truncate font-mono text-sm" title={lane.key}>{lane.key}</CardTitle>
        <CardAction className="flex items-center gap-1">
          <StateBadge state={lane.state} />
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="divide-y rounded-md border px-3">
          <Row k="Started">{started ? new Date(started).toLocaleTimeString() : '—'}</Row>
          <Row k="Duration">{laneDuration(lane)}</Row>
          <Row k="Workspace path">{cwd ? <code className="text-[11px]" title={cwd}>{cwd}</code> : '—'}</Row>
          <Row k="Branch">{repo?.branch ? <code className="text-[11px]" title={repo.branch}>{repo.branch}</code> : '—'}</Row>
          <Row k="Tokens / cost">{usageLabel(lane.steps)}</Row>
        </div>
        <Separator />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Steps for this item</span>
        {lane.steps.length === 0 && <p className="text-xs text-muted-foreground">Not started yet.</p>}
        {lane.steps.map((s) => (
          <div key={s.id} className="flex flex-col gap-2 rounded-md border p-2.5">
            <button type="button" onClick={() => onSelectStep(s)} className="flex items-center justify-between gap-2 text-left text-xs font-medium hover:underline">
              <span className="truncate">{s.nodeName ?? s.name}</span>
              <span className="shrink-0 font-normal text-muted-foreground">{s.status} · {stepDuration(s)}</span>
            </button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => onView('context', s)}>View context</Button>
              <Button variant="outline" size="sm" onClick={() => onView('output', s)}>View full output</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/** Panel shown when the ForEach header is clicked: one row per item. */
export function ForEachTable({ progress, onClose, onSelectItem, onViewOutput }: {
  progress: UIProgress
  onClose: () => void
  onSelectItem: (key: string) => void
  onViewOutput: (step: UIStep) => void
}) {
  return (
    <Card className="mb-4 gap-3 py-4">
      <CardHeader className="px-4">
        <CardDescription className="text-[10px] uppercase tracking-wider">ForEach · {progress.counter}</CardDescription>
        <CardTitle className="truncate text-sm">{progress.label}</CardTitle>
        <CardAction><Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button></CardAction>
      </CardHeader>
      <CardContent className="px-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {progress.lanes.map((l) => {
              const exit = l.steps[l.steps.length - 1]
              return (
                <TableRow key={l.key}>
                  <TableCell className="max-w-[9rem]">
                    <button type="button" title={l.key} onClick={() => onSelectItem(l.key)} className="block max-w-full truncate font-mono text-xs font-semibold hover:underline">{l.key}</button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs" style={{ color: COLOR[l.state] }}>{ICON[l.state]} {LABEL[l.state]}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{laneDuration(l)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{usageLabel(l.steps)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" disabled={!exit || exit.status === 'Pending'} onClick={() => exit && onViewOutput(exit)}>Output</Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
