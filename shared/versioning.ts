import type { Block, PipelineNode } from './schemas'

/** Compare dotted numeric versions ("1.2.3"); non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Highest version a consumer can pin: the doc itself if Published, otherwise the one before the draft. */
export function latestPublishedVersion(doc: { version: number; status?: string }): number {
  return doc.status === 'Published' || doc.status === 'Deprecated' ? doc.version : doc.version - 1
}

/** D13 "newer version available": the node pins an older block version than the latest published one. */
export function newerBlockVersion(node: Pick<PipelineNode, 'blockVersion'>, block: Pick<Block, 'version' | 'status'> | undefined): number | null {
  if (!block || node.blockVersion === undefined) return null
  const latest = latestPublishedVersion(block)
  return latest > node.blockVersion ? latest : null
}
