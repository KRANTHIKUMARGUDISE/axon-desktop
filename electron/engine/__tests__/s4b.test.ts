import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHarness, ok, deferred } from './harness'
import type { Harness } from './harness'
import { createSnapshotService } from '../../workspace/snapshots'
import type { PipelineNode, PipelineEdge, BlockInput } from '../../../shared'

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-snap-'))
  tmp.push(dir)
  await git(dir, 'init', '-q')
  await git(dir, 'config', 'core.autocrlf', 'false')
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
const refs = async (repo: string) => (await git(repo, 'for-each-ref', 'refs/axon/')).trim()
const calls = (label: string) => h.runner.mock.calls.map((c) => c[0]).filter((i) => i.nodeLabel === label)
const run = async (id: string) => { await h.engine.start(id); await h.engine.whenIdle(id) }
const mkDelivery = (pipelineId: string, ticketId = 'T-1') =>
  h.store.createDelivery({ ticketId, title: 't', pipelineId, repoUrl: '', workspaceType: 'Default' })

const LIST = [{ name: 'work', type: 'WorkItemList', itemFields: ['repo'] }]
async function mkForEach(opts: { body: string[]; items?: unknown[]; bodyReq?: string[] }) {
  const block = (over: Partial<BlockInput>) => h.mkBlock({ contextMode: 'Selective', ...over })
  const planner = await block({ name: 'planner', outputSchema: LIST })
  const nodes: PipelineNode[] = [
    { id: 'plan', label: 'plan', blockId: planner.id, position: pos },
    { id: 'fe', type: 'forEach', blockId: '', label: 'fe', position: pos },
  ]
  const edges: PipelineEdge[] = [e('plan', 'fe')]
  let prev = ''
  for (const name of opts.body) {
    const b = await block({ name, contextRequirements: opts.bodyReq ?? ['item', 'task'] })
    nodes.push({ id: name, label: name, blockId: b.id, parentId: 'fe', position: pos })
    if (prev) edges.push(e(prev, name))
    prev = name
  }
  const pipeline = await h.store.createPipeline({ name: 'P', description: '', nodes, edges })
  const delivery = await mkDelivery(pipeline.id)
  h.script.plan = () => ok('plan', { work: { items: opts.items ?? [{ key: 'one', task: 'do', repo: 'r' }] } })
  return delivery
}

describe('workspace snapshots (agent standard rule 9)', () => {
  it('a failed attempt is left in the folder with its ref kept; resume restores the pre-step state; Completed deletes the refs', async () => {
    const repo = await mkRepo()
    h = await createHarness({ snapshots: createSnapshotService(), workspace: { resolveCwd: async () => repo } })
    const d = await mkForEach({ body: ['coder', 'reviewer'] })
    let attempt = 0
    h.script.coder = async () => { await fs.writeFile(path.join(repo, 'coder.txt'), 'coded\n'); return ok('coder') }
    h.script.reviewer = async () => {
      attempt++
      await fs.writeFile(path.join(repo, 'review.txt'), `partial ${attempt}\n`)
      await fs.appendFile(path.join(repo, 'base.txt'), 'review-edit\n')
      if (attempt === 1) return { status: 'failed' as const, summary: 'boom', errorMessage: 'boom', result: {} }
      return ok('reviewer')
    }
    await run(d.id)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Failed')
    // after the failure: the folder is left as the agent left it (debugging) and the snapshot refs are kept
    expect(await fs.readFile(path.join(repo, 'coder.txt'), 'utf8')).toBe('coded\n')
    expect(await fs.readFile(path.join(repo, 'review.txt'), 'utf8')).toBe('partial 1\n')
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\nreview-edit\n')
    expect(await refs(repo)).toContain(`refs/axon/${d.id}/coder_one`)
    expect(await refs(repo)).toContain(`refs/axon/${d.id}/reviewer_one`)

    expect((await h.engine.resume(d.id)).success).toBe(true)
    await h.engine.whenIdle(d.id)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Completed')
    expect(calls('coder')).toHaveLength(1) // not re-run
    // restored before re-running: the reviewer's first attempt is gone (edit applied once), the coder's work stays
    expect(await fs.readFile(path.join(repo, 'coder.txt'), 'utf8')).toBe('coded\n')
    expect(await fs.readFile(path.join(repo, 'review.txt'), 'utf8')).toBe('partial 2\n')
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\nreview-edit\n')
    expect((await git(repo, 'rev-list', '--count', 'HEAD')).trim()).toBe('1') // agents never commit
    expect(await refs(repo)).toBe('')
  })

  it('an item that appends a line, fails and is resumed leaves the line once', async () => {
    const repo = await mkRepo()
    h = await createHarness({ snapshots: createSnapshotService(), workspace: { resolveCwd: async () => repo } })
    const d = await mkForEach({ body: ['appender'] })
    let n = 0
    h.script.appender = async () => {
      await fs.appendFile(path.join(repo, 'base.txt'), 'appended\n')
      return ++n === 1 ? { status: 'failed' as const, summary: 'x', errorMessage: 'x', result: {} } : ok('appender')
    }
    await run(d.id)
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\nappended\n') // failed attempt left in place
    await h.engine.resume(d.id)
    await h.engine.whenIdle(d.id)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Completed')
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\nappended\n')
    expect(await refs(repo)).toBe('')
  })

  it('restores a snapshot that survived a crash when the step runs again, and skips non-git folders', async () => {
    const snaps = createSnapshotService()
    const repo = await mkRepo()
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'wip\n') // untracked work present at snapshot time
    expect(await snaps.ensure(repo, 'del1', 'n1')).toBe('snapshotted')
    await fs.appendFile(path.join(repo, 'base.txt'), 'garbage\n')
    await fs.writeFile(path.join(repo, 'new.txt'), 'x')
    await fs.rm(path.join(repo, 'dirty.txt'))
    expect(await snaps.ensure(repo, 'del1', 'n1')).toBe('restored')
    expect(await fs.readFile(path.join(repo, 'base.txt'), 'utf8')).toBe('base\n')
    expect(await fs.readFile(path.join(repo, 'dirty.txt'), 'utf8')).toBe('wip\n')
    await expect(fs.stat(path.join(repo, 'new.txt'))).rejects.toThrow()
    expect(await git(repo, 'status', '--porcelain')).toBe('?? dirty.txt\n') // real index and branch untouched
    await snaps.dropAll('del1', [repo])
    expect(await refs(repo)).toBe('')

    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-plain-'))
    tmp.push(plain)
    expect(await snaps.ensure(plain, 'del1', 'n1')).toBe('skipped')
  })
})

describe('snapshot ref lifetime', () => {
  async function failedDelivery() {
    const repo = await mkRepo()
    h = await createHarness({ snapshots: createSnapshotService(), workspace: { resolveCwd: async () => repo } })
    const d = await mkForEach({ body: ['coder'] })
    h.script.coder = async () => ({ status: 'failed' as const, summary: 'x', errorMessage: 'x', result: {} })
    await run(d.id)
    return { repo, d }
  }

  it('cancelling a running delivery deletes the refs and leaves the folder as it was', async () => {
    const repo = await mkRepo()
    h = await createHarness({ snapshots: createSnapshotService(), workspace: { resolveCwd: async () => repo } })
    const d = await mkForEach({ body: ['coder'] })
    const gate = deferred<void>()
    h.script.coder = async () => { await fs.writeFile(path.join(repo, 'wip.txt'), 'x'); await gate.promise; return ok('coder') }
    await h.engine.start(d.id)
    await vi.waitFor(async () => expect(await refs(repo)).toContain('coder_one'), { timeout: 20_000, interval: 100 })
    await h.engine.cancel(d.id)
    gate.resolve()
    await h.engine.whenIdle(d.id)
    expect(await refs(repo)).toBe('')
    expect(await fs.readFile(path.join(repo, 'wip.txt'), 'utf8')).toBe('x') // not rolled back
  })

  it('discarding deletes the refs', async () => {
    const { repo, d } = await failedDelivery()
    expect(await refs(repo)).not.toBe('')
    await h.engine.discardSnapshots(d.id)
    expect(await refs(repo)).toBe('')
  })

  it('cleanup removes refs of Failed deliveries older than 14 days only', async () => {
    const { repo, d } = await failedDelivery()
    expect(await h.engine.cleanupFailedSnapshots(14)).toBe(0) // just failed
    expect(await refs(repo)).not.toBe('')
    await h.store.updateDelivery(d.id, (x) => { x.completedAt = new Date(Date.now() - 15 * 86_400_000).toISOString() })
    expect(await h.engine.cleanupFailedSnapshots(14)).toBe(1)
    expect(await refs(repo)).toBe('')
  })
})

describe('output validation, contracts, summary cap', () => {
  it('a success missing or mistyping a declared output field fails the step naming the field', async () => {
    h = await createHarness()
    const b = await h.mkBlock({ name: 'a', outputSchema: ['report', { name: 'count', type: 'number' }] })
    const p = await h.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'a', label: 'a', blockId: b.id, position: pos }], edges: [] })
    const d = await mkDelivery(p.id)
    h.script.a = () => ok('a', { report: 'r' })
    await run(d.id)
    const got = (await h.store.getDelivery(d.id))!
    expect(got.status).toBe('Failed')
    expect(got.errorMessage).toMatch(/count/)

    h.script.a = () => ok('a', { report: 'r', count: 'three' })
    const d2 = await mkDelivery(p.id, 'T-2')
    await run(d2.id)
    expect((await h.store.getDelivery(d2.id))!.errorMessage).toMatch(/"count" must be of type number/)
  })

  it('an item missing a field the consumer requires fails the producing step naming item and field', async () => {
    h = await createHarness()
    const planner = await h.mkBlock({ name: 'planner', outputSchema: LIST })
    const prov = await h.mkBlock({ name: 'prov', requiredItemFields: ['repo'], outputSchema: [{ name: 'work', type: 'WorkItemList', itemFields: ['repo'] }] })
    const p = await h.store.createPipeline({
      name: 'P', description: '',
      nodes: [{ id: 'plan', label: 'plan', blockId: planner.id, position: pos }, { id: 'prov', label: 'prov', blockId: prov.id, position: pos }],
      edges: [e('plan', 'prov')],
    })
    const d = await mkDelivery(p.id)
    h.script.plan = () => ok('plan', { work: { items: [{ key: 'a', task: 't', repo: 'x' }, { key: 'b', task: 't' }] } })
    await run(d.id)
    const got = (await h.store.getDelivery(d.id))!
    expect(got.status).toBe('Failed')
    expect(got.errorMessage).toMatch(/key "b"/)
    expect(got.errorMessage).toMatch(/required item field "repo"/)
    expect(got.steps.find((s) => s.nodeId === 'plan')?.status).toBe('Failed')
  })

  it('completedItems summaries are capped at 500 characters', async () => {
    h = await createHarness()
    const d = await mkForEach({ body: ['w'], items: [{ key: 'a', task: 't' }, { key: 'b', task: 't' }], bodyReq: ['item', 'task', 'completedItems'] })
    h.script.w = () => ({ status: 'success', summary: 'x'.repeat(2000), result: { wOut: true } })
    await run(d.id)
    const second = calls('w')[1].deliveryContext.currentInputs.completedItems as { summary: string }[]
    expect(second).toHaveLength(1)
    expect(second[0].summary.length).toBeLessThanOrEqual(500)
  })
})

describe('repoCatalog context field', () => {
  const entries = [
    { name: 'web', description: 'React frontend', tags: ['frontend'] },
    { name: 'api', description: 'Payments API', tags: ['backend', 'payments'] },
  ]
  async function single(over: Partial<BlockInput>) {
    const b = await h.mkBlock({ name: 'planner', ...over })
    const p = await h.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'plan', label: 'planner', blockId: b.id, position: pos }], edges: [] })
    return mkDelivery(p.id)
  }

  it('is injected only when declared, as compact lines without URLs, and records the catalog version', async () => {
    h = await createHarness({ getRepoCatalog: async () => ({ entries, version: 'abc123' }) })
    const none = await single({ contextMode: 'Selective', contextRequirements: ['somethingElse?'] })
    await run(none.id)
    expect(calls('planner')[0].deliveryContext.currentInputs).not.toHaveProperty('repoCatalog')
    expect((await h.store.getDelivery(none.id))!.catalogVersion).toBeUndefined()

    h.runner.mockClear()
    const yes = await single({ contextMode: 'Selective', contextRequirements: ['repoCatalog'] })
    await run(yes.id)
    const cat = calls('planner')[0].deliveryContext.currentInputs.repoCatalog as string
    expect(cat).toBe('web: React frontend [frontend]\napi: Payments API [backend, payments]')
    expect(cat).not.toMatch(/https?:|git@/)
    const got = (await h.store.getDelivery(yes.id))!
    expect(got.catalogVersion).toBe('abc123')
    expect(got.steps[0].catalogStats?.repos).toBe(2)
  })

  it('catalogTags keeps only repos with one of the tags', async () => {
    h = await createHarness({ getRepoCatalog: async () => ({ entries }) })
    const d = await single({ contextMode: 'Selective', contextRequirements: ['repoCatalog'], catalogTags: ['payments'] })
    await run(d.id)
    expect(calls('planner')[0].deliveryContext.currentInputs.repoCatalog).toBe('api: Payments API [backend, payments]')
  })
})
