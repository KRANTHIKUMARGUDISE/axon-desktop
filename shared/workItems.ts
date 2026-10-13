import type { Block, OutputSchemaEntry, PipelineNode } from './schemas'
import { WORK_ITEM_LIST_TYPE } from './schemas'

// WorkItemList (D16): `{ items: [ { key, task, workspacePath? } ], shared? }`. `key` (unique, rerun-stable)
// and `task` (string handed to the body) are required; `workspacePath` is optional; every other field
// passes through untouched and the whole item object is handed to the body. Items run in list order.

export const isForEach = (n: Pick<PipelineNode, 'type'>): boolean => n.type === 'forEach'

export function outputFieldNames(schema?: OutputSchemaEntry[]): string[] {
  return (schema ?? []).map((e) => (typeof e === 'string' ? e : e.name))
}

export function outputFieldTypes(schema?: OutputSchemaEntry[]): { name: string; type?: string }[] {
  return (schema ?? []).map((e) => (typeof e === 'string' ? { name: e } : { name: e.name, type: e.type }))
}

/** Output fields of a block typed WorkItemList (a block may declare at most one). */
export function workItemListFields(block: Pick<Block, 'outputSchema'> | undefined): string[] {
  return outputFieldTypes(block?.outputSchema).filter((f) => f.type === WORK_ITEM_LIST_TYPE).map((f) => f.name)
}

/** Extra per-item fields the block's WorkItemList output promises (handoff contract), e.g. ["repo"]. */
export function workItemListItemFields(block: Pick<Block, 'outputSchema'> | undefined): string[] {
  const f = (block?.outputSchema ?? []).find((e) => typeof e !== 'string' && e.type === WORK_ITEM_LIST_TYPE)
  return typeof f === 'object' ? (f.itemFields ?? []) : []
}

/** Max length of a per-item summary handed to later ForEach items (agent standard rule 8). */
export const COMPLETED_ITEM_SUMMARY_CAP = 500
export const capSummary = (s: string, cap = COMPLETED_ITEM_SUMMARY_CAP): string => (s.length > cap ? s.slice(0, cap - 1) + '…' : s)

export function atMostOneWorkItemListField(block: Pick<Block, 'outputSchema' | 'name'>): string | null {
  const fields = workItemListFields(block)
  return fields.length > 1 ? `A block may declare at most one WorkItemList output field (found: ${fields.join(', ')})` : null
}

export interface WorkItemEntry {
  key: string
  item: Record<string, unknown>
}

export interface WorkItemListOptions {
  maxItems?: number
  onEmpty?: 'skip' | 'fail'
}

export type WorkItemListResult =
  | { ok: true; entries: WorkItemEntry[]; shared: unknown }
  | { ok: false; error: string }

const label = (i: number, it: unknown): string => {
  const k = typeof it === 'object' && it !== null ? (it as Record<string, unknown>).key : undefined
  return typeof k === 'string' && k ? `Work item #${i + 1} (key "${k}")` : `Work item #${i + 1}`
}

/** Shape check only (what a producing step must return): list, unique string keys, string tasks. */
export function validateWorkItemList(raw: unknown, requiredFields: string[] = []): WorkItemListResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray((raw as { items?: unknown }).items)) {
    return { ok: false, error: 'Not a work-item list: expected { items: [ { key, task, workspacePath? } ], shared? }' }
  }
  const list = raw as { items: unknown[]; shared?: unknown }
  const seen = new Set<string>()
  const entries: WorkItemEntry[] = []
  for (const [i, it] of list.items.entries()) {
    if (typeof it !== 'object' || it === null || Array.isArray(it)) return { ok: false, error: `${label(i, it)} is not an object` }
    const o = it as Record<string, unknown>
    if (typeof o.key !== 'string' || !o.key.trim()) return { ok: false, error: `${label(i, it)} has no "key" (every item needs a unique string key)` }
    if (typeof o.task !== 'string' || !o.task.trim()) return { ok: false, error: `${label(i, it)} has no "task" (every item needs a task string)` }
    if (o.workspacePath !== undefined && typeof o.workspacePath !== 'string') return { ok: false, error: `${label(i, it)}: "workspacePath" must be a string` }
    if (seen.has(o.key)) return { ok: false, error: `Duplicate work item key "${o.key}" (${label(i, it)}) — keys must be unique` }
    for (const f of requiredFields) {
      if (o[f] === undefined || o[f] === null || o[f] === '') return { ok: false, error: `${label(i, it)} is missing required item field "${f}"` }
    }
    seen.add(o.key)
    entries.push({ key: o.key, item: o })
  }
  return { ok: true, entries, shared: list.shared }
}

/** validateWorkItemList + the ForEach limits (empty list per `onEmpty`, default Fail; `maxItems`, default 10). */
export function parseWorkItemList(raw: unknown, opts: WorkItemListOptions = {}): WorkItemListResult {
  const v = validateWorkItemList(raw)
  if (!v.ok) return v
  if (v.entries.length === 0) {
    return (opts.onEmpty ?? 'fail') === 'fail' ? { ok: false, error: 'The work-item list is empty (the ForEach is set to fail on an empty list)' } : v
  }
  const max = opts.maxItems ?? 10
  if (v.entries.length > max) return { ok: false, error: `Work item list has ${v.entries.length} items; the limit (max items) is ${max}` }
  return v
}
