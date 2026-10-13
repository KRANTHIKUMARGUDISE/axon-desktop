import type { PipelineEdge, PipelineNode, DeliveryStep, Block } from './schemas'

// Pure pipeline-graph helpers shared by the engine and the renderer's validator.

// Top-level flow only: nodes inside a ForEach (parentId) are run by the ForEach executor, not the main loop.
export function findStartNode(nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode | undefined {
  const hasIncoming = new Set(edges.map((e) => e.targetNodeId))
  return nodes.find((n) => !n.parentId && !hasIncoming.has(n.id))
}

/** The body of a ForEach, in run order (entry -> exit along a straight chain). */
export function forEachBody(forEachId: string, nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode[] {
  const children = nodes.filter((n) => n.parentId === forEachId)
  const ids = new Set(children.map((c) => c.id))
  const inner = edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId))
  const hasIncoming = new Set(inner.map((e) => e.targetNodeId))
  const out: PipelineNode[] = []
  let cur = children.find((c) => !hasIncoming.has(c.id))
  while (cur && !out.includes(cur)) {
    out.push(cur)
    const e = inner.find((x) => x.sourceNodeId === cur!.id)
    cur = e ? children.find((c) => c.id === e.targetNodeId) : undefined
  }
  return out
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
  steps: (Pick<DeliveryStep, 'nodeId' | 'status'> & { itemKey?: string | null })[],
): { lastCompletedNode?: PipelineNode; resumeNode?: PipelineNode } {
  // Only the node's own (itemKey-less) step counts: a ForEach is complete once its summary step is.
  const completed = new Set(steps.filter((s) => s.status === 'Completed' && !s.itemKey).map((s) => s.nodeId))
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
    if (n.type !== 'forEach' && blocks && !blocks.has(n.blockId)) errors.push(`Node "${n.label ?? n.id}" references unknown block ${n.blockId}`)
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
