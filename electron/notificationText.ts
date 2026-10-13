import type { Delivery, DeliveryEvent } from '../shared'

// Pure text for the OS notifications (S5 item 10); the Electron side lives in notifications.ts.

export interface NotificationText {
  title: string
  body: string
}

const cap = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function describeNotification(event: DeliveryEvent, delivery: Pick<Delivery, 'ticketId' | 'title' | 'pipelineName' | 'prUrl' | 'errorMessage' | 'failureCategory'> | null): NotificationText | null {
  const ticket = delivery?.ticketId ?? 'A delivery'
  const what = delivery?.title ? `${ticket} — ${delivery.title}` : ticket
  switch (event.type) {
    case 'gate_reached':
      return { title: `Review needed: ${ticket}`, body: cap(`${event.blockName} is waiting for your decision. ${what}`) }
    case 'gate_notified':
      return { title: `Review due: ${ticket}`, body: cap(`${event.blockName}: ${event.reason ?? 'a review is due'} (the delivery keeps running)`) }
    case 'completed':
      return { title: `Completed: ${ticket}`, body: cap(delivery?.prUrl ? `Pull request ready: ${delivery.prUrl}` : `${what} finished.`) }
    case 'failed':
      return { title: `Failed: ${ticket}`, body: cap(`${event.failureCategory ? `${event.failureCategory} failure. ` : ''}${event.message}`) }
    default:
      return null
  }
}
