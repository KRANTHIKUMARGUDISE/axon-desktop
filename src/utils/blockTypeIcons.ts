import type { BlockType } from '../types'
import axonDecision from '../assets/block-roles/axon-decision.png'
import axonExecution from '../assets/block-roles/axon-execution.png'
import axonKnowledge from '../assets/block-roles/axon-knowledge.png'
import axonControl from '../assets/block-roles/axon-control.png'
import axonIo from '../assets/block-roles/axon-io.png'
import axonUtility from '../assets/block-roles/axon-utility.png'

// Map block types to their icon assets
const BLOCK_TYPE_ICON_MAP: Record<BlockType, string> = {
  Decision: axonDecision,
  Execution: axonExecution,
  Knowledge: axonKnowledge,
  Control: axonControl,
  IO: axonIo,
  Utility: axonUtility,
}

export function getBlockTypeIcon(type: BlockType): string {
  return BLOCK_TYPE_ICON_MAP[type]
}
