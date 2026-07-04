import { GitPullRequestDraft } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  MetricPanel,
  ReasonList,
  CATEGORY_COLORS,
  HumanGateRejectByPipeline,
  truncateText,
} from './shared'

const ACCENT = CATEGORY_COLORS.reworkRate

// Static illustrative data — no data wiring in this pass.
const MY_GATE_METRICS = [
  { label: 'Gate approve rate', value: '83%' },
  { label: 'Gate reject rate', value: '17%' },
  { label: 'Avg review latency', value: '1.4h' },
]

const TEAM_GATE_METRICS = [
  { label: 'Gate reject rate', value: '19%' },
  { label: 'Avg review latency', value: '2.1h' },
  { label: 'Reject-then-manual-PR proxy', value: '4 this period' },
]

const MY_REJECT_COMMENTS = [
  'Confidence was borderline on the schema migration step — wanted a second pair of eyes before merging.',
  "Generated tests didn't cover the retry/backoff path, so I sent it back for another pass on edge cases.",
]

const TEAM_TOP_REJECT_REASONS = [
  { label: 'Confidence below threshold', count: 21 },
  { label: 'Incomplete context', count: 14 },
  { label: 'Needs manual review', count: 9 },
]

function PostPrReworkPanel() {
  return (
    <Card size="sm" className="opacity-60">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <GitPullRequestDraft className="size-4 text-muted-foreground" />
          Post-PR rework
          <Badge variant="outline" className="ml-auto">Coming soon</Badge>
        </CardTitle>
        <CardDescription>Coming soon — requires GitHub integration</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-16 rounded-lg border border-dashed border-border" />
      </CardContent>
    </Card>
  )
}

export function ReworkRatePanel({ level }: { level: 'my' | 'team' }) {
  return (
    <div className="flex flex-col gap-3">
      {level === 'my' ? (
        <>
          <MetricPanel title="My gate reviews" accentColor={ACCENT} metrics={MY_GATE_METRICS} />

          <Card size="sm" className="border-l-2" style={{ borderLeftColor: ACCENT }}>
            <CardHeader>
              <CardTitle className="text-sm">My reject reasons</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex max-w-md flex-col gap-2">
                {MY_REJECT_COMMENTS.map(comment => (
                  <li key={comment} className="text-sm text-foreground">
                    {truncateText(comment, 80)}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <PostPrReworkPanel />
        </>
      ) : (
        <>
          <MetricPanel title="Gate review — team" accentColor={ACCENT} metrics={TEAM_GATE_METRICS} />

          <ReasonList
            title="Top reject reasons"
            items={TEAM_TOP_REJECT_REASONS}
            accentColor={ACCENT}
            subLabel="Aggregated · anonymized · no per-engineer breakdown"
          />

          <HumanGateRejectByPipeline accentColor={ACCENT} />

          <PostPrReworkPanel />
        </>
      )}
    </div>
  )
}
