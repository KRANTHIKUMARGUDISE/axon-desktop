import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, deferred } from './harness'
import type { Harness } from './harness'
import { createScheduler } from '../scheduler'

let h: Harness
afterEach(async () => { await h?.cleanup() })

describe('concurrency scheduler (cap)', () => {
  it('runs one delivery at a time by default; the rest stay Pending and start as slots free', async () => {
    const gate = deferred()
    h = await createHarness({ script: { slow: async () => { await gate.promise; return { status: 'success', summary: 'ok', result: {} } } } })
    const sched = createScheduler({ engine: h.engine, bus: h.bus, getCap: () => 1 })
    const first = await h.mkDelivery(['slow'])
    const second = await h.mkDelivery(['quick'])
    const third = await h.mkDelivery(['quick'])

    expect(await sched.start(first.delivery.id)).toMatchObject({ success: true })
    expect(await sched.start(second.delivery.id)).toMatchObject({ success: true, queued: true })
    expect(await sched.start(third.delivery.id)).toMatchObject({ success: true, queued: true })
    expect((await h.store.getDelivery(second.delivery.id))!.status).toBe('Pending')
    expect(sched.queued()).toEqual([second.delivery.id, third.delivery.id])
    expect(h.engine.activeCount()).toBe(1)

    gate.resolve()
    for (let i = 0; i < 50 && (await h.store.getDelivery(third.delivery.id))!.status !== 'Completed'; i++) await new Promise((r) => setTimeout(r, 20))
    for (const d of [first, second, third]) expect((await h.store.getDelivery(d.delivery.id))!.status).toBe('Completed')
    expect(sched.queued()).toEqual([])
  })

  it('a higher cap lets that many run together', async () => {
    const gate = deferred()
    h = await createHarness({ script: { slow: async () => { await gate.promise; return { status: 'success', summary: 'ok', result: {} } } } })
    const sched = createScheduler({ engine: h.engine, bus: h.bus, getCap: () => 2 })
    const a = await h.mkDelivery(['slow'])
    const b = await h.mkDelivery(['slow'])
    const c = await h.mkDelivery(['slow'])
    await sched.start(a.delivery.id)
    await sched.start(b.delivery.id)
    expect(await sched.start(c.delivery.id)).toMatchObject({ queued: true })
    expect(h.engine.activeCount()).toBe(2)
    gate.resolve()
    // Let all three finish (the queued one starts once a slot frees) before the harness cleans up its directory.
    for (let i = 0; i < 100 && (await h.store.getDelivery(c.delivery.id))!.status !== 'Completed'; i++) await new Promise((r) => setTimeout(r, 20))
    for (const d of [a, b, c]) {
      await h.engine.whenIdle(d.delivery.id)
      expect((await h.store.getDelivery(d.delivery.id))!.status).toBe('Completed')
    }
  })
})
