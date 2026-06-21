import type { BlockType } from '../types'

// Map block types to their icon file names
const BLOCK_TYPE_ICON_MAP: Record<BlockType, string> = {
  Decision: 'axon-decision.png',
  Execution: 'axon-execution.png',
  Knowledge: 'axon-knowledge.png',
  Control: 'axon-control.png',
  IO: 'axon-io.png',
  Utility: 'axon-utility.png',
}

export function getBlockTypeIcon(type: BlockType): string {
  return `/src/assets/block-roles/${BLOCK_TYPE_ICON_MAP[type]}`
}

export function getBlockTypeIconPath(type: BlockType): string {
  // For import statements
  return BLOCK_TYPE_ICON_MAP[type]
}
