import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { z } from 'zod'
import {
  BlockSchema, PipelineSchema, DeliverySchema, PipelineNodeSchema, PipelineEdgeSchema,
  SCHEMA_VERSION,
} from '../../shared'
import type {
  Block, BlockInput, Pipeline, PipelineInput, Delivery, CreateDeliveryInput, DeliveryStep,
} from '../../shared'
import { atomicWrite } from './atomic'
import { KeyedMutex } from './mutex'
import { sameStepKey } from './types'
import type { Store } from './types'

// Patches arrive over IPC with explicit `undefined` keys ("don't change this"); spreading them
// would blank the stored value.
function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

export interface FileStoreOptions {
  dir: string
  now?: () => Date
}

// {dir}/blocks/{id}.json, {dir}/pipelines/{id}.json, {dir}/deliveries/{id}.json (steps
// embedded — one file per delivery), {dir}/meta.json (localSeq counter).
export class FileStore implements Store {
  private readonly dir: string
  private readonly now: () => Date
  private readonly mutex = new KeyedMutex()

  constructor(opts: FileStoreOptions) {
    this.dir = opts.dir
    this.now = opts.now ?? (() => new Date())
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
    return schema.parse(JSON.parse(raw))
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
        out.push(schema.parse(JSON.parse(raw)))
      } catch (err) {
        console.warn(`[store] skipping unreadable ${kind}/${name}: ${err}`)
      }
    }
    return out
  }

  // ------------------------------------------------------------ blocks

  listBlocks(): Promise<Block[]> {
    return this.listDocs('blocks', BlockSchema)
  }

  getBlock(id: string): Promise<Block | null> {
    return this.readDoc('blocks', id, BlockSchema)
  }

  async createBlock(input: BlockInput): Promise<Block> {
    const ts = this.ts()
    const block = BlockSchema.parse({
      ...input, id: crypto.randomUUID(), schemaVersion: SCHEMA_VERSION, version: 1, createdAt: ts, updatedAt: ts,
    })
    await this.writeDoc('blocks', block.id, block)
    return block
  }

  updateBlock(id: string, patch: Partial<BlockInput>): Promise<Block> {
    return this.mutex.run(`block:${id}`, async () => {
      const existing = await this.getBlock(id)
      if (!existing) throw new Error(`Block ${id} not found`)
      if (existing.immutable) throw new Error(`Block "${existing.name}" is a built-in Axon block and cannot be modified`)
      const next = BlockSchema.parse({
        ...existing, ...defined(patch), id, immutable: existing.immutable, version: existing.version + 1, updatedAt: this.ts(),
      })
      await this.writeDoc('blocks', id, next)
      return next
    })
  }

  deleteBlock(id: string): Promise<void> {
    return this.mutex.run(`block:${id}`, async () => {
      const existing = await this.getBlock(id)
      if (!existing) return
      if (existing.immutable) throw new Error(`Block "${existing.name}" is a built-in Axon block and cannot be deleted`)
      await fs.unlink(this.file('blocks', id)).catch(() => {})
    })
  }

  async seedBlock(block: Block): Promise<void> {
    const existing = await this.getBlock(block.id)
    if (existing) return
    await this.writeDoc('blocks', block.id, BlockSchema.parse({ ...block, immutable: true }))
  }

  // ------------------------------------------------------------ pipelines

  listPipelines(): Promise<Pipeline[]> {
    return this.listDocs('pipelines', PipelineSchema)
  }

  getPipeline(id: string): Promise<Pipeline | null> {
    return this.readDoc('pipelines', id, PipelineSchema)
  }

  async createPipeline(input: PipelineInput, createdByName?: string): Promise<Pipeline> {
    const ts = this.ts()
    const pipeline = PipelineSchema.parse({
      name: input.name,
      description: input.description,
      nodes: input.nodes.map((n) => PipelineNodeSchema.parse(n)),
      edges: input.edges.map((e) => PipelineEdgeSchema.parse(e)),
      id: crypto.randomUUID(), schemaVersion: SCHEMA_VERSION, version: 1, createdAt: ts, updatedAt: ts,
      createdByName,
    })
    await this.writeDoc('pipelines', pipeline.id, pipeline)
    return pipeline
  }

  updatePipeline(id: string, patch: Partial<PipelineInput>): Promise<Pipeline> {
    return this.mutex.run(`pipeline:${id}`, async () => {
      const existing = await this.getPipeline(id)
      if (!existing) throw new Error(`Pipeline ${id} not found`)
      const next = PipelineSchema.parse({
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.nodes ? { nodes: patch.nodes.map((n) => PipelineNodeSchema.parse(n)) } : {}),
        ...(patch.edges ? { edges: patch.edges.map((e) => PipelineEdgeSchema.parse(e)) } : {}),
        version: existing.version + 1,
        updatedAt: this.ts(),
      })
      await this.writeDoc('pipelines', id, next)
      return next
    })
  }

  async deletePipeline(id: string): Promise<void> {
    await fs.unlink(this.file('pipelines', id)).catch(() => {})
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
      const block = await this.getBlock(node.blockId)
      if (!block) throw new Error(`Block ${node.blockId} (node "${node.label ?? node.id}") not found`)
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
