import type { AgentOutput, Block } from '../../shared'
import type { DeliveryContext } from '../engine/context'

export interface RunnerInput {
  block: Block
  nodeLabel: string
  // Entry-file content of the block's artifact (SKILL.md etc.); '' for native blocks.
  instructions: string
  deliveryContext: DeliveryContext
  workspacePath: string
  effectiveTools: string[]
  timeoutSeconds: number
  signal: AbortSignal
}

export type Runner = (input: RunnerInput) => Promise<AgentOutput>
