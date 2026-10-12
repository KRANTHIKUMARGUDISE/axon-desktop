import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import YAML from 'yaml'
import { z } from 'zod'
import { BlockSchema } from '../../shared'
import type { Block } from '../../shared'
import type { Store } from './types'
import { log } from '../log'

// Built-in Axon blocks ship in the installer as a versioned, checksummed bundle:
//   resources/seed/manifest.json
//   resources/seed/blocks/{name}/block.yaml
// They are loaded as sourceType Axon and are immutable — enforced in the store (main), not just hidden
// in the UI. A block whose checksum does not match the manifest is skipped (and logged).
export const HUMAN_GATE_BLOCK_ID = 'axon-human-gate'

const ManifestSchema = z.object({
  schemaVersion: z.number().int(),
  bundleVersion: z.number().int(),
  blocks: z.array(z.object({ id: z.string(), name: z.string(), version: z.number().int(), path: z.string(), sha256: z.string() })),
})
export type SeedManifest = z.infer<typeof ManifestSchema>

function listFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listFiles(dir, rel))
    else out.push(rel)
  }
  return out.sort()
}

/** sha256 over (relative path, normalised content) of every file in a block folder. */
export function checksumDir(dir: string): string {
  const h = crypto.createHash('sha256')
  for (const rel of listFiles(dir)) {
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n'))
    h.update('\0')
  }
  return h.digest('hex')
}

/** Packaged: {resources}/seed (extraResources). Dev/compiled/tests: <repo>/resources/seed. */
export function resolveSeedDir(): string {
  const candidates = [
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ? path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath as string, 'seed') : '',
    path.join(__dirname, '..', '..', 'resources', 'seed'),
    path.join(__dirname, '..', '..', '..', 'resources', 'seed'),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(path.join(c, 'manifest.json'))) return c
  throw new Error('Seed bundle (resources/seed/manifest.json) not found')
}

/** Reads and verifies the bundle. Blocks failing their checksum or schema are dropped. */
export function loadSeedBundle(seedDir: string = resolveSeedDir(), now: Date = new Date()): { manifest: SeedManifest; blocks: Block[] } {
  const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(seedDir, 'manifest.json'), 'utf8')))
  const ts = now.toISOString()
  const blocks: Block[] = []
  for (const entry of manifest.blocks) {
    try {
      const dir = path.resolve(seedDir, entry.path)
      if (!dir.startsWith(path.resolve(seedDir) + path.sep)) throw new Error('path escapes the seed bundle')
      if (checksumDir(dir) !== entry.sha256) throw new Error('checksum mismatch')
      const doc = YAML.parse(fs.readFileSync(path.join(dir, 'block.yaml'), 'utf8')) as Record<string, unknown>
      const block = BlockSchema.parse({ ...doc, createdAt: ts, updatedAt: ts, scope: 'Org', owner: 'axon', status: 'Published', immutable: true })
      if (block.id !== entry.id || block.version !== entry.version) throw new Error('manifest does not match block.yaml')
      if (block.sourceType !== 'Axon') throw new Error('seed blocks must be sourceType Axon')
      blocks.push(block)
    } catch (err) {
      log.error(`[seed] skipping ${entry.id}`, err)
    }
  }
  return { manifest, blocks }
}

export function builtInBlocks(seedDir?: string, now?: Date): Block[] {
  return loadSeedBundle(seedDir, now).blocks
}

export async function seedBuiltIns(store: Store, seedDir?: string): Promise<void> {
  for (const block of builtInBlocks(seedDir)) await store.seedBlock(block)
}

