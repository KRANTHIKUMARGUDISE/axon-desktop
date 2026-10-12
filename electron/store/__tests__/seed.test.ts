import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { FileStore } from '../fileStore'
import { loadSeedBundle, resolveSeedDir, seedBuiltIns, checksumDir, HUMAN_GATE_BLOCK_ID } from '../seed'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-seed-'))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('seed bundle', () => {
  it('ships human-gate plus stubs for the S4/S5 native blocks, all Axon + immutable + checksummed', () => {
    const { manifest, blocks } = loadSeedBundle()
    expect(blocks.map((b) => b.id).sort()).toEqual([
      'axon-human-gate', 'axon-pr-creator', 'axon-test-runner', 'axon-ticket-fetcher', 'axon-workspace-provisioner',
    ])
    expect(manifest.blocks).toHaveLength(blocks.length)
    for (const b of blocks) expect(b).toMatchObject({ sourceType: 'Axon', immutable: true, scope: 'Org', status: 'Published', artifactFormat: 'Native' })
  })

  it('manifest checksums match the files (regenerate with scripts/build-seed-manifest.js)', () => {
    const seedDir = resolveSeedDir()
    const { manifest } = loadSeedBundle(seedDir)
    for (const entry of manifest.blocks) expect(checksumDir(path.join(seedDir, entry.path)), entry.id).toBe(entry.sha256)
  })

  it('drops a block whose files were tampered with (checksum mismatch)', async () => {
    const copy = path.join(dir, 'seed')
    await fs.cp(resolveSeedDir(), copy, { recursive: true })
    await fs.appendFile(path.join(copy, 'blocks/human-gate/block.yaml'), 'description: tampered\n')
    const ids = loadSeedBundle(copy).blocks.map((b) => b.id)
    expect(ids).not.toContain(HUMAN_GATE_BLOCK_ID)
    expect(ids).toContain('axon-pr-creator')
  })

  it('upgrades a seeded block when the bundled version is newer, never downgrades, never touches user blocks', async () => {
    const store = new FileStore({ dir })
    await seedBuiltIns(store)
    const [gate] = loadSeedBundle().blocks.filter((b) => b.id === HUMAN_GATE_BLOCK_ID)
    await store.seedBlock({ ...gate, version: 5, description: 'newer' })
    expect((await store.getBlock(HUMAN_GATE_BLOCK_ID))?.description).toBe('newer')
    await seedBuiltIns(store) // bundle is v1 < v5: keep the newer one
    expect((await store.getBlock(HUMAN_GATE_BLOCK_ID))?.version).toBe(5)
    await expect(store.updateBlock(HUMAN_GATE_BLOCK_ID, { description: 'x' })).rejects.toThrow(/built-in/)
  })
})
