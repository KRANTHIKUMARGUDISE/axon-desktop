import { ipcMain } from 'electron'
import { z } from 'zod'
import os from 'os'
import { BlockInputSchema, PipelineInputSchema, CreateDeliveryInputSchema } from '../../shared'
import type { Store } from '../store/types'
import { readStored } from '../engine/runs'

const Id = z.string().min(1)
const OutputKind = z.enum(['context', 'output'])

// Thin IPC layer over the Store — every argument is validated at the boundary.
export function registerDataHandlers(store: Store, runsDir: string) {
  ipcMain.handle('blocks:list', () => store.listBlocks())
  ipcMain.handle('blocks:get', (_e, id: unknown) => store.getBlock(Id.parse(id)))
  ipcMain.handle('blocks:create', (_e, input: unknown) => {
    const parsed = BlockInputSchema.parse(input)
    if (parsed.sourceType === 'Axon') throw new Error('Axon blocks are built in and cannot be created')
    return store.createBlock(parsed)
  })
  ipcMain.handle('blocks:update', (_e, id: unknown, patch: unknown) =>
    store.updateBlock(Id.parse(id), BlockInputSchema.partial().parse(patch)))
  ipcMain.handle('blocks:delete', (_e, id: unknown) => store.deleteBlock(Id.parse(id)))

  ipcMain.handle('pipelines:list', () => store.listPipelines())
  ipcMain.handle('pipelines:get', (_e, id: unknown) => store.getPipeline(Id.parse(id)))
  ipcMain.handle('pipelines:create', (_e, input: unknown) =>
    store.createPipeline(PipelineInputSchema.parse(input), os.userInfo().username))
  ipcMain.handle('pipelines:update', (_e, id: unknown, patch: unknown) =>
    store.updatePipeline(Id.parse(id), PipelineInputSchema.partial().parse(patch)))
  ipcMain.handle('pipelines:delete', (_e, id: unknown) => store.deletePipeline(Id.parse(id)))

  ipcMain.handle('deliveries:list', () => store.listDeliveries())
  ipcMain.handle('deliveries:get', (_e, id: unknown) => store.getDelivery(Id.parse(id)))
  ipcMain.handle('deliveries:create', (_e, input: unknown) =>
    store.createDelivery(CreateDeliveryInputSchema.parse(input), os.userInfo().username))

  // Full context / output for one step — reads the DS1 file when the document only holds a marker.
  ipcMain.handle('deliveries:stepData', async (_e, deliveryId: unknown, nodeId: unknown, kind: unknown) => {
    const delivery = await store.getDelivery(Id.parse(deliveryId))
    const step = delivery?.steps.find((s) => s.nodeId === Id.parse(nodeId))
    if (!delivery || !step) throw new Error('Step not found')
    if (OutputKind.parse(kind) === 'context') {
      if (step.isContextTruncated && step.contextFileRef) return readStored(runsDir, delivery.id, step.contextFileRef)
      return step.contextSnapshot ?? {}
    }
    if (step.output?.isTruncated && step.output.outputFileRef) return readStored(runsDir, delivery.id, step.output.outputFileRef)
    return step.output?.result ?? {}
  })
}
