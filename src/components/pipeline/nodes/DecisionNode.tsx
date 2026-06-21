import BaseNode from './BaseNode'
import type { NodeProps } from '@xyflow/react'

export default function DecisionNode(props: NodeProps) {
  return <BaseNode {...(props as any)} />
}
