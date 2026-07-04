import { Activity } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { CATEGORY_COLORS } from './shared'

// Static illustrative value — no data wiring in this pass.
const UNEXPECTED_FAILURES_30D = 4

/**
 * Persistent panel shown at the bottom of the Intelligence page in both
 * My View and Team View — platform-level signal, not scoped to a person or team.
 * Rendered as a sibling after the category Tabs block (not inside TabsContent),
 * so it stays visible regardless of tab-content scroll height.
 */
export function ReliabilityPanel() {
  return (
    <Card size="sm" className="border-l-2" style={{ borderLeftColor: CATEGORY_COLORS.axonReliability }}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Activity className="size-4 text-muted-foreground" />
          AXON Reliability
        </CardTitle>
        <CardDescription>Platform health — reported via rerun reason</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold text-foreground">
            {UNEXPECTED_FAILURES_30D}
          </span>
          <span className="text-sm text-muted-foreground">unexpected failures (last 30d)</span>
        </div>
      </CardContent>
    </Card>
  )
}
