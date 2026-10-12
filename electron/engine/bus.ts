import type { DeliveryEvent } from '../../shared'

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type EventInput = DistributiveOmit<DeliveryEvent, 'at' | 'deliveryId'>

export interface EventBus {
  emit(event: DeliveryEvent): void
  subscribe(listener: (event: DeliveryEvent) => void): () => void
}

export function createBus(): EventBus {
  const listeners = new Set<(event: DeliveryEvent) => void>()
  return {
    emit(event) {
      for (const l of listeners) {
        try {
          l(event)
        } catch (err) {
          console.warn(`[bus] listener threw: ${err}`)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
