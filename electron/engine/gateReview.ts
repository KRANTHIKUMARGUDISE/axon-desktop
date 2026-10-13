import { capSummary } from '../../shared'
import type { Delivery } from '../../shared'
import type { RepoChanges } from '../workspace/changes'

// Q7: what a gate reviewer sees — outcomes, not lines. Per repo the files changed, test results when a step reported
// them, and each preceding agent's own summary. Built on demand from the persisted delivery; nothing here is stored.

export interface GateReview {
  nodeId: string
  reason: string
  checklist: string[]
  mode: 'Pause' | 'NotifyOnly'
  repos: RepoChanges[]
  tests: { nodeId: string; blockName: string; summary: string; result: unknown }[]
  agents: { nodeId: string; blockName: string; itemKey: string | null; summary: string }[]
}

const TEST_KEYS = ['testResults', 'testSummary', 'tests'] as const

export async function buildGateReview(
  d: Delivery,
  deps: { changedFiles: (cwd: string) => Promise<RepoChanges | null> },
): Promise<GateReview | null> {
  const gate = d.steps.find((s) => s.nodeId === d.currentNodeId && (s.status === 'AwaitingApproval' || s.output?.gateMode !== undefined))
  if (!gate) return null

  const cwds = [...new Set(d.steps.map((s) => s.cwd).filter((c): c is string => !!c && c !== d.deliveryFolder))]
  const repos: RepoChanges[] = []
  const seen = new Set<string>()
  for (const cwd of cwds) {
    const changes = await deps.changedFiles(cwd).catch(() => null)
    if (!changes || seen.has(changes.repo)) continue
    seen.add(changes.repo)
    repos.push(changes)
  }

  const before = d.steps.filter((s) => s !== gate && s.status === 'Completed')
  const tests = before.flatMap((s) => {
    const result = s.output?.result as Record<string, unknown> | undefined
    const key = TEST_KEYS.find((k) => result && result[k] !== undefined)
    return key ? [{ nodeId: s.nodeId, blockName: s.blockName, summary: capSummary(s.output?.summary ?? ''), result: result![key] }] : []
  })
  const agents = before
    .filter((s) => s.agentRuntime !== undefined && s.agentRuntime !== 'Axon' && s.output)
    .map((s) => ({ nodeId: s.nodeId, blockName: s.blockName, itemKey: s.itemKey ?? null, summary: capSummary(s.output?.summary ?? '') }))

  return {
    nodeId: gate.nodeId,
    reason: gate.output?.humanGateReason ?? '',
    checklist: gate.output?.gateChecklist ?? [],
    mode: gate.output?.gateMode ?? 'Pause',
    repos,
    tests,
    agents,
  }
}
