import { BrowserWindow, Notification } from 'electron'
import type { EventBus } from './engine/bus'
import type { Store } from './store/types'
import { describeNotification } from './notificationText'
import { redact, log } from './log'

// OS notifications on gate reached / review due / completed / failed. Clicking one focuses the app and opens that
// delivery's Live View. (The renderer's web Notification API is denied by the permission handler, so this is main-only.)

export const OPEN_DELIVERY_CHANNEL = 'notification:openDelivery'

export function startNotifications(deps: { bus: EventBus; store: Store; getWindow: () => BrowserWindow | null; createWindow: () => void }): () => void {
  return deps.bus.subscribe((event) => {
    if (event.type !== 'gate_reached' && event.type !== 'gate_notified' && event.type !== 'completed' && event.type !== 'failed') return
    if (!Notification.isSupported()) return
    void deps.store.getDelivery(event.deliveryId).then((delivery) => {
      const text = describeNotification(event, delivery)
      if (!text) return
      const n = new Notification({ title: text.title, body: redact(text.body) })
      n.on('click', () => {
        let win = deps.getWindow()
        if (!win || win.isDestroyed()) {
          deps.createWindow()
          win = deps.getWindow()
        }
        if (!win) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        const send = () => win?.webContents.send(OPEN_DELIVERY_CHANNEL, event.deliveryId)
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
        else send()
      })
      n.show()
    }).catch((err) => log.warn('[notifications] failed', err))
  })
}
