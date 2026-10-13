import { z } from 'zod'
import { BlockInputSchema, PipelineInputSchema, CreateDeliveryInputSchema, watcherEligible } from '../../shared'
import type { DeliveryRule } from '../../shared'
import type { Store } from '../store/types'
import { readStored } from '../engine/runs'
import { handle } from './guard'
import type { IdentityProvider } from '../identity'

const Id = z.string().min(1)
const OutputKind = z.enum(['context', 'output'])

// Thin IPC layer over the Store — every argument is validated at the boundary.
export function registerDataHandlers(
  store: Store,
  runsDir: string,
  identity: IdentityProvider,
  onRerun?: (previousDeliveryId: string) => void,
  listRules?: () => Promise<Pick<DeliveryRule, 'enabled' | 'jiraProjectKey' | 'pipelineId'>[]>,
) {
  handle('blocks:list', z.tuple([]), () => store.listBlocks())
  handle('blocks:get', z.tuple([Id]), ([id]) => store.getBlock(id))
  handle('blocks:create', z.tuple([z.unknown()]), ([input]) => {
    const parsed = BlockInputSchema.parse(input)
    if (parsed.sourceType === 'Axon') throw new Error('Axon blocks are built in and cannot be created')
    // Stamp the verified identity — the renderer can't claim who accepted the execution agreement.
    return store.createBlock({ ...parsed, executionAgreementAcceptedBy: parsed.executionAgreementAcceptedAt ? identity.actor() : undefined })
  })
  handle('blocks:update', z.tuple([Id, z.unknown()]), ([id, patch]) =>
    store.updateBlock(id, BlockInputSchema.partial().parse(patch)))
  handle('blocks:delete', z.tuple([Id]), ([id]) => store.deleteBlock(id))

  handle('pipelines:list', z.tuple([]), () => store.listPipelines())
  handle('pipelines:get', z.tuple([Id]), ([id]) => store.getPipeline(id))
  handle('pipelines:getVersion', z.tuple([Id, z.number().int().min(1)]), ([id, version]) => store.getPipelineVersion(id, version))
  handle('pipelines:create', z.tuple([z.unknown()]), ([input]) =>
    store.createPipeline(PipelineInputSchema.parse(input), identity.displayName()))
  handle('pipelines:update', z.tuple([Id, z.unknown()]), ([id, patch]) =>
    store.updatePipeline(id, PipelineInputSchema.partial().parse(patch)))
  handle('pipelines:delete', z.tuple([Id]), ([id]) => store.deletePipeline(id))

  handle('deliveries:list', z.tuple([]), () => store.listDeliveries())
  handle('deliveries:get', z.tuple([Id]), ([id]) => store.getDelivery(id))
  handle('deliveries:create', z.tuple([z.unknown()]), async ([input]) => {
    // The renderer only ever creates Manual deliveries: trigger, rule, claim and the eligibility flag are main-owned
    // (a forged "Watcher" trigger would hide an intervention from the metrics).
    const { trigger: _t, ruleId: _r, claimKey: _c, watcherEligible: _w, ...fromRenderer } = CreateDeliveryInputSchema.parse(input)
    const eligible = listRules ? watcherEligible(await listRules().catch(() => []), fromRenderer.ticketId, fromRenderer.pipelineId) : false
    const parsed = { ...fromRenderer, trigger: 'Manual' as const, watcherEligible: eligible }
    const created = await store.createDelivery(parsed, identity.displayName())
    // The delivery being re-run may now be Superseded: let the registry run summary follow.
    if (parsed.retriedFromDeliveryId) onRerun?.(parsed.retriedFromDeliveryId)
    return created
  })

  // Full context / output for one step — reads the DS1 file when the document only holds a marker.
  // `itemKey` selects one ForEach item's step: a step is keyed by (nodeId, itemKey), never merged across items.
  handle('deliveries:stepData', z.tuple([Id, Id, OutputKind, z.string().min(1).optional()]), async ([deliveryId, nodeId, kind, itemKey]) => {
    const delivery = await store.getDelivery(deliveryId)
    const step = delivery?.steps.find((s) => s.nodeId === nodeId && (s.itemKey ?? null) === (itemKey ?? null))
    if (!delivery || !step) throw new Error('Step not found')
    if (kind === 'context') {
      if (step.isContextTruncated && step.contextFileRef) return readStored(runsDir, delivery.id, step.contextFileRef)
      return step.contextSnapshot ?? {}
    }
    if (step.output?.isTruncated && step.output.outputFileRef) return readStored(runsDir, delivery.id, step.output.outputFileRef)
    return step.output?.result ?? {}
  })
}
