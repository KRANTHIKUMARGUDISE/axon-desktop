import { BrowserWindow } from 'electron'
import { handle } from './guard'
import { z } from 'zod'
import type { Engine } from '../engine/engine'
import type { EventBus } from '../engine/bus'

const Id = z.string().min(1)

// Thin IPC handlers over the engine, plus the single typed event channel (D2).
export const DELIVERY_EVENT_CHANNEL = 'delivery:event'

export function registerDeliveryHandlers(engine: Engine, bus: EventBus) {
  handle('delivery:start', z.tuple([Id]), ([id]) => engine.start(id))
  handle('delivery:resume', z.tuple([Id]), ([id]) => engine.resume(id))
  handle('delivery:cancel', z.tuple([Id]), ([id]) => engine.cancel(id))
  handle('delivery:previewResume', z.tuple([Id]), ([id]) => engine.previewResume(id))
  handle('delivery:approveGate', z.tuple([Id, z.string().max(10_000).optional()]), ([id, comment]) =>
    engine.approveGate(id, comment))
  handle('delivery:rejectGate', z.tuple([Id, z.string().max(10_000)]), ([id, comment]) =>
    engine.rejectGate(id, comment))

  bus.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(DELIVERY_EVENT_CHANNEL, event)
    }
  })
}
