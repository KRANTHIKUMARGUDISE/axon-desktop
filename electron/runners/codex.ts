import type { AgentOutput } from '../../shared'
import type { RunnerInput } from './types'

// Codex is hidden in the UI for v1 (D4); the enum value is kept so stored blocks stay valid.
export async function runCodex(_input: RunnerInput): Promise<AgentOutput> {
  throw new Error('The Codex runtime is not supported in this version of AXON')
}
