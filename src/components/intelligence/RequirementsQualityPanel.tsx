import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatCard, ReasonList, SectionGrid, CATEGORY_COLORS } from './shared'

const ACCENT = CATEGORY_COLORS.requirementsQuality

// Static illustrative data — no data wiring in this pass.
const MY_STATS = {
  rraPassRate: '86%',
  rcaPassRate: '91%',
  firstPassYield: '74%',
  resubmitCount30d: 2,
}

const TEAM_STATS = {
  rraPassRate: '84%',
  rcaPassRate: '76%',
  firstPassYield: '71%',
  totalResubmits30d: 11,
}

const MY_TOP_FAILING_REASONS = [
  { label: 'Missing acceptance criteria', count: 12 },
  { label: 'Ambiguous scope', count: 9 },
  { label: 'Unclear API contract', count: 6 },
  { label: 'Missing edge-case coverage', count: 4 },
]

const TEAM_TOP_FAILING_RRA = [
  { label: 'Missing acceptance criteria', count: 14 },
  { label: 'Ambiguous scope', count: 10 },
  { label: 'Unclear API contract', count: 7 },
]

const TEAM_TOP_REJECTION_RCA = [
  { label: 'Missing rollback plan', count: 9 },
  { label: 'Incomplete risk assessment', count: 6 },
  { label: 'Untested edge cases', count: 5 },
]

const WEEKLY_TREND = [
  { week: 'W1', rra: 72, rca: 80 },
  { week: 'W2', rra: 75, rca: 82 },
  { week: 'W3', rra: 79, rca: 85 },
  { week: 'W4', rra: 77, rca: 84 },
  { week: 'W5', rra: 81, rca: 87 },
  { week: 'W6', rra: 81, rca: 88 },
]

export function RequirementsQualityPanel({ level }: { level: 'my' | 'team' }) {
  return (
    <div className="flex flex-col gap-3">
      {level === 'my' ? (
        <>
          <SectionGrid>
            <StatCard label="Your RRA pass rate" value={MY_STATS.rraPassRate} accentColor={ACCENT} />
            <StatCard label="Your RCA pass rate" value={MY_STATS.rcaPassRate} accentColor={ACCENT} />
            <StatCard label="First-pass yield" value={MY_STATS.firstPassYield} accentColor={ACCENT} />
            <StatCard label="Resubmit count (30d)" value={MY_STATS.resubmitCount30d} accentColor={ACCENT} />
          </SectionGrid>

          <ReasonList title="Top failing reasons" items={MY_TOP_FAILING_REASONS} accentColor={ACCENT} />
        </>
      ) : (
        <>
          <Card size="sm" className="border-l-2" style={{ borderLeftColor: ACCENT }}>
            <CardHeader>
              <CardTitle className="text-sm">Team requirement quality</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground">RRA pass rate</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-foreground">{TEAM_STATS.rraPassRate}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">RCA pass rate</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-foreground">{TEAM_STATS.rcaPassRate}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">First-pass yield</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-foreground">{TEAM_STATS.firstPassYield}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Total resubmits (30d)</div>
                  <div className="mt-1 font-mono text-xl font-semibold text-foreground">{TEAM_STATS.totalResubmits30d}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <ReasonList title="Top failing checks — RRA" items={TEAM_TOP_FAILING_RRA} accentColor={ACCENT} />
          <ReasonList
            title="Top rejection reasons — RCA"
            items={TEAM_TOP_REJECTION_RCA}
            accentColor={ACCENT}
            subLabel="Aggregated · anonymized · no per-engineer breakdown"
          />

          <Card size="sm" className="border-l-2" style={{ borderLeftColor: ACCENT }}>
            <CardHeader>
              <CardTitle className="text-sm">Week-over-week trend</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-2 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full" style={{ background: 'var(--chart-1)' }} />
                  RRA pass rate
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full" style={{ background: 'var(--chart-2)' }} />
                  RCA pass rate
                </span>
              </div>
              <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={WEEKLY_TREND} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rraFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="rcaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="week" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} unit="%" width={44} />
                  <Tooltip
                    contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--foreground)' }}
                  />
                  <Area type="monotone" dataKey="rra" name="RRA pass rate" stroke="var(--chart-1)" fill="url(#rraFill)" strokeWidth={2} />
                  <Area type="monotone" dataKey="rca" name="RCA pass rate" stroke="var(--chart-2)" fill="url(#rcaFill)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
