import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileStore } from '../fileStore'
import { seedBuiltIns } from '../seed'

let dir: string
let store: FileStore
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-pv-'))
  store = new FileStore({ dir })
  await seedBuiltIns(store)
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('reading an older published pipeline version', () => {
  it('returns the frozen older version and the current one', async () => {
    const node = { id: 'g', blockId: 'axon-human-gate', position: { x: 0, y: 0 }, config: { reason: 'r', mode: 'Pause', checklist: [] } }
    const p = await store.createPipeline({ name: 'P', description: '', nodes: [node], edges: [] })
    await store.publish('pipeline', p.id, { changeNote: 'first' })
    const draft = await store.updatePipeline(p.id, { name: 'P renamed' })
    expect(draft.version).toBe(2)
    await store.publish('pipeline', p.id, {})
    const v1 = await store.getPipelineVersion(p.id, 1)
    expect(v1).toMatchObject({ version: 1, name: 'P', changeNote: 'first' })
    expect((await store.getPipelineVersion(p.id, 2))?.name).toBe('P renamed')
    expect(await store.getPipelineVersion(p.id, 9)).toBeNull()
  })
})
