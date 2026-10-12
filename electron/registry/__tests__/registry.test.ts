import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import type { BlockInput, Delivery } from '../../../shared'
import { RunSummarySchema } from '../../../shared'
import { createMachine, createRemote, makeTmp, remoteFile, remoteFiles, testGit } from './fixtures'
import { toRunSummary } from '../runSummary'
import { scanText } from '../secretScan'
import { HUMAN_GATE_BLOCK_ID } from '../../store/seed'

let root: string
beforeEach(async () => {
  root = await makeTmp()
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

const blockInput = (over: Partial<BlockInput> = {}): BlockInput => ({
  name: 'My skill', role: 'Execution', description: 'd', tags: [], sourceType: 'Local', agentRuntime: 'Claude', artifactFormat: 'Skill',
  cachedFiles: [{ relativePath: 'SKILL.md', content: '---\nname: x\n---\nDo it.' }, { relativePath: 'refs/a.md', content: 'ref' }],
  entryPointPath: 'SKILL.md', ...over,
})

const orgBlock = `id: org-block-1
schemaVersion: 2
name: Org Reviewer
role: Execution
description: shared
version: 1
status: Published
tags: []
sourceType: Local
agentRuntime: Claude
artifactFormat: Skill
`

describe('fresh machine', () => {
  it('shows seeded and org blocks (read-through from the clone, works offline afterwards)', async () => {
    const remote = await createRemote(root, { files: { 'org/blocks/org-block-1/v1/block.yaml': orgBlock, 'org/blocks/org-block-1/v1/files/SKILL.md': 'org skill' } })
    const m = await createMachine(root, 'alice', remote)
    expect((await m.local.listBlocks()).map((b) => b.id)).toContain(HUMAN_GATE_BLOCK_ID) // seeded before any network
    expect((await m.sync.syncNow()).state).toBe('Idle')
    const blocks = await m.store.listBlocks()
    expect(blocks.find((b) => b.id === HUMAN_GATE_BLOCK_ID)).toMatchObject({ sourceType: 'Axon', immutable: true, scope: 'Org' })
    const org = blocks.find((b) => b.id === 'org-block-1')
    expect(org).toMatchObject({ scope: 'Org', status: 'Published', name: 'Org Reviewer' })
    expect(org?.cachedFiles).toEqual([{ relativePath: 'SKILL.md', content: 'org skill' }])
    // org docs are read-only here
    await expect(m.store.updateBlock('org-block-1', { description: 'x' })).rejects.toThrow(/read-only/)
    await expect(m.store.deleteBlock('org-block-1')).rejects.toThrow(/read-only/)
    // seeded blocks are immutable in the store itself
    await expect(m.store.updateBlock(HUMAN_GATE_BLOCK_ID, { name: 'x' })).rejects.toThrow(/built-in/)
    await expect(m.store.deleteBlock(HUMAN_GATE_BLOCK_ID)).rejects.toThrow(/built-in/)
  })

  it('registry copies of seeded ids are ignored (cannot shadow a built-in block)', async () => {
    const remote = await createRemote(root, { files: { [`org/blocks/${HUMAN_GATE_BLOCK_ID}/v1/block.yaml`]: orgBlock.replace('org-block-1', HUMAN_GATE_BLOCK_ID).replace('Org Reviewer', 'EVIL') } })
    const m = await createMachine(root, 'alice', remote)
    await m.sync.syncNow()
    expect((await m.store.getBlock(HUMAN_GATE_BLOCK_ID))?.name).toBe('Human Gate')
  })

  it('skips documents from a newer schema instead of crashing', async () => {
    const remote = await createRemote(root, { files: { 'org/blocks/future/v1/block.yaml': orgBlock.replace('org-block-1', 'future').replace('schemaVersion: 2', 'schemaVersion: 99') } })
    const m = await createMachine(root, 'alice', remote)
    await m.sync.syncNow()
    expect(await m.store.getBlock('future')).toBeNull()
    expect(await m.reader.skipped()).toEqual(['org/blocks/future/v1'])
  })
})

describe('personal pipelines reach users/{email}/ and survive offline + crash', () => {
  it('create -> sync -> publish -> edit keeps every version file in the registry', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const p = await m.store.createPipeline({
      name: 'Deliver', description: '', nodes: [{ id: 'n1', label: 'Gate', blockId: HUMAN_GATE_BLOCK_ID, position: { x: 0, y: 0 } }], edges: [],
    }, 'alice')
    expect(p).toMatchObject({ scope: 'Personal', owner: m.email, status: 'Draft', version: 1 })
    await m.sync.syncNow()
    const base = `users/${m.email}/pipelines/${p.id}`
    expect(await remoteFiles(remote)).toContain(`${base}/draft.yaml`)

    const published = await m.store.publish('pipeline', p.id, { versionLabel: '1.0', changeNote: 'first' })
    expect(published).toMatchObject({ status: 'Published', version: 1, nodes: [{ blockVersion: 1 }] })
    await m.sync.syncNow()
    let files = await remoteFiles(remote)
    expect(files).toContain(`${base}/v1.yaml`)
    expect(files).not.toContain(`${base}/draft.yaml`)

    const draft = await m.store.updatePipeline(p.id, { name: 'Deliver 2' })
    expect(draft).toMatchObject({ version: 2, status: 'Draft' })
    await m.sync.syncNow()
    files = await remoteFiles(remote)
    expect(files).toEqual(expect.arrayContaining([`${base}/v1.yaml`, `${base}/draft.yaml`]))
    expect(await remoteFile(root, remote, `${base}/v1.yaml`)).toContain('name: Deliver\n')
    const history = await m.store.listVersions('pipeline', p.id)
    expect(history.map((v) => [v.version, v.status])).toEqual([[2, 'Draft'], [1, 'Published']])
  })

  it('blocks are folders: block.yaml + skill files, one folder per version', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const b = await m.store.createBlock(blockInput())
    await m.sync.syncNow()
    const dir = `users/${m.email}/blocks/${b.id}`
    expect(await remoteFiles(remote)).toEqual(expect.arrayContaining([`${dir}/draft/block.yaml`, `${dir}/draft/files/SKILL.md`, `${dir}/draft/files/refs/a.md`]))
    expect(await remoteFile(root, remote, `${dir}/draft/block.yaml`)).not.toContain('Do it.')
    await m.store.publish('block', b.id)
    await m.sync.syncNow()
    const files = await remoteFiles(remote)
    expect(files).toContain(`${dir}/v1/block.yaml`)
    expect(files.some((f) => f.startsWith(`${dir}/draft/`))).toBe(false)
  })

  it('offline: queues, survives a crash, syncs on reconnect', async () => {
    const remote = await createRemote(root)
    let url = path.join(root, 'nowhere.git')
    const m = await createMachine(root, 'alice', remote, { url: () => url })
    const p = await m.store.createPipeline({ name: 'Offline one', description: '', nodes: [], edges: [] })
    expect((await m.sync.syncNow()).state).toBe('Offline')
    expect(m.queue.count()).toBe(1)

    const reborn = await createMachine(root, 'alice', remote, { url: () => url }) // same dirs = restart after a crash
    expect(reborn.queue.count()).toBe(1)
    url = remote
    expect((await reborn.sync.syncNow()).state).toBe('Idle')
    expect(await remoteFiles(remote)).toContain(`users/${reborn.email}/pipelines/${p.id}/draft.yaml`)
  })

  it('a second machine of the same engineer pulls their documents down', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'alice', remote)
    const b1 = await a.store.createBlock(blockInput())
    await a.store.publish('block', b1.id)
    const p = await a.store.createPipeline({ name: 'Mine', description: '', nodes: [], edges: [] })
    await a.sync.syncNow()

    const laptop = await createMachine(root, 'alice-laptop', remote, { email: a.email })
    await laptop.sync.syncNow()
    expect((await laptop.store.getPipeline(p.id))?.name).toBe('Mine')
    expect(await laptop.store.getBlockVersion(b1.id, 1)).toMatchObject({ status: 'Published', cachedFiles: expect.any(Array) })
  })
})

describe('versioning (D13)', () => {
  it('published versions are immutable; deprecate keeps them readable; duplicate records derivedFrom', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const b = await m.store.createBlock(blockInput())
    await m.store.publish('block', b.id)
    await expect(m.store.publish('block', b.id)).rejects.toThrow(/already published/)
    await m.store.updateBlock(b.id, { description: 'v2 work' })
    await m.store.publish('block', b.id, { changeNote: 'v2' })
    expect((await m.store.getBlockVersion(b.id, 1))?.description).toBe('d')
    expect((await m.store.getBlockVersion(b.id, 2))?.description).toBe('v2 work')

    await m.store.deprecate('block', b.id)
    expect(await m.store.getBlockVersion(b.id, 2)).toMatchObject({ status: 'Deprecated' })
    expect(await m.store.getBlockVersion(b.id, 1)).toMatchObject({ status: 'Published' })
    await expect(m.store.updateBlock(b.id, { description: 'x' })).rejects.toThrow(/deprecated/)

    const copy = await m.store.duplicate('block', b.id)
    expect(copy).toMatchObject({ derivedFrom: { id: b.id, version: 2 }, status: 'Draft', version: 1, scope: 'Personal' })
    expect(copy.id).not.toBe(b.id)
    await expect(m.store.duplicate('block', HUMAN_GATE_BLOCK_ID)).rejects.toThrow(/cannot be duplicated/)
  })

  it('pipelines pin block versions on publish; deliveries record pipeline + block versions and run the pinned one', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const b = await m.store.createBlock(blockInput())
    const p = await m.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'n1', label: 'A', blockId: b.id, position: { x: 0, y: 0 } }], edges: [] })
    await expect(m.store.publish('pipeline', p.id)).rejects.toThrow(/Publish these blocks first/)
    await m.store.publish('block', b.id)
    await m.store.publish('pipeline', p.id)
    await m.store.updateBlock(b.id, { description: 'newer draft' })
    await m.store.publish('block', b.id)

    const delivery = await m.store.createDelivery({ ticketId: 'T-1', title: '', pipelineId: p.id, repoUrl: '', workspaceType: 'Default' })
    expect(delivery).toMatchObject({ pipelineId: p.id, pipelineVersion: 1 })
    expect(delivery.pipelineSnapshot.blockVersions).toEqual({ [b.id]: 1 }) // pinned, not the latest (2)
    expect((await m.store.getBlockVersion(b.id, 1))?.description).toBe('d')
  })
})

describe('promotion to org/team (PR only)', () => {
  function mockGitHub() {
    const calls: { url: string; method: string; body?: string }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
      if (init?.method === 'POST') return new Response(JSON.stringify({ html_url: 'https://github.com/acme/axon-registry/pull/7' }), { status: 201 })
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  it('pushes a promotion branch (never main) and returns the PR URL', async () => {
    const remote = await createRemote(root)
    const gh = mockGitHub()
    const m = await createMachine(root, 'alice', remote, { fetchImpl: gh.fetchImpl })
    const b = await m.store.createBlock(blockInput())
    await expect(m.service.promote('block', b.id, { scope: 'Org' })).rejects.toThrow(/Publish .* first/)
    await m.store.publish('block', b.id)

    const res = await m.service.promote('block', b.id, { scope: 'Org' })
    expect(res.prUrl).toBe('https://github.com/acme/axon-registry/pull/7')
    expect(res.branch).toMatch(/^axon\/promote\/alice-example-com-block-/)
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(JSON.parse(gh.calls[1].body!)).toMatchObject({ head: res.branch, base: 'main' })

    // on the promotion branch, not on main
    const onBranch = (await testGit(remote).raw(['ls-tree', '-r', '--name-only', res.branch])).split('\n')
    expect(onBranch).toEqual(expect.arrayContaining([`org/blocks/${b.id}/v1/block.yaml`, `org/blocks/${b.id}/v1/files/SKILL.md`]))
    expect((await remoteFiles(remote)).some((f) => f.startsWith('org/'))).toBe(false)
    // the clone is left on main, clean
    expect((await testGit(m.registryDir).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main')
    expect((await testGit(m.registryDir).raw(['status', '--porcelain'])).trim()).toBe('')

    // promoting the same version again is refused once it has merged (immutable)
    await testGit(remote).raw(['update-ref', 'refs/heads/main', res.branch])
    await m.sync.syncNow()
    await expect(m.service.promote('block', b.id, { scope: 'Org' })).rejects.toThrow(/already exists/)
  })

  it('promotes to a team folder and requires a GitHub token', async () => {
    const remote = await createRemote(root)
    const gh = mockGitHub()
    const noToken = await createMachine(root, 'alice', remote, { fetchImpl: gh.fetchImpl, token: null })
    const b = await noToken.store.createBlock(blockInput())
    await noToken.store.publish('block', b.id)
    await expect(noToken.service.promote('block', b.id, { scope: 'Team', team: 'core' })).rejects.toThrow(/GitHub token/)

    const m = await createMachine(root, 'bob', remote, { fetchImpl: gh.fetchImpl })
    const b2 = await m.store.createBlock(blockInput())
    await m.store.publish('block', b2.id)
    const res = await m.service.promote('block', b2.id, { scope: 'Team', team: 'core' })
    expect((await testGit(remote).raw(['ls-tree', '-r', '--name-only', res.branch])).split('\n')).toContain(`teams/core/blocks/${b2.id}/v1/block.yaml`)
    await expect(m.service.promote('block', b2.id, { scope: 'Team', team: '../x' })).rejects.toThrow()
  })

  it('refuses built-ins, and pipelines that use personal blocks', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote, { fetchImpl: mockGitHub().fetchImpl })
    await expect(m.service.promote('block', HUMAN_GATE_BLOCK_ID, { scope: 'Org' })).rejects.toThrow(/cannot be promoted/)
    const b = await m.store.createBlock(blockInput())
    await m.store.publish('block', b.id)
    const p = await m.store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'n', label: 'A', blockId: b.id, position: { x: 0, y: 0 } }], edges: [] })
    await m.store.publish('pipeline', p.id)
    await expect(m.service.promote('pipeline', p.id, { scope: 'Org' })).rejects.toThrow(/Promote these blocks first/)
  })

  it('refuses to promote content containing a secret', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote, { fetchImpl: mockGitHub().fetchImpl })
    const b = await m.store.createBlock(blockInput({ cachedFiles: [{ relativePath: 'SKILL.md', content: 'token = ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] }))
    await m.store.publish('block', b.id)
    await expect(m.service.promote('block', b.id, { scope: 'Org' })).rejects.toThrow(/Possible secret/)
  })
})

describe('profile, activity log and run summaries', () => {
  it('profile.yaml and activity.log are pushed with the next sync (one commit, not one per launch)', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    await m.service.onLaunch()
    await m.service.onLaunch()
    await m.sync.syncNow()
    const profile = await remoteFile(root, remote, `users/${m.email}/profile.yaml`)
    expect(profile).toMatch(/email: alice@example.com/)
    expect(profile).toMatch(/displayName: alice Dev/)
    expect(profile).toMatch(/team: core/)
    expect(profile).toMatch(/name: alice-pc/)
    const log = (await remoteFile(root, remote, `users/${m.email}/activity.log`))!.trim().split('\n')
    expect(log).toHaveLength(2)
    expect(JSON.parse(log[0])).toMatchObject({ event: 'launch', email: m.email, machine: 'alice-pc' })
    expect((await testGit(remote).raw(['rev-list', '--count', 'main'])).trim()).toBe('2') // init + one sync commit
  })

  it('no activity.log without consent', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote, { consent: false })
    await m.service.onLaunch()
    await m.sync.syncNow()
    expect(await remoteFile(root, remote, `users/${m.email}/activity.log`)).toBeNull()
    expect(await remoteFile(root, remote, `users/${m.email}/profile.yaml`)).not.toBeNull()
  })
})

describe('run summary contract', () => {
  const delivery = (): Delivery => ({
    id: 'd1', schemaVersion: 2, createdAt: 't', updatedAt: 't', localSeq: 1, ticketId: 'ABC-1', title: 'SECRET TITLE sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz',
    pipelineId: 'p1', pipelineName: 'P', pipelineVersion: 3,
    pipelineSnapshot: { pipelineId: 'p1', pipelineVersion: 3, name: 'P', nodes: [], edges: [], blockVersions: { b1: 2 } },
    status: 'Completed', repoUrl: 'https://github.com/acme/app.git', workspaceType: 'Default', prUrl: 'https://github.com/acme/app/pull/9',
    startedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T10:05:00.000Z', retriedFromDeliveryId: 'd0', rerunReason: 'flaky',
    workspacePath: 'C:\\secret\\workspace', errorMessage: 'customer code leaked here', inputs: { ticket: 'description with secrets' },
    steps: [{
      nodeId: 'n1', itemKey: null, blockId: 'b1', blockName: 'Coder', status: 'Completed', startedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T10:01:00.000Z',
      contextSnapshot: { code: 'function secret() {}' },
      output: { status: 'success', summary: 'wrote customer code', result: { diff: '+ password = hunter2hunter2hunter2' }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
    }, {
      nodeId: 'n2', itemKey: null, blockId: 'g', blockName: 'Human Gate', status: 'Completed',
      output: { status: 'success', summary: '', result: {}, approvedBy: 'alice@example.com', approvedAt: '2026-10-01T10:04:00.000Z', reviewComment: 'private comment' },
    }],
  } as Delivery)

  it('contains only whitelisted keys and none of the output, context, summaries, comments or paths', () => {
    const s = toRunSummary(delivery(), 'alice@example.com')
    expect(() => RunSummarySchema.parse(s)).not.toThrow()
    expect(Object.keys(s).sort()).toEqual([
      'blockVersions', 'completedAt', 'costUsd', 'durationMs', 'gates', 'id', 'inputTokens', 'outputTokens', 'owner', 'pipelineId',
      'pipelineVersion', 'prUrls', 'repoUrls', 'rerunOf', 'rerunReason', 'schemaVersion', 'scope', 'startedAt', 'status', 'steps', 'ticketId',
    ])
    expect(s).toMatchObject({
      pipelineId: 'p1', pipelineVersion: 3, blockVersions: { b1: 2 }, rerunOf: 'd0', rerunReason: 'flaky', prUrls: ['https://github.com/acme/app/pull/9'],
      repoUrls: ['https://github.com/acme/app.git'], inputTokens: 10, outputTokens: 5, costUsd: 0.01, durationMs: 300000,
      gates: [{ nodeId: 'n2', outcome: 'approved', by: 'alice@example.com', at: '2026-10-01T10:04:00.000Z' }],
    })
    for (const step of s.steps) expect(Object.keys(step).every((k) => ['nodeId', 'blockId', 'blockName', 'status', 'startedAt', 'completedAt', 'durationMs', 'inputTokens', 'outputTokens', 'costUsd'].includes(k))).toBe(true)
    const text = JSON.stringify(s)
    for (const leaked of ['SECRET TITLE', 'customer code', 'hunter2', 'function secret', 'private comment', 'C:\\\\secret', 'description with secrets']) expect(text).not.toContain(leaked)
    expect(scanText(text)).toBeNull()
  })

  it('caps free-text fields', () => {
    const d = delivery()
    d.ticketId = 'X'.repeat(5000)
    d.rerunReason = 'R'.repeat(500)
    d.steps[0].blockName = 'B'.repeat(5000)
    const s = toRunSummary(d, 'alice@example.com')
    expect(s.ticketId.length).toBeLessThanOrEqual(200)
    expect(s.rerunReason!.length).toBeLessThanOrEqual(400)
    expect(s.steps[0].blockName.length).toBeLessThanOrEqual(200)
  })

  it('a stray field fails the strict schema instead of leaking', () => {
    const s = { ...toRunSummary(delivery(), 'alice@example.com'), output: { secret: 1 } }
    expect(() => RunSummarySchema.parse(s)).toThrow()
  })

  it('a run record is queued and synced under runs/{yyyy-mm}/ — and a secret in it is refused by the pre-push scan', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    await m.service.recordRun(delivery())
    await m.sync.syncNow()
    const body = await remoteFile(root, remote, `users/${m.email}/runs/2026-10/d1.json`)
    expect(JSON.parse(body!)).toMatchObject({ id: 'd1', owner: m.email })

    // seeded fake secrets in a free-text field are rejected by the scan, never pushed
    const leaky = delivery()
    leaky.id = 'd2'
    leaky.rerunReason = 'key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'
    await m.service.recordRun(leaky)
    const status = await m.sync.syncNow()
    expect(status.rejected).toEqual([{ path: `users/${m.email}/runs/2026-10/d2.json`, rule: 'anthropic-api-key' }])
    expect(await remoteFile(root, remote, `users/${m.email}/runs/2026-10/d2.json`)).toBeNull()
  })
})

describe('secret scanner rules', () => {
  it.each([
    ['anthropic-api-key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['github-token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github-fine-grained-pat', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
    ['aws-access-key-id', 'AKIAABCDEFGHIJKLMNOP'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['slack-token', 'xoxb-1234567890-abcdefghij'],
    ['bearer-token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['basic-auth-url', 'https://user:hunter2@example.com/repo.git'],
    ['atlassian-api-token', 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123'],
    ['generic-secret-assignment', 'api_key = "abcdefghijklmnopqrstuvwxyz0123"'],
  ])('flags %s', (rule, text) => {
    expect(scanText(`config: ${text}\n`)).toBe(rule)
  })

  it('does not flag ordinary YAML/markdown', () => {
    expect(scanText('name: Reviewer\ndescription: Reviews pull requests and tokens are handled elsewhere\nuse the GITHUB_TOKEN env var\n')).toBeNull()
  })
})

describe('backfill of pre-registry documents', () => {
  it('pushes existing local documents (incl. schema-v1 files with no owner) to users/{email}/ once identity exists', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    // a document written by an S1/S2 build: schemaVersion 1, no scope/owner/status
    const legacy = { id: 'legacy-pipe', schemaVersion: 1, name: 'Legacy', description: '', version: 4, nodes: [], edges: [], createdAt: 't', updatedAt: 't' }
    await fs.mkdir(path.join(root, 'alice', 'store', 'pipelines'), { recursive: true })
    await fs.writeFile(path.join(root, 'alice', 'store', 'pipelines', 'legacy-pipe.json'), JSON.stringify(legacy))
    const own = await m.local.createBlock(blockInput({ name: 'Local only' })) // created without going through the registry store
    expect(m.queue.count()).toBe(0)

    expect(await m.store.backfill()).toBe(2)
    await m.sync.syncNow()
    const files = await remoteFiles(remote)
    expect(files).toContain(`users/${m.email}/pipelines/legacy-pipe/v4.yaml`) // migrated: Published v4
    expect(files).toContain(`users/${m.email}/blocks/${own.id}/draft/block.yaml`)
    expect(await remoteFile(root, remote, `users/${m.email}/pipelines/legacy-pipe/v4.yaml`)).toMatch(/owner: alice@example.com/)
    // built-ins are never mirrored
    expect(files.some((f) => f.includes('axon-human-gate'))).toBe(false)
  })
})

describe('deleting and refused writes', () => {
  it('a deleted document is not resurrected by hydration while its delete is still queued, and disappears from the registry after sync', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const p = await m.store.createPipeline({ name: 'Temp', description: '', nodes: [], edges: [] })
    await m.sync.syncNow()
    expect(await remoteFiles(remote)).toContain(`users/${m.email}/pipelines/${p.id}/draft.yaml`)

    await m.store.deletePipeline(p.id)
    expect(await m.service.hydrate()).toBe(0) // still in the clone, but the delete is queued
    expect(await m.store.getPipeline(p.id)).toBeNull()
    await m.sync.syncNow()
    expect(await remoteFiles(remote)).not.toContain(`users/${m.email}/pipelines/${p.id}/draft.yaml`)
    expect(await m.store.getPipeline(p.id)).toBeNull()
  })

  it('a refused (secret) write is forgotten once the fixed document syncs', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const b = await m.store.createBlock(blockInput({ cachedFiles: [{ relativePath: 'SKILL.md', content: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }] }))
    expect((await m.sync.syncNow()).rejected).toHaveLength(1)
    await m.store.updateBlock(b.id, { cachedFiles: [{ relativePath: 'SKILL.md', content: 'clean' }] })
    const status = await m.sync.syncNow()
    expect(status.rejected).toEqual([])
    expect(await remoteFile(root, remote, `users/${m.email}/blocks/${b.id}/draft/files/SKILL.md`)).toBe('clean')
  })
})
