import type { AxonBridge } from '@shared'

declare global {
  interface Window {
    axon: AxonBridge
  }
}

export {}
