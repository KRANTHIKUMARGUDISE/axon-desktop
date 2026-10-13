import type { Delivery } from './schemas'
import type { RunSummary, DeliveryRule } from './registry'

// S5 Part C: the autonomy metric and the "could the watcher have run this?" check.

type Autonomous = Pick<Delivery, 'status'> & { interventions?: unknown[] | number }
const count = (v: Autonomous['interventions']): number => (typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0)

/** % of completed deliveries with zero interventions (null when nothing completed yet). */
export function autonomyRate(items: Autonomous[]): { percent: number | null; completed: number; autonomous: number } {
  const done = items.filter((d) => d.status === 'Completed')
  const autonomous = done.filter((d) => count(d.interventions) === 0).length
  return { percent: done.length ? Math.round((autonomous / done.length) * 100) : null, completed: done.length, autonomous }
}

export const autonomyFromSummaries = (runs: Pick<RunSummary, 'status' | 'interventions'>[]) => autonomyRate(runs)

/** Ticket key prefix (`ABC` of `ABC-12`). */
export const projectKeyOf = (ticketId: string): string => ticketId.split('-')[0]?.toUpperCase() ?? ''

/** A manual start counts as an intervention when an enabled rule for this project + pipeline could have run it. */
export function watcherEligible(rules: Pick<DeliveryRule, 'enabled' | 'jiraProjectKey' | 'pipelineId'>[], ticketId: string, pipelineId: string): boolean {
  const key = projectKeyOf(ticketId)
  return rules.some((r) => r.enabled && r.jiraProjectKey.toUpperCase() === key && r.pipelineId === pipelineId)
}
