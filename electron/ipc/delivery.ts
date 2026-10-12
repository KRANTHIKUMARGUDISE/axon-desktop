import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import type { Engine } from '../engine/engine'
import type { EventBus } from '../engine/bus'

const Id = z.string().min(1)

// Thin IPC handlers over the engine, plus the single typed event channel (D2).
export const DELIVERY_EVENT_CHANNEL = 'delivery:event'

export function registerDeliveryHandlers(engine: Engine, bus: EventBus) {
  ipcMain.handle('delivery:start', (_e, id: unknown) => engine.start(Id.parse(id)))
  ipcMain.handle('delivery:resume', (_e, id: unknown) => engine.resume(Id.parse(id)))
  ipcMain.handle('delivery:cancel', (_e, id: unknown) => engine.cancel(Id.parse(id)))
  ipcMain.handle('delivery:previewResume', (_e, id: unknown) => engine.previewResume(Id.parse(id)))
  ipcMain.handle('delivery:approveGate', (_e, id: unknown, comment: unknown) =>
    engine.approveGate(Id.parse(id), z.string().optional().parse(comment)))
  ipcMain.handle('delivery:rejectGate', (_e, id: unknown, comment: unknown) =>
    engine.rejectGate(Id.parse(id), z.string().parse(comment)))

  bus.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(DELIVERY_EVENT_CHANNEL, event)
    }
  })
}
