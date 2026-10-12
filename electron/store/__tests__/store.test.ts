import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { FileStore } from '../fileStore'
import { atomicWrite } from '../atomic'
import { seedBuiltIns, HUMAN_GATE_BLOCK_ID } from '../seed'
import type { BlockInput } from '../../../shared'

let dir: string
let store: FileStore

const blockInput = (over: Partial<BlockInput> = {}): BlockInput => ({
  name: 'B', role: 'Execution', description: '', tags: [], sourceType: 'Local', agentRuntime: 'Claude', artifactFormat: 'Skill', ...over,
})

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-store-'))
  store = new FileStore({ dir })
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    const file = path.join(dir, 'x', 'doc.json')
    await atomicWrite(file, '{"a":1}')
    await atomicWrite(file, '{"a":2}')
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ a: 2 })
    expect(await fs.readdir(path.dirname(file))).toEqual(['doc.json'])
  })

  it('writes binary data intact', async () => {
    const file = path.join(dir, 'b.bin')
    await atomicWrite(file, Buffer.from([0, 255, 128, 7]))
    expect([...(await fs.readFile(file))]).toEqual([0, 255, 128, 7])
  })
})

describe('blocks and pipelines', () => {
  it('stamps id, schemaVersion, timestamps and version on create', async () => {
    const b = await store.createBlock(blockInput())
    expect(b).toMatchObject({ schemaVersion: 1, version: 1 })
    expect(b.id).toBeTruthy()
    expect(b.createdAt).toBe(b.updatedAt)
    expect(await store.getBlock(b.id)).toEqual(b)
  })

  it('bumps the version on update', async () => {
    const b = await store.createBlock(blockInput())
    const u = await store.updateBlock(b.id, { description: 'new' })
    expect(u.version).toBe(2)
    expect(u.description).toBe('new')
  })

  it('seeded Axon blocks are immutable: update and delete are refused', async () => {
    await seedBuiltIns(store)
    await expect(store.updateBlock(HUMAN_GATE_BLOCK_ID, { name: 'x' })).rejects.toThrow(/built-in/)
    await expect(store.deleteBlock(HUMAN_GATE_BLOCK_ID)).rejects.toThrow(/built-in/)
    expect((await store.getBlock(HUMAN_GATE_BLOCK_ID))!.name).toBe('Human Gate')
  })

  it('seeding twice does not duplicate or overwrite', async () => {
    await seedBuiltIns(store)
    await seedBuiltIns(store)
    expect((await store.listBlocks()).filter((b) => b.id === HUMAN_GATE_BLOCK_ID)).toHaveLength(1)
  })

  it('rejects ids that could escape the store directory', async () => {
    await expect(store.getBlock('../../etc/passwd')).rejects.toThrow(/Invalid id/)
  })

  it('creates, updates (version bump) and deletes pipelines', async () => {
    const p = await store.createPipeline({ name: 'P', description: '', nodes: [], edges: [] })
    const u = await store.updatePipeline(p.id, { name: 'P2' })
    expect(u).toMatchObject({ name: 'P2', version: 2 })
    await store.deletePipeline(p.id)
    expect(await store.getPipeline(p.id)).toBeNull()
  })
})

describe('deliveries', () => {
  async function seedPipeline() {
    const block = await store.createBlock(blockInput())
    await store.updateBlock(block.id, { description: 'v2' }) // version 2
    const pipeline = await store.createPipeline({
      name: 'P', description: '',
      nodes: [{ id: 'n1', label: 'A', blockId: block.id, position: { x: 0, y: 0 } }], edges: [],
    })
    return { block, pipeline }
  }

  it('builds a local pipelineSnapshot including block versions', async () => {
    const { block, pipeline } = await seedPipeline()
    const d = await store.createDelivery({ ticketId: 'T-1', title: 't', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    expect(d.status).toBe('Pending')
    expect(d.pipelineSnapshot).toMatchObject({
      pipelineId: pipeline.id, pipelineVersion: 1, name: 'P', blockVersions: { [block.id]: 2 },
    })
    expect(d.pipelineSnapshot.nodes).toHaveLength(1)
  })

  it('assigns an incrementing local sequence number', async () => {
    const { pipeline } = await seedPipeline()
    const mk = () => store.createDelivery({ ticketId: 'T', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    const seqs = (await Promise.all([mk(), mk(), mk()])).map((d) => d.localSeq).sort()
    expect(seqs).toEqual([1, 2, 3])
  })

  it('refuses a delivery for a missing pipeline or block', async () => {
    await expect(store.createDelivery({ ticketId: 'T', title: '', pipelineId: 'nope', repoUrl: '', workspaceType: 'Default' })).rejects.toThrow(/not found/)
    const p = await store.createPipeline({ name: 'P', description: '', nodes: [{ id: 'n', blockId: 'ghost' }], edges: [] })
    await expect(store.createDelivery({ ticketId: 'T', title: '', pipelineId: p.id, repoUrl: '', workspaceType: 'Default' })).rejects.toThrow(/ghost/)
  })

  it('serialises concurrent updates to one delivery (no lost writes)', async () => {
    const { pipeline } = await seedPipeline()
    const d = await store.createDelivery({ ticketId: 'T', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.updateDelivery(d.id, (x) => { x.steps.push({ nodeId: `n${i}`, itemKey: null, blockName: 'b', status: 'Pending' }) })),
    )
    expect((await store.getDelivery(d.id))!.steps).toHaveLength(25)
  })

  it('upsertStep inserts once and replaces by (nodeId, itemKey)', async () => {
    const { pipeline } = await seedPipeline()
    const d = await store.createDelivery({ ticketId: 'T', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    await store.upsertStep(d.id, { nodeId: 'n1', itemKey: null, blockName: 'A', status: 'Running' })
    await store.upsertStep(d.id, { nodeId: 'n1', itemKey: null, blockName: 'A', status: 'Completed' })
    await store.upsertStep(d.id, { nodeId: 'n1', itemKey: 'item-1', blockName: 'A', status: 'Running' })
    const steps = (await store.getDelivery(d.id))!.steps
    expect(steps).toHaveLength(2)
    expect(steps.find((s) => s.itemKey === null)!.status).toBe('Completed')
  })

  it('survives a store restart (documents persist on disk, one file per delivery)', async () => {
    const { pipeline } = await seedPipeline()
    const d = await store.createDelivery({ ticketId: 'T', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    const reopened = new FileStore({ dir })
    expect((await reopened.getDelivery(d.id))!.id).toBe(d.id)
    expect(await fs.readdir(path.join(dir, 'deliveries'))).toEqual([`${d.id}.json`])
  })

  it('skips a corrupt document when listing instead of failing the whole list', async () => {
    const { pipeline } = await seedPipeline()
    const d = await store.createDelivery({ ticketId: 'T', title: '', pipelineId: pipeline.id, repoUrl: '', workspaceType: 'Default' })
    await fs.writeFile(path.join(dir, 'deliveries', 'broken.json'), '{ not json')
    expect((await store.listDeliveries()).map((x) => x.id)).toEqual([d.id])
  })
})
