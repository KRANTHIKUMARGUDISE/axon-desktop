import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ALL_STATUS_KEYS, statusBg, statusBgMap, statusColor, statusColorMap } from '../utils/statusColors'
import { Plus } from 'lucide-react'
import { autonomyRate } from '@shared'
import { useDeliveries } from '@/hooks/useDeliveries'
import { usePipelines } from '@/hooks/usePipelines'
import NewDeliveryModal, { useNewDeliveryModal } from '@/components/delivery/NewDeliveryModal'
import DeliveryPanel from '@/components/delivery/DeliveryPanel'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { JiraTicketLink } from '@/components/shared/JiraTicketLink'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

// ── helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = statusColorMap(ALL_STATUS_KEYS)

const STATUS_BG: Record<string, string> = statusBgMap(ALL_STATUS_KEYS)

const PROGRESS_COLOR: Record<string, string> = STATUS_COLOR

const STATUS_TABS = ['All', 'Running', 'Waiting', 'Completed', 'Failed', 'Cancelled', 'Superseded'] as const
type TabStatus = typeof STATUS_TABS[number]

// Tabs that should call out attention with their semantic status color whenever they
// have a nonzero count — not just when they're the active tab.
const TAB_ALERT_COLOR: Partial<Record<TabStatus, string>> = {
  Waiting: statusColor('Waiting'),
  Failed: statusColor('Failed'),
}
const TAB_ALERT_BG: Partial<Record<TabStatus, string>> = {
  Waiting: statusBg('Waiting'),
  Failed: statusBg('Failed'),
}

const DATE_RANGES = ['All Time', 'Today', 'This Week', 'This Month', 'Last 30 Days', 'Last 90 Days'] as const
type DateRange = typeof DATE_RANGES[number]

// Sentinel values for the "reset to All" option — a Select item can't use an empty
// string, so these stand in for "no filter" and get mapped back to null on change.
const ALL_PIPELINES_VALUE = '__all-pipelines__'
const ALL_TEAMS_VALUE = '__all-teams__'

function isWithinDateRange(iso: string | undefined, range: DateRange): boolean {
  if (range === 'All Time') return true
  if (!iso) return false
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  const now = new Date()

  switch (range) {
    case 'Today':
      return d.toDateString() === now.toDateString()
    case 'This Week': {
      const dayIndex = (now.getDay() + 6) % 7 // days since most recent Monday
      const monday = new Date(now)
      monday.setHours(0, 0, 0, 0)
      monday.setDate(now.getDate() - dayIndex)
      return d >= monday
    }
    case 'This Month':
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    case 'Last 30 Days':
      return now.getTime() - d.getTime() <= 30 * 86400000
    case 'Last 90 Days':
      return now.getTime() - d.getTime() <= 90 * 86400000
    default:
      return true
  }
}

function fmtStarted(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (diffDays === 0) return `Today ${time}`
  if (diffDays === 1) return `Yesterday ${time}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` ${time}`
}

function initials(name: string | undefined | null) {
  return (name ?? '?').slice(0, 2).toUpperCase()
}

// ── skeleton row ───────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <TableRow>
      {[200, 120, 70, 100, 90, 70, 50].map((w, i) => (
        <TableCell key={i} style={{ padding: '12px 14px' }}>
          <div style={{ height: 12, width: w, borderRadius: 4, background: 'var(--axon-bg4)' }} />
        </TableCell>
      ))}
    </TableRow>
  )
}

// ── main component ─────────────────────────────────────────────────────────────
export default function Deliveries() {
  // Set window title
  useEffect(() => {
    if (window.axon?.window?.setTitle) {
      window.axon.window.setTitle('AXON — Deliveries')
    }
  }, [])

  const modal = useNewDeliveryModal()

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activeStatus, setActiveStatus] = useState<TabStatus>('All')
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null)
  const [activeTeam, setActiveTeam] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>('All Time')
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(20)
  const [activeTrigger, setActiveTrigger] = useState<'all' | 'manual' | 'automation'>('all')
  // ?rule=<id> (from the Automation page): only deliveries started by that rule.
  const [params, setParams] = useSearchParams()
  const ruleFilter = params.get('rule')
  const { data: ruleList = [] } = useQuery({ queryKey: ['rules'], queryFn: () => window.axon.rules.list() })
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const { data: pipelines = [] } = usePipelines(undefined)
  // Every delivery is loaded once (they are local) so that filters, counts and paging are always correct across pages.
  const { data: everything, isLoading, isError, error } = useDeliveries({ page: 1, pageSize: 100_000 })
  const universe = everything?.items ?? []
  const autonomy = autonomyRate(universe.map(d => ({ status: d.status, interventions: d.interventionCount ?? 0 })))

  // Extract distinct teams
  const allTeams = Array.from(new Set(universe.map(d => d.ownerTeam).filter(Boolean))) as string[]

  // Everything except the status tab: the tab counts describe what the other filters leave.
  const base = universe.filter(d => {
    if (ruleFilter && d.ruleId !== ruleFilter) return false
    if (activeTrigger === 'manual' && d.trigger === 'Watcher') return false
    if (activeTrigger === 'automation' && d.trigger !== 'Watcher') return false
    if (activePipelineId && d.pipelineId !== activePipelineId) return false
    if (activeTeam && d.ownerTeam !== activeTeam) return false
    if (!isWithinDateRange(d.startedAt, dateRange)) return false
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      if (!(d.ticketId ?? '').toLowerCase().includes(q) && !(d.title ?? '').toLowerCase().includes(q) && !(d.pipelineName ?? '').toLowerCase().includes(q)) return false
    }
    return true
  })

  const byStatus = base.filter(d => {
    if (activeStatus === 'All') return true
    if (activeStatus === 'Waiting') return d.status === 'Pending' || d.status === 'Paused'
    return d.status === activeStatus
  })

  // status counts
  const counts: Record<TabStatus, number> = {
    All: base.length,
    Running: base.filter(d => d.status === 'Running').length,
    Waiting: base.filter(d => d.status === 'Pending' || d.status === 'Paused').length,
    Completed: base.filter(d => d.status === 'Completed').length,
    Failed: base.filter(d => d.status === 'Failed').length,
    Cancelled: base.filter(d => d.status === 'Cancelled').length,
    // A superseded attempt is not a failure of its own: the story (original → reruns) counts once, via its latest attempt.
    Superseded: base.filter(d => d.status === 'Superseded').length,
  }

  const total = byStatus.length
  const pageSize = rowsPerPage
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, totalPages)
  const filtered = byStatus.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const showFrom = (currentPage - 1) * pageSize + 1
  const showTo = Math.min(currentPage * pageSize, total)

  function handleRowClick(id: string) {
    setSelectedDeliveryId(prev => prev === id ? null : id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', overflow: 'hidden', background: 'var(--axon-bg)' }}>
      {/* ── List side ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {/* Top bar */}
        <div style={{
          padding: '0 22px', height: 52,
          background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)',
          display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)' }}>Deliveries</div>
            <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 1 }}>Track and manage all pipeline executions</div>
          </div>
          {/* S5 Q13: share of completed deliveries that needed no human intervention (this machine's deliveries, you). */}
          <div
            data-testid="autonomy-metric"
            title="Deliveries completed with zero interventions. Interventions: a rejected gate, a rerun after a failure, an edit in the workspace before approving, or starting by hand something the Jira watcher could have run. Approving unchanged and the trigger itself do not count."
            style={{ textAlign: 'right', lineHeight: 1.2 }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--axon-t1)' }}>{autonomy.percent === null ? '—' : `${autonomy.percent}%`}</div>
            <div style={{ fontSize: 10.5, color: 'var(--axon-t3)' }}>
              {autonomy.percent === null ? 'Autonomy: nothing completed yet' : `Autonomy · ${autonomy.autonomous} of ${autonomy.completed} completed with no intervention`}
            </div>
          </div>
          <Button onClick={() => modal.open()} size="sm">
            <Plus className="size-3.5" />
            New Delivery
          </Button>
        </div>

        {ruleFilter && (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-6 py-2 text-sm" data-testid="rule-filter">
            <span>Showing deliveries started by rule <strong>{ruleList.find(r => r.id === ruleFilter)?.name ?? ruleFilter}</strong></span>
            <Button variant="outline" size="sm" onClick={() => { params.delete('rule'); setParams(params, { replace: true }) }}>Show all</Button>
          </div>
        )}
        {/* Filter row */}
        <div style={{
          padding: '10px 22px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)', flexShrink: 0,
        }}>
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by ticket ID, title, pipeline…"
            className="flex-1 min-w-0 dark:bg-[var(--axon-bg3)]"
          />
          <Select
            value={activePipelineId ?? ALL_PIPELINES_VALUE}
            onValueChange={v => { setActivePipelineId(v === ALL_PIPELINES_VALUE ? null : v); setPage(1) }}
          >
            <SelectTrigger size="sm" className="w-[168px] dark:bg-[var(--axon-bg3)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PIPELINES_VALUE}>All Pipelines</SelectItem>
              {pipelines.map(p => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={activeTrigger} onValueChange={v => { setActiveTrigger(v as typeof activeTrigger); setPage(1) }}>
            <SelectTrigger size="sm" className="w-[150px] dark:bg-[var(--axon-bg3)]" aria-label="Filter by trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All triggers</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="automation">Automation</SelectItem>
            </SelectContent>
          </Select>

          {allTeams.length > 0 && (
            <Select
              value={activeTeam ?? ALL_TEAMS_VALUE}
              onValueChange={v => { setActiveTeam(v === ALL_TEAMS_VALUE ? null : v); setPage(1) }}
            >
              <SelectTrigger size="sm" className="w-[152px] dark:bg-[var(--axon-bg3)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TEAMS_VALUE}>All Teams</SelectItem>
                {allTeams.map(t => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={dateRange} onValueChange={v => { setDateRange(v as DateRange); setPage(1) }}>
            <SelectTrigger size="sm" className="w-[152px] dark:bg-[var(--axon-bg3)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_RANGES.map(range => (
                <SelectItem key={range} value={range}>{range}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Status tabs */}
        <Tabs
          value={activeStatus}
          onValueChange={v => { setActiveStatus(v as TabStatus); setPage(1) }}
        >
          <TabsList
            className="h-auto w-full justify-start gap-0 rounded-none bg-transparent p-0"
            style={{ padding: '0 22px', background: 'var(--axon-bg2)', borderBottom: '1px solid var(--axon-border)' }}
          >
            {STATUS_TABS.map(tab => {
              const isActive = activeStatus === tab
              const alertColor = TAB_ALERT_COLOR[tab]
              const hasAlert = !!alertColor && counts[tab] > 0
              const accent = isActive ? (alertColor ?? 'var(--axon-nexus2)') : hasAlert ? alertColor : undefined

              return (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="gap-1.5 rounded-none border-b-[3px] border-transparent bg-transparent px-3.5 py-2 shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  style={{ color: accent ?? 'var(--axon-t3)', borderBottomColor: isActive ? accent : 'transparent' }}
                >
                  {tab}
                  <Badge
                    variant="outline"
                    style={{
                      background: isActive ? 'var(--axon-nx-glow)' : hasAlert ? TAB_ALERT_BG[tab] : 'var(--axon-bg4)',
                      color: accent ?? 'var(--axon-t4)',
                      borderColor: 'transparent',
                    }}
                  >
                    {counts[tab]}
                  </Badge>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Table style={{ fontSize: 12 }}>
            <TableHeader>
              <TableRow style={{ background: 'var(--axon-bg2)', position: 'sticky', top: 0, zIndex: 1 }}>
                {['Job', 'Delivery', 'Pipeline', 'Status', 'Progress', 'Started', 'Duration', 'Trigger', 'By'].map(col => (
                  <TableHead key={col} style={{
                    padding: '9px 14px', fontSize: 11, fontWeight: 600,
                    color: 'var(--axon-t3)', borderBottom: '1px solid var(--axon-border)',
                    whiteSpace: 'nowrap',
                  }}>{col}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={9} style={{ padding: '40px 14px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--axon-red)', fontSize: 12, marginBottom: 4 }}>Failed to load deliveries</div>
                    <div style={{ color: 'var(--axon-t4)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                      {error instanceof Error ? error.message : String(error)}
                    </div>
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} style={{ padding: '40px 14px', textAlign: 'center', color: 'var(--axon-t3)', fontSize: 12 }}>
                    No deliveries found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(d => {
                  const isSelected = selectedDeliveryId === d.id
                  // Debug: check if status colors are found
                  if (!STATUS_COLOR[d.status]) {
                    console.warn(`Status "${d.status}" not found in STATUS_COLOR. Available keys:`, Object.keys(STATUS_COLOR))
                  }
                  return (
                    <TableRow
                      key={d.id}
                      onClick={() => handleRowClick(d.id)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(111,95,232,0.07)' : 'transparent',
                        borderBottom: '1px solid var(--axon-border)',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--axon-bg2)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isSelected ? 'rgba(111,95,232,0.07)' : 'transparent' }}
                    >
                      {/* Job */}
                      <TableCell style={{ padding: '11px 14px', color: 'var(--axon-t2)', fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {d.localSeq ? `#${d.localSeq}` : '—'}
                      </TableCell>
                      {/* Delivery */}
                      <TableCell style={{ padding: '11px 14px' }}>
                        <JiraTicketLink ticket={d.ticketId} className="text-xs" />
                        {d.title && d.title !== d.ticketId && (
                          <div className="mt-0.5 max-w-[360px] whitespace-normal break-words text-xs leading-snug text-muted-foreground">{d.title}</div>
                        )}
                      </TableCell>
                      {/* Pipeline */}
                      <TableCell style={{ padding: '11px 14px', color: 'var(--axon-t2)', whiteSpace: 'nowrap' }}>
                        <span>{d.pipelineName}</span>
                        {d.pipelineVersion !== undefined && <Badge variant="secondary" className="ml-1.5 font-mono" title="Pipeline version this delivery ran">v{d.pipelineVersion}</Badge>}
                      </TableCell>
                      {/* Status */}
                      <TableCell style={{ padding: '11px 14px' }}>
                        <Badge
                          variant="outline"
                          className="gap-1.5"
                          style={{
                            color: STATUS_COLOR[d.status] || 'var(--axon-t3)',
                            background: STATUS_BG[d.status] || 'var(--axon-bg4)',
                            borderColor: `${STATUS_COLOR[d.status] || 'var(--axon-t3)'}33`,
                          }}
                        >
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%',
                            background: STATUS_COLOR[d.status] || 'var(--axon-t3)',
                            flexShrink: 0
                          }} />
                          {d.status}
                        </Badge>
                      </TableCell>
                      {/* Progress */}
                      <TableCell style={{ padding: '11px 14px', minWidth: 110 }}>
                        {d.status === 'Superseded' ? (
                          <span className="text-xs text-muted-foreground" title="A newer attempt replaced this one, so its partial progress no longer matters">Replaced</span>
                        ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--axon-bg4)', overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: 2,
                              width: `${d.progress}%`,
                              background: PROGRESS_COLOR[d.status] || 'var(--axon-t3)',
                              transition: 'width 0.3s',
                            }} />
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--axon-t3)', minWidth: 28, textAlign: 'right' }}>{d.progress}%</span>
                        </div>
                        )}
                      </TableCell>
                      {/* Started */}
                      <TableCell style={{ padding: '11px 14px', color: 'var(--axon-t2)', whiteSpace: 'nowrap', fontSize: 11 }}>{fmtStarted(d.startedAt)}</TableCell>
                      {/* Duration */}
                      <TableCell style={{ padding: '11px 14px', color: 'var(--axon-t2)', whiteSpace: 'nowrap', fontSize: 11 }}>{d.duration ?? '—'}</TableCell>
                      {/* Trigger: manual, or the automation rule that started it */}
                      <TableCell style={{ padding: '11px 14px' }}>
                        {d.trigger === 'Watcher' ? (
                          <button
                            type="button"
                            title="Show every delivery started by this rule"
                            onClick={(e) => { e.stopPropagation(); if (d.ruleId) setParams({ rule: d.ruleId }) }}
                            className="flex max-w-[190px] cursor-pointer flex-col items-start gap-0.5 text-left"
                          >
                            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">Automation</Badge>
                            <span className="w-full truncate text-xs text-muted-foreground">{ruleList.find((r) => r.id === d.ruleId)?.name ?? 'rule removed'}</span>
                          </button>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">Manual</Badge>
                        )}
                      </TableCell>
                      {/* Triggered by */}
                      <TableCell style={{ padding: '11px 14px' }}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex size-7 cursor-default items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[10px] font-bold text-primary">
                              {initials(d.createdByName)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {d.createdByName ?? 'Unknown'}{d.trigger === 'Watcher' ? ' · started by an automation rule' : ' · started manually'}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        <div style={{
          padding: '10px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--axon-bg2)', borderTop: '1px solid var(--axon-border)', flexShrink: 0,
        }}>
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Showing {total === 0 ? 0 : showFrom}–{showTo} of {total} deliveries</span>
            <Select value={String(rowsPerPage)} onValueChange={(v) => { setRowsPerPage(Number(v)); setPage(1) }}>
              <SelectTrigger size="sm" className="w-[110px]" aria-label="Rows per page"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" side="top">
                {[10, 20, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n} per page</SelectItem>)}
              </SelectContent>
            </Select>
          </span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <PageBtn label="←" disabled={page === 1} onClick={() => setPage(p => p - 1)} />
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
              <PageBtn key={p} label={String(p)} active={page === p} onClick={() => setPage(p)} />
            ))}
            {totalPages > 5 && <span style={{ color: 'var(--axon-t4)', fontSize: 11, padding: '0 2px' }}>…</span>}
            {totalPages > 5 && <PageBtn label={String(totalPages)} active={page === totalPages} onClick={() => setPage(totalPages)} />}
            <PageBtn label="→" disabled={page === totalPages} onClick={() => setPage(p => p + 1)} />
          </div>
        </div>
      </div>

      {/* ── Slide-out panel ── */}
      {selectedDeliveryId && (
        <DeliveryPanel
          deliveryId={selectedDeliveryId}
          onClose={() => setSelectedDeliveryId(null)}
        />
      )}

      <NewDeliveryModal
        isOpen={modal.isOpen}
        onClose={modal.close}
        defaultPipelineId={modal.defaultPipelineId}
      />
    </div>
  )
}

function PageBtn({ label, onClick, disabled, active }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      variant="outline"
      size="icon-sm"
      className="min-w-7"
      style={{
        borderColor: active ? 'var(--axon-nexus2)' : 'var(--axon-border2)',
        background: active ? 'var(--axon-nx-glow)' : 'transparent',
        color: active ? 'var(--axon-nexus2)' : undefined,
      }}
    >
      {label}
    </Button>
  )
}
