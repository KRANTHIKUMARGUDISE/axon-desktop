import type { Block } from './schemas'
import { workItemListFields, workItemListItemFields, outputFieldTypes } from './workItems'

/** What a block hands to the next one, e.g. "Demo Planner → Workspace Provisioner: WorkItemList (key, task, repo)". */
export function describeHandoff(
  src: { name: string; block?: Pick<Block, 'outputSchema'> },
  dstName: string,
  /** Effective item fields when they differ from the block's own (pass-through blocks, see effectiveItemFields). */
  itemFields?: string[],
): string {
  const head = `${src.name} → ${dstName}: `
  if (workItemListFields(src.block).length === 1) {
    return `${head}WorkItemList (${['key', 'task', ...(itemFields ?? workItemListItemFields(src.block))].join(', ')})`
  }
  const fields = outputFieldTypes(src.block?.outputSchema).map((f) => (f.type ? `${f.name}: ${f.type}` : f.name))
  return `${head}${fields.length ? fields.join(', ') : 'no declared output'}`
}
