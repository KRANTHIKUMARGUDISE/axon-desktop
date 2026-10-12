import type {
  Block, BlockInput, Pipeline, PipelineInput, Delivery, CreateDeliveryInput, DeliveryStep,
} from '../../shared'
import type { Store, DocKind, DocOf, VersionInfo, PublishMeta } from './types'
import type { FileStore } from './fileStore'
import { blockOps, pipelineOps } from '../registry/docs'
import type { FileOp } from '../registry/docs'
import { userRoot } from '../registry/layout'
import { log } from '../log'

export interface GitRepoStoreDeps {
  /** Local cache + working copy (also does the read-through to org/team definitions). */
  local: FileStore
  /** Verified email of this engineer; '' before onboarding (nothing is mirrored then). */
  getEmail: () => string
  /** Hands a registry file operation to the durable write queue. */
  enqueue: (op: FileOp) => Promise<void>
}

// The Store used by the app: FileStore stays the offline-capable cache and source for reads; every
// change to the engineer's own blocks/pipelines is additionally mirrored into the registry layout and
// queued for sync (users/{email}/…). Deliveries and runs are never mirrored here — only a whitelisted
// run summary leaves the machine (registry/runSummary.ts). A mirror failure never fails the local write.
export class GitRepoStore implements Store {
  constructor(private readonly deps: GitRepoStoreDeps) {}

  private get local(): FileStore {
    return this.deps.local
  }

  private async send(ops: FileOp[]): Promise<void> {
    for (const op of ops) await this.deps.enqueue(op)
  }

  private async mirror(what: string, fn: (root: string) => Promise<FileOp[]>): Promise<void> {
    const email = this.deps.getEmail()
    if (!email) return
    try {
      await this.send(await fn(userRoot(email)))
    } catch (err) {
      log.warn(`[registry] could not queue ${what} for sync (kept locally)`, err)
    }
  }

  /** Re-queue the current local state of a document (Draft → draft.yaml, Published → v{n}). */
  mirrorCurrent(kind: DocKind, id: string): Promise<void> {
    return this.mirror(`${kind} ${id}`, async (root) => {
      const doc = await this.local.getLocal(kind, id)
      if (!doc || doc.scope !== 'Personal' || (doc as Block).immutable) return []
      // Pre-registry documents have no owner yet; the registry copy always carries it.
      const owned = { ...doc, owner: doc.owner || this.deps.getEmail() }
      return kind === 'block' ? blockOps(root, owned as Block) : pipelineOps(root, owned as Pipeline)
    })
  }

  private mirrorDoc(kind: DocKind, doc: Block | Pipeline): Promise<void> {
    return this.mirror(`${kind} ${doc.id}`, async (root) =>
      kind === 'block' ? blockOps(root, doc as Block, { pruneDraft: false }) : pipelineOps(root, doc as Pipeline, { pruneDraft: false }))
  }

  private mirrorDelete(kind: DocKind, id: string): Promise<void> {
    return this.mirror(`delete ${kind} ${id}`, async (root) => [{ op: 'delete', path: `${root}/${kind}s/${id}` }])
  }

  /**
   * One-time catch-up for documents created before the registry existed (or while no identity was set):
   * queue every Personal document, plus its published versions, so an engineer's existing work reaches
   * users/{email}/ without having to edit it first. Idempotent (identical content is a no-op commit).
   */
  async backfill(): Promise<number> {
    const email = this.deps.getEmail()
    if (!email) return 0
    let n = 0
    for (const kind of ['block', 'pipeline'] as const) {
      const docs: (Block | Pipeline)[] = kind === 'block' ? await this.local.listBlocks() : await this.local.listPipelines()
      for (const doc of docs) {
        if (doc.scope !== 'Personal' || (doc as Block).immutable || (doc as Block).sourceType === 'Axon') continue
        for (const v of await this.local.localPublishedVersions(kind, doc.id)) {
          if (v.version !== doc.version) await this.mirrorDoc(kind, { ...v, owner: v.owner || email })
        }
        await this.mirrorCurrent(kind, doc.id)
        n++
      }
    }
    return n
  }

  // ---------------------------------------------------------------- blocks

  listBlocks = (): Promise<Block[]> => this.local.listBlocks()
  getBlock = (id: string): Promise<Block | null> => this.local.getBlock(id)
  getBlockVersion = (id: string, version: number): Promise<Block | null> => this.local.getBlockVersion(id, version)
  seedBlock = (block: Block): Promise<void> => this.local.seedBlock(block)

  async createBlock(input: BlockInput): Promise<Block> {
    const block = await this.local.createBlock(input)
    await this.mirrorCurrent('block', block.id)
    return block
  }

  async updateBlock(id: string, patch: Partial<BlockInput>): Promise<Block> {
    const block = await this.local.updateBlock(id, patch)
    await this.mirrorCurrent('block', id)
    return block
  }

  async deleteBlock(id: string): Promise<void> {
    await this.local.deleteBlock(id)
    await this.mirrorDelete('block', id)
  }

  // ---------------------------------------------------------------- pipelines

  listPipelines = (): Promise<Pipeline[]> => this.local.listPipelines()
  getPipeline = (id: string): Promise<Pipeline | null> => this.local.getPipeline(id)
  getPipelineVersion = (id: string, version: number): Promise<Pipeline | null> => this.local.getPipelineVersion(id, version)

  async createPipeline(input: PipelineInput, createdByName?: string): Promise<Pipeline> {
    const pipeline = await this.local.createPipeline(input, createdByName)
    await this.mirrorCurrent('pipeline', pipeline.id)
    return pipeline
  }

  async updatePipeline(id: string, patch: Partial<PipelineInput>): Promise<Pipeline> {
    const pipeline = await this.local.updatePipeline(id, patch)
    await this.mirrorCurrent('pipeline', id)
    return pipeline
  }

  async deletePipeline(id: string): Promise<void> {
    await this.local.deletePipeline(id)
    await this.mirrorDelete('pipeline', id)
  }

  // ---------------------------------------------------------------- versioning (D13)

  listVersions = (kind: DocKind, id: string): Promise<VersionInfo[]> => this.local.listVersions(kind, id)

  async publish<K extends DocKind>(kind: K, id: string, meta?: PublishMeta): Promise<DocOf<K>> {
    const doc = await this.local.publish(kind, id, meta)
    await this.mirrorCurrent(kind, id)
    return doc
  }

  async deprecate<K extends DocKind>(kind: K, id: string): Promise<DocOf<K>> {
    const doc = await this.local.deprecate(kind, id)
    // The deprecated version may be older than the current draft: re-write that version file only.
    await this.mirrorDoc(kind, doc)
    return doc
  }

  async duplicate<K extends DocKind>(kind: K, id: string): Promise<DocOf<K>> {
    const doc = await this.local.duplicate(kind, id)
    await this.mirrorCurrent(kind, doc.id)
    return doc
  }

  // ---------------------------------------------------------------- deliveries (local only)

  listDeliveries = (): Promise<Delivery[]> => this.local.listDeliveries()
  getDelivery = (id: string): Promise<Delivery | null> => this.local.getDelivery(id)
  createDelivery = (input: CreateDeliveryInput, createdByName?: string): Promise<Delivery> => this.local.createDelivery(input, createdByName)
  updateDelivery = (id: string, mutate: (d: Delivery) => Delivery | void): Promise<Delivery> => this.local.updateDelivery(id, mutate)
  upsertStep = (deliveryId: string, step: DeliveryStep): Promise<Delivery> => this.local.upsertStep(deliveryId, step)
}
