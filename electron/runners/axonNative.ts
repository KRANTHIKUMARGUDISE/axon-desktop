import type { AgentOutput } from '../../shared'
import type { RunnerInput } from './types'
import type { NativeServices } from './native/types'
import { runNativeBlock } from './native/registry'

// Native (Axon-runtime) block handlers live in the registry (./native/registry.ts), keyed by artifactName.
export function createAxonNativeRunner(services?: NativeServices) {
  return (input: RunnerInput): Promise<AgentOutput> => runNativeBlock(input, services)
}

export const runAxonNative = createAxonNativeRunner()
