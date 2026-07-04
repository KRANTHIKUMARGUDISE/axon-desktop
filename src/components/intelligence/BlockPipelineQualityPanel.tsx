import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  StatCard,
  CATEGORY_COLORS,
  HumanGateRejectByPipeline,
  PipelineFilterSelect,
  BlockFilterSelect,
} from './shared'

const ACCENT = CATEGORY_COLORS.blockPipelineQuality

// Static illustrative data — no data wiring in this pass.
const MY_BLOCKS = [
  { name: 'TicketFetcher', confidenceTrend: '78% → 84%', reuseCount: 23 },
  { name: 'ReleaseNotesWriter', confidenceTrend: '65% → 71%', reuseCount: 9 },
  { name: 'CodeReviewSummary', confidenceTrend: '82% → 80%', reuseCount: 31 },
]

const MY_TOOLS_DENIED_RATE = '4%'

const BLOCK_QUALITY_ROWS = [
  { name: 'TicketFetcher', confidence: '84%', toolsDenied: '0%' },
  { name: 'ReleaseNotes', confidence: '71%', toolsDenied: '3%' },
  { name: 'CodeReviewSummary', confidence: '86%', toolsDenied: '8%' },
  { name: 'RRAAssessment', confidence: '88%', toolsDenied: '1%' },
  { name: 'PRCreator', confidence: '92%', toolsDenied: '0%' },
]

const DEAD_BLOCKS = [
  { name: 'LegacyChangelogGen', idleDays: 54 },
  { name: 'DraftPRTitleSuggester', idleDays: 41 },
]

const PIPELINE_VERSION_DRIFT = {
  outOfDate: 3,
  total: 11,
}

interface BlockPipelineQualityPanelProps {
  level: 'my' | 'team'
  pipeline: string
  onPipelineChange: (value: string) => void
  block: string
  onBlockChange: (value: string) => void
}

export function BlockPipelineQualityPanel({
  level,
  pipeline,
  onPipelineChange,
  block,
  onBlockChange,
}: BlockPipelineQualityPanelProps) {
  if (level === 'my') {
    return (
      <div className="flex flex-col gap-3">
        <StatCard label="ToolsDenied rate" value={MY_TOOLS_DENIED_RATE} accentColor={ACCENT} />

        <Card size="sm" className="border-l-2" style={{ borderLeftColor: ACCENT }}>
          <CardHeader>
            <CardTitle className="text-sm">Blocks authored by me</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex max-w-lg flex-col gap-2">
              {MY_BLOCKS.map(block => (
                <li key={block.name} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-sm">
                  <span className="text-foreground">{block.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{block.confidenceTrend}</span>
                  <Badge variant="outline" className="shrink-0 font-mono">
                    {block.reuseCount}× reused
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <PipelineFilterSelect value={pipeline} onChange={onPipelineChange} />
          <BlockFilterSelect value={block} onChange={onBlockChange} />
        </div>
        <p className="text-xs text-muted-foreground">
          Showing execution quality across all blocks this team has run — including shared and Axon-native blocks
        </p>
      </div>

      <StatCard
        label="Pipeline version drift"
        value={`${PIPELINE_VERSION_DRIFT.outOfDate} / ${PIPELINE_VERSION_DRIFT.total}`}
        sub="pipelines running an outdated version"
        accentColor={ACCENT}
      />

      <Card size="sm" className="border-l-2" style={{ borderLeftColor: ACCENT }}>
        <CardHeader>
          <CardTitle className="text-sm">Block quality</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full max-w-lg border-collapse text-sm">
            <thead>
              <tr>
                <th className="pb-1.5 text-left text-xs font-normal text-muted-foreground">Block</th>
                <th className="pb-1.5 text-right text-xs font-normal text-muted-foreground">Confidence</th>
                <th
                  className="pb-1.5 text-right text-xs font-normal text-muted-foreground"
                  title="Agent attempted tools outside its declared scope"
                >
                  Tools denied
                </th>
              </tr>
            </thead>
            <tbody>
              {BLOCK_QUALITY_ROWS.map(row => (
                <tr key={row.name} className="border-t border-border">
                  <td className="py-1.5 text-foreground">{row.name}</td>
                  <td className="py-1.5 text-right font-mono text-xs text-muted-foreground">{row.confidence}</td>
                  <td className="py-1.5 text-right font-mono text-xs text-muted-foreground">{row.toolsDenied}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            Tools denied: agent attempted tools outside its declared scope
          </p>
        </CardContent>
      </Card>

      <HumanGateRejectByPipeline accentColor={ACCENT} />

      <Card size="sm" className="border-l-2" style={{ borderLeftColor: ACCENT }}>
        <CardHeader>
          <CardTitle className="text-sm">Dead blocks</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex max-w-md flex-col gap-2">
            {DEAD_BLOCKS.map(block => (
              <li key={block.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground">{block.name}</span>
                <Badge variant="outline" className="shrink-0">
                  runCount 0 · idle {block.idleDays}d
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Created but never used — coaching signal for block authors
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
