import type { JiraClient } from './client'
import { PROP_RUNS } from './client'

// S5b: the issue property `axon.runs` replaces the global axon-done / axon-failed labels. One record per rule, so a
// finished spec stage never blocks the coding stage (a different rule) on the same ticket.

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunRecord {
  deliveryId: string
  status: RunStatus
  at: string
  /** The Jira status the ticket was in when the run started. */
  statusAtStart: string
}
export type RunsProperty = Record<string, RunRecord>

export async function readRuns(client: JiraClient, key: string): Promise<RunsProperty> {
  const v = await client.getProperty<RunsProperty>(key, PROP_RUNS)
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export async function writeRun(client: JiraClient, key: string, ruleId: string, record: RunRecord): Promise<void> {
  await client.updateProperty<RunsProperty>(key, PROP_RUNS, (cur) => ({ ...(cur && typeof cur === 'object' ? cur : {}), [ruleId]: record }))
}

/**
 * Should a status-based rule skip this ticket? Only if this rule already ran for it and the ticket has not entered the ready
 * status again since (a ticket that left and came back is a new request). Label rules need no skip: the ready label is
 * consumed at the claim, so a label on the ticket always means "run" (re-labelling = Rerun).
 */
export async function alreadyRanFromThisState(
  client: JiraClient, key: string, ruleId: string, readyStatus: string, runs?: RunsProperty,
): Promise<boolean> {
  const record = (runs ?? (await readRuns(client, key)))[ruleId]
  if (!record) return false
  if (record.statusAtStart !== readyStatus) return false
  const entered = await client.statusEnteredAt(key, readyStatus)
  // No changelog entry = the ticket was created in this status: the run covers it.
  if (!entered) return true
  return jiraTime(entered) <= jiraTime(record.at)
}

/** Jira timestamps look like 2026-10-13T10:00:00.000+0000 (no colon in the offset); normalise before parsing. */
export function jiraTime(s: string): number {
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(t) ? t : 0
}
