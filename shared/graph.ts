import type { PipelineEdge, PipelineNode, DeliveryStep, Block } from './schemas'

// Pure pipeline-graph helpers shared by the engine and the renderer's validator.

export function findStartNode(nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode | undefined {
  const hasIncoming = new Set(edges.map((e) => e.targetNodeId))
  return nodes.find((n) => !hasIncoming.has(n.id))
}

export function nextNode(currentId: string, nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode | undefined {
  const outgoing = edges.filter((e) => e.sourceNodeId === currentId)
  const edge = outgoing.find((e) => e.isDefault) ?? outgoing[0]
  if (!edge) return undefined
  return nodes.find((n) => n.id === edge.targetNodeId)
}

// Walks from the start node to the first node WITHOUT a Completed step record. A visited
// set guards against cycles (back-edges are unsupported in v1, D12) so a malformed
// pipeline can never spin this loop forever.
export function resolvePipelineProgress(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  steps: Pick<DeliveryStep, 'nodeId' | 'status'>[],
): { lastCompletedNode?: PipelineNode; resumeNode?: PipelineNode } {
  const completed = new Set(steps.filter((s) => s.status === 'Completed').map((s) => s.nodeId))
  const visited = new Set<string>()
  let lastCompletedNode: PipelineNode | undefined
  let node = findStartNode(nodes, edges)
  while (node && completed.has(node.id) && !visited.has(node.id)) {
    visited.add(node.id)
    lastCompletedNode = node
    node = nextNode(node.id, nodes, edges)
  }
  if (node && visited.has(node.id)) return { lastCompletedNode, resumeNode: undefined }
  return { lastCompletedNode, resumeNode: node }
}

export interface PipelineValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function validatePipelineGraph(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  blocks?: Map<string, Pick<Block, 'id'>>,
): PipelineValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (nodes.length === 0) errors.push('Pipeline has no nodes')
  if (nodes.length > 0 && !findStartNode(nodes, edges)) errors.push('No start node (a node with no incoming edges)')

  const ids = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (!ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId)) errors.push(`Edge ${e.id} references a missing node`)
  }
  for (const n of nodes) {
    const outs = edges.filter((e) => e.sourceNodeId === n.id)
    if (outs.length > 1 && !outs.some((e) => e.isDefault)) {
      errors.push(`Node "${n.label ?? n.id}" has multiple outgoing edges but no default route`)
    }
    if (blocks && !blocks.has(n.blockId)) errors.push(`Node "${n.label ?? n.id}" references unknown block ${n.blockId}`)
  }
  // Cycle detection (no back-edges in v1).
  const visiting = new Set<string>()
  const done = new Set<string>()
  const dfs = (id: string): boolean => {
    if (done.has(id)) return false
    if (visiting.has(id)) return true
    visiting.add(id)
    for (const e of edges.filter((x) => x.sourceNodeId === id)) if (dfs(e.targetNodeId)) return true
    visiting.delete(id)
    done.add(id)
    return false
  }
  if (nodes.some((n) => dfs(n.id))) errors.push('Pipeline contains a cycle (loops are not supported)')
  return { valid: errors.length === 0, errors, warnings }
}
