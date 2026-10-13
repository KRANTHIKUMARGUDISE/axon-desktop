import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHarness, ok, deferred } from './harness'
import type { Harness } from './harness'
import { createSnapshotService } from '../../workspace/snapshots'
import { toRunSummary } from '../../registry/runSummary'
import { CreateDeliveryInputSchema, buildStories, storyCounts } from '../../../shared'
import type { PipelineNode, PipelineEdge } from '../../../shared'
import { HUMAN_GATE_BLOCK_ID } from '../../store/seed'

let h: Harness
let tmp: string[] = []
afterEach(async () => {
  await h?.cleanup()
  for (const t of tmp) await fs.rm(t, { recursive: true, force: true }).catch(() => {})
  tmp = []
})

const pos = { x: 0, y: 0 }
const e = (s: string, t: string): PipelineEdge => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t })
const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((res, rej) =>
    execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }, (err, out, se) => (err ? rej(new Error(se)) : res(out))))
async function mkRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-rerun-'))
  tmp.push(dir)
  await git(dir, 'init', '-q')
  await git(dir, 'config', 'core.autocrlf', 'false')
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
const refs = async (repo: string) => (await git(repo, 'for-each-ref', 'refs/axon/')).trim()
const run = async (id: string) => { await h.engine.start(id); await h.engine.whenIdle(id) }
const get = async (id: string) => (await h.store.getDelivery(id))!

// a -> b (top-level steps, no ForEach)
async function twoStep(over: { gate?: boolean } = {}) {
  const a = await h.mkBlock({ name: 'a' })
  const b = await h.mkBlock({ name: 'b' })
  const nodes: PipelineNode[] = [
    { id: 'a', label: 'a', blockId: a.id, position: pos },
    over.gate ? { id: 'b', label: 'gate1', blockId: HUMAN_GATE_BLOCK_ID, position: pos, config: { reason: 'A human decides here' } } : { id: 'b', label: 'b', blockId: b.id, position: pos },
  ]
  const p = await h.store.createPipeline({ name: 'P', description: '', nodes, edges: [e('a', 'b')] })
  const mk = (extra: Record<string, unknown> = {}) =>
    h.store.createDelivery({ ticketId: 'T-1', title: 't', pipelineId: p.id, repoUrl: '', workspaceType: 'Default', ...extra } as never)
  return { p, mk }
}

describe('Resume (same delivery) from a Failed step', () => {
  it('continues from the failed top-level step in the same workspace, restoring its snapshot first', async () => {
    const repo = await mkRepo()
    h = await createHarness({ snapshots: createSnapshotService(), workspace: { resolveCwd: async () => repo } })
    const { mk } = await twoStep()
    const d = await mk()
    let n = 0
    h.script.a = async () => { await fs.writeFile(path.join(repo, 'a.txt'), 'a\n'); return ok('a') }
    h.script.b = async () => {
      await fs.appendFile(path.join(repo, 'base.txt'), 'b-edit\n')
      return ++n === 1 ? { status: 'failed' as const, summary: 'x', errorMessage: 'x', result: {} } : ok('b')
    }
    await run(d.id)
    expect((await get(d.id)).status).toBe('Failed')
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\nb-edit\n') // left as the agent left it
    expect(await refs(repo)).toContain(`refs/axon/${d.id}/b`)

    expect((await h.engine.resume(d.id)).success).toBe(true)
    await h.engine.whenIdle(d.id)
    const done = await get(d.id)
    expect(done.status).toBe('Completed')
    expect(done.id).toBe(d.id) // same delivery
    expect(h.runner.mock.calls.filter((c) => c[0].nodeLabel === 'a')).toHaveLength(1) // a not re-run
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\nb-edit\n') // b's first edit restored away, applied once
    expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
    expect(await refs(repo)).toBe('')
  })

  it('also resumes an Interrupted delivery', async () => {
    h = await createHarness()
    const { mk } = await twoStep()
    const d = await mk()
    await run(d.id)
    await h.store.updateDelivery(d.id, (x) => {
      x.status = 'Interrupted'
      x.steps = x.steps.filter((s) => s.nodeId === 'a')
    })
    expect((await h.engine.resume(d.id)).success).toBe(true)
    await h.engine.whenIdle(d.id)
    expect((await get(d.id)).status).toBe('Completed')
  })

  it('refuses a Failed delivery that failed by a rejected approval, and a Superseded one', async () => {
    h = await createHarness()
    const { mk } = await twoStep({ gate: true })
    const d = await mk()
    await run(d.id)
    expect((await get(d.id)).status).toBe('Paused')
    await h.engine.rejectGate(d.id, 'no')
    expect((await get(d.id)).status).toBe('Failed')
    const r = await h.engine.resume(d.id)
    expect(r.success).toBe(false)

    const { mk: mk2 } = await twoStep()
    const failed = await mk2()
    h.script.b = () => ({ status: 'failed' as const, summary: 'x', errorMessage: 'x', result: {} })
    await run(failed.id)
    await mk2({ retriedFromDeliveryId: failed.id })
    expect((await get(failed.id)).status).toBe('Superseded')
    expect((await h.engine.resume(failed.id)).success).toBe(false)
    expect((await h.engine.cancel(failed.id)).success).toBe(false) // already finished
  })
})

describe('Rerun (new delivery) and Superseded linking', () => {
  async function failedDelivery() {
    h = await createHarness()
    const { mk } = await twoStep()
    h.script.b = () => ({ status: 'failed' as const, summary: 'x', errorMessage: 'x', result: {} })
    const d = await mk()
    await run(d.id)
    return { d, mk }
  }

  it('creates a linked new delivery, marks the old one Superseded and counts attempts', async () => {
    const { d, mk } = await failedDelivery()
    const second = await mk({ retriedFromDeliveryId: d.id, rerunReason: 'AgentUpdated' })
    expect(second.retriedFromDeliveryId).toBe(d.id)
    expect(second.rerunReason).toBe('AgentUpdated')
    expect(second.attemptNumber).toBe(2)
    const old = await get(d.id)
    expect(old.status).toBe('Superseded')
    expect(old.supersededBy).toBe(second.id)
    expect(old.steps.length).toBeGreaterThan(0) // history kept

    // chain: a third attempt supersedes the second once that failed
    await h.store.updateDelivery(second.id, (x) => { x.status = 'Failed' })
    const third = await mk({ retriedFromDeliveryId: second.id })
    expect(third.attemptNumber).toBe(3)
    expect(third.rerunReason).toBe('RequirementUpdated') // default
    expect((await get(second.id)).supersededBy).toBe(third.id)
  })

  it('"Run again" of a Completed delivery links but does not supersede it', async () => {
    h = await createHarness()
    const { mk } = await twoStep()
    const d = await mk()
    await run(d.id)
    expect((await get(d.id)).status).toBe('Completed')
    const again = await mk({ retriedFromDeliveryId: d.id })
    expect(again.retriedFromDeliveryId).toBe(d.id)
    expect((await get(d.id)).status).toBe('Completed')
    expect((await get(d.id)).supersededBy).toBeUndefined()
  })

  it('rejects an unknown rerun reason', () => {
    const base = { ticketId: 'T-1', pipelineId: 'p', retriedFromDeliveryId: 'x' }
    expect(CreateDeliveryInputSchema.safeParse({ ...base, rerunReason: 'Whatever' }).success).toBe(false)
    for (const r of ['RequirementUpdated', 'AgentUpdated', 'PlatformRetry', 'Other']) {
      expect(CreateDeliveryInputSchema.safeParse({ ...base, rerunReason: r }).success).toBe(true)
    }
  })

  it('the registry run summary carries the chain (attempt, supersededBy, rerunOf, reason)', async () => {
    const { d, mk } = await failedDelivery()
    const second = await mk({ retriedFromDeliveryId: d.id, rerunReason: 'PlatformRetry' })
    const oldSummary = toRunSummary(await get(d.id), 'dev@example.com')
    expect(oldSummary).toMatchObject({ status: 'Superseded', supersededBy: second.id })
    const newSummary = toRunSummary(second, 'dev@example.com')
    expect(newSummary).toMatchObject({ rerunOf: d.id, rerunReason: 'PlatformRetry', attemptNumber: 2 })
  })

  it('Superseded deliveries keep their snapshot refs until the 14-day cleanup', async () => {
    const repo = await mkRepo()
    h = await createHarness({ snapshots: createSnapshotService(), workspace: { resolveCwd: async () => repo } })
    const { mk } = await twoStep()
    h.script.b = () => ({ status: 'failed' as const, summary: 'x', errorMessage: 'x', result: {} })
    const d = await mk()
    await run(d.id)
    await mk({ retriedFromDeliveryId: d.id })
    expect((await get(d.id)).status).toBe('Superseded')
    expect(await refs(repo)).toContain(`refs/axon/${d.id}/`)
    expect(await h.engine.cleanupFailedSnapshots(14)).toBe(0)
    await h.store.updateDelivery(d.id, (x) => { x.completedAt = new Date(Date.now() - 15 * 86_400_000).toISOString() })
    expect(await h.engine.cleanupFailedSnapshots(14)).toBe(1)
    expect(await refs(repo)).toBe('')
  })
})

describe('story metrics', () => {
  it('a Superseded attempt is not a separate failure: the chain counts as one story with N attempts', () => {
    const list = [
      { id: 'a1', status: 'Superseded' as const, previousId: null, startedAt: '2026-10-01T10:00:00Z' },
      { id: 'a2', status: 'Superseded' as const, previousId: 'a1', startedAt: '2026-10-01T11:00:00Z' },
      { id: 'a3', status: 'Completed' as const, previousId: 'a2', startedAt: '2026-10-01T12:00:00Z' },
      { id: 'b1', status: 'Failed' as const, previousId: null, startedAt: '2026-10-02T10:00:00Z' },
      { id: 'c1', status: 'Completed' as const, previousId: null, startedAt: '2026-10-03T10:00:00Z' },
      { id: 'c2', status: 'Completed' as const, previousId: 'c1', startedAt: '2026-10-03T11:00:00Z' }, // "run again" of a Completed one
    ]
    const stories = buildStories(list)
    expect(stories.find((s) => s.rootId === 'a1')).toMatchObject({ attempts: 3, latestId: 'a3', status: 'Completed', attemptIds: ['a1', 'a2', 'a3'] })
    expect(storyCounts(list)).toEqual({ stories: 3, failed: 1, completed: 2, attempts: 6 })
    // a story whose latest attempt failed (and nothing superseded it) is one failure
    expect(storyCounts([{ id: 'x1', status: 'Superseded', previousId: null }, { id: 'x2', status: 'Failed', previousId: 'x1' }]))
      .toEqual({ stories: 1, failed: 1, completed: 0, attempts: 2 })
  })
})

describe('cancelled / interrupted steps are not "Failed"', () => {
  it('cancelling marks the in-flight step Cancelled; a shutdown marks it Interrupted; Resume continues from it', async () => {
    h = await createHarness()
    const { mk } = await twoStep()
    const gate = deferred<void>()
    h.script.b = async () => { await gate.promise; return ok('b') }
    const d = await mk()
    await h.engine.start(d.id)
    await vi.waitFor(async () => expect((await get(d.id)).steps.some((s) => s.nodeId === 'b' && s.status === 'Running')).toBe(true))
    await h.engine.cancel(d.id)
    gate.resolve()
    await h.engine.whenIdle(d.id)
    const cancelled = await get(d.id)
    expect(cancelled.status).toBe('Cancelled')
    const step = cancelled.steps.find((s) => s.nodeId === 'b')!
    expect(step.status).toBe('Cancelled')
    expect(step.output?.errorMessage).toBe('Cancelled by user')
    // the preview names it as the step to run again and lists it as the stop reason
    const prev = (await h.engine.previewResume(d.id)).preview!
    expect(prev.stepLabel).toBe('b')
    expect(prev.failureReason).toBe('Cancelled by user')
    h.script.b = () => ok('b')
    expect((await h.engine.resume(d.id)).success).toBe(true)
    await h.engine.whenIdle(d.id)
    expect((await get(d.id)).status).toBe('Completed')
  })

  it('shutdown marks the running step Interrupted', async () => {
    h = await createHarness()
    const { mk } = await twoStep()
    const gate = deferred<void>()
    h.script.b = async () => { await gate.promise; return ok('b') }
    const d = await mk()
    await h.engine.start(d.id)
    await vi.waitFor(async () => expect((await get(d.id)).steps.some((s) => s.nodeId === 'b' && s.status === 'Running')).toBe(true))
    await h.engine.shutdown()
    gate.resolve()
    const got = await get(d.id)
    expect(got.status).toBe('Interrupted')
    expect(got.steps.find((s) => s.nodeId === 'b')?.status).toBe('Interrupted')
  })

  it('older deliveries stored as Failed + "Cancelled by user" are read as Cancelled', async () => {
    h = await createHarness()
    const { mk } = await twoStep()
    const d = await mk()
    await h.store.updateDelivery(d.id, (x) => {
      x.status = 'Cancelled'
      x.steps = [
        { nodeId: 'a', itemKey: null, blockId: 'x', blockName: 'a', status: 'Failed', output: { status: 'failed', summary: 'Cancelled by user', result: {}, errorMessage: 'Cancelled by user' } },
        { nodeId: 'b', itemKey: null, blockId: 'x', blockName: 'b', status: 'Failed', output: { status: 'failed', summary: 'Interrupted (AXON was closed while this step was running)', result: {}, errorMessage: 'Interrupted (AXON was closed while this step was running)' } },
        { nodeId: 'c', itemKey: null, blockId: 'x', blockName: 'c', status: 'Failed', output: { status: 'failed', summary: 'real failure', result: {}, errorMessage: 'real failure' } },
      ] as never
    })
    expect((await get(d.id)).steps.map((s) => s.status)).toEqual(['Cancelled', 'Interrupted', 'Failed'])
    expect((await h.store.listDeliveries()).find((x) => x.id === d.id)!.steps[0].status).toBe('Cancelled')
  })
})
