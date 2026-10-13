import type { AgentOutput, Block } from '../../shared'
import type { DeliveryContext } from '../engine/context'

export interface RunnerInput {
  deliveryId: string
  pipelineName?: string
  block: Block
  nodeLabel: string
  // Entry-file content of the block's artifact (SKILL.md etc.); '' for native blocks.
  instructions: string
  deliveryContext: DeliveryContext
  workspacePath: string
  effectiveTools: string[]
  timeoutSeconds: number
  signal: AbortSignal
  /** S5b: the node's own settings (action blocks: Jira Update / PR Update config), pinned with the pipeline version. */
  nodeId?: string
  itemKey?: string | null
  nodeConfig?: Record<string, unknown>
  /** The first attempt of this story (follows retriedFromDeliveryId): action idempotency markers use it so a Rerun never re-applies. */
  rootDeliveryId?: string
}

export type Runner = (input: RunnerInput) => Promise<AgentOutput>
