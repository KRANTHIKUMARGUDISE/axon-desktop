import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { createHarness, deferred, ok } from './harness'
import type { Harness } from './harness'
import { DeliveryEventSchema } from '../../../shared'
import type { AgentOutput } from '../../../shared'

let h: Harness
afterEach(async () => {
  await h?.engine.shutdown()
  await h?.cleanup()
})

// Runner that blocks until released or aborted — for cancel / in-flight tests.
function blockingScript(label: string) {
  const gate = deferred<AgentOutput>()
  const started = deferred()
  const fn = (input: { signal: AbortSignal }) => {
    started.resolve()
    input.signal.addEventListener('abort', () => gate.resolve({ status: 'failed', summary: 'aborted', result: {} }), { once: true })
    return gate.promise
  }
  return { script: { [label]: fn }, gate, started }
}

describe('start + linear run', () => {
  it('runs a single step pipeline to Completed', async () => {
    h = await createHarness()
    const r = await h.run(['a'])
    expect(r.res.success).toBe(true)
    const d = await r.get()
    expect(d.status).toBe('Completed')
    expect(d.completedAt).toBeDefined()
    expect(d.deliveryFolder).toBe(h.workspaceDir)
    expect(d.workspacePath).toBeUndefined()
  })

  it('runs a linear pipeline in order and records one step per node', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'b', 'c'])
    expect(h.runner.mock.calls.map((c) => c[0].nodeLabel)).toEqual(['a', 'b', 'c'])
    const d = await r.get()
    expect(d.steps.map((s) => [s.nodeId, s.status])).toEqual([['n1', 'Completed'], ['n2', 'Completed'], ['n3', 'Completed']])
  })

  it('passes earlier step results into later steps context', async () => {
    h = await createHarness()
    await h.run(['a', 'b'], { inputs: { seed: 1 } })
    const ctxB = h.runner.mock.calls[1][0].deliveryContext
    expect(ctxB.previousStepsResults).toMatchObject({ aOut: true })
    expect(ctxB.currentInputs).toEqual({ seed: 1 })
  })

  it('emits typed events that all validate against DeliveryEventSchema', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'b'])
    expect(h.eventTypes(r.delivery.id)).toEqual(expect.arrayContaining([
      'workspace_provisioning', 'workspace_provisioned', 'step_started', 'step_completed', 'completed',
    ]))
    for (const e of h.events) expect(() => DeliveryEventSchema.parse(e)).not.toThrow()
  })

  it('rejects start for a delivery that is not Pending', async () => {
    h = await createHarness()
    const r = await h.run(['a'])
    const again = await h.engine.start(r.delivery.id)
    expect(again.success).toBe(false)
    expect(again.error).toMatch(/Completed/)
  })

  it('blocks a concurrent double start (runner invoked once)', async () => {
    const block = blockingScript('a')
    h = await createHarness({ script: block.script })
    const { delivery } = await h.mkDelivery(['a'])
    const [first, second] = await Promise.all([h.engine.start(delivery.id), h.engine.start(delivery.id)])
    expect([first.success, second.success].sort()).toEqual([false, true])
    await block.started.promise
    block.gate.resolve(ok('a'))
    await h.engine.whenIdle(delivery.id)
    expect(h.runner).toHaveBeenCalledTimes(1)
  })

  it('refuses to start a cyclic pipeline and leaves the delivery Pending', async () => {
    h = await createHarness()
    const { delivery, pipeline } = await h.mkDelivery(['a', 'b'])
    // Tamper with the snapshot: add a back-edge.
    await h.store.updateDelivery(delivery.id, (d) => {
      d.pipelineSnapshot.edges.push({ id: 'back', sourceNodeId: 'n2', targetNodeId: 'n1' })
    })
    const res = await h.engine.start(delivery.id)
    expect(res.success).toBe(false)
    expect(pipeline.id).toBeTruthy()
    expect((await h.store.getDelivery(delivery.id))!.status).toBe('Pending')
  })

  it('keeps the delivery Pending when workspace preparation fails', async () => {
    h = await createHarness({ workspace: { prepare: async () => { throw new Error('clone failed') } } })
    const { delivery } = await h.mkDelivery(['a'])
    const res = await h.engine.start(delivery.id)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/clone failed/)
    expect((await h.store.getDelivery(delivery.id))!.status).toBe('Pending')
  })
})

describe('failures', () => {
  it('fails the delivery when the runner throws', async () => {
    h = await createHarness({ script: { b: () => { throw new Error('boom') } } })
    const r = await h.run(['a', 'b', 'c'])
    const d = await r.get()
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toBe('boom')
    expect(d.currentNodeId).toBe('n2')
    expect(d.steps.find((s) => s.nodeId === 'n2')!.status).toBe('Failed')
    expect(h.runner).toHaveBeenCalledTimes(2)
    expect(h.eventTypes()).toContain('step_failed')
  })

  it('fails the delivery when an agent returns status failed', async () => {
    h = await createHarness({ script: { a: () => ({ status: 'failed', summary: 'nope', result: {}, errorMessage: 'bad input' }) } })
    const r = await h.run(['a', 'b'])
    const d = await r.get()
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toBe('bad input')
    expect(h.runner).toHaveBeenCalledTimes(1)
  })

  it('treats a partial result as a completed step', async () => {
    h = await createHarness({ script: { a: () => ({ status: 'partial', summary: 'some', result: { x: 1 } }) } })
    const r = await h.run(['a', 'b'])
    expect((await r.get()).status).toBe('Completed')
    expect(h.runner).toHaveBeenCalledTimes(2)
  })

  it('has no hidden git tail: a delivery completes when its last node succeeds', async () => {
    h = await createHarness()
    const r = await h.run(['a'])
    const d = await r.get()
    expect(d.status).toBe('Completed')
    expect(d.prUrl ?? null).toBeNull()
    expect(h.workspace.prepare).toHaveBeenCalledTimes(1)
  })
})

describe('gates', () => {
  it('pauses at a gate with the step awaiting approval', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    const d = await r.get()
    expect(d.status).toBe('Paused')
    expect(d.currentNodeId).toBe('n2')
    expect(d.steps.find((s) => s.nodeId === 'n2')!.status).toBe('AwaitingApproval')
    expect(h.eventTypes()).toContain('gate_reached')
    expect(h.runner.mock.calls.some((c) => c[0].nodeLabel === 'b')).toBe(false)
  })

  it('approve records approver, timestamp and comment, then resumes to completion', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    const res = await h.engine.approveGate(r.delivery.id, ' looks good ')
    expect(res.success).toBe(true)
    await h.engine.whenIdle(r.delivery.id)
    const d = await r.get()
    expect(d.status).toBe('Completed')
    const gate = d.steps.find((s) => s.nodeId === 'n2')!
    expect(gate.status).toBe('Completed')
    expect(gate.output).toMatchObject({ approvedBy: 'dev@example.com', reviewComment: 'looks good' })
    expect(gate.output!.approvedAt).toBeTruthy()
    expect(h.runner.mock.calls.some((c) => c[0].nodeLabel === 'b')).toBe(true)
    expect(h.eventTypes()).toContain('gate_approved')
  })

  it('does not re-run steps that completed before the gate', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    await h.engine.approveGate(r.delivery.id)
    await h.engine.whenIdle(r.delivery.id)
    expect(h.runner.mock.calls.filter((c) => c[0].nodeLabel === 'a')).toHaveLength(1)
  })

  it('reject requires a non-empty comment and changes nothing without one', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1'])
    const res = await h.engine.rejectGate(r.delivery.id, '   ')
    expect(res.success).toBe(false)
    expect((await r.get()).status).toBe('Paused')
  })

  it('reject fails the delivery and records who/when/why', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    const res = await h.engine.rejectGate(r.delivery.id, 'wrong approach')
    expect(res.success).toBe(true)
    const d = await r.get()
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toMatch(/wrong approach/)
    const gate = d.steps.find((s) => s.nodeId === 'n2')!
    expect(gate.status).toBe('Failed')
    expect(gate.output).toMatchObject({ rejectedBy: 'dev@example.com', reviewComment: 'wrong approach' })
    expect(gate.output!.rejectedAt).toBeTruthy()
    expect(h.eventTypes()).toEqual(expect.arrayContaining(['gate_rejected', 'failed']))
  })

  it('approve/reject error when the delivery is not awaiting approval', async () => {
    h = await createHarness()
    const r = await h.run(['a'])
    expect((await h.engine.approveGate(r.delivery.id)).success).toBe(false)
    expect((await h.engine.rejectGate(r.delivery.id, 'x')).success).toBe(false)
  })

  it('a double-fired approve only resumes once', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    const [x, y] = await Promise.all([h.engine.approveGate(r.delivery.id), h.engine.approveGate(r.delivery.id)])
    expect([x.success, y.success].sort()).toEqual([false, true])
    await h.engine.whenIdle(r.delivery.id)
    expect(h.runner.mock.calls.filter((c) => c[0].nodeLabel === 'b')).toHaveLength(1)
  })
})

describe('cancel', () => {
  it('cancels mid-step: Cancelled stays, even when the aborted runner reports failed', async () => {
    const block = blockingScript('b')
    h = await createHarness({ script: block.script })
    const { delivery } = await h.mkDelivery(['a', 'b', 'c'])
    await h.engine.start(delivery.id)
    await block.started.promise
    const res = await h.engine.cancel(delivery.id)
    expect(res.success).toBe(true)
    await h.engine.whenIdle(delivery.id)
    const d = (await h.store.getDelivery(delivery.id))!
    expect(d.status).toBe('Cancelled')
    expect(h.eventTypes()).toContain('cancelled')
    expect(h.eventTypes()).not.toContain('failed')
    expect(h.runner.mock.calls.some((c) => c[0].nodeLabel === 'c')).toBe(false)
    expect(d.steps.find((s) => s.nodeId === 'n2')!.status).toBe('Cancelled') // ghost Running step closed out
  })

  it('aborts the signal handed to the in-flight runner', async () => {
    const block = blockingScript('a')
    h = await createHarness({ script: block.script })
    const { delivery } = await h.mkDelivery(['a'])
    await h.engine.start(delivery.id)
    await block.started.promise
    const signal = h.runner.mock.calls[0][0].signal
    expect(signal.aborted).toBe(false)
    await h.engine.cancel(delivery.id)
    expect(signal.aborted).toBe(true)
    await h.engine.whenIdle(delivery.id)
  })

  it('can resume a cancelled delivery and finishes only the remaining steps', async () => {
    const block = blockingScript('b')
    h = await createHarness({ script: block.script })
    const { delivery } = await h.mkDelivery(['a', 'b', 'c'])
    await h.engine.start(delivery.id)
    await block.started.promise
    await h.engine.cancel(delivery.id)
    await h.engine.whenIdle(delivery.id)

    delete h.script.b
    const res = await h.engine.resume(delivery.id)
    expect(res.success).toBe(true)
    await h.engine.whenIdle(delivery.id)
    expect((await h.store.getDelivery(delivery.id))!.status).toBe('Completed')
    expect(h.runner.mock.calls.filter((c) => c[0].nodeLabel === 'a')).toHaveLength(1)
    expect(h.runner.mock.calls.filter((c) => c[0].nodeLabel === 'c')).toHaveLength(1)
  })

  it('cancels an idle paused delivery and refuses to cancel a finished one', async () => {
    h = await createHarness()
    const paused = await h.run(['gate1'])
    expect((await h.engine.cancel(paused.delivery.id)).success).toBe(true)
    expect((await paused.get()).status).toBe('Cancelled')
    const done = await h.run(['a'])
    expect((await h.engine.cancel(done.delivery.id)).success).toBe(false)
    expect((await done.get()).status).toBe('Completed')
  })
})

describe('resume', () => {
  it('refuses to resume a Completed or Pending delivery; a Failed one resumes from its failed step', async () => {
    h = await createHarness()
    const done = await h.run(['a'])
    expect((await h.engine.resume(done.delivery.id)).success).toBe(false)
    let boom = true
    h.script.a = () => { if (boom) throw new Error('x'); return ok('a') }
    const failed = await h.run(['a'])
    boom = false
    expect((await h.engine.resume(failed.delivery.id)).success).toBe(true)
    await h.engine.whenIdle(failed.delivery.id)
    expect((await h.store.getDelivery(failed.delivery.id))!.status).toBe('Completed')
    const pending = await h.mkDelivery(['a'])
    expect((await h.engine.resume(pending.delivery.id)).success).toBe(false)
  })

  it('resume after a pause continues at the first incomplete node', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    // Mark the gate completed as if approved out-of-band, then resume directly.
    await h.store.updateDelivery(r.delivery.id, (d) => {
      d.steps.find((s) => s.nodeId === 'n2')!.status = 'Completed'
    })
    expect((await h.engine.resume(r.delivery.id)).success).toBe(true)
    await h.engine.whenIdle(r.delivery.id)
    expect((await r.get()).status).toBe('Completed')
  })

  it('completes straight away when every node already has a completed step', async () => {
    h = await createHarness()
    const r = await h.run(['a'])
    await h.store.updateDelivery(r.delivery.id, (d) => { d.status = 'Interrupted' })
    const res = await h.engine.resume(r.delivery.id)
    expect(res.success).toBe(true)
    expect((await r.get()).status).toBe('Completed')
    expect(h.runner).toHaveBeenCalledTimes(1)
  })

  it('previewResume reports where it would resume and the reconstructed context', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'gate1', 'b'])
    await h.store.updateDelivery(r.delivery.id, (d) => { d.steps.find((s) => s.nodeId === 'n2')!.status = 'Completed' })
    const prev = await h.engine.previewResume(r.delivery.id)
    expect(prev.success).toBe(true)
    expect(prev.preview).toMatchObject({
      resumeNodeId: 'n3', resumeNodeLabel: 'b', lastCompletedNodeLabel: 'gate1', hasPriorAttempt: false, allNodesCompleted: false,
    })
    expect(prev.preview!.reconstructedContextKeys).toContain('aOut')
  })
})

describe('crash recovery', () => {
  it('marks a Running delivery with no active run Interrupted on boot, then resume completes it', async () => {
    h = await createHarness()
    const { delivery } = await h.mkDelivery(['a', 'b', 'c'])
    // Simulate a kill -9 mid-run: step a done, step b Running, delivery Running, no process.
    await h.store.updateDelivery(delivery.id, (d) => {
      d.status = 'Running'
      d.workspacePath = h.workspaceDir
      d.steps.push(
        { nodeId: 'n1', itemKey: null, blockName: 'a', status: 'Completed', output: { status: 'success', summary: '', result: { aOut: true } } },
        { nodeId: 'n2', itemKey: null, blockName: 'b', status: 'Running' },
      )
    })

    const rebooted = h.build() // fresh engine == fresh process
    expect(await rebooted.reconcileOnBoot()).toBe(1)
    const d1 = (await h.store.getDelivery(delivery.id))!
    expect(d1.status).toBe('Interrupted')
    expect(d1.steps.find((s) => s.nodeId === 'n2')!.status).toBe('Interrupted')
    expect(h.eventTypes()).toContain('interrupted')

    expect((await rebooted.resume(delivery.id)).success).toBe(true)
    await rebooted.whenIdle(delivery.id)
    expect((await h.store.getDelivery(delivery.id))!.status).toBe('Completed')
    expect(h.runner.mock.calls.map((c) => c[0].nodeLabel)).toEqual(['b', 'c'])
    expect(h.runner.mock.calls[0][0].deliveryContext.previousStepsResults).toMatchObject({ aOut: true })
  })

  it('reconcile ignores deliveries that are not Running and counts none', async () => {
    h = await createHarness()
    await h.run(['a'])
    await h.run(['gate1'])
    await h.mkDelivery(['a'])
    expect(await h.build().reconcileOnBoot()).toBe(0)
  })

  it('shutdown aborts the in-flight run and persists Interrupted (resumable)', async () => {
    const block = blockingScript('b')
    h = await createHarness({ script: block.script })
    const { delivery } = await h.mkDelivery(['a', 'b'])
    await h.engine.start(delivery.id)
    await block.started.promise
    await h.engine.shutdown()
    const d = (await h.store.getDelivery(delivery.id))!
    expect(d.status).toBe('Interrupted')
    delete h.script.b
    expect((await h.engine.resume(delivery.id)).success).toBe(true)
    await h.engine.whenIdle(delivery.id)
    expect((await h.store.getDelivery(delivery.id))!.status).toBe('Completed')
  })
})

describe('DS1 large payload storage', () => {
  const big = { blob: 'x'.repeat(2000) }

  it('keeps small outputs inline', async () => {
    h = await createHarness({ ds1ThresholdBytes: 10_000, script: { a: () => ok('a', big) } })
    const r = await h.run(['a'])
    const out = (await r.get()).steps[0].output!
    expect(out.isTruncated).toBeFalsy()
    expect(out.result).toMatchObject(big)
  })

  it('stores large outputs under runs/{deliveryId}, leaving a marker in the document', async () => {
    h = await createHarness({ ds1ThresholdBytes: 500, script: { a: () => ok('a', big) } })
    const r = await h.run(['a', 'b'])
    const out = (await r.get()).steps[0].output!
    expect(out.isTruncated).toBe(true)
    expect(out.outputFileRef).toMatch(/^outputs\/n1-\d+\.json$/)
    expect(out.result).toMatchObject({ truncated: true })
    const stored = JSON.parse(await fs.readFile(path.join(h.runsDir, r.delivery.id, out.outputFileRef!), 'utf-8'))
    expect(stored.blob).toBe(big.blob)
    // Downstream step in the same run sees the FULL result, not the marker.
    expect(h.runner.mock.calls[1][0].deliveryContext.previousStepsResults).toMatchObject(big)
  })

  it('writes nothing into the workspace (worktree stays clean)', async () => {
    h = await createHarness({ ds1ThresholdBytes: 500, script: { a: () => ok('a', big) } })
    await h.run(['a'], { storeFullContext: true })
    expect(await fs.readdir(h.workspaceDir)).toEqual([])
  })

  it('reloads the full output from file when resuming (no truncated marker leaks into context)', async () => {
    h = await createHarness({ ds1ThresholdBytes: 500, script: { a: () => ok('a', big) } })
    const r = await h.run(['a', 'gate1', 'b'])
    await h.engine.approveGate(r.delivery.id)
    await h.engine.whenIdle(r.delivery.id)
    const ctxB = h.runner.mock.calls.find((c) => c[0].nodeLabel === 'b')![0].deliveryContext
    expect(ctxB.previousStepsResults).toMatchObject(big)
    expect(ctxB.previousStepsResults).not.toHaveProperty('truncated')
  })

  it('previewResume reconstructs keys from the stored file too', async () => {
    h = await createHarness({ ds1ThresholdBytes: 500, script: { a: () => ok('a', big) } })
    const r = await h.run(['a', 'gate1'])
    await h.store.updateDelivery(r.delivery.id, (d) => { d.steps[1].status = 'Completed' })
    const prev = await h.engine.previewResume(r.delivery.id)
    expect(prev.preview!.reconstructedContextKeys).toContain('blob')
  })

  it('stores a large context snapshot to file only when storeFullContext is on', async () => {
    h = await createHarness({ ds1ThresholdBytes: 500 })
    const on = await h.run(['a'], { storeFullContext: true, inputs: big })
    const stepOn = (await on.get()).steps[0]
    expect(stepOn.isContextTruncated).toBe(true)
    expect(stepOn.contextFileRef).toMatch(/^inputs\//)
    const off = await h.run(['a'], { storeFullContext: false, inputs: big })
    expect((await off.get()).steps[0].contextSnapshot).toBeUndefined()
  })

  it('fails the step (instead of persisting inline) when the file cannot be written', async () => {
    h = await createHarness({ ds1ThresholdBytes: 500, script: { a: () => ok('a', big) } })
    // Make runs/ a plain file so mkdir of runs/{id} fails.
    await fs.writeFile(h.runsDir, 'not a directory')
    const r = await h.run(['a'])
    const d = await r.get()
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toMatch(/Failed to store step output/)
  })
})

describe('step records', () => {
  it('keeps exactly one record per (nodeId, itemKey) across a run', async () => {
    h = await createHarness()
    const r = await h.run(['a', 'b'])
    const d = await r.get()
    expect(d.steps).toHaveLength(2)
    expect(new Set(d.steps.map((s) => `${s.nodeId}|${s.itemKey}`)).size).toBe(2)
  })

  it('replaces the prior attempt when a node re-runs after resume (no stale output)', async () => {
    h = await createHarness({ script: { b: () => { throw new Error('first try fails') } } })
    const r = await h.run(['a', 'b'])
    expect((await r.get()).status).toBe('Failed')
    await h.store.updateDelivery(r.delivery.id, (d) => { d.status = 'Interrupted' })
    delete h.script.b
    await h.engine.resume(r.delivery.id)
    await h.engine.whenIdle(r.delivery.id)
    const d = await r.get()
    expect(d.steps.filter((s) => s.nodeId === 'n2')).toHaveLength(1)
    expect(d.steps.find((s) => s.nodeId === 'n2')!.output!.errorMessage).toBeUndefined()
    expect(d.status).toBe('Completed')
  })
})

describe('pinned block versions (D13)', () => {
  it('runs the block version the delivery was created against, not the latest', async () => {
    h = await createHarness({ script: { A: (input) => ({ status: 'success', summary: input.block.description, result: { desc: input.block.description } }) } })
    const block = await h.mkBlock({ description: 'v1 behaviour' })
    await h.store.publish('block', block.id)
    const pipeline = await h.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'n1', label: 'A', blockId: block.id, position: { x: 0, y: 0 } }], edges: [] })
    const delivery = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    // the block moves on after the delivery was created
    await h.store.updateBlock(block.id, { description: 'v2 behaviour' })
    await h.store.publish('block', block.id)
    await h.engine.start(delivery.id)
    await h.engine.whenIdle(delivery.id)
    const done = await h.store.getDelivery(delivery.id)
    expect(done?.status).toBe('Completed')
    expect(done?.steps[0].output?.result).toMatchObject({ desc: 'v1 behaviour' })
  })
})
