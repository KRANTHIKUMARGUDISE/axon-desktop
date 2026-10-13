import type { PipelineNode } from './schemas'

// Pure helpers that translate the Pipeline Creator's canvas nodes into the stored flat node list.
// Kept here (not in the React page) so the rules — parents first, relative positions, version pins
// kept on a Draft save — are unit-tested.

export const FOREACH_DEFAULT_SIZE = { width: 420, height: 220 }

export interface CanvasNode {
  id: string
  position: { x: number; y: number }
  parentId?: string
  width?: number
  height?: number
  style?: { width?: unknown; height?: unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>
}

export function canvasNodeSize(n: Pick<CanvasNode, 'width' | 'height' | 'style'>): { width: number; height: number } {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
  return {
    width: n.width ?? num(n.style?.width) ?? FOREACH_DEFAULT_SIZE.width,
    height: n.height ?? num(n.style?.height) ?? FOREACH_DEFAULT_SIZE.height,
  }
}

/** xyflow needs a parent to precede its children, and the stored list is saved the same way. */
export function parentsFirst<T extends { parentId?: string }>(nodes: T[]): T[] {
  return [...nodes.filter((n) => !n.parentId), ...nodes.filter((n) => n.parentId)]
}

export function toPipelineNodes(nodes: CanvasNode[]): PipelineNode[] {
  return parentsFirst(nodes).map((n) => {
    const d = n.data
    const base = {
      id: n.id, label: d.label, name: d.label, position: n.position,
      ...(n.parentId ? { parentId: n.parentId } : {}),
    }
    if (d.nodeType === 'forEach') {
      return {
        ...base, type: 'forEach' as const, blockId: '',
        maxItems: d.maxItems, onEmpty: d.onEmpty ?? 'fail', size: canvasNodeSize(n),
      }
    }
    return {
      ...base, type: d.nodeType, blockId: d.blockId, config: d.config ?? {},
      timeoutSeconds: d.timeoutSeconds ?? 120,
      // Version pins survive a Draft save; they only change through the explicit "Update block versions" action.
      ...(d.blockVersion !== undefined ? { blockVersion: d.blockVersion } : {}),
    }
  }) as PipelineNode[]
}

/** Name of the node feeding a ForEach (its single incoming edge from outside the container), if any. */
export function forEachSourceLabel(
  forEachId: string,
  nodes: { id: string; parentId?: string; label?: string; name?: string }[],
  edges: { sourceNodeId: string; targetNodeId: string }[],
): string | undefined {
  const into = edges.filter((e) => e.targetNodeId === forEachId && nodes.find((n) => n.id === e.sourceNodeId)?.parentId !== forEachId)
  if (into.length !== 1) return undefined
  const src = nodes.find((n) => n.id === into[0].sourceNodeId)
  return src ? (src.label ?? src.name ?? src.id) : undefined
}
