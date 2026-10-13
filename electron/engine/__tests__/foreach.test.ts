import { describe, it, expect, afterEach } from 'vitest'
import { createHarness, ok, deferred } from './harness'
import type { Harness } from './harness'
import { DeliveryEventSchema } from '../../../shared'
import type { PipelineNode, PipelineEdge, BlockInput } from '../../../shared'
import { HUMAN_GATE_BLOCK_ID } from '../../store/seed'

let h: Harness
afterEach(async () => { await h?.cleanup() })

const pos = { x: 0, y: 0 }
const e = (s: string, t: string): PipelineEdge => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t })
const LIST = [{ name: 'work', type: 'WorkItemList' }]

// plan -> [prov] -> ForEach(code -> review) -> sum -> [gate -> pr]; labels are the runner-script keys.
async function build(opts: { prov?: boolean; tail?: boolean; onEmpty?: 'skip' | 'fail'; maxItems?: number; items?: unknown[]; deliveryWorkspace?: string } = {}) {
  const block = (over: Partial<BlockInput>) => h.mkBlock({ contextMode: 'Selective', ...over })
  const planner = await block({ name: 'planner', outputSchema: LIST })
  const prov = await block({ name: 'prov', role: 'IO', artifactName: 'workspace-provisioner', outputSchema: [{ name: 'work', type: 'WorkItemList' }, 'provisionedRepos'] })
  const code = await block({ name: 'code', contextRequirements: ['item', 'task', 'shared', 'itemKey', 'completedItems'] })
  const review = await block({ name: 'review', contextRequirements: ['item', 'task', 'codeOut'] })
  const sum = await block({ name: 'sum', contextRequirements: ['itemResults'] })
  const pr = await block({ name: 'pr', artifactName: 'pr-creator', contextRequirements: ['stepCwds'] })

  const nodes: PipelineNode[] = [{ id: 'plan', label: 'plan', blockId: planner.id, position: pos }]
  const edges: PipelineEdge[] = []
  let prev = 'plan'
  const link = (id: string) => { edges.push(e(prev, id)); prev = id }
  if (opts.prov) {
    nodes.push({ id: 'prov', label: 'prov', blockId: prov.id, position: pos })
    link('prov')
  }
  nodes.push(
    { id: 'fe', type: 'forEach', blockId: '', label: 'fe', onEmpty: opts.onEmpty, maxItems: opts.maxItems, position: pos },
    { id: 'code', label: 'code', blockId: code.id, parentId: 'fe', position: pos },
    { id: 'review', label: 'review', blockId: review.id, parentId: 'fe', position: pos },
  )
  edges.push(e('code', 'review'))
  link('fe')
  nodes.push({ id: 'sum', label: 'sum', blockId: sum.id, position: pos })
  link('sum')
  if (opts.tail) {
    nodes.push({ id: 'gate', label: 'gate1', blockId: HUMAN_GATE_BLOCK_ID, position: pos, config: { reason: 'A human decides here' } }, { id: 'pr', label: 'pr', blockId: pr.id, position: pos })
    link('gate')
    link('pr')
  }
  const pipeline = await h.store.createPipeline({ name: 'FE', description: '', nodes, edges })
  const delivery = await h.store.createDelivery({
    ticketId: 'T-1', title: 'Test', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default', workspacePath: opts.deliveryWorkspace,
  })
  const items = opts.items ?? [
    { key: 'b', task: 'second', repo: 'api', extra: { n: 2 } },
    { key: 'a', task: 'first', repo: 'web' },
  ]
  const list = { items, shared: { team: 'x' } }
  h.script.plan = () => ok('plan', { work: list })
  h.script.prov = () => ok('prov', {
    work: { ...list, items: items.map((i) => ({ ...(i as object), workspacePath: `/w/${(i as { repo: string }).repo}` })) },
    provisionedRepos: [],
  })
  return { delivery, pipeline }
}

const calls = (label: string) => h.runner.mock.calls.map((c) => c[0]).filter((i) => i.nodeLabel === label)
const run = async (id: string) => { await h.engine.start(id); await h.engine.whenIdle(id) }
const get = async (id: string) => (await h.store.getDelivery(id))!

describe('ForEach executor (D16/D17)', () => {
  it('runs the predecessor list in list order, with task/shared/item/itemKey/completedItems and each item workspacePath as cwd', async () => {
    h = await createHarness()
    const { delivery } = await build({ prov: true, tail: true })
    await run(delivery.id)

    const code = calls('code')
    expect(code.map((c) => c.deliveryContext.currentInputs.itemKey)).toEqual(['b', 'a']) // list order, not sorted
    expect(code.map((c) => c.workspacePath)).toEqual(['/w/api', '/w/web']) // item.workspacePath from the provisioner
    expect(code[1].deliveryContext.currentInputs).toMatchObject({
      task: 'first', shared: { team: 'x' }, itemKey: 'a',
      item: { key: 'a', task: 'first', repo: 'web', workspacePath: '/w/web' },
      completedItems: [{ key: 'b', status: 'completed' }],
    })
    expect(code[0].deliveryContext.currentInputs.item).toMatchObject({ extra: { n: 2 } }) // extra fields untouched
    expect(calls('review')[0].deliveryContext.previousStepsResults).toMatchObject({ codeOut: true })

    const d = await get(delivery.id)
    expect(d.steps.filter((s) => s.nodeId === 'code').map((s) => s.itemKey)).toEqual(['b', 'a'])
    expect(d.steps.find((s) => s.nodeId === 'fe')).toMatchObject({ itemKey: null, status: 'Completed' })
    expect(d.itemPlan?.fe.items.map((i) => i.key)).toEqual(['b', 'a'])
    // every step records the folder it ran in; PR Creator derives its repos from those (never from agent output)
    expect(d.steps.filter((s) => s.nodeId === 'code').map((s) => s.cwd)).toEqual(['/w/api', '/w/web'])
    expect(d.steps.find((s) => s.nodeId === 'plan')?.cwd).toBe(h.workspaceDir)
    expect(d.steps.filter((s) => s.nodeId !== 'fe').every((s) => !!s.cwd)).toBe(true) // the ForEach container itself runs no block
    const itemResults = calls('sum')[0].deliveryContext.previousStepsResults.itemResults as { key: string; status: string; summary: string }[]
    expect(itemResults.map((r) => [r.key, r.status])).toEqual([['b', 'completed'], ['a', 'completed']])
    for (const ev of h.events) expect(() => DeliveryEventSchema.parse(ev)).not.toThrow()
    expect(h.events.filter((ev) => ev.type === 'item_started').map((ev) => ev.type === 'item_started' && `${ev.itemKey} ${ev.index + 1}/${ev.total}`)).toEqual(['b 1/2', 'a 2/2'])

    expect(d.status).toBe('Paused')
    h.script.pr = () => ok('pr', { prUrls: [{ repo: 'api', url: 'https://github.com/acme/api/pull/1' }] })
    await h.engine.approveGate(delivery.id)
    await h.engine.whenIdle(delivery.id)
    expect(calls('pr')[0].deliveryContext.currentInputs.stepCwds).toEqual(['/w/api', '/w/web']) // the Delivery Folder itself is not a repo candidate
    const done = await get(delivery.id)
    expect(done.status).toBe('Completed')
    expect(done.prUrl).toBe('https://github.com/acme/api/pull/1')
    expect(h.workspace.release).toHaveBeenCalledTimes(1)
  })

  it('without item paths a node runs in the delivery Workspace path, else the Delivery Folder', async () => {
    h = await createHarness()
    const a = await build({ items: [{ key: 'k', task: 't' }] })
    await run(a.delivery.id)
    expect(calls('code')[0].workspacePath).toBe(h.workspaceDir) // Delivery Folder
    expect(calls('plan')[0].workspacePath).toBe(h.workspaceDir)

    h.runner.mockClear()
    const b = await build({ items: [{ key: 'k', task: 't' }, { key: 'm', task: 'u', workspacePath: '/w/own' }], deliveryWorkspace: '/w/default' })
    h.workspace.prepare = (async (d) => ({ deliveryFolder: h.workspaceDir, workspacePath: d.workspacePath })) as typeof h.workspace.prepare
    await run(b.delivery.id)
    expect(calls('code').map((c) => c.workspacePath)).toEqual(['/w/default', '/w/own']) // item path wins, default path otherwise
    expect(calls('plan')[0].workspacePath).toBe('/w/default')
  })

  it('a failure on item 2 fails the delivery; Resume restarts item 2 only and keeps item 1', async () => {
    h = await createHarness()
    const { delivery } = await build({ items: [{ key: 'one', task: '1' }, { key: 'two', task: '2' }, { key: 'three', task: '3' }] })
    let failTwo = true
    h.script.code = (i) => (i.deliveryContext.currentInputs.itemKey === 'two' && failTwo
      ? { status: 'failed', summary: 'boom', errorMessage: 'boom', result: {} }
      : ok('code'))
    await run(delivery.id)
    let d = await get(delivery.id)
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toMatch(/Item "two" failed at "code": boom/)
    expect(calls('code').map((c) => c.deliveryContext.currentInputs.itemKey)).toEqual(['one', 'two'])
    expect(h.workspace.release).toHaveBeenCalledTimes(1)

    failTwo = false
    h.runner.mockClear()
    expect((await h.engine.resume(delivery.id)).success).toBe(true)
    await h.engine.whenIdle(delivery.id)
    d = await get(delivery.id)
    expect(d.status).toBe('Completed')
    expect(h.workspace.reacquire).toHaveBeenCalled()
    expect(calls('code').map((c) => c.deliveryContext.currentInputs.itemKey)).toEqual(['two', 'three'])
    expect(calls('plan')).toHaveLength(0)
    expect((calls('sum')[0].deliveryContext.previousStepsResults.itemResults as { key: string }[]).map((r) => r.key)).toEqual(['one', 'two', 'three'])
  })

  it.each([
    ['a missing key', [{ key: 'a', task: 't' }, { task: 'x' }], /#2 has no "key"/],
    ['a missing task', [{ key: 'a', task: 't' }, { key: 'b' }], /#2 \(key "b"\) has no "task"/],
    ['a duplicate key', [{ key: 'a', task: 't' }, { key: 'a', task: 'u' }], /Duplicate work item key "a"/],
  ] as const)('fails the producing step, naming the bad item, before any item runs: %s', async (_n, items, msg) => {
    h = await createHarness()
    const { delivery } = await build({ items: items as unknown as unknown[] })
    await run(delivery.id)
    const d = await get(delivery.id)
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toMatch(msg)
    expect(calls('code')).toHaveLength(0)
    const plan = d.steps.find((s) => s.nodeId === 'plan')
    expect(plan).toMatchObject({ status: 'Failed' })
    expect(plan?.output?.errorMessage).toMatch(msg)
  })

  it('a result that is not a list fails the producing step', async () => {
    h = await createHarness()
    const { delivery } = await build()
    h.script.plan = () => ok('plan', { work: 'nope' })
    await run(delivery.id)
    expect((await get(delivery.id)).errorMessage).toMatch(/Not a work-item list/)
    expect(calls('code')).toHaveLength(0)
  })

  it('an empty list fails by default and is skipped when the ForEach says Skip', async () => {
    h = await createHarness()
    const a = await build({ items: [] })
    await run(a.delivery.id)
    const d = await get(a.delivery.id)
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toMatch(/empty/)

    const b = await build({ items: [], onEmpty: 'skip' })
    await run(b.delivery.id)
    expect((await get(b.delivery.id)).status).toBe('Completed')
    expect(calls('sum')[calls('sum').length - 1]?.deliveryContext.previousStepsResults.itemResults).toEqual([])
  })

  it('a workspacePath the port rejects fails that item with the port message', async () => {
    h = await createHarness({
      workspace: {
        resolveCwd: async (_d, item) => {
          if (item === '/etc') throw new Error('Workspace path must be inside the Workspace Root: /etc')
          return item ?? h.workspaceDir
        },
      },
    })
    const { delivery } = await build({ items: [{ key: 'ok1', task: 't' }, { key: 'bad', task: 't', workspacePath: '/etc' }] })
    await run(delivery.id)
    const d = await get(delivery.id)
    expect(d.status).toBe('Failed')
    expect(d.errorMessage).toMatch(/Item "bad" failed at "code": Workspace path must be inside the Workspace Root: \/etc/)
    expect(calls('code').map((c) => c.deliveryContext.currentInputs.itemKey)).toEqual(['ok1'])
  })

  it('releases the workspace when a delivery is cancelled', async () => {
    h = await createHarness()
    const gate = deferred<void>()
    const { delivery } = await build({ items: [{ key: 'a', task: 't' }] })
    h.script.code = async () => { await gate.promise; return ok('code') }
    await h.engine.start(delivery.id)
    await new Promise((r) => setTimeout(r, 50))
    await h.engine.cancel(delivery.id)
    gate.resolve()
    await h.engine.whenIdle(delivery.id)
    expect((await get(delivery.id)).status).toBe('Cancelled')
    expect(h.workspace.release).toHaveBeenCalled()
  })

  it('the same block works standalone in one pipeline and inside a ForEach in another', async () => {
    h = await createHarness()
    const shared = await h.mkBlock({ name: 'shared', contextRequirements: ['x'] })
    const p1 = await h.store.createPipeline({ name: 'solo', description: '', nodes: [{ id: 'n1', label: 'shared', blockId: shared.id, position: pos }], edges: [] })
    const d1 = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: p1.id, repoUrl: '', workspaceType: 'Default' })
    await run(d1.id)
    expect((await get(d1.id)).status).toBe('Completed')

    const planner = await h.mkBlock({ name: 'planner2', outputSchema: LIST })
    const nodes: PipelineNode[] = [
      { id: 'p', label: 'planner2', blockId: planner.id, position: pos },
      { id: 'fe', type: 'forEach', blockId: '', label: 'fe', position: pos },
      { id: 'in', label: 'shared', blockId: shared.id, parentId: 'fe', position: pos },
    ]
    const p2 = await h.store.createPipeline({ name: 'loop', description: '', nodes, edges: [e('p', 'fe')] })
    h.script.planner2 = () => ok('planner2', { work: { items: [{ key: 'k1', task: 'a' }, { key: 'k2', task: 'b' }] } })
    const d2 = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: p2.id, repoUrl: '', workspaceType: 'Default' })
    await run(d2.id)
    expect((await get(d2.id)).status).toBe('Completed')
    expect(calls('shared')).toHaveLength(3)
  })

  it('refuses to start a ForEach without a list-producing predecessor', async () => {
    h = await createHarness()
    const blockX = await h.mkBlock({ name: 'x' })
    const nodes: PipelineNode[] = [
      { id: 'p', label: 'x', blockId: blockX.id, position: pos },
      { id: 'fe', type: 'forEach', blockId: '', label: 'fe', position: pos },
      { id: 'in', label: 'x', blockId: blockX.id, parentId: 'fe', position: pos },
    ]
    const pl = await h.store.createPipeline({ name: 'bad', description: '', nodes, edges: [e('p', 'fe')] })
    const d = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: pl.id, repoUrl: '', workspaceType: 'Default' })
    const res = await h.engine.start(d.id)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Connect a block that returns a work-item list/)
  })
})

describe('blocks receive only their declared inputs (B1)', () => {
  it('a Selective block sees only its declared fields; the chips and snapshot describe exactly that', async () => {
    h = await createHarness()
    const a = await h.mkBlock({ name: 'a' })
    const sel = await h.mkBlock({ name: 'sel', contextMode: 'Selective', contextRequirements: ['aOut'] })
    const full = await h.mkBlock({ name: 'full', contextMode: 'Full' })
    const nodes: PipelineNode[] = [
      { id: 'n1', label: 'a', blockId: a.id, position: pos },
      { id: 'n2', label: 'sel', blockId: sel.id, position: pos },
      { id: 'n3', label: 'full', blockId: full.id, position: pos },
    ]
    const pl = await h.store.createPipeline({ name: 'S', description: '', nodes, edges: [e('n1', 'n2'), e('n2', 'n3')] })
    h.script.a = () => ok('a', { secret: 1, other: 2 })
    const d = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: pl.id, repoUrl: '', workspaceType: 'Default', storeFullContext: true, inputs: { adhoc: 'x' } })
    await run(d.id)
    const selCtx = calls('sel')[0].deliveryContext
    expect(Object.keys({ ...selCtx.previousStepsResults, ...selCtx.currentInputs })).toEqual(['aOut'])
    const done = await get(d.id)
    const selStep = done.steps.find((s) => s.nodeId === 'n2')!
    expect(Object.keys(selStep.contextAvailability ?? {})).toEqual(['aOut']) // no "+N undeclared fields also sent"
    expect(Object.keys(selStep.contextSnapshot ?? {})).toEqual(['aOut'])
    expect(Object.keys(done.steps.find((s) => s.nodeId === 'n3')!.contextAvailability ?? {})).toEqual(expect.arrayContaining(['aOut', 'secret', 'other', 'adhoc']))
  })

  it('optional inputs ("name?") are passed when present and never reported as missing', async () => {
    h = await createHarness()
    const a = await h.mkBlock({ name: 'a' })
    const sel = await h.mkBlock({ name: 'sel', contextMode: 'Selective', contextRequirements: ['aOut', 'later?', 'adhoc?'] })
    const nodes: PipelineNode[] = [
      { id: 'n1', label: 'a', blockId: a.id, position: pos },
      { id: 'n2', label: 'sel', blockId: sel.id, position: pos },
    ]
    const pl = await h.store.createPipeline({ name: 'O', description: '', nodes, edges: [e('n1', 'n2')] })
    const d = await h.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: pl.id, repoUrl: '', workspaceType: 'Default', inputs: { adhoc: 'x' } })
    await run(d.id)
    const ctx = calls('sel')[0].deliveryContext
    expect(Object.keys({ ...ctx.previousStepsResults, ...ctx.currentInputs }).sort()).toEqual(['aOut', 'adhoc'])
    const availability = (await get(d.id)).steps.find((s) => s.nodeId === 'n2')!.contextAvailability ?? {}
    expect(availability).toMatchObject({ aOut: 'available', adhoc: 'available' })
    expect(availability).not.toHaveProperty('later') // absent optional input: not "missing"
  })

  it('a native block (provisioner / PR Creator) gets exactly the inputs it declares', async () => {
    h = await createHarness()
    const { delivery } = await build({ prov: true, tail: true })
    await run(delivery.id)
    await h.engine.approveGate(delivery.id)
    await h.engine.whenIdle(delivery.id)
    const d = await get(delivery.id)
    const pr = calls('pr')[0].deliveryContext
    expect(Object.keys({ ...pr.previousStepsResults, ...pr.currentInputs })).toEqual(['stepCwds'])
    expect(Object.keys(d.steps.find((s) => s.nodeId === 'pr')!.contextAvailability ?? {})).toEqual(['stepCwds'])
  })
})
