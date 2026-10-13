import type { Block, PipelineEdge, PipelineNode } from './schemas'
import { validatePipelineGraph } from './graph'
import type { PipelineValidation } from './graph'
import { outputFieldNames, workItemListFields, workItemListItemFields, atMostOneWorkItemListField } from './workItems'
import { contextKey, isOptionalContext } from './contextKeys'
import { readGateConfig } from './gate'
import {
  ACTION_ARTIFACTS, JIRA_UPDATE_ARTIFACT, PR_UPDATE_ARTIFACT, TEMPLATE_HINT,
  readJiraUpdateConfig, readPrUpdateConfig, templateRefs,
} from './actions'

// Shared pipeline validator (Creator + engine.start). Structural graph checks live in graph.ts;
// this adds the ForEach contract (D16) and block rules.

export const PROVISIONER = 'workspace-provisioner'
export const PR_CREATOR = 'pr-creator'
/** Fields only a ForEach body can supply. */
export const PER_ITEM_FIELDS = ['item', 'itemKey', 'task', 'completedItems'] as const

export const NO_LIST_PREDECESSOR = 'Connect a block that returns a work-item list.'

export type ValidatorBlock = Pick<Block, 'id' | 'role' | 'artifactName' | 'executionType' | 'contextRequirements' | 'outputSchema' | 'requiredItemFields' | 'contextMode'> & { name?: string }

/** The node feeding a ForEach: its single incoming edge from outside the container. */
export function forEachPredecessors(fe: PipelineNode, nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return edges
    .filter((e) => e.targetNodeId === fe.id && byId.get(e.sourceNodeId)?.parentId !== fe.id)
    .map((e) => byId.get(e.sourceNodeId))
    .filter((n): n is PipelineNode => !!n)
}

/**
 * The item fields a node's WorkItemList really carries. The Workspace Provisioner is a pass-through: its list has
 * its input's item fields plus workspacePath; every other block declares its own `itemFields`.
 */
export function effectiveItemFields(
  node: PipelineNode, nodes: PipelineNode[], edges: PipelineEdge[], blocks: Map<string, ValidatorBlock>, seen = new Set<string>(),
): string[] {
  const block = node.type === 'forEach' ? undefined : blocks.get(node.blockId)
  if (block?.artifactName !== PROVISIONER) return workItemListItemFields(block)
  if (seen.has(node.id)) return ['workspacePath']
  seen.add(node.id)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const inputs = edges.filter((e) => e.targetNodeId === node.id).map((e) => byId.get(e.sourceNodeId))
    .filter((p): p is PipelineNode => !!p && p.parentId === node.parentId && p.type !== 'forEach' && workItemListFields(blocks.get(p.blockId)).length === 1)
  return [...new Set([...inputs.flatMap((p) => effectiveItemFields(p, nodes, edges, blocks, seen)), 'workspacePath'])]
}

/** Context names AXON itself hands to blocks (everything else must be returned by an earlier block or typed in manually). */
export const AXON_PROVIDED_INPUTS = ['repoCatalog', 'stepCwds', 'workItemList', 'repositories', 'task', 'shared', 'item', 'itemKey', 'completedItems']

/**
 * Required context fields that no earlier block returns and AXON does not provide. A manual delivery can still supply them as
 * JSON inputs, but a delivery started by an automation rule has no inputs, so it would fail at that step.
 */
export function unprovidedInputs(nodes: PipelineNode[], edges: PipelineEdge[], blocks: Map<string, ValidatorBlock>): { node: string; field: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, string[]>()
  for (const e of edges) incoming.set(e.targetNodeId, [...(incoming.get(e.targetNodeId) ?? []), e.sourceNodeId])
  const upstream = (id: string, seen = new Set<string>()): Set<string> => {
    for (const p of incoming.get(id) ?? []) if (!seen.has(p)) { seen.add(p); upstream(p, seen) }
    const parent = byId.get(id)?.parentId
    if (parent && !seen.has(parent)) upstream(parent, seen)
    return seen
  }
  const out: { node: string; field: string }[] = []
  for (const n of nodes) {
    const block = n.type === 'forEach' ? undefined : blocks.get(n.blockId)
    if (!block || block.contextMode === 'Full') continue
    const provided = new Set<string>()
    for (const u of upstream(n.id)) {
      const ub = byId.get(u)?.type === 'forEach' ? undefined : blocks.get(byId.get(u)?.blockId ?? '')
      for (const o of ub?.outputSchema ?? []) provided.add(typeof o === 'string' ? o : (o as { name: string }).name)
    }
    for (const r of block.contextRequirements ?? []) {
      if (isOptionalContext(r)) continue
      const key = contextKey(r)
      if (AXON_PROVIDED_INPUTS.includes(key) || provided.has(key)) continue
      out.push({ node: n.label ?? n.name ?? n.id, field: key })
    }
  }
  return out
}

export function validatePipeline(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  blocks: Map<string, ValidatorBlock>,
): PipelineValidation {
  const base = validatePipelineGraph(nodes, edges, blocks)
  const errors = [...base.errors]
  const warnings = [...base.warnings]
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nameOf = (n: PipelineNode) => n.label ?? n.name ?? n.id
  const blockOf = (n: PipelineNode) => (n.type === 'forEach' ? undefined : blocks.get(n.blockId))

  // Every node that runs before `id` (transitive predecessors; a ForEach child also inherits its container predecessors).
  const incoming = new Map<string, string[]>()
  for (const e of edges) incoming.set(e.targetNodeId, [...(incoming.get(e.targetNodeId) ?? []), e.sourceNodeId])
  const upstream = (id: string, seen = new Set<string>()): Set<string> => {
    for (const p of incoming.get(id) ?? []) if (!seen.has(p)) { seen.add(p); upstream(p, seen) }
    const parent = byId.get(id)?.parentId
    if (parent && !seen.has(parent)) upstream(parent, seen)
    return seen
  }

  for (const n of nodes) {
    const block = blockOf(n)
    if (block?.artifactName === PR_CREATOR) {
      const hasProvisioner = [...upstream(n.id)].some((u) => { const un = byId.get(u); return un ? blockOf(un)?.artifactName === PROVISIONER : false })
      if (!hasProvisioner) warnings.push(`"${nameOf(n)}" (PR Creator) has no Workspace Provisioner upstream: it will only open PRs for the delivery Workspace path or folders your blocks work in`)
    }
    if (n.parentId) {
      const parent = byId.get(n.parentId)
      if (!parent || parent.type !== 'forEach') errors.push(`Node "${nameOf(n)}" has an unknown parent`)
      else if (parent.parentId) errors.push(`ForEach "${nameOf(parent)}" cannot be nested inside another ForEach`)
    }
    if (n.type === 'forEach' || !block) continue

    if (block.executionType === 'Agentic' && !(block.contextRequirements && block.contextRequirements.length)) {
      errors.push(`Agentic block "${nameOf(n)}" must declare contextRequirements`)
    }
    const multi = atMostOneWorkItemListField({ outputSchema: block.outputSchema, name: nameOf(n) })
    if (multi) errors.push(`"${nameOf(n)}": ${multi}`)
    if (block.requiredItemFields?.length) {
      // Handoff contract: the list feeding this block must promise the item fields it needs.
      // A ForEach body item comes from the list feeding its ForEach.
      const container = n.parentId ? byId.get(n.parentId) : undefined
      const feeders = container
        ? forEachPredecessors(container, nodes, edges)
        : (incoming.get(n.id) ?? []).map((id) => byId.get(id)).filter((p): p is PipelineNode => !!p && p.parentId === n.parentId)
      const lists = feeders.filter((p) => workItemListFields(blockOf(p)).length === 1)
      if (lists.length === 0) errors.push(`"${nameOf(n)}" needs a work-item list with item field(s) ${block.requiredItemFields.join(', ')} from the block before it`)
      for (const p of lists) {
        const missing = block.requiredItemFields.filter((f) => !effectiveItemFields(p, nodes, edges, blocks).includes(f))
        const separate = missing.filter((m) => outputFieldNames(blocks.get(p.blockId)?.outputSchema as never).includes(m))
        if (missing.length) errors.push(`"${nameOf(p)}" sends a work list to "${nameOf(n)}", and every item in it must say ${missing.length === 1 ? `its "${missing[0]}"` : `its ${missing.map((m) => `"${m}"`).join(', ')}`} (for example which repository to work in), but "${nameOf(p)}" does not promise ${missing.length === 1 ? 'that field' : 'those fields'}. Fix: edit the "${nameOf(p)}" block → Output schema: tick the field that is the work-item list and add ${missing.join(', ')} under "Item fields".${separate.length ? ` Note: ${separate.map((m) => `"${m}"`).join(', ')} is listed as a separate output field of the block; it must go in "Item fields" of the work-item list instead (a separate output field is not part of each item).` : ''}`)
      }
    }
    // S5 (Q15): a Human Gate must say why a human decides here; the reviewer sees it on the gate card.
    if (block.role === 'Control' && !readGateConfig(n.config).reason) {
      errors.push(`"${nameOf(n)}" (Human Gate) needs a reason: fill in "Why a human decides here"`)
    }
    // S5b: action blocks. Templates may only use known variables and outputs declared by a block upstream.
    if (block.artifactName && ACTION_ARTIFACTS.includes(block.artifactName)) {
      const templates = block.artifactName === JIRA_UPDATE_ARTIFACT ? [readJiraUpdateConfig(n.config).comment]
        : block.artifactName === PR_UPDATE_ARTIFACT ? [readPrUpdateConfig(n.config).comment] : []
      const declared = new Set<string>()
      for (const u of upstream(n.id)) {
        const ub = byId.get(u) ? blockOf(byId.get(u)!) : undefined
        for (const o of ub?.outputSchema ?? []) declared.add(typeof o === 'string' ? o : (o as { name: string }).name)
      }
      for (const t of templates) {
        const refs = templateRefs(t)
        for (const bad of refs.unknown) errors.push(`"${nameOf(n)}": unknown template field {{${bad}}} (use ${TEMPLATE_HINT})`)
        for (const o of refs.outputs) {
          if (!declared.has(o)) errors.push(`"${nameOf(n)}": {{output.${o}}} is not an output of any block before it`)
        }
      }
      if (block.artifactName === JIRA_UPDATE_ARTIFACT) {
        const c = readJiraUpdateConfig(n.config)
        if (!c.transition && !c.addLabels.length && !c.removeLabels.length && !c.assign && !c.comment) {
          errors.push(`"${nameOf(n)}" (Jira Update) does nothing: set a status, labels, an assignee or a comment`)
        }
      }
      if (block.artifactName === PR_UPDATE_ARTIFACT) {
        const c = readPrUpdateConfig(n.config)
        if (!c.addLabels.length && !c.reviewers.length && !c.readyForReview && !c.comment) {
          errors.push(`"${nameOf(n)}" (PR Update) does nothing: set labels, reviewers, ready for review or a comment`)
        }
      }
    }
    if (n.parentId && (block.artifactName === PR_CREATOR || block.role === 'Control')) {
      errors.push(`"${nameOf(n)}" (${block.artifactName === PR_CREATOR ? 'PR Creator' : 'Human Gate'}) must sit outside a ForEach`)
    }
    if (!n.parentId) {
      const perItem = (block.contextRequirements ?? []).map(contextKey).filter((r) => (PER_ITEM_FIELDS as readonly string[]).includes(r))
      if (perItem.length) errors.push(`"${nameOf(n)}" requires per-item field(s) ${perItem.join(', ')} but is not inside a ForEach`)
    }
  }

  for (const fe of nodes.filter((n) => n.type === 'forEach')) {
    const label = nameOf(fe)
    const children = nodes.filter((n) => n.parentId === fe.id)
    if (children.length === 0) errors.push(`ForEach "${label}" has no nodes inside it`)
    const ids = new Set(children.map((c) => c.id))
    const inner = edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId))
    for (const e of edges) {
      const s = byId.get(e.sourceNodeId)?.parentId
      const t = byId.get(e.targetNodeId)?.parentId
      if ((e.sourceNodeId === fe.id || e.targetNodeId === fe.id) && (s === fe.id || t === fe.id)) continue
      if ((ids.has(e.sourceNodeId) || ids.has(e.targetNodeId)) && s !== t) {
        errors.push(`An edge crosses the border of ForEach "${label}" (edges must connect nodes with the same parent)`)
      }
    }
    if (children.length) {
      const entries = children.filter((c) => !inner.some((e) => e.targetNodeId === c.id))
      const exits = children.filter((c) => !inner.some((e) => e.sourceNodeId === c.id))
      if (entries.length !== 1) errors.push(`ForEach "${label}" must have exactly one entry node (found ${entries.length})`)
      if (exits.length !== 1) errors.push(`ForEach "${label}" must have exactly one exit node (found ${exits.length})`)
      for (const c of children) {
        if (inner.filter((e) => e.sourceNodeId === c.id).length > 1) errors.push(`ForEach "${label}": the body must be a straight chain ("${nameOf(c)}" branches)`)
      }
    }

    // D16: iterate over the work-item list returned by the single direct predecessor.
    const preds = forEachPredecessors(fe, nodes, edges)
    if (preds.length !== 1) {
      errors.push(`ForEach "${label}" must have exactly one incoming connection (found ${preds.length}). ${NO_LIST_PREDECESSOR}`)
    } else if (workItemListFields(blockOf(preds[0])).length !== 1) {
      errors.push(`ForEach "${label}": "${nameOf(preds[0])}" does not declare a work-item list output. ${NO_LIST_PREDECESSOR}`)
    }
  }

  for (const u of unprovidedInputs(nodes, edges, blocks)) {
    warnings.push(`"${u.node}" needs "${u.field}" but no earlier block returns it. A manual delivery can type it in as an input; a delivery started by an automation rule cannot (add a block before it that returns "${u.field}", e.g. Ticket Fetcher for the ticket).`)
  }
  return { valid: errors.length === 0, errors, warnings }
}
