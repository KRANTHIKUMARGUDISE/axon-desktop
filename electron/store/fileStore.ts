import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { z } from 'zod'
import {
  BlockSchema, PipelineSchema, DeliverySchema, PipelineNodeSchema, PipelineEdgeSchema,
  SCHEMA_VERSION, migrateDoc, latestPublishedVersion,
} from '../../shared'
import type {
  Block, BlockInput, Pipeline, PipelineInput, Delivery, CreateDeliveryInput, DeliveryStep,
} from '../../shared'
import { atomicWrite } from './atomic'
import { log } from '../log'
import { KeyedMutex } from './mutex'
import { sameStepKey } from './types'
import type { Store, DocKind, DocOf, VersionInfo, PublishMeta, DefinitionSource } from './types'

// Patches arrive over IPC with explicit `undefined` keys ("don't change this"); spreading them
// would blank the stored value.
function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

export interface FileStoreOptions {
  dir: string
  now?: () => Date
  /** Identity (lowercased email) stamped as `owner` on new definitions. */
  getOwner?: () => string
  /** Read-only fallback for definitions that are not local (org / team docs from the registry). */
  definitions?: DefinitionSource
}

function docKindOf(kind: 'blocks' | 'pipelines' | 'deliveries'): 'block' | 'pipeline' | 'other' {
  return kind === 'blocks' ? 'block' : kind === 'pipelines' ? 'pipeline' : 'other'
}

// {dir}/blocks/{id}.json, {dir}/pipelines/{id}.json, {dir}/deliveries/{id}.json (steps
// embedded — one file per delivery), {dir}/meta.json (localSeq counter).
export class FileStore implements Store {
  private readonly dir: string
  private readonly now: () => Date
  private readonly mutex = new KeyedMutex()
  private readonly getOwner: () => string
  private definitions?: DefinitionSource

  constructor(opts: FileStoreOptions) {
    this.dir = opts.dir
    this.now = opts.now ?? (() => new Date())
    this.getOwner = opts.getOwner ?? (() => '')
    this.definitions = opts.definitions
  }

  setDefinitions(source: DefinitionSource | undefined): void {
    this.definitions = source
  }

  private ts(): string {
    return this.now().toISOString()
  }

  private file(kind: 'blocks' | 'pipelines' | 'deliveries', id: string): string {
    // ids are generated here, but a renderer-supplied id must never escape the store dir.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid id: ${id}`)
    return path.join(this.dir, kind, `${id}.json`)
  }

  private async readDoc<T>(kind: 'blocks' | 'pipelines' | 'deliveries', id: string, schema: z.ZodType<T>): Promise<T | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.file(kind, id), 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    return schema.parse(migrateDoc(JSON.parse(raw), docKindOf(kind)))
  }

  private async writeDoc(kind: 'blocks' | 'pipelines' | 'deliveries', id: string, doc: unknown): Promise<void> {
    await atomicWrite(this.file(kind, id), JSON.stringify(doc, null, 2))
  }

  private async listDocs<T>(kind: 'blocks' | 'pipelines' | 'deliveries', schema: z.ZodType<T>): Promise<T[]> {
    let names: string[]
    try {
      names = await fs.readdir(path.join(this.dir, kind))
    } catch {
      return []
    }
    const out: T[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(this.dir, kind, name), 'utf-8')
        out.push(schema.parse(migrateDoc(JSON.parse(raw), docKindOf(kind))))
      } catch (err) {
        log.warn(`[store] skipping unreadable ${kind}/${name}`, err)
      }
    }
    return out
  }

  // ------------------------------------------------------------ local doc primitives

  private readLocal<K extends DocKind>(kind: K, id: string): Promise<DocOf<K> | null> {
    return (kind === 'block'
      ? this.readDoc('blocks', id, BlockSchema)
      : this.readDoc('pipelines', id, PipelineSchema)) as Promise<DocOf<K> | null>
  }

  private writeLocal(kind: DocKind, doc: Block | Pipeline): Promise<void> {
    return this.writeDoc(kind === 'block' ? 'blocks' : 'pipelines', doc.id, doc)
  }

  // D13: one immutable file per published version — {dir}/versions/{blocks|pipelines}/{id}/v{n}.json
  private versionFile(kind: DocKind, id: string, version: number): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid id: ${id}`)
    return path.join(this.dir, 'versions', kind === 'block' ? 'blocks' : 'pipelines', id, `v${Math.trunc(version)}.json`)
  }

  private async readVersion<K extends DocKind>(kind: K, id: string, version: number): Promise<DocOf<K> | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.versionFile(kind, id, version), 'utf-8'))
      return (kind === 'block'
        ? BlockSchema.parse(migrateDoc(raw, 'block'))
        : PipelineSchema.parse(migrateDoc(raw, 'pipeline'))) as DocOf<K>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private async listLocalVersions(kind: DocKind, id: string): Promise<(Block | Pipeline)[]> {
    const dir = path.dirname(this.versionFile(kind, id, 1))
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const out: (Block | Pipeline)[] = []
    for (const name of names) {
      const m = /^v(\d+)\.json$/.exec(name)
      if (!m) continue
      const doc = await this.readVersion(kind, id, Number(m[1])).catch(() => null)
      if (doc) out.push(doc)
    }
    return out.sort((a, b) => a.version - b.version)
  }

  private newDefinitionMeta() {
    const ts = this.ts()
    return {
      id: crypto.randomUUID(), schemaVersion: SCHEMA_VERSION, createdAt: ts, updatedAt: ts,
      scope: 'Personal' as const, owner: this.getOwner(), status: 'Draft' as const, version: 1,
    }
  }

  /** Throws unless `existing` is a local, editable definition (not built-in or deprecated). */
  private assertEditable(kind: DocKind, existing: Block | Pipeline | null, id: string, verb: string): asserts existing is Block | Pipeline {
    if (!existing) throw new Error(`${kind === 'block' ? 'Block' : 'Pipeline'} ${id} not found`)
    if ((existing as Block).immutable) throw new Error(`Block "${existing.name}" is a built-in Axon block and cannot be ${verb}`)
    if (existing.status === 'Deprecated') throw new Error(`"${existing.name}" is deprecated and cannot be ${verb}; duplicate it instead`)
  }

  // Edit-in-place for a Draft; editing a Published definition starts the next Draft (D13).
  private nextRevision(existing: Block | Pipeline) {
    const base = { versionLabel: undefined, changeNote: undefined }
    if (existing.status === 'Published') return { ...base, version: existing.version + 1, status: 'Draft' as const }
    return { ...base, version: existing.version, status: existing.status }
  }

  // ------------------------------------------------------------ blocks

  async listBlocks(): Promise<Block[]> {
    const local = await this.listDocs('blocks', BlockSchema)
    if (!this.definitions) return local
    const ids = new Set(local.map((b) => b.id))
    return [...local, ...(await this.definitions.listBlocks()).filter((b) => !ids.has(b.id))]
  }

  async getBlock(id: string): Promise<Block | null> {
    return (await this.readDoc('blocks', id, BlockSchema)) ?? (await this.definitions?.getBlock(id)) ?? null
  }

  async getBlockVersion(id: string, version: number): Promise<Block | null> {
    const current = await this.readDoc('blocks', id, BlockSchema)
    if (current?.version === version) return current
    return (await this.readVersion('block', id, version)) ?? (await this.definitions?.getBlockVersion(id, version)) ?? null
  }

  async createBlock(input: BlockInput): Promise<Block> {
    const block = BlockSchema.parse({ ...input, ...this.newDefinitionMeta() })
    await this.writeDoc('blocks', block.id, block)
    return block
  }

  updateBlock(id: string, patch: Partial<BlockInput>): Promise<Block> {
    return this.mutex.run(`block:${id}`, async () => {
      const existing = await this.readDoc('blocks', id, BlockSchema)
      if (!existing && (await this.definitions?.getBlock(id))) {
        throw new Error('This block comes from the registry (read-only) — duplicate it to edit')
      }
      this.assertEditable('block', existing, id, 'modified')
      const next = BlockSchema.parse({
        ...existing, ...defined(patch), id, immutable: existing.immutable, ...this.nextRevision(existing), updatedAt: this.ts(),
      })
      await this.writeDoc('blocks', id, next)
      return next
    })
  }

  deleteBlock(id: string): Promise<void> {
    return this.mutex.run(`block:${id}`, async () => {
      const existing = await this.readDoc('blocks', id, BlockSchema)
      if (!existing) {
        if (await this.definitions?.getBlock(id)) throw new Error('This block comes from the registry (read-only)')
        return
      }
      if (existing.immutable) throw new Error(`Block "${existing.name}" is a built-in Axon block and cannot be deleted`)
      await fs.unlink(this.file('blocks', id)).catch(() => {})
      await fs.rm(path.dirname(this.versionFile('block', id, 1)), { recursive: true, force: true })
    })
  }

  async seedBlock(block: Block): Promise<void> {
    const seeded = BlockSchema.parse({ ...block, scope: 'Org', owner: 'axon', status: 'Published', immutable: true })
    await this.mutex.run(`block:${block.id}`, async () => {
      const existing = await this.readDoc('blocks', block.id, BlockSchema).catch(() => null)
      if (existing && existing.immutable && existing.version >= seeded.version) return
      await this.writeDoc('blocks', block.id, seeded)
    })
  }

  // ------------------------------------------------------------ pipelines

  async listPipelines(): Promise<Pipeline[]> {
    const local = await this.listDocs('pipelines', PipelineSchema)
    if (!this.definitions) return local
    const ids = new Set(local.map((p) => p.id))
    return [...local, ...(await this.definitions.listPipelines()).filter((p) => !ids.has(p.id))]
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    return (await this.readDoc('pipelines', id, PipelineSchema)) ?? (await this.definitions?.getPipeline(id)) ?? null
  }

  async getPipelineVersion(id: string, version: number): Promise<Pipeline | null> {
    const current = await this.readDoc('pipelines', id, PipelineSchema)
    if (current?.version === version) return current
    return (await this.readVersion('pipeline', id, version)) ?? (await this.definitions?.getPipelineVersion(id, version)) ?? null
  }

  async createPipeline(input: PipelineInput, createdByName?: string): Promise<Pipeline> {
    const pipeline = PipelineSchema.parse({
      name: input.name,
      description: input.description,
      nodes: input.nodes.map((n) => PipelineNodeSchema.parse(n)),
      edges: input.edges.map((e) => PipelineEdgeSchema.parse(e)),
      ...this.newDefinitionMeta(),
      createdByName,
    })
    await this.writeDoc('pipelines', pipeline.id, pipeline)
    return pipeline
  }

  updatePipeline(id: string, patch: Partial<PipelineInput>): Promise<Pipeline> {
    return this.mutex.run(`pipeline:${id}`, async () => {
      const existing = await this.readDoc('pipelines', id, PipelineSchema)
      if (!existing && (await this.definitions?.getPipeline(id))) {
        throw new Error('This pipeline comes from the registry (read-only) — duplicate it to edit')
      }
      this.assertEditable('pipeline', existing, id, 'modified')
      const next = PipelineSchema.parse({
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.nodes ? { nodes: patch.nodes.map((n) => PipelineNodeSchema.parse(n)) } : {}),
        ...(patch.edges ? { edges: patch.edges.map((e) => PipelineEdgeSchema.parse(e)) } : {}),
        ...this.nextRevision(existing),
        updatedAt: this.ts(),
      })
      await this.writeDoc('pipelines', id, next)
      return next
    })
  }

  deletePipeline(id: string): Promise<void> {
    return this.mutex.run(`pipeline:${id}`, async () => {
      if (!(await this.readDoc('pipelines', id, PipelineSchema)) && (await this.definitions?.getPipeline(id))) {
        throw new Error('This pipeline comes from the registry (read-only)')
      }
      await fs.unlink(this.file('pipelines', id)).catch(() => {})
      await fs.rm(path.dirname(this.versionFile('pipeline', id, 1)), { recursive: true, force: true })
    })
  }

  // ------------------------------------------------------------ versioning (D13)

  async listVersions(kind: DocKind, id: string): Promise<VersionInfo[]> {
    const info = (d: Block | Pipeline, source: VersionInfo['source']): VersionInfo => ({
      version: d.version, status: d.status, versionLabel: d.versionLabel, changeNote: d.changeNote,
      updatedAt: d.updatedAt, scope: d.scope, source,
    })
    const byVersion = new Map<number, VersionInfo>()
    for (const d of await this.listLocalVersions(kind, id)) byVersion.set(d.version, info(d, 'local'))
    const current = await this.readLocal(kind, id)
    if (current) byVersion.set(current.version, info(current, 'local'))
    for (const v of (await this.definitions?.listVersions(kind, id)) ?? []) if (!byVersion.has(v.version)) byVersion.set(v.version, v)
    return [...byVersion.values()].sort((a, b) => b.version - a.version)
  }

  publish<K extends DocKind>(kind: K, id: string, meta: PublishMeta = {}): Promise<DocOf<K>> {
    return this.mutex.run(`${kind}:${id}`, async () => {
      const existing = await this.readLocal(kind, id)
      this.assertEditable(kind, existing, id, 'published')
      if (existing.status !== 'Draft') throw new Error(`"${existing.name}" v${existing.version} is already published — edit it to start the next draft`)
      if (await this.readVersion(kind, id, existing.version)) throw new Error(`Version ${existing.version} already exists and is immutable`)

      let next: Block | Pipeline = { ...existing, status: 'Published', versionLabel: meta.versionLabel, changeNote: meta.changeNote, updatedAt: this.ts() }
      if (kind === 'pipeline') {
        // Nodes pin the block version they were published against, so reruns never drift.
        const pipeline = next as Pipeline
        const unpublished: string[] = []
        const nodes = []
        for (const node of pipeline.nodes) {
          const block = await this.getBlock(node.blockId)
          if (!block) throw new Error(`Block ${node.blockId} (node "${node.label ?? node.id}") not found`)
          const latest = latestPublishedVersion(block)
          if (node.blockVersion === undefined && latest < 1) unpublished.push(block.name)
          nodes.push({ ...node, blockVersion: node.blockVersion ?? latest })
        }
        if (unpublished.length) throw new Error(`Publish these blocks first: ${[...new Set(unpublished)].join(', ')}`)
        next = { ...pipeline, nodes }
      }
      const parsed = (kind === 'block' ? BlockSchema.parse(next) : PipelineSchema.parse(next)) as Block | Pipeline
      await atomicWrite(this.versionFile(kind, id, parsed.version), JSON.stringify(parsed, null, 2))
      await this.writeLocal(kind, parsed)
      return parsed as DocOf<K>
    })
  }

  deprecate<K extends DocKind>(kind: K, id: string): Promise<DocOf<K>> {
    return this.mutex.run(`${kind}:${id}`, async () => {
      const existing = await this.readLocal(kind, id)
      if (!existing) throw new Error(`${kind} ${id} not found`)
      if ((existing as Block).immutable) throw new Error(`Block "${existing.name}" is a built-in Axon block and cannot be deprecated`)
      const target = latestPublishedVersion(existing)
      const published: Block | Pipeline | null = target < 1
        ? null
        : existing.version === target && existing.status !== 'Draft' ? existing : await this.readVersion(kind, id, target)
      if (!published || published.status === 'Draft') throw new Error(`"${existing.name}" has no published version to deprecate`)
      const deprecated = { ...published, status: 'Deprecated' as const, updatedAt: this.ts() }
      // Status is the one field allowed to change on a published version file.
      await atomicWrite(this.versionFile(kind, id, target), JSON.stringify(deprecated, null, 2))
      if (existing.version === target) await this.writeLocal(kind, deprecated)
      return deprecated as DocOf<K>
    })
  }

  async duplicate<K extends DocKind>(kind: K, id: string): Promise<DocOf<K>> {
    const source = kind === 'block' ? await this.getBlock(id) : await this.getPipeline(id)
    if (!source) throw new Error(`${kind} ${id} not found`)
    if (kind === 'block' && ((source as Block).immutable || (source as Block).sourceType === 'Axon')) {
      throw new Error('Built-in Axon blocks cannot be duplicated')
    }
    const copy = {
      ...source,
      ...this.newDefinitionMeta(),
      name: `${source.name} (copy)`,
      team: undefined,
      versionLabel: undefined,
      changeNote: undefined,
      derivedFrom: { id: source.id, version: latestPublishedVersion(source) || source.version },
      immutable: undefined,
    }
    const parsed = (kind === 'block' ? BlockSchema.parse(copy) : PipelineSchema.parse(copy)) as Block | Pipeline
    await this.writeLocal(kind, parsed)
    return parsed as DocOf<K>
  }

  /** Registry hydration: import a document (and its published versions) that this machine lacks. */
  importDoc(kind: DocKind, current: Block | Pipeline, published: (Block | Pipeline)[]): Promise<boolean> {
    return this.mutex.run(`${kind}:${current.id}`, async () => {
      if (await this.readLocal(kind, current.id).catch(() => null)) return false
      for (const v of published) await atomicWrite(this.versionFile(kind, current.id, v.version), JSON.stringify(v, null, 2))
      await this.writeLocal(kind, current)
      return true
    })
  }

  /** Local published versions of a document (used when mirroring to the registry). */
  localPublishedVersions(kind: DocKind, id: string): Promise<(Block | Pipeline)[]> {
    return this.listLocalVersions(kind, id)
  }

  getLocal<K extends DocKind>(kind: K, id: string): Promise<DocOf<K> | null> {
    return this.readLocal(kind, id)
  }

  // ------------------------------------------------------------ deliveries

  listDeliveries(): Promise<Delivery[]> {
    return this.listDocs('deliveries', DeliverySchema)
  }

  getDelivery(id: string): Promise<Delivery | null> {
    return this.readDoc('deliveries', id, DeliverySchema)
  }

  private nextLocalSeq(): Promise<number> {
    return this.mutex.run('meta', async () => {
      const metaPath = path.join(this.dir, 'meta.json')
      let seq = 0
      try {
        seq = (JSON.parse(await fs.readFile(metaPath, 'utf-8')) as { localSeq?: number }).localSeq ?? 0
      } catch {
        // first delivery — counter starts at 0
      }
      seq += 1
      await atomicWrite(metaPath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, localSeq: seq }))
      return seq
    })
  }

  async createDelivery(input: CreateDeliveryInput, createdByName?: string): Promise<Delivery> {
    const pipeline = await this.getPipeline(input.pipelineId)
    if (!pipeline) throw new Error(`Pipeline ${input.pipelineId} not found`)

    const blockVersions: Record<string, number> = {}
    for (const node of pipeline.nodes) {
      if (node.blockId in blockVersions) continue
      const block = node.blockVersion !== undefined
        ? await this.getBlockVersion(node.blockId, node.blockVersion)
        : await this.getBlock(node.blockId)
      if (!block) throw new Error(`Block ${node.blockId}${node.blockVersion !== undefined ? ` v${node.blockVersion}` : ''} (node "${node.label ?? node.id}") not found`)
      blockVersions[node.blockId] = block.version
    }

    const ts = this.ts()
    const delivery = DeliverySchema.parse({
      id: crypto.randomUUID(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      localSeq: await this.nextLocalSeq(),
      ticketId: input.ticketId,
      title: input.title,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      pipelineVersion: pipeline.version,
      pipelineSnapshot: {
        pipelineId: pipeline.id,
        pipelineVersion: pipeline.version,
        name: pipeline.name,
        nodes: pipeline.nodes,
        edges: pipeline.edges,
        blockVersions,
      },
      status: 'Pending',
      repoUrl: input.repoUrl,
      workspaceType: input.workspaceType,
      storeFullContext: input.storeFullContext,
      steps: [],
      inputs: input.inputs,
      retriedFromDeliveryId: input.retriedFromDeliveryId ?? null,
      rerunReason: input.rerunReason,
      startedAt: ts,
      createdByName,
    })
    await this.writeDoc('deliveries', delivery.id, delivery)
    return delivery
  }

  updateDelivery(id: string, mutate: (d: Delivery) => Delivery | void): Promise<Delivery> {
    return this.mutex.run(`delivery:${id}`, async () => {
      const existing = await this.getDelivery(id)
      if (!existing) throw new Error(`Delivery ${id} not found`)
      const result = mutate(existing)
      const next = DeliverySchema.parse({ ...(result ?? existing), id, updatedAt: this.ts() })
      await this.writeDoc('deliveries', id, next)
      return next
    })
  }

  upsertStep(deliveryId: string, step: DeliveryStep): Promise<Delivery> {
    return this.updateDelivery(deliveryId, (d) => {
      const idx = d.steps.findIndex((s) => sameStepKey(s, step))
      if (idx >= 0) d.steps[idx] = step
      else d.steps.push(step)
    })
  }
}
