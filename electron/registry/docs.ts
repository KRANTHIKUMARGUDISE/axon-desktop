import fs from 'fs/promises'
import path from 'path'
import YAML from 'yaml'
import { BlockSchema, PipelineSchema, migrateDoc, ProfileSchema, DeliveryRuleSchema } from '../../shared'
import type { Block, Pipeline, Profile, DeliveryRule } from '../../shared'
import { blockDir, cleanRelPath, pipelineDraftPath, pipelineVersionPath } from './layout'
import { log } from '../log'

// Document <-> registry file mapping. Pipelines are one YAML file per version (+ draft.yaml);
// blocks are folders: block.yaml + files/{relativePath} for the skill files.

export type FileOp = { op: 'put'; path: string; content: string } | { op: 'delete'; path: string }

const toYaml = (doc: unknown) => YAML.stringify(doc, { lineWidth: 0 })

// Hand-authored org/team files (admins editing the registry directly) may omit timestamps.
const EPOCH = new Date(0).toISOString()
const withTimestamps = (doc: Record<string, unknown>) => ({ createdAt: EPOCH, updatedAt: EPOCH, ...doc })

/**
 * Ops that make the registry reflect `pipeline` (a Draft → draft.yaml; Published/Deprecated → v{n}.yaml).
 * `pruneDraft` (default) deletes draft.yaml when publishing; pass false when only re-writing an older version.
 */
export function pipelineOps(root: string, pipeline: Pipeline, opts: { pruneDraft?: boolean } = {}): FileOp[] {
  if (pipeline.status === 'Draft') return [{ op: 'put', path: pipelineDraftPath(root, pipeline.id), content: toYaml(pipeline) }]
  const ops: FileOp[] = [{ op: 'put', path: pipelineVersionPath(root, pipeline.id, pipeline.version), content: toYaml(pipeline) }]
  if (opts.pruneDraft ?? true) ops.push({ op: 'delete', path: pipelineDraftPath(root, pipeline.id) })
  return ops
}

export function blockOps(root: string, block: Block, opts: { pruneDraft?: boolean } = {}): FileOp[] {
  const dir = blockDir(root, block.id, block.status === 'Draft' ? 'draft' : block.version)
  const { cachedFiles, ...meta } = block
  const ops: FileOp[] = [{ op: 'delete', path: dir }, { op: 'put', path: `${dir}/block.yaml`, content: toYaml(meta) }]
  for (const f of cachedFiles ?? []) {
    const rel = cleanRelPath(f.relativePath.replace(/^\.?\//, ''))
    if (!rel) {
      log.warn(`[registry] skipping skill file with unsafe path: ${f.relativePath}`)
      continue
    }
    ops.push({ op: 'put', path: `${dir}/files/${rel}`, content: f.content })
  }
  if (block.status !== 'Draft' && (opts.pruneDraft ?? true)) ops.push({ op: 'delete', path: blockDir(root, block.id, 'draft') })
  return ops
}

export function profileYaml(profile: Profile): string {
  return toYaml(profile)
}

export function parseProfile(text: string): Profile | null {
  try {
    return ProfileSchema.parse(migrateDoc(YAML.parse(text), 'other'))
  } catch {
    return null
  }
}

// Watcher rules: users/{email}/rules/{id}.yaml (S5). Personal only — rules are never promoted.
export function ruleYaml(rule: DeliveryRule): string {
  return toYaml(rule)
}

export function parseRule(text: string): DeliveryRule | null {
  try {
    return DeliveryRuleSchema.parse(migrateDoc(YAML.parse(text), 'other'))
  } catch {
    return null
  }
}

/** Reads `{rootDir}/rules/*.yaml`; unreadable files are skipped (never fatal). */
export async function loadRules(rootDir: string): Promise<DeliveryRule[]> {
  let names: string[]
  try {
    names = (await fs.readdir(path.join(rootDir, 'rules'), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.yaml')).map((e) => e.name)
  } catch {
    return []
  }
  const out: DeliveryRule[] = []
  for (const name of names) {
    const rule = parseRule((await readOptional(path.join(rootDir, 'rules', name))) ?? '')
    if (rule && `${rule.id}.yaml` === name) out.push(rule)
    else log.warn(`[registry] skipping rules/${name}`)
  }
  return out
}

export function parsePipelineFile(text: string): Pipeline {
  return PipelineSchema.parse(withTimestamps(migrateDoc(YAML.parse(text), 'pipeline')))
}

// ---------------------------------------------------------------- reading from a clone

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

async function listFilesUnder(dir: string, base = ''): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await fs.readdir(path.join(dir, base), { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFilesUnder(dir, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

export async function readBlockDir(dir: string): Promise<Block> {
  const meta = YAML.parse((await fs.readFile(path.join(dir, 'block.yaml'), 'utf-8')))
  const doc = migrateDoc(meta, 'block')
  const files = []
  for (const rel of await listFilesUnder(path.join(dir, 'files'))) {
    files.push({ relativePath: rel, content: (await readOptional(path.join(dir, 'files', rel))) ?? '' })
  }
  return BlockSchema.parse({ ...withTimestamps(doc), ...(files.length ? { cachedFiles: files } : {}) })
}

export interface LoadedDefinitions<T> {
  /** id -> { draft?, versions (ascending) } */
  byId: Map<string, { draft?: T; versions: T[] }>
  /** Documents that could not be read (newer schema, corrupt) — surfaced, never fatal. */
  skipped: string[]
}

/** Reads `{rootDir}/pipelines/*` or `{rootDir}/blocks/*` from a working tree. */
export async function loadDefinitions(rootDir: string, kind: 'pipeline' | 'block'): Promise<LoadedDefinitions<Pipeline | Block>> {
  const byId = new Map<string, { draft?: Pipeline | Block; versions: (Pipeline | Block)[] }>()
  const skipped: string[] = []
  const collection = path.join(rootDir, kind === 'pipeline' ? 'pipelines' : 'blocks')
  let ids: string[]
  try {
    ids = (await fs.readdir(collection, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { byId, skipped }
  }
  for (const id of ids) {
    const entry: { draft?: Pipeline | Block; versions: (Pipeline | Block)[] } = { versions: [] }
    const dir = path.join(collection, id)
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const label = `${kind}s/${id}/${e.name}`
      try {
        if (kind === 'pipeline' && e.isFile() && /^(draft|v\d+)\.yaml$/.test(e.name)) {
          const doc = parsePipelineFile(await fs.readFile(path.join(dir, e.name), 'utf-8'))
          if (doc.id !== id) throw new Error('id does not match folder')
          if (e.name === 'draft.yaml') entry.draft = doc
          else entry.versions.push(doc)
        } else if (kind === 'block' && e.isDirectory() && /^(draft|v\d+)$/.test(e.name)) {
          const doc = await readBlockDir(path.join(dir, e.name))
          if (doc.id !== id) throw new Error('id does not match folder')
          if (e.name === 'draft') entry.draft = doc
          else entry.versions.push(doc)
        }
      } catch (err) {
        skipped.push(label)
        log.warn(`[registry] skipping ${label}`, err)
      }
    }
    entry.versions.sort((a, b) => a.version - b.version)
    if (entry.draft || entry.versions.length) byId.set(id, entry)
  }
  return { byId, skipped }
}
