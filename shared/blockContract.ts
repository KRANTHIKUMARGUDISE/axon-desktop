import { parse as parseYaml } from 'yaml'
import type { OutputSchemaEntry } from './schemas'
import { contextKey, isOptionalContext } from './contextKeys'

// D19: a block's contract (what it needs and what it returns) is declared once, in the frontmatter of its artifact
// (the agent's SKILL.md), next to the prompt that fulfils it:
//
//   ---
//   axon:
//     inputs: [task, shared, item.repo, repoCatalog]
//     outputs:
//       workItems: { list: true, itemFields: [repo] }
//       summary: text
//   ---
//
// It maps onto the existing block fields (contextRequirements / outputSchema / requiredItemFields), so the validator and
// the runtime checks are unchanged. Only how the contract is declared changes.

export const OUTPUT_KINDS = ['text', 'number', 'boolean', 'array', 'object'] as const
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/** One thing a block returns. `list` = the WorkItemList that feeds a ForEach (at most one per block). */
export interface ContractOutput {
  name: string
  kind: (typeof OUTPUT_KINDS)[number]
  list?: boolean
  itemFields?: string[]
}

export interface BlockContract {
  /** Context names; a trailing `?` marks optional; `item.<field>` = a field every incoming work item must have. */
  inputs: string[]
  outputs: ContractOutput[]
}

export interface ContractFields {
  contextRequirements: string[]
  outputSchema: OutputSchemaEntry[]
  requiredItemFields: string[]
}

export interface ParsedContract {
  /** The artifact has an `axon:` frontmatter key. */
  declared: boolean
  contract: BlockContract
  /** Problems found; when non-empty the declaration is ignored. */
  errors: string[]
}

const empty = (): BlockContract => ({ inputs: [], outputs: [] })

/** The YAML frontmatter of a markdown file as a plain object, or null. */
export function readFrontmatter(markdown: string): Record<string, unknown> | null {
  const m = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!m) return null
  try {
    const doc = parseYaml(m[1])
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseAxonContract(markdown: string): ParsedContract {
  const fm = readFrontmatter(markdown)
  if (!fm || !('axon' in fm)) return { declared: false, contract: empty(), errors: [] }
  const axon = fm.axon
  if (!axon || typeof axon !== 'object' || Array.isArray(axon)) {
    return { declared: true, contract: empty(), errors: ['`axon:` must contain `inputs` and `outputs`'] }
  }
  const errors: string[] = []
  const a = axon as { inputs?: unknown; outputs?: unknown }

  const inputs: string[] = []
  if (a.inputs !== undefined) {
    if (!Array.isArray(a.inputs)) errors.push('`axon.inputs` must be a list of names')
    else {
      for (const raw of a.inputs) {
        if (typeof raw !== 'string') { errors.push(`input ${JSON.stringify(raw)} must be a name`); continue }
        const name = raw.trim()
        const base = name.replace(/\?$/, '')
        const [head, field, ...rest] = base.split('.')
        const ok = FIELD_NAME.test(head) && (field === undefined || (head === 'item' && FIELD_NAME.test(field) && rest.length === 0))
        if (!ok) { errors.push(`input "${name}" is not a valid name (use letters/digits, or item.<field>)`); continue }
        if (!inputs.includes(name)) inputs.push(name)
      }
    }
  }

  const outputs: ContractOutput[] = []
  if (a.outputs !== undefined) {
    if (!a.outputs || typeof a.outputs !== 'object' || Array.isArray(a.outputs)) errors.push('`axon.outputs` must be a map: name -> text | { list: true, itemFields: [...] }')
    else {
      for (const [name, spec] of Object.entries(a.outputs as Record<string, unknown>)) {
        if (!FIELD_NAME.test(name)) { errors.push(`output "${name}" is not a valid name`); continue }
        if (typeof spec === 'string') {
          if (!(OUTPUT_KINDS as readonly string[]).includes(spec)) { errors.push(`output "${name}": unknown type "${spec}" (use ${OUTPUT_KINDS.join(' | ')} or { list: true })`); continue }
          outputs.push({ name, kind: spec as ContractOutput['kind'] })
        } else if (spec && typeof spec === 'object' && (spec as { list?: unknown }).list === true) {
          const fields = (spec as { itemFields?: unknown }).itemFields
          if (fields !== undefined && !(Array.isArray(fields) && fields.every((f) => typeof f === 'string' && FIELD_NAME.test(f)))) {
            errors.push(`output "${name}": itemFields must be a list of field names`)
            continue
          }
          outputs.push({ name, kind: 'array', list: true, itemFields: [...new Set((fields as string[] | undefined) ?? [])] })
        } else {
          errors.push(`output "${name}" must be a type name or { list: true, itemFields: [...] }`)
        }
      }
      if (outputs.filter((o) => o.list).length > 1) errors.push('A block can return at most one work-item list')
    }
  }
  return errors.length ? { declared: true, contract: empty(), errors } : { declared: true, contract: { inputs, outputs }, errors: [] }
}

/** Contract -> the stored block fields. `item.<field>` also makes the block receive `item`. */
export function contractToFields(c: BlockContract): ContractFields {
  const contextRequirements: string[] = []
  const requiredItemFields: string[] = []
  for (const input of c.inputs) {
    const m = /^item\.([A-Za-z][A-Za-z0-9_]*)$/.exec(input.replace(/\?$/, ''))
    if (m) {
      if (!requiredItemFields.includes(m[1])) requiredItemFields.push(m[1])
      if (!contextRequirements.includes('item')) contextRequirements.push('item')
    } else if (!contextRequirements.includes(input)) contextRequirements.push(input)
  }
  const outputSchema: OutputSchemaEntry[] = c.outputs.map((o) =>
    o.list
      ? { name: o.name, type: 'WorkItemList', ...(o.itemFields?.length ? { itemFields: o.itemFields } : {}) }
      : o.kind === 'text'
        ? o.name
        : ({ name: o.name, type: o.kind === 'array' ? 'array' : o.kind } as OutputSchemaEntry),
  )
  return { contextRequirements, outputSchema, requiredItemFields }
}

/** Stored block fields -> the contract shown in the form (so a block without frontmatter can be edited the same way). */
export function fieldsToContract(f: { contextRequirements?: string[]; outputSchema?: OutputSchemaEntry[]; requiredItemFields?: string[] }): BlockContract {
  const required = f.requiredItemFields ?? []
  const inputs: string[] = []
  for (const r of f.contextRequirements ?? []) {
    // `item` is implied by item.<field>
    if (contextKey(r) === 'item' && required.length) continue
    inputs.push(r)
  }
  for (const field of required) inputs.push(`item.${field}`)
  const outputs: ContractOutput[] = (f.outputSchema ?? []).map((e): ContractOutput => {
    if (typeof e === 'string') return { name: e, kind: 'text' }
    if (e.type === 'WorkItemList') return { name: e.name, kind: 'array', list: true, itemFields: e.itemFields ?? [] }
    const kind = (OUTPUT_KINDS as readonly string[]).includes(String(e.type)) ? (e.type as ContractOutput['kind']) : e.type === 'string' ? 'text' : 'text'
    return { name: e.name, kind }
  })
  return { inputs, outputs }
}

/** "Needs: task, shared, item.repo" / "Returns: workItems (work list: repo), summary" */
export function contractSummary(c: BlockContract): { needs: string; returns: string } {
  return {
    needs: c.inputs.length ? c.inputs.join(', ') : 'nothing from earlier steps',
    returns: c.outputs.length
      ? c.outputs.map((o) => (o.list ? `${o.name} (work list${o.itemFields?.length ? `: ${o.itemFields.join(', ')}` : ''})` : o.kind === 'text' ? o.name : `${o.name} (${o.kind})`)).join(', ')
      : 'nothing declared',
  }
}

/** The entry file of an artifact (SKILL.md / agent .md) from a block's cached files. */
export function entryFileContent(block: { cachedFiles?: ({ relativePath: string; content: string } | string)[]; entryPointPath?: string }): string | undefined {
  const entry = (block.cachedFiles ?? []).find((f) => typeof f !== 'string' && f.relativePath === block.entryPointPath)
  return entry && typeof entry !== 'string' ? entry.content : undefined
}

/** Where the contract comes from. Frontmatter wins over the form; differing values are reported so the form can warn. */
export function reconcileContract(
  fromArtifact: ParsedContract | null,
  form: { contextRequirements?: string[]; outputSchema?: OutputSchemaEntry[]; requiredItemFields?: string[] },
): { source: 'artifact' | 'form'; fields: ContractFields; warnings: string[] } {
  const formFields: ContractFields = {
    contextRequirements: form.contextRequirements ?? [], outputSchema: form.outputSchema ?? [], requiredItemFields: form.requiredItemFields ?? [],
  }
  if (!fromArtifact?.declared || fromArtifact.errors.length) return { source: 'form', fields: formFields, warnings: [] }
  const fields = contractToFields(fromArtifact.contract)
  const warnings: string[] = []
  const hasForm = formFields.contextRequirements.length || formFields.outputSchema.length || formFields.requiredItemFields.length
  if (hasForm) {
    const key = (f: ContractFields) => JSON.stringify([[...f.contextRequirements].sort(), [...f.requiredItemFields].sort(), f.outputSchema.map((e) => (typeof e === 'string' ? e : `${e.name}:${e.type ?? ''}:${(e.itemFields ?? []).join('+')}`)).sort()])
    if (key(fields) !== key(formFields)) warnings.push('The block form and the artifact frontmatter (`axon:`) disagree; the frontmatter is used.')
  }
  return { source: 'artifact', fields, warnings }
}

/**
 * Text appended to the agent's prompt so authors do not have to describe the output twice. Empty when the block does not declare
 * its contract in the artifact (existing blocks behave exactly as before).
 */
export function contractPromptSection(c: BlockContract): string {
  if (!c.outputs.length) return ''
  const lines = c.outputs.map((o) => {
    if (o.list) {
      const extra = o.itemFields?.length ? `, ${o.itemFields.map((f) => `"${f}": "..."`).join(', ')}` : ''
      return `- "${o.name}": a work-item list: { "items": [ { "key": "unique id", "task": "what to do"${extra} } ], "shared": "optional notes for every item" }. Items run in the order you list them.`
    }
    return `- "${o.name}": ${o.kind === 'text' ? 'text' : o.kind}`
  })
  return `\n\n<axon_output_contract>\nPut these fields in the "result" object of your JSON reply:\n${lines.join('\n')}\n</axon_output_contract>`
}

export { isOptionalContext }
