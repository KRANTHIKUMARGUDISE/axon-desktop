import type { PipelineNode } from './schemas'
import { JIRA_UPDATE_ARTIFACT, readJiraUpdateConfig } from './actions'

// S5b: staged workflows are chains of rules: the pipeline of one rule sets a label / status that the next rule triggers on.
// These pure helpers make the chain visible on the Automation page and warn about loops with no human in them.

export interface PipelineEffects {
  addLabels: string[]
  removeLabels: string[]
  /** Statuses the pipeline moves the ticket to (Jira Update nodes). */
  transitions: string[]
  /** The pipeline contains a Human Gate that pauses. */
  hasGate: boolean
}

export interface ChainBlock { id: string; role?: string; artifactName?: string }

/** What a pipeline changes in Jira (its Jira Update nodes; "On failure" actions are not part of the happy path). */
export function pipelineEffects(nodes: PipelineNode[], blocks: Map<string, ChainBlock>): PipelineEffects {
  const out: PipelineEffects = { addLabels: [], removeLabels: [], transitions: [], hasGate: false }
  const push = (list: string[], v: string[]) => { for (const x of v) if (!list.includes(x)) list.push(x) }
  for (const n of nodes) {
    if (n.type === 'forEach') continue
    const b = blocks.get(n.blockId)
    if (!b) continue
    if (b.role === 'Control' && (n.config?.mode ?? 'Pause') !== 'NotifyOnly') out.hasGate = true
    if (b.artifactName === JIRA_UPDATE_ARTIFACT) {
      const c = readJiraUpdateConfig(n.config)
      push(out.addLabels, c.addLabels)
      push(out.removeLabels, c.removeLabels)
      if (c.transition) push(out.transitions, [c.transition])
    }
  }
  return out
}

export interface ChainRule {
  id: string
  name: string
  jiraProjectKey: string
  readyLabel: string
  readyStatus?: string
  effects: PipelineEffects
}

export interface RuleChainInfo {
  ruleId: string
  /** "label axon-ready" / "status In Review" */
  triggersOn: string
  /** Rules whose trigger this rule's pipeline sets. */
  next: string[]
  /** Rules that set this rule's trigger. */
  previous: string[]
}

export interface RuleChains {
  rules: RuleChainInfo[]
  /** Human-readable warnings: loops where no pipeline has a Human Gate. */
  warnings: string[]
}

const sets = (from: ChainRule, to: ChainRule): boolean => {
  if (from.jiraProjectKey !== to.jiraProjectKey) return false
  return to.readyStatus ? from.effects.transitions.includes(to.readyStatus) : from.effects.addLabels.includes(to.readyLabel)
}

export function ruleChains(rules: ChainRule[]): RuleChains {
  const next = new Map<string, string[]>(rules.map((r) => [r.id, rules.filter((o) => sets(r, o)).map((o) => o.id)]))
  const info: RuleChainInfo[] = rules.map((r) => ({
    ruleId: r.id,
    triggersOn: r.readyStatus ? `status ${r.readyStatus}` : `label ${r.readyLabel}`,
    next: next.get(r.id) ?? [],
    previous: rules.filter((o) => (next.get(o.id) ?? []).includes(r.id)).map((o) => o.id),
  }))

  // A cycle of rules re-triggers itself forever unless some pipeline in it pauses for a human.
  const byId = new Map(rules.map((r) => [r.id, r]))
  const warnings: string[] = []
  const seenCycles = new Set<string>()
  const walk = (start: string, at: string, path: string[]) => {
    for (const n of next.get(at) ?? []) {
      if (n === start) {
        const key = [...path].sort().join('|')
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          if (!path.some((id) => byId.get(id)?.effects.hasGate)) {
            warnings.push(`Rules ${[...path, start].map((id) => `"${byId.get(id)!.name}"`).join(' → ')} trigger each other in a loop and no pipeline in it has a Human Gate.`)
          }
        }
      } else if (!path.includes(n)) walk(start, n, [...path, n])
    }
  }
  for (const r of rules) walk(r.id, r.id, [r.id])
  return { rules: info, warnings }
}
