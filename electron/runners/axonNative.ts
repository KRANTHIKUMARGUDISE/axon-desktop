import type { AgentOutput } from '../../shared'
import type { RunnerInput } from './types'

// Native (Axon-runtime) block handlers — no external call, no instructions needed.
// Add a case when wiring up a new artifactName for a Native/Axon block.
export async function runAxonNative(input: RunnerInput): Promise<AgentOutput> {
  switch (input.block.artifactName) {
    case 'human-gate':
      // The pause itself is driven by the block's role (Control) in the engine; this just
      // returns a valid output so the step completes normally.
      return { status: 'success', summary: 'Awaiting human review', result: {} }
    default:
      throw new Error(`No native handler for Axon block artifactName "${input.block.artifactName}"`)
  }
}
