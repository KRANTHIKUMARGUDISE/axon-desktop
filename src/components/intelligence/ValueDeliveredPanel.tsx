import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { MetricPanel, CATEGORY_COLORS, NEUTRAL_TREND, PipelineFilterSelect } from './shared'

const ACCENT = CATEGORY_COLORS.deliveries

// Static illustrative data — no data wiring in this pass.
const MY_METRICS = [
  { label: 'Deliveries completed (30d)', value: 9 },
  { label: 'Avg cycle time', value: '1.1d' },
  { label: 'Agent utilisation', value: '68%' },
]

const TEAM_METRICS = [
  { label: 'Deliveries completed (30d)', value: 47 },
  { label: 'Avg cycle time', value: '1.6d' },
  { label: 'Agent utilisation', value: '61%' },
]

const MY_CYCLE_TIME_SPARKLINE = [
  { week: 'W1', days: 1.5 },
  { week: 'W2', days: 1.3 },
  { week: 'W3', days: 1.2 },
  { week: 'W4', days: 1.0 },
  { week: 'W5', days: 1.2 },
  { week: 'W6', days: 1.1 },
]

const THROUGHPUT_TREND = [
  { week: 'W1', deliveries: 11 },
  { week: 'W2', deliveries: 14 },
  { week: 'W3', deliveries: 12 },
  { week: 'W4', deliveries: 17 },
  { week: 'W5', deliveries: 15 },
  { week: 'W6', deliveries: 17 },
]

const CYCLE_TIME_TREND = [
  { week: 'W1', days: 3.4 },
  { week: 'W2', days: 3.1 },
  { week: 'W3', days: 3.2 },
  { week: 'W4', days: 2.8 },
  { week: 'W5', days: 3.0 },
  { week: 'W6', days: 2.9 },
]

interface ValueDeliveredPanelProps {
  level: 'my' | 'team'
  pipeline: string
  onPipelineChange: (value: string) => void
}

export function ValueDeliveredPanel({ level, pipeline, onPipelineChange }: ValueDeliveredPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      {level === 'my' ? (
        <MetricPanel title="My deliveries" accentColor={ACCENT} metrics={MY_METRICS}>
          <div className="h-20">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={MY_CYCLE_TIME_SPARKLINE} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <Line type="monotone" dataKey="days" stroke={NEUTRAL_TREND} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground">Cycle time — last 6 weeks</p>
        </MetricPanel>
      ) : (
        <>
          <PipelineFilterSelect value={pipeline} onChange={onPipelineChange} />

          <MetricPanel title="Team throughput" accentColor={ACCENT} metrics={TEAM_METRICS}>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={THROUGHPUT_TREND} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="week" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip
                    cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
                    contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--foreground)' }}
                  />
                  <Bar dataKey="deliveries" name="Deliveries completed" fill={ACCENT} fillOpacity={0.4} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={CYCLE_TIME_TREND} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="week" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} unit="d" width={40} />
                  <Tooltip
                    cursor={{ stroke: 'var(--border)' }}
                    contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: 'var(--foreground)' }}
                  />
                  <Line type="monotone" dataKey="days" name="Cycle time (days)" stroke={NEUTRAL_TREND} strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </MetricPanel>
        </>
      )}
    </div>
  )
}
