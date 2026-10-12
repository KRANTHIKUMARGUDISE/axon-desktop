import type {
  Block, BlockInput, Pipeline, PipelineInput, Delivery, CreateDeliveryInput, DeliveryStep, DocStatus, Scope,
} from '../../shared'

export type DocKind = 'block' | 'pipeline'
export type DocOf<K extends DocKind> = K extends 'block' ? Block : Pipeline

export interface VersionInfo {
  version: number
  status: DocStatus
  versionLabel?: string
  changeNote?: string
  updatedAt: string
  scope: Scope
  /** 'local' = this machine's store; 'registry' = read from the shared registry clone. */
  source: 'local' | 'registry'
}

export interface PublishMeta {
  versionLabel?: string
  changeNote?: string
}

/** Read-only definitions that live outside the local store (org/team docs from the registry). */
export interface DefinitionSource {
  listBlocks(): Promise<Block[]>
  getBlock(id: string): Promise<Block | null>
  getBlockVersion(id: string, version: number): Promise<Block | null>
  listPipelines(): Promise<Pipeline[]>
  getPipeline(id: string): Promise<Pipeline | null>
  getPipelineVersion(id: string, version: number): Promise<Pipeline | null>
  listVersions(kind: DocKind, id: string): Promise<VersionInfo[]>
}

// Persistence port for AXON documents. FileStore is the local implementation; GitRepoStore wraps
// it with registry sync (S3); a future ApiStore implements the same interface.
export interface Store {
  listBlocks(): Promise<Block[]>
  getBlock(id: string): Promise<Block | null>
  /** A specific immutable version (or the current document when it is that version). */
  getBlockVersion(id: string, version: number): Promise<Block | null>
  createBlock(input: BlockInput): Promise<Block>
  /** Edits the Draft in place; editing a Published block starts the next Draft (D13). */
  updateBlock(id: string, patch: Partial<BlockInput>): Promise<Block>
  deleteBlock(id: string): Promise<void>
  /** Insert a built-in (immutable) block, or upgrade it when the bundled version is newer. */
  seedBlock(block: Block): Promise<void>

  listPipelines(): Promise<Pipeline[]>
  getPipeline(id: string): Promise<Pipeline | null>
  getPipelineVersion(id: string, version: number): Promise<Pipeline | null>
  createPipeline(input: PipelineInput, createdByName?: string): Promise<Pipeline>
  updatePipeline(id: string, patch: Partial<PipelineInput>): Promise<Pipeline>
  deletePipeline(id: string): Promise<void>

  // ---- D13 versioning (blocks and pipelines)
  listVersions(kind: DocKind, id: string): Promise<VersionInfo[]>
  /** Draft -> Published (immutable). Pipelines pin each node's blockVersion. */
  publish<K extends DocKind>(kind: K, id: string, meta?: PublishMeta): Promise<DocOf<K>>
  /** Published -> Deprecated (the version stays readable and pinned runs keep working). */
  deprecate<K extends DocKind>(kind: K, id: string): Promise<DocOf<K>>
  /** New Personal Draft that records `derivedFrom: {id, version}`. */
  duplicate<K extends DocKind>(kind: K, id: string): Promise<DocOf<K>>

  listDeliveries(): Promise<Delivery[]>
  getDelivery(id: string): Promise<Delivery | null>
  /** Builds pipelineSnapshot (nodes, edges, block versions) from the current pipeline + blocks. */
  createDelivery(input: CreateDeliveryInput, createdByName?: string): Promise<Delivery>
  /**
   * Single-writer read-modify-write for one delivery. The mutator may mutate in place or
   * return a replacement; the result is persisted atomically and returned.
   */
  updateDelivery(id: string, mutate: (d: Delivery) => Delivery | void): Promise<Delivery>
  /** Insert or replace a step keyed by (nodeId, itemKey). */
  upsertStep(deliveryId: string, step: DeliveryStep): Promise<Delivery>
}

export function sameStepKey(a: { nodeId: string; itemKey?: string | null }, b: { nodeId: string; itemKey?: string | null }): boolean {
  return a.nodeId === b.nodeId && (a.itemKey ?? null) === (b.itemKey ?? null)
}

/** Insert-or-replace a step in a delivery (keyed by nodeId + itemKey). Mutates `d`. */
export function applyStep(d: { steps: DeliveryStep[] }, step: DeliveryStep): void {
  const idx = d.steps.findIndex((s) => sameStepKey(s, step))
  if (idx >= 0) d.steps[idx] = step
  else d.steps.push(step)
}
