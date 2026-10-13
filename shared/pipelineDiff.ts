import type { OnFailureAction } from './actions'
import type { PipelineEdge, PipelineNode } from './schemas'
import type { PipelineEffects } from './ruleChains'

// What changed between two versions of a pipeline, in plain words (shown before a rule is moved to a newer version).

export interface PipelineSide {
  version: number
  versionLabel?: string
  changeNote?: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  onFailure?: OnFailureAction[]
  onFailureOnCancel?: boolean
}

export interface DiffItem { kind: 'added' | 'removed' | 'changed'; text: string }

export interface PipelineDiff {
  from: number
  to: number
  versionLabel?: string
  changeNote?: string
  items: DiffItem[]
  /** What the new version does differently in Jira / for the chain of rules. */
  ruleEffect: string[]
}

const CONFIG_LABELS: Record<string, string> = {
  reason: 'review reason', mode: 'mode', checklist: 'review checklist', transition: 'status to move to', addLabels: 'labels added', removeLabels: 'labels removed',
  assign: 'assignee', comment: 'comment text', reviewers: 'reviewers', readyForReview: 'mark ready for review',
}

const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? 'unset' : s.length > 40 ? `${s.slice(0, 37)}…` : s
}

function describeValue(key: string, a: unknown, b: unknown): string {
  const label = CONFIG_LABELS[key] ?? key
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = (Array.isArray(a) ? a : []).map(String)
    const y = (Array.isArray(b) ? b : []).map(String)
    const add = y.filter((i) => !x.includes(i))
    const del = x.filter((i) => !y.includes(i))
    return `${label}: ${[add.length ? `+ ${add.join(', ')}` : '', del.length ? `− ${del.join(', ')}` : ''].filter(Boolean).join(' ') || 'reordered'}`
  }
  if (key === 'comment' || key === 'reason') return `${label} changed`
  return `${label}: ${short(a ?? 'unset')} → ${short(b ?? 'unset')}`
}

export function diffPipelines(
  from: PipelineSide,
  to: PipelineSide,
  opts: { blockName: (blockId: string) => string; effects?: { from: PipelineEffects; to: PipelineEffects } },
): PipelineDiff {
  const items: DiffItem[] = []
  const nameOf = (n: PipelineNode) => (n.type === 'forEach' ? n.label ?? n.name ?? 'ForEach' : n.label ?? n.name ?? opts.blockName(n.blockId))
  const blockLabel = (n: PipelineNode) => (n.type === 'forEach' ? 'ForEach' : opts.blockName(n.blockId))
  const describeNode = (n: PipelineNode) => {
    const block = blockLabel(n)
    const label = nameOf(n)
    return label === block ? block : `${block} (“${label}”)`
  }

  const before = new Map(from.nodes.map((n) => [n.id, n]))
  const after = new Map(to.nodes.map((n) => [n.id, n]))

  for (const n of to.nodes) if (!before.has(n.id)) items.push({ kind: 'added', text: `Added ${describeNode(n)}` })
  for (const n of from.nodes) if (!after.has(n.id)) items.push({ kind: 'removed', text: `Removed ${describeNode(n)}` })

  for (const n of to.nodes) {
    const o = before.get(n.id)
    if (!o) continue
    const who = `“${nameOf(n)}”`
    if (o.blockId !== n.blockId) items.push({ kind: 'changed', text: `${who}: now runs ${blockLabel(n)} instead of ${blockLabel(o)}` })
    else if (o.blockVersion !== n.blockVersion && n.type !== 'forEach') items.push({ kind: 'changed', text: `${who}: ${blockLabel(n)} v${o.blockVersion ?? '?'} → v${n.blockVersion ?? '?'}` })
    if (nameOf(o) !== nameOf(n)) items.push({ kind: 'changed', text: `Renamed “${nameOf(o)}” → “${nameOf(n)}”` })
    if (o.timeoutSeconds !== n.timeoutSeconds && (o.timeoutSeconds ?? n.timeoutSeconds) !== undefined) items.push({ kind: 'changed', text: `${who}: timeout ${o.timeoutSeconds ?? 'default'} → ${n.timeoutSeconds ?? 'default'} s` })
    if (n.type === 'forEach') {
      if (o.maxItems !== n.maxItems) items.push({ kind: 'changed', text: `${who}: max items ${o.maxItems ?? 10} → ${n.maxItems ?? 10}` })
      if ((o.onEmpty ?? 'fail') !== (n.onEmpty ?? 'fail')) items.push({ kind: 'changed', text: `${who}: if the list is empty ${o.onEmpty ?? 'fail'} → ${n.onEmpty ?? 'fail'}` })
    }
    const oc = (o.config ?? {}) as Record<string, unknown>
    const nc = (n.config ?? {}) as Record<string, unknown>
    for (const key of new Set([...Object.keys(oc), ...Object.keys(nc)])) {
      if (JSON.stringify(oc[key]) !== JSON.stringify(nc[key])) items.push({ kind: 'changed', text: `${who}: ${describeValue(key, oc[key], nc[key])}` })
    }
  }

  const edgeKey = (e: PipelineEdge) => `${e.sourceNodeId}->${e.targetNodeId}`
  const nodeName = (side: PipelineSide, id: string) => {
    const n = side.nodes.find((x) => x.id === id)
    return n ? nameOf(n) : id
  }
  const oldEdges = new Set(from.edges.map(edgeKey))
  const newEdges = new Set(to.edges.map(edgeKey))
  for (const e of to.edges) if (!oldEdges.has(edgeKey(e))) items.push({ kind: 'added', text: `Connected ${nodeName(to, e.sourceNodeId)} → ${nodeName(to, e.targetNodeId)}` })
  for (const e of from.edges) if (!newEdges.has(edgeKey(e))) items.push({ kind: 'removed', text: `Disconnected ${nodeName(from, e.sourceNodeId)} → ${nodeName(from, e.targetNodeId)}` })

  const fa = from.onFailure ?? []
  const fb = to.onFailure ?? []
  if (JSON.stringify(fa) !== JSON.stringify(fb)) items.push({ kind: 'changed', text: `“When the pipeline fails” actions: ${fa.length} → ${fb.length}` })
  if ((from.onFailureOnCancel ?? false) !== (to.onFailureOnCancel ?? false)) items.push({ kind: 'changed', text: `Failure actions on cancel: ${to.onFailureOnCancel ? 'now run' : 'no longer run'}` })

  const order = { added: 0, removed: 1, changed: 2 } as const
  items.sort((a, b) => order[a.kind] - order[b.kind])

  const ruleEffect: string[] = []
  if (opts.effects) {
    const { from: ef, to: et } = opts.effects
    const diffList = (label: string, a: string[], b: string[]) => {
      for (const x of b.filter((v) => !a.includes(v))) ruleEffect.push(`Now ${label} ${x}`)
      for (const x of a.filter((v) => !b.includes(v))) ruleEffect.push(`No longer ${label} ${x}`)
    }
    diffList('moves the ticket to status', ef.transitions, et.transitions)
    diffList('adds the label', ef.addLabels, et.addLabels)
    diffList('removes the label', ef.removeLabels, et.removeLabels)
    if (!ef.hasGate && et.hasGate) ruleEffect.push('Now pauses for a Human Gate')
    if (ef.hasGate && !et.hasGate) ruleEffect.push('No longer pauses for a Human Gate')
  }

  return { from: from.version, to: to.version, versionLabel: to.versionLabel, changeNote: to.changeNote, items, ruleEffect }
}
