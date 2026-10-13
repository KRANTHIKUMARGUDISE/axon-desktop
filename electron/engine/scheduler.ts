import type { ActionResult } from '../../shared'
import type { Engine } from './engine'
import type { EventBus } from './bus'
import { log } from '../log'

// S5 item 9: a global cap on running deliveries (default 1). Starts beyond the cap stay Pending in a FIFO
// queue and begin when a slot frees (a delivery completes/fails/is cancelled/interrupted, or pauses at a gate).
// Resume/approve of an already-started delivery is not queued: it was admitted before.

export interface Scheduler {
  /** Starts the delivery now, or queues it (it stays Pending). */
  start(deliveryId: string): Promise<ActionResult & { queued?: boolean }>
  /** Queued ids in order (for tests/diagnostics). */
  queued(): string[]
  /** Removes a delivery from the queue (cancelled while waiting). */
  forget(deliveryId: string): void
}

const FREEING = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'gate_reached'])

export function createScheduler(deps: { engine: Engine; bus: EventBus; getCap: () => number }): Scheduler {
  const { engine, bus } = deps
  const queue: string[] = []
  // Starts handed to the engine whose run loop has not registered as active yet.
  let pumping: Promise<void> = Promise.resolve()

  const cap = () => Math.max(1, Math.floor(deps.getCap() || 1))
  const free = () => engine.activeCount() < cap()

  // Serialised so two events cannot both see the same free slot.
  function pump(): Promise<void> {
    pumping = pumping.then(async () => {
      while (queue.length && free()) {
        const id = queue.shift() as string
        const res = await engine.start(id)
        if (!res.success) log.warn(`[scheduler] queued delivery ${id} could not start: ${res.error}`)
      }
    }).catch((err) => log.warn('[scheduler] pump failed', err))
    return pumping
  }

  bus.subscribe((event) => {
    if (FREEING.has(event.type)) {
      // The run loop unwinds just after it emits; wait for it before counting.
      void engine.whenIdle(event.deliveryId).then(() => pump())
    }
  })

  return {
    async start(id) {
      if (queue.includes(id)) return { success: true, queued: true }
      await pumping
      if (queue.length === 0 && free()) return engine.start(id)
      queue.push(id)
      void pump()
      return { success: true, queued: queue.includes(id) }
    },
    queued: () => [...queue],
    forget(id) {
      const i = queue.indexOf(id)
      if (i >= 0) queue.splice(i, 1)
    },
  }
}
