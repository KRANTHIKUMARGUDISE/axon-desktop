import type {
  Block, BlockInput, Pipeline, PipelineInput, Delivery, CreateDeliveryInput, DeliveryStep,
} from '../../shared'

// Persistence port for AXON documents. FileStore (this session) is the local
// implementation; GitRepoStore (S3) and a future ApiStore implement the same interface.
export interface Store {
  listBlocks(): Promise<Block[]>
  getBlock(id: string): Promise<Block | null>
  createBlock(input: BlockInput): Promise<Block>
  updateBlock(id: string, patch: Partial<BlockInput>): Promise<Block>
  deleteBlock(id: string): Promise<void>
  /** Insert a built-in (immutable) block if it is not already present. */
  seedBlock(block: Block): Promise<void>

  listPipelines(): Promise<Pipeline[]>
  getPipeline(id: string): Promise<Pipeline | null>
  createPipeline(input: PipelineInput, createdByName?: string): Promise<Pipeline>
  updatePipeline(id: string, patch: Partial<PipelineInput>): Promise<Pipeline>
  deletePipeline(id: string): Promise<void>

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
