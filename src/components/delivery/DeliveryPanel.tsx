import { useState } from 'react'
import { ALL_STATUS_KEYS, statusBgMap, statusColorMap } from '../../utils/statusColors'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { FolderOpen, Code2, Copy, X } from 'lucide-react'
import { useDelivery } from '@/hooks/useDeliveries'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DeliveryStep } from '@/types'

interface Props {
  deliveryId: string
  onClose: () => void
}

function fmt(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDuration(startedAt?: string, completedAt?: string) {
  if (!startedAt) return '—'
  const end = completedAt ? new Date(completedAt) : new Date()
  const secs = Math.floor((end.getTime() - new Date(startedAt).getTime()) / 1000)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function StepRow({ step, index }: { step: DeliveryStep; index: number }) {
  const iconStyle: React.CSSProperties = {
    width: 18, height: 18, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10, fontWeight: 700, flexShrink: 0,
  }

  let icon: React.ReactNode
  let statusLabel: React.ReactNode

  if (step.status === 'Completed') {
    icon = <div style={{ ...iconStyle, background: 'var(--axon-green-d)', color: 'var(--axon-green)', border: '1px solid rgba(16,185,129,0.3)' }}>✓</div>
    statusLabel = <span style={{ fontSize: 11, color: 'var(--axon-green)' }}>✓ Done</span>
  } else if (step.status === 'Running') {
    icon = (
      <div style={{ ...iconStyle, background: 'var(--axon-nx-glow)', border: '1px solid rgba(111,95,232,0.3)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--axon-nexus2)', display: 'block', animation: 'pulse 1.5s infinite' }} />
      </div>
    )
    statusLabel = <span style={{ fontSize: 11, color: 'var(--axon-nexus2)' }}>Running</span>
  } else if (step.status === 'Failed') {
    icon = <div style={{ ...iconStyle, background: 'var(--axon-red-d)', color: 'var(--axon-red)', border: '1px solid rgba(239,68,68,0.3)' }}>✕</div>
    statusLabel = <span style={{ fontSize: 11, color: 'var(--axon-red)' }}>Failed</span>
  } else if (step.status === 'Cancelled' || step.status === 'Interrupted') {
    icon = <div style={{ ...iconStyle, background: 'var(--axon-bg4)', color: 'var(--axon-t2)', border: '1px solid var(--axon-border2)' }}>{step.status === 'Cancelled' ? '■' : '⏸'}</div>
    statusLabel = <span style={{ fontSize: 11, color: 'var(--axon-t2)' }}>{step.status}</span>
  } else if (step.status === 'AwaitingApproval') {
    icon = <div style={{ ...iconStyle, background: 'var(--axon-amber-d)', color: 'var(--axon-amber)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 11 }}>🚦</div>
    statusLabel = <span style={{ fontSize: 11, color: 'var(--axon-amber)' }}>Awaiting approval</span>
  } else {
    icon = <div style={{ ...iconStyle, background: 'var(--axon-bg4)', color: 'var(--axon-t3)', border: '1px solid var(--axon-border2)' }}>{index + 1}</div>
    statusLabel = <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>Pending</span>
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
      {icon}
      <span style={{ flex: 1, fontSize: 12, color: 'var(--axon-t1)', fontWeight: 500 }}>{step.name}</span>
      {statusLabel}
    </div>
  )
}

const STATUS_COLORS: Record<string, string> = statusColorMap(ALL_STATUS_KEYS)

const STATUS_BG: Record<string, string> = statusBgMap(ALL_STATUS_KEYS)


export default function DeliveryPanel({ deliveryId, onClose }: Props) {
  const navigate = useNavigate()
  const { data: delivery, isLoading } = useDelivery(deliveryId)
  const [tab, setTab] = useState<'overview' | 'timeline' | 'logs'>('overview')

  const tabs = ['overview', 'timeline', 'logs'] as const

  const handleOpenWorkspace = async () => {
    if (!delivery?.workspacePath) return
    const res = await window.axon.shell.openPath(delivery.workspacePath)
    if (!res.success) toast.error(res.error ? `Failed to open folder: ${res.error}` : 'Failed to open folder')
  }

  const handleOpenInVSCode = async () => {
    if (!delivery?.workspacePath) return
    const res = await window.axon.shell.openInVSCode(delivery.workspacePath)
    if (!res.success) toast.error(res.error ? `Failed to open VS Code: ${res.error}` : 'Failed to open VS Code')
  }

  const handleCopyRepoLink = async () => {
    if (!delivery?.repoUrl) return
    await navigator.clipboard.writeText(delivery.repoUrl)
    toast.success('Repo link copied')
  }

  return (
    <div style={{
      width: 340, flexShrink: 0,
      background: 'var(--axon-bg2)',
      borderLeft: '1px solid var(--axon-border)',
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
    }}>
      {isLoading || !delivery ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--axon-t3)' }}>Loading…</span>
        </div>
      ) : (
        <>
          {/* Header */}
          <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--axon-border)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--axon-t1)', fontFamily: 'var(--font-mono)' }}>
                    {delivery.ticketId}
                  </span>
                  <Badge
                    variant="outline"
                    style={{
                      color: STATUS_COLORS[delivery.status], background: STATUS_BG[delivery.status],
                      borderColor: `${STATUS_COLORS[delivery.status]}33`,
                    }}
                  >
                    {delivery.status}
                  </Badge>
                </div>
                <div style={{ fontSize: 11, color: 'var(--axon-t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {delivery.title} · {delivery.pipelineName}
                </div>
              </div>
              <Button onClick={onClose} variant="outline" size="icon-sm" className="shrink-0">
                <X className="size-3.5" />
              </Button>
            </div>
          </div>

          {/* Progress section */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--axon-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t2)' }}>
                Progress — {(delivery.steps ?? []).filter(s => s.status === 'Completed').length} of {(delivery.steps ?? []).length} stages
              </span>
              <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>{delivery.progress}%</span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--axon-bg4)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 3,
                width: `${delivery.progress}%`,
                background: delivery.status === 'Completed' ? 'var(--axon-green)'
                  : delivery.status === 'Failed' ? 'var(--axon-red)'
                  : 'var(--axon-nexus2)',
                transition: 'width 0.3s',
              }} />
            </div>
          </div>

          {/* Current stage card */}
          {(() => {
            const current = (delivery.steps ?? []).find(s => s.status === 'Running' || s.status === 'AwaitingApproval')
            if (!current) return null
            return (
              <div style={{ margin: '10px 16px', padding: '10px 12px', background: 'var(--axon-bg3)', borderRadius: 8, border: '1px solid var(--axon-border2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 22, height: 22, borderRadius: 4, background: 'var(--axon-nx-glow)', border: '1px solid rgba(111,95,232,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--axon-nexus2)', fontWeight: 700 }}>E</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--axon-t1)' }}>{current.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--axon-t3)', marginTop: 1 }}>
                      {current.status === 'AwaitingApproval' ? 'Awaiting approval' : `Running for ${fmtDuration(current.startedAt)}`}
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Tabs */}
          <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
            <TabsList
              className="h-auto w-full justify-start gap-0 rounded-none bg-transparent p-0"
              style={{ padding: '0 16px', borderBottom: '1px solid var(--axon-border)' }}
            >
              {tabs.map(t => (
                <TabsTrigger
                  key={t}
                  value={t}
                  className="rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 capitalize shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  style={{ color: tab === t ? 'var(--axon-nexus2)' : 'var(--axon-t3)', borderBottomColor: tab === t ? 'var(--axon-nexus2)' : 'transparent' }}
                >
                  {t}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
            {tab !== 'overview' ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--axon-t3)', fontSize: 12 }}>Coming soon</div>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-t3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pipeline Flow</div>
                <div style={{ borderRadius: 8, overflow: 'hidden' }}>
                  {(delivery.steps ?? []).map((step, i) => (
                    <div key={step.id} style={{ borderBottom: i < (delivery.steps ?? []).length - 1 ? '1px solid var(--axon-border)' : 'none' }}>
                      <StepRow step={step} index={i} />
                    </div>
                  ))}
                </div>

                <div style={{ borderTop: '1px solid var(--axon-border)', marginTop: 12, paddingTop: 12 }}>
                  {[
                    ['Started', fmt(delivery.startedAt)],
                    ['Triggered by', delivery.createdByName ?? '—'],
                    ['Pipeline Team', delivery.ownerTeam ?? '—'],
                    ['Repo', delivery.repoUrl ?? '—'],
                    ['Repository', delivery.repository?.split('/').pop() ?? '—'],
                    ['Branch', delivery.branch ?? (delivery.ticketId ? `feat/${delivery.ticketId.toLowerCase()}` : '—')],
                    ['Workspace', delivery.workspacePath ?? delivery.workspaceType ?? '—'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                      <span style={{ fontSize: 11, color: 'var(--axon-t3)' }}>{label}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{
                          fontSize: 11, fontWeight: 500, color: 'var(--axon-t2)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={typeof value === 'string' ? value : undefined}>
                          {value}
                        </span>
                        {label === 'Repo' && delivery.repoUrl && (
                          <Button
                            onClick={handleCopyRepoLink}
                            title="Copy repository link"
                            variant="outline"
                            size="icon-xs"
                            className="dark:bg-[var(--axon-bg3)]"
                          >
                            <Copy className="size-3" />
                          </Button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>

                {delivery.workspacePath && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    <Button
                      onClick={handleOpenWorkspace}
                      title="Open workspace folder in Explorer"
                      variant="outline"
                      size="sm"
                      className="flex-1 dark:bg-[var(--axon-bg3)]"
                    >
                      <FolderOpen className="size-3" /> Explorer
                    </Button>
                    <Button
                      onClick={handleOpenInVSCode}
                      title="Open workspace folder in VS Code"
                      variant="outline"
                      size="sm"
                      className="flex-1 dark:bg-[var(--axon-bg3)]"
                    >
                      <Code2 className="size-3" /> VS Code
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--axon-border)' }}>
            <Button
              onClick={() => navigate(`/deliveries/${deliveryId}`)}
              variant="outline"
              className="w-full dark:bg-[var(--axon-bg3)]"
            >
              View Full Delivery →
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
