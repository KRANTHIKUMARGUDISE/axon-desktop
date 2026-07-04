import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Category identity colors — panel borders only. Never on values/counts/names. */
export const CATEGORY_COLORS = {
  requirementsQuality: '#7EB8F7',
  reworkRate: '#F7C07E',
  deliveries: '#7EF7C0',
  blockPipelineQuality: '#B99EF5',
  axonReliability: '#F2A33D',
} as const

/** Neutral trend color — used for every trend line/indicator. No green-up/red-down. */
export const NEUTRAL_TREND = '#8B97A3'

export function truncateText(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/** 2px left border in the accent color — the only place a panel carries identity color. */
function accentStyle(accentColor?: string) {
  return accentColor
    ? { className: 'border-l-2', style: { borderLeftColor: accentColor } }
    : { className: undefined, style: undefined }
}

export function StatCard({
  label,
  value,
  sub,
  accentColor,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  accentColor?: string
}) {
  const accent = accentStyle(accentColor)
  return (
    <Card size="sm" className={accent.className} style={accent.style}>
      <CardHeader>
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="font-mono text-2xl font-semibold text-foreground">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}

/** One named panel grouping several related metrics — used where the spec calls out a
 * single titled "Panel" containing multiple stats (as opposed to several independent
 * StatCards side by side). */
export function MetricPanel({
  title,
  accentColor,
  metrics,
  children,
}: {
  title: string
  accentColor: string
  metrics: { label: string; value: ReactNode }[]
  children?: ReactNode
}) {
  return (
    <Card size="sm" className="border-l-2" style={{ borderLeftColor: accentColor }}>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          {metrics.map(m => (
            <div key={m.label}>
              <div className="text-xs text-muted-foreground">{m.label}</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{m.value}</div>
            </div>
          ))}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

export function ReasonList({
  title,
  items,
  accentColor,
  subLabel,
}: {
  title: string
  items: { label: string; count: number }[]
  accentColor?: string
  subLabel?: string
}) {
  const accent = accentStyle(accentColor)
  return (
    <Card size="sm" className={accent.className} style={accent.style}>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex max-w-md flex-col gap-2">
          {items.map(item => (
            <li key={item.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-foreground">{item.label}</span>
              <Badge variant="outline" className="shrink-0 font-mono">
                {item.count}
              </Badge>
            </li>
          ))}
        </ul>
        {subLabel && <p className="mt-2 text-xs text-muted-foreground">{subLabel}</p>}
      </CardContent>
    </Card>
  )
}

const PIPELINE_REJECT_RATES = [
  { pipeline: 'Standard Delivery', rejectRate: '12%' },
  { pipeline: 'Fast Track', rejectRate: '28%' },
  { pipeline: 'Review Heavy', rejectRate: '9%' },
]

/** Shared by Rework Rate (team) and Block & Pipeline Quality (team) — identical shape,
 * just a different accent color per tab. */
export function HumanGateRejectByPipeline({ accentColor }: { accentColor: string }) {
  return (
    <Card size="sm" className="border-l-2" style={{ borderLeftColor: accentColor }}>
      <CardHeader>
        <CardTitle className="text-sm">HumanGate reject rate by pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex max-w-md flex-col gap-2">
          {PIPELINE_REJECT_RATES.map(row => (
            <li key={row.pipeline} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-foreground">{row.pipeline}</span>
              <span className="font-mono text-xs text-muted-foreground">{row.rejectRate}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          High reject rate signals pipeline composition issues — not individual engineer performance
        </p>
      </CardContent>
    </Card>
  )
}

export function SectionGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-4 gap-3">{children}</div>
}

// ── Pipeline / Block filters — shared between Deliveries and Block &
// Pipeline Quality tab content (moved out of the global filter bar). ──────────

export const PIPELINE_OPTIONS = ['Standard Delivery', 'Fast Track', 'Review Heavy', 'Custom Sprint']
export const BLOCK_OPTIONS = ['TicketFetcher', 'RRAAssessment', 'RCAAssessment', 'SDLCAgent', 'PRCreator']

// Sentinel values for the "reset to All" option — a Select item can't use an empty
// string, so these stand in for "no filter" selected.
export const ALL_PIPELINES_VALUE = '__all-pipelines__'
export const ALL_BLOCKS_VALUE = '__all-blocks__'

export function PipelineFilterSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_PIPELINES_VALUE}>All pipelines</SelectItem>
        {PIPELINE_OPTIONS.map(p => (
          <SelectItem key={p} value={p}>{p}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function BlockFilterSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_BLOCKS_VALUE}>All blocks</SelectItem>
        {BLOCK_OPTIONS.map(b => (
          <SelectItem key={b} value={b}>{b}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
