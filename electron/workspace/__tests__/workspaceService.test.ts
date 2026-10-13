import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testGit } from '../../registry/__tests__/fixtures'
import { createWorkspaceService } from '../gitWorkspace'
import { createHarness, ok, deferred } from '../../engine/__tests__/harness'
import type { Harness } from '../../engine/__tests__/harness'
import type { Delivery } from '../../../shared'

// D17/D18 against real git repos under a temporary Workspace Root: cwd resolution, root containment,
// clean-tree + lock rules, delivery branch create/restore across completed, failed and cancelled deliveries.

let root: string
let statuses: Record<string, string>
const ident = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']

const svc = () => createWorkspaceService({
  getWorkspaceRoot: () => root,
  makeGit: async (dir) => testGit(dir),
  username: () => 'dev',
  getDelivery: async (id) => (statuses[id] ? ({ status: statuses[id] } as Pick<Delivery, 'status'>) : null),
})

async function makeRepo(name: string, branch = 'main'): Promise<string> {
  const dir = path.join(root, 'repos', name)
  await fs.mkdir(dir, { recursive: true })
  const g = testGit(dir)
  await g.raw(['init', '-b', branch])
  await fs.writeFile(path.join(dir, 'README.md'), 'hi\n')
  await g.raw(['add', '-A'])
  await g.raw([...ident, 'commit', '-m', 'init'])
  return dir
}
const branchOf = async (dir: string) => (await testGit(dir).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
const delivery = (id: string, over: Partial<Delivery> = {}) => ({ id, ticketId: 'PROJ-1', ...over }) as Delivery

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-ws-svc-'))
  statuses = {}
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })

describe('Workspace path checks (D18)', () => {
  it('rejects a path outside the Workspace Root, a non-repo, a dirty tree and a folder locked by another delivery', async () => {
    const s = svc()
    await expect(s.checkWorkspacePath(os.tmpdir())).rejects.toThrow(/must be inside the Workspace Root/)
    const plain = path.join(root, 'plain')
    await fs.mkdir(plain)
    await expect(s.checkWorkspacePath(plain)).rejects.toThrow(/not a git repository/)
    await expect(s.checkWorkspacePath(path.join(root, 'nope'))).rejects.toThrow(/does not exist/)

    const repo = await makeRepo('app')
    await expect(s.checkWorkspacePath(repo)).resolves.toBe(repo)
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'x')
    await expect(s.checkWorkspacePath(repo)).rejects.toThrow(/uncommitted changes/)
    await fs.rm(path.join(repo, 'dirty.txt'))

    statuses.other = 'Running'
    await s.locks.acquire(repo, 'other')
    await expect(s.checkWorkspacePath(repo)).rejects.toThrow(/in use by another delivery/)
  })

  it('takes over a stale lock (its delivery has finished)', async () => {
    const s = svc()
    const repo = await makeRepo('app')
    statuses.old = 'Running'
    await s.locks.acquire(repo, 'old')
    statuses.old = 'Completed'
    await expect(s.checkWorkspacePath(repo)).resolves.toBe(repo)
    await s.locks.acquire(repo, 'new') // does not throw
    expect(await s.locks.ownerOf(repo)).toBeNull() // 'new' is not a known delivery -> not active
  })
})

describe('cwd resolution (D17)', () => {
  it('item path -> delivery Workspace path -> Delivery Folder', async () => {
    const s = svc()
    const folder = path.join(root, 'deliveries', 'd1')
    await fs.mkdir(path.join(folder, 'wt'), { recursive: true })
    const d = delivery('d1', { deliveryFolder: folder })
    expect(await s.port.resolveCwd(d)).toBe(folder)
    expect(await s.port.resolveCwd(delivery('d1', { deliveryFolder: folder, workspacePath: '/w/default' }))).toBe('/w/default')
    expect(await s.port.resolveCwd(d, path.join(folder, 'wt'))).toBe(path.join(folder, 'wt'))
    expect(await s.port.resolveCwd(d, 'wt')).toBe(path.join(folder, 'wt')) // relative to the Delivery Folder
  })

  it('rejects an item workspacePath outside the Workspace Root', async () => {
    const s = svc()
    const d = delivery('d1', { deliveryFolder: path.join(root, 'deliveries', 'd1') })
    await expect(s.port.resolveCwd(d, os.tmpdir())).rejects.toThrow(`Workspace path must be inside the Workspace Root: ${os.tmpdir()}`)
    await expect(s.port.resolveCwd(d, '../../../..')).rejects.toThrow(/must be inside the Workspace Root/)
  })

  it('a repo folder not created by AXON is used only if clean, and locked to one delivery', async () => {
    const s = svc()
    const repo = await makeRepo('x')
    statuses.d1 = 'Running'
    statuses.d2 = 'Running'
    const d1 = delivery('d1', { deliveryFolder: path.join(root, 'deliveries', 'd1') })
    const d2 = delivery('d2', { deliveryFolder: path.join(root, 'deliveries', 'd2') })

    await fs.writeFile(path.join(repo, 'wip.txt'), 'x')
    await expect(s.port.resolveCwd(d1, repo)).rejects.toThrow(/uncommitted changes/)
    await fs.rm(path.join(repo, 'wip.txt'))

    expect(await s.port.resolveCwd(d1, repo)).toBe(repo)
    await fs.writeFile(path.join(repo, 'agent-edit.txt'), 'x') // the owning delivery may edit it
    expect(await s.port.resolveCwd(d1, repo)).toBe(repo)
    await expect(s.port.resolveCwd(d2, repo)).rejects.toThrow(/in use by another delivery/)

    await s.port.release(d1)
    await fs.rm(path.join(repo, 'agent-edit.txt'))
    expect(await s.port.resolveCwd(d2, repo)).toBe(repo)
  })
})

describe('delivery branch lifecycle (D18)', () => {
  let h: Harness
  afterEach(async () => { await h?.cleanup() })

  async function setup(script: Parameters<typeof createHarness>[0] = {}) {
    const s = svc()
    // the service looks deliveries up in the harness store
    const real = createWorkspaceService({
      getWorkspaceRoot: () => root,
      makeGit: async (dir) => testGit(dir),
      username: () => 'dev',
      getDelivery: async (id) => h.store.getDelivery(id),
    })
    void s
    h = await createHarness({ ...script, workspace: real.port })
    const repo = await makeRepo('app', 'trunk')
    const block = await h.mkBlock({ name: 'work' })
    const pl = await h.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'n1', label: 'work', blockId: block.id, position: { x: 0, y: 0 } }], edges: [] })
    const d = await h.store.createDelivery({ ticketId: 'PROJ-9', title: 't', pipelineId: pl.id, repoUrl: '', workspaceType: 'Default', workspacePath: repo })
    return { repo, d, real }
  }
  const lockFiles = async () => (await fs.readdir(path.join(root, '.axon', 'locks')).catch(() => [])).length

  it('creates the delivery branch in the Workspace path and restores the original after Completed', async () => {
    const { repo, d } = await setup()
    let during = ''
    h.script.work = async (i) => { during = await branchOf(i.workspacePath); return ok('work') }
    await h.engine.start(d.id)
    await h.engine.whenIdle(d.id)
    const done = (await h.store.getDelivery(d.id))!
    expect(done.status).toBe('Completed')
    expect(during).toMatch(/^axon\/dev\/PROJ-9-[a-z2-7]{6}$/)
    expect(done.workspaceBase?.originalBranch).toBe('trunk')
    expect(done.deliveryFolder).toBe(path.join(root, 'deliveries', d.id))
    expect(await branchOf(repo)).toBe('trunk')
    expect(await lockFiles()).toBe(0)
  })

  it('restores the original branch after Failed', async () => {
    const { repo, d } = await setup()
    h.script.work = () => ({ status: 'failed', summary: 'x', errorMessage: 'x', result: {} })
    await h.engine.start(d.id)
    await h.engine.whenIdle(d.id)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Failed')
    expect(await branchOf(repo)).toBe('trunk')
    expect(await lockFiles()).toBe(0)
  })

  it('restores the original branch after Cancelled', async () => {
    const { repo, d } = await setup()
    const gate = deferred<void>()
    h.script.work = async () => { await gate.promise; return ok('work') }
    await h.engine.start(d.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(await branchOf(repo)).toMatch(/^axon\/dev\//)
    await h.engine.cancel(d.id)
    gate.resolve()
    await h.engine.whenIdle(d.id)
    expect(await branchOf(repo)).toBe('trunk')
    expect(await lockFiles()).toBe(0)
  })

  // Leaves the delivery branch with a commit that edits README plus an uncommitted edit of the same file, so
  // switching back to the original branch is blocked by the leftover change.
  async function leaveConflictingChanges(dir: string) {
    const g = testGit(dir)
    await fs.writeFile(path.join(dir, 'README.md'), 'agent committed\n')
    await g.raw(['add', '-A'])
    await g.raw([...ident, 'commit', '-m', 'agent work'])
    await fs.writeFile(path.join(dir, 'README.md'), 'leftover uncommitted\n')
    await fs.writeFile(path.join(dir, 'scratch.txt'), 'untracked leftover\n')
  }

  for (const how of ['Completed', 'Failed', 'Cancelled'] as const) {
    it(`stashes leftovers as axon/<deliveryId>, restores the branch and shows a notice after ${how}`, async () => {
      const { repo, d } = await setup()
      const gate = deferred<void>()
      const leftovers = deferred<void>()
      h.script.work = async (i) => {
        await leaveConflictingChanges(i.workspacePath)
        leftovers.resolve()
        if (how === 'Cancelled') await gate.promise
        return how === 'Failed' ? { status: 'failed', summary: 'x', errorMessage: 'x', result: {} } : ok('work')
      }
      await h.engine.start(d.id)
      if (how === 'Cancelled') {
        await leftovers.promise // cancel only once the agent has left its changes behind (no timing guess)
        await h.engine.cancel(d.id)
        gate.resolve()
      }
      await h.engine.whenIdle(d.id)
      const done = (await h.store.getDelivery(d.id))!
      expect(done.status).toBe(how)
      expect(await branchOf(repo)).toBe('trunk') // never left on the AXON branch
      const stashes = await testGit(repo).raw(['stash', 'list'])
      expect(stashes).toContain(`axon/${d.id}`)
      expect(done.workspaceNotice).toMatchObject({ kind: 'stashed', stashName: `axon/${d.id}`, folder: repo })
      expect(done.workspaceNotice?.message).toMatch(/stash pop/)
      expect(h.events.some((e) => e.type === 'workspace_notice')).toBe(true)
      expect(await fs.readFile(path.join(repo, 'README.md'), 'utf8')).toMatch(/hi/) // original branch content, leftovers are in the stash
      expect(await lockFiles()).toBe(0)
    })
  }

  it('says so (and how to recover) when the branch still cannot be restored', async () => {
    let failCheckout = false
    const real = createWorkspaceService({
      getWorkspaceRoot: () => root,
      makeGit: async (dir) => {
        const g = testGit(dir)
        const raw = g.raw.bind(g)
        g.raw = ((args: string[]) => (failCheckout && Array.isArray(args) && args[0] === 'checkout' ? Promise.reject(new Error('simulated checkout failure')) : raw(args))) as typeof g.raw
        return g
      },
      username: () => 'dev',
      getDelivery: async (id) => h.store.getDelivery(id),
    })
    h = await createHarness({ workspace: real.port })
    const repo = await makeRepo('app', 'trunk')
    const block = await h.mkBlock({ name: 'work' })
    const pl = await h.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'n1', label: 'work', blockId: block.id, position: { x: 0, y: 0 } }], edges: [] })
    const d = await h.store.createDelivery({ ticketId: 'PROJ-9', title: 't', pipelineId: pl.id, repoUrl: '', workspaceType: 'Default', workspacePath: repo })
    h.script.work = async () => { failCheckout = true; await fs.writeFile(path.join(repo, 'x.txt'), 'x'); return ok('work') }
    await h.engine.start(d.id)
    await h.engine.whenIdle(d.id)
    const done = (await h.store.getDelivery(d.id))!
    expect(done.workspaceNotice?.kind).toBe('not-restored')
    expect(done.workspaceNotice?.message).toMatch(/still on the delivery branch/)
    expect(done.workspaceNotice?.message).toMatch(/checkout trunk/)
    expect(await lockFiles()).toBe(0) // locks are released regardless
  })

  it('an Interrupted delivery keeps its branch and lock until it is cancelled', async () => {
    const { repo, d, real } = await setup()
    const gate = deferred<void>()
    h.script.work = async () => { await gate.promise; return ok('work') }
    await h.engine.start(d.id)
    await new Promise((r) => setTimeout(r, 300))
    await h.engine.shutdown() // app quit mid-run -> Interrupted
    gate.resolve()
    expect((await h.store.getDelivery(d.id))!.status).toBe('Interrupted')
    expect(await branchOf(repo)).toMatch(/^axon\/dev\//)
    expect(await lockFiles()).toBe(1)
    await expect(real.checkWorkspacePath(repo)).rejects.toThrow(/in use by another delivery/)

    await h.engine.cancel(d.id) // cancelling releases it
    expect(await branchOf(repo)).toBe('trunk')
    expect(await lockFiles()).toBe(0)
  })

  it('refuses to start (delivery stays Pending) on a dirty tree and on a path outside the root', async () => {
    const { repo, d } = await setup()
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'x')
    const res = await h.engine.start(d.id)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/uncommitted changes/)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Pending')
    expect(await branchOf(repo)).toBe('trunk')

    const outside = await h.store.createDelivery({ ticketId: 'PROJ-9', title: 't', pipelineId: d.pipelineId, repoUrl: '', workspaceType: 'Default', workspacePath: os.tmpdir() })
    expect((await h.engine.start(outside.id)).error).toMatch(/must be inside the Workspace Root/)
  })
})
