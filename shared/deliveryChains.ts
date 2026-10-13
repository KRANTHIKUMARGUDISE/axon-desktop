import type { DeliveryStatus } from './schemas'

// A story = a delivery plus its reruns. Metrics count the chain once (with N attempts), never each failed attempt.
export interface ChainDelivery {
  id: string
  status: DeliveryStatus
  /** The delivery this one re-ran (retriedFromDeliveryId / rerunOf). */
  previousId?: string | null
  startedAt?: string
}

export interface Story {
  rootId: string
  /** Attempts in order, oldest first. */
  attemptIds: string[]
  attempts: number
  /** The newest attempt decides the story's outcome. */
  latestId: string
  status: DeliveryStatus
}

export function buildStories(deliveries: ChainDelivery[]): Story[] {
  const byId = new Map(deliveries.map((d) => [d.id, d]))
  const rootOf = (d: ChainDelivery): string => {
    const seen = new Set<string>()
    let cur = d
    while (cur.previousId && byId.has(cur.previousId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.previousId)!
    }
    return cur.id
  }
  const groups = new Map<string, ChainDelivery[]>()
  for (const d of deliveries) groups.set(rootOf(d), [...(groups.get(rootOf(d)) ?? []), d])
  return [...groups.entries()].map(([rootId, members]) => {
    const ordered = members.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    const latest = ordered[ordered.length - 1]
    return { rootId, attemptIds: ordered.map((m) => m.id), attempts: ordered.length, latestId: latest.id, status: latest.status }
  })
}

/** Story-level counts: a Superseded attempt is never a failure of its own; only a story whose latest attempt Failed counts. */
export function storyCounts(deliveries: ChainDelivery[]): { stories: number; failed: number; completed: number; attempts: number } {
  const stories = buildStories(deliveries)
  return {
    stories: stories.length,
    failed: stories.filter((s) => s.status === 'Failed').length,
    completed: stories.filter((s) => s.status === 'Completed').length,
    attempts: deliveries.length,
  }
}
