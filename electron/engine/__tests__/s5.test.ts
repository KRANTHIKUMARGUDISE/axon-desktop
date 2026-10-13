import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness } from './harness'
import type { Harness } from './harness'
import { HUMAN_GATE_BLOCK_ID } from '../../store/seed'
import { classifyFailure, isPlatformErrorMessage, autonomyRate, watcherEligible, readGateConfig, validatePipeline } from '../../../shared'
import type { AgentOutput } from '../../../shared'
import { toRunSummary } from '../../registry/runSummary'

let h: Harness
afterEach(async () => { await h?.cleanup() })

const failed = (message: string, extra: Partial<AgentOutput> = {}): AgentOutput => ({ status: 'failed', summary: message, result: {}, errorMessage: message, ...extra })

// a -> gate -> b with a custom gate config
async function gatePipeline(config: Record<string, unknown>, blockOver = {}) {
  const block = await h.mkBlock(blockOver)
  const nodes = [
    { id: 'n1', label: 'a', blockId: block.id, position: { x: 0, y: 0 } },
    { id: 'n2', label: 'gate1', blockId: HUMAN_GATE_BLOCK_ID, position: { x: 100, y: 0 }, config },
    { id: 'n3', label: 'b', blockId: block.id, position: { x: 200, y: 0 } },
  ]
  const edges = [
    { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' },
    { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3' },
  ]
  const pipeline = await h.store.createPipeline({ name: 'G', description: '', nodes, edges })
  const delivery = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
  const res = await h.engine.start(delivery.id)
  await h.engine.whenIdle(delivery.id)
  return { delivery, res, get: () => h.store.getDelivery(delivery.id) as Promise<import('../../../shared').Delivery> }
}

describe('S5 gates (Part B)', () => {
  it('a gate without a reason is a validator error', async () => {
    h = await createHarness()
    const block = await h.mkBlock()
    const gate = await h.store.getBlock(HUMAN_GATE_BLOCK_ID)
    const nodes = [
      { id: 'n1', label: 'a', blockId: block.id, position: { x: 0, y: 0 } },
      { id: 'n2', label: 'gate1', blockId: HUMAN_GATE_BLOCK_ID, position: { x: 1, y: 0 } },
    ]
    const v = validatePipeline(nodes, [{ id: 'e', sourceNodeId: 'n1', targetNodeId: 'n2' }], new Map([[block.id, block], [gate!.id, gate!]]))
    expect(v.valid).toBe(false)
    expect(v.errors.join('|')).toMatch(/Human Gate\) needs a reason/)
  })

  it('Pause mode records the reason, checklist and mode on the step and pauses', async () => {
    h = await createHarness()
    const r = await gatePipeline({ reason: 'Touches billing', checklist: ['Tests pass', 'No secrets'], mode: 'Pause' })
    const d = await r.get()
    expect(d.status).toBe('Paused')
    const gate = d.steps.find((s) => s.nodeId === 'n2')!
    expect(gate.status).toBe('AwaitingApproval')
    expect(gate.output).toMatchObject({ humanGateReason: 'Touches billing', gateChecklist: ['Tests pass', 'No secrets'], gateMode: 'Pause' })
  })

  it('Notify-only does not pause, is recorded, and the delivery completes', async () => {
    h = await createHarness()
    const r = await gatePipeline({ reason: 'Review the PR', mode: 'NotifyOnly' })
    const d = await r.get()
    expect(d.status).toBe('Completed')
    const gate = d.steps.find((s) => s.nodeId === 'n2')!
    expect(gate.status).toBe('Completed')
    expect(gate.output).toMatchObject({ gateMode: 'NotifyOnly', humanGateReason: 'Review the PR' })
    expect(h.eventTypes(r.delivery.id)).toContain('gate_notified')
    expect(h.eventTypes(r.delivery.id)).not.toContain('gate_reached')
    const summary = toRunSummary(d, 'dev@example.com')
    expect(summary).toMatchObject({ gateCount: 1, gatesPaused: 0, interventions: 0 })
  })

  it('readGateConfig defaults to Pause', () => {
    expect(readGateConfig({ reason: ' why ' })).toEqual({ reason: 'why', checklist: [], mode: 'Pause' })
  })
})

describe('S5 failure classification (Q9)', () => {
  it('classifies unit cases', () => {
    expect(classifyFailure({ runtime: 'Claude', message: 'bad output' })).toBe('Agent')
    expect(classifyFailure({ thrown: true, message: 'ENOENT' })).toBe('Platform')
    expect(classifyFailure({ runtime: 'Claude', blockTags: ['Readiness'] })).toBe('Requirement')
    expect(classifyFailure({ runtime: 'Claude', result: { requirementUnclear: true } })).toBe('Requirement')
    expect(classifyFailure({ rejectedAtGate: true })).toBe('Agent')
    expect(isPlatformErrorMessage('git push failed: Could not resolve host: github.com')).toBe(true)
    expect(isPlatformErrorMessage('the agent wrote bad code')).toBe(false)
  })

  it('an agent step that returns failed -> Agent, in the delivery and the failed event', async () => {
    h = await createHarness({ script: { a: () => failed('output invalid') } })
    const r = await h.run(['a'])
    const d = await r.get()
    expect(d.status).toBe('Failed')
    expect(d.failureCategory).toBe('Agent')
    expect(h.events.find((e) => e.type === 'failed')).toMatchObject({ failureCategory: 'Agent' })
    expect(toRunSummary(d, 'dev@example.com').failureCategory).toBe('Agent')
  })

  it('a runner crash -> Platform', async () => {
    h = await createHarness({ script: { a: () => { throw new Error('socket exploded') } } })
    const r = await h.run(['a'])
    expect((await r.get()).failureCategory).toBe('Platform')
  })

  it('a failing block tagged readiness -> Requirement', async () => {
    h = await createHarness({ script: { a: () => failed('ticket has no acceptance criteria') } })
    const r = await h.run(['a'], { blockOver: { tags: ['readiness'] } })
    expect((await r.get()).failureCategory).toBe('Requirement')
  })

  it('a rejected gate -> Agent + a GateRejected intervention', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1'])
    await h.engine.rejectGate(r.delivery.id, 'nope')
    const d = await r.get()
    expect(d.failureCategory).toBe('Agent')
    expect(d.interventions?.map((i) => i.kind)).toEqual(['GateRejected'])
  })
})

describe('S5 automatic Platform retry (15b)', () => {
  const nativeBlock = () => h.mkBlock({ agentRuntime: 'Axon', artifactFormat: 'Native', artifactName: 'flaky', cachedFiles: undefined, entryPointPath: undefined })
  async function run(script: () => AgentOutput, native = true) {
    const block = native ? await nativeBlock() : await h.mkBlock()
    const nodes = [{ id: 'n1', label: 'a', blockId: block.id, position: { x: 0, y: 0 } }]
    const pipeline = await h.store.createPipeline({ name: 'R', description: '', nodes, edges: [] })
    const delivery = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    h.script.a = script
    await h.engine.start(delivery.id)
    await h.engine.whenIdle(delivery.id)
    return (await h.store.getDelivery(delivery.id))!
  }

  it('retries a built-in step twice, logs each retry, then succeeds', async () => {
    h = await createHarness()
    let calls = 0
    const d = await run(() => (++calls <= 2 ? failed('git push failed: Could not resolve host') : { status: 'success', summary: 'ok', result: {} }))
    expect(d.status).toBe('Completed')
    expect(calls).toBe(3)
    expect(d.steps[0].retries).toHaveLength(2)
  })

  it('gives up after 2 retries and fails as Platform', async () => {
    h = await createHarness()
    let calls = 0
    const d = await run(() => { calls++; return failed('git push failed: network unreachable') })
    expect(calls).toBe(3)
    expect(d.status).toBe('Failed')
    expect(d.failureCategory).toBe('Platform')
    expect(d.steps[0].retries).toHaveLength(2)
  })

  it('never retries an agent step, whatever the message', async () => {
    h = await createHarness()
    let calls = 0
    const d = await run(() => { calls++; return failed('network error in my test') }, false)
    expect(calls).toBe(1)
    expect(d.failureCategory).toBe('Agent')
  })
})

describe('S5 interventions (Q13)', () => {
  const repoCwd = '/repo/under/test'
  const withHashes = (...hashes: string[]) => {
    const treeHash = vi.fn<(cwd: string) => Promise<string | null>>()
    for (const x of hashes) treeHash.mockResolvedValueOnce(x)
    return {
      ensure: vi.fn(async () => 'skipped' as const), has: vi.fn(async () => false), restore: vi.fn(async () => false), dropAll: vi.fn(async () => {}), treeHash,
    }
  }

  it('approving unchanged is not an intervention', async () => {
    h = await createHarness({ snapshots: withHashes('h1', 'h1'), workspace: { resolveCwd: async () => repoCwd } })
    const r = await h.run(['a', 'gate1'])
    await h.engine.approveGate(r.delivery.id)
    await h.engine.whenIdle(r.delivery.id)
    const d = await r.get()
    expect(d.status).toBe('Completed')
    expect(d.interventions ?? []).toEqual([])
  })

  it('a workspace edit between the gate and the approval counts', async () => {
    h = await createHarness({ snapshots: withHashes('h1', 'h2'), workspace: { resolveCwd: async () => repoCwd } })
    const r = await h.run(['a', 'gate1'])
    await h.engine.approveGate(r.delivery.id)
    await h.engine.whenIdle(r.delivery.id)
    const d = await r.get()
    expect(d.interventions?.map((i) => i.kind)).toEqual(['EditBeforeApproval'])
  })

  it('re-running a failed delivery records RerunAfterFailure on the new attempt', async () => {
    h = await createHarness({ script: { a: () => failed('boom') } })
    const r = await h.run(['a'])
    const again = await h.store.createDelivery({
      ticketId: 'T-1', title: '', pipelineId: r.pipeline.id, repoUrl: '', workspaceType: 'Default', retriedFromDeliveryId: r.delivery.id,
    })
    expect(again.interventions?.map((i) => i.kind)).toEqual(['RerunAfterFailure'])
  })

  it('a manual start of a watcher-eligible ticket counts; a watcher start does not', async () => {
    h = await createHarness()
    const { pipeline } = await h.mkPipeline(['a'])
    const base = { ticketId: 'T-1', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' as const }
    const manual = await h.store.createDelivery({ ...base, watcherEligible: true })
    expect(manual.interventions?.map((i) => i.kind)).toEqual(['ManualStartWatcherEligible'])
    const watcher = await h.store.createDelivery({ ...base, trigger: 'Watcher', ruleId: 'r1', watcherEligible: true })
    expect(watcher.interventions).toEqual([])
    expect(watcher.trigger).toBe('Watcher')
    expect(toRunSummary(watcher, 'dev@example.com')).toMatchObject({ trigger: 'Watcher', ruleId: 'r1' })
  })

  it('watcherEligible + autonomyRate helpers', () => {
    const rules = [{ enabled: true, jiraProjectKey: 'T', pipelineId: 'p1' }, { enabled: false, jiraProjectKey: 'X', pipelineId: 'p1' }]
    expect(watcherEligible(rules, 'T-9', 'p1')).toBe(true)
    expect(watcherEligible(rules, 'X-9', 'p1')).toBe(false) // disabled
    expect(watcherEligible(rules, 'T-9', 'other')).toBe(false)
    expect(autonomyRate([
      { status: 'Completed', interventions: [] }, { status: 'Completed', interventions: [{}] }, { status: 'Failed', interventions: [] },
    ])).toEqual({ percent: 50, completed: 2, autonomous: 1 })
    expect(autonomyRate([]).percent).toBeNull()
  })
})
