// ForEach progress derived purely from the stored delivery (plan + steps), so the lanes and the
// "2 of 4 · key" counter look the same live and after an app restart.

export type LaneState = 'pending' | 'running' | 'done' | 'failed'

export interface StepLike {
  nodeId: string
  itemKey?: string | null
  status: string
}

interface NodeLike {
  id: string
  type?: string
  parentId?: string
  label?: string
  name?: string
}

export interface ItemLane<S extends StepLike = StepLike> {
  key: string
  state: LaneState
  /** Body steps recorded for this item, in body order. */
  steps: S[]
}

export interface ForEachProgress<S extends StepLike = StepLike> {
  nodeId: string
  label: string
  total: number
  done: number
  failed: number
  /** Key of the running (or first failed / next pending) item. */
  currentKey?: string
  lanes: ItemLane<S>[]
  /** "2 of 4 · refunds-api" */
  counter: string
}

export interface ItemProgressInput<S extends StepLike> {
  steps: S[]
  itemPlan?: Record<string, { items: { key: string }[] }>
  pipelineSnapshot?: { nodes?: NodeLike[] }
}

export function forEachProgress<S extends StepLike>(d: ItemProgressInput<S>): ForEachProgress<S>[] {
  const nodes = d.pipelineSnapshot?.nodes ?? []
  const out: ForEachProgress<S>[] = []
  for (const fe of nodes.filter((n) => n.type === 'forEach')) {
    const plan = d.itemPlan?.[fe.id]
    if (!plan) continue
    const bodyIds = nodes.filter((n) => n.parentId === fe.id).map((n) => n.id)
    const lanes: ItemLane<S>[] = plan.items.map((it) => {
      const steps = d.steps
        .filter((s) => s.itemKey === it.key && bodyIds.includes(s.nodeId))
        .sort((a, b) => bodyIds.indexOf(a.nodeId) - bodyIds.indexOf(b.nodeId))
      const complete = bodyIds.length > 0 && bodyIds.every((id) => steps.some((s) => s.nodeId === id && s.status === 'Completed'))
      const state: LaneState = complete ? 'done'
        : steps.some((s) => s.status === 'Failed') ? 'failed'
          : steps.some((s) => s.status === 'Running') ? 'running'
            : 'pending'
      return { key: it.key, state, steps }
    })
    const done = lanes.filter((l) => l.state === 'done').length
    const failed = lanes.filter((l) => l.state === 'failed').length
    const current = lanes.find((l) => l.state === 'running') ?? lanes.find((l) => l.state === 'failed') ?? lanes.find((l) => l.state === 'pending')
    const shown = current ? lanes.indexOf(current) + 1 : lanes.length
    out.push({
      nodeId: fe.id,
      label: fe.label ?? fe.name ?? fe.id,
      total: lanes.length,
      done,
      failed,
      currentKey: current?.key,
      lanes,
      counter: lanes.length === 0 ? '0 items' : `${shown} of ${lanes.length}${current ? ` · ${current.key}` : ''}`,
    })
  }
  return out
}
