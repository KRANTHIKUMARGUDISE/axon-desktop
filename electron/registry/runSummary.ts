import { RunSummarySchema, RUN_TEXT_CAP, SCHEMA_VERSION } from '../../shared'
import type { Delivery, RunSummary, DeliveryStep } from '../../shared'

// Run summaries are the only per-run data that reaches the registry. Fields are copied one by one
// from an explicit whitelist — never spread `output`, `contextSnapshot` or step summaries (they can
// hold customer code, secrets and model/Jira-derived free text). RunSummarySchema is `.strict()`, so a
// stray key is a parse error rather than a leak.

const cap = (s: string | undefined, n = RUN_TEXT_CAP): string | undefined =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s
const ms = (a?: string, b?: string) => {
  if (!a || !b) return undefined
  const d = Date.parse(b) - Date.parse(a)
  return Number.isFinite(d) && d >= 0 ? d : undefined
}

function stepSummary(s: DeliveryStep): RunSummary['steps'][number] {
  const usage = s.output?.usage
  return {
    nodeId: s.nodeId,
    blockId: s.blockId,
    blockName: cap(s.blockName) ?? '',
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    durationMs: ms(s.startedAt, s.completedAt),
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    costUsd: usage?.costUsd,
  }
}

export function toRunSummary(delivery: Delivery, owner: string): RunSummary {
  const gates: RunSummary['gates'] = []
  for (const s of delivery.steps) {
    const o = s.output
    if (o?.approvedBy && o.approvedAt) {
      gates.push({ nodeId: s.nodeId, blockName: cap(s.blockName) ?? '', outcome: 'approved', by: cap(o.approvedBy) ?? '', at: o.approvedAt })
    } else if (o?.rejectedBy && o.rejectedAt) {
      gates.push({ nodeId: s.nodeId, blockName: cap(s.blockName) ?? '', outcome: 'rejected', by: cap(o.rejectedBy) ?? '', at: o.rejectedAt })
    }
  }
  const sum = (key: 'inputTokens' | 'outputTokens' | 'costUsd') => {
    const vals = delivery.steps.map((s) => s.output?.usage?.[key]).filter((v): v is number => typeof v === 'number')
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined
  }
  return RunSummarySchema.parse({
    id: delivery.id,
    schemaVersion: SCHEMA_VERSION,
    scope: 'Personal',
    owner,
    ticketId: cap(delivery.ticketId) ?? '',
    status: delivery.status,
    startedAt: delivery.startedAt,
    completedAt: delivery.completedAt,
    durationMs: ms(delivery.startedAt, delivery.completedAt),
    pipelineId: delivery.pipelineId,
    pipelineVersion: delivery.pipelineVersion,
    blockVersions: { ...delivery.pipelineSnapshot.blockVersions },
    rerunOf: delivery.retriedFromDeliveryId ?? undefined,
    rerunReason: cap(delivery.rerunReason, RUN_TEXT_CAP * 2),
    gates,
    steps: delivery.steps.map(stepSummary),
    prUrls: delivery.prUrl ? [cap(delivery.prUrl, 500) as string] : [],
    repoUrls: delivery.repoUrl ? [cap(delivery.repoUrl, 500) as string] : [],
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: sum('costUsd'),
  })
}

/** yyyy-mm bucket for the registry path of a run. */
export const runMonth = (iso: string) => iso.slice(0, 7)
