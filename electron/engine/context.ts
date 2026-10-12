import type { Block, DeliveryStep } from '../../shared'
import { AGENTIC_TOOL_CEILING } from '../../shared'

export interface DeliveryContext {
  ticketId: string
  ticketTitle?: string
  previousStepsResults: Record<string, unknown>
  currentInputs: Record<string, unknown>
}

export type Availability = Record<string, 'available' | 'missing' | 'empty'>

// The persisted/displayed "Full Context Snapshot": the entire accumulated pool, NOT
// filtered to the block's contextRequirements (what the agent's prompt receives is
// filtered separately in the runners).
export function buildContextSnapshot(ctx: DeliveryContext): Record<string, unknown> {
  return { ...ctx.previousStepsResults, ...ctx.currentInputs }
}

export function computeAvailability(fields: Record<string, unknown>, declaredKeys?: string[]): Availability {
  // Reports on every key in the pool; declared keys only add entries for absent ones.
  const keys = new Set(Object.keys(fields))
  for (const key of declaredKeys ?? []) keys.add(key)
  const out: Availability = {}
  for (const key of keys) {
    if (!(key in fields)) {
      out[key] = 'missing'
      continue
    }
    const v = fields[key]
    out[key] = v == null || v === '' || (Array.isArray(v) && v.length === 0) ? 'empty' : 'available'
  }
  return out
}

export function computeContextAvailability(ctx: DeliveryContext, requirements?: string[]): Availability {
  return computeAvailability(buildContextSnapshot(ctx), requirements)
}

// One resolved tool list per step, handed to both the SDK `tools` option and the
// PreToolUse allow-check so the two can't disagree.
export function resolveEffectiveTools(block: Block): string[] {
  const exploring = (block.visibility ?? 'Personal') === 'Personal'
    && block.executionType === 'Agentic'
    && (!block.allowedTools || block.allowedTools.length === 0)
  return exploring ? [...AGENTIC_TOOL_CEILING] : (block.allowedTools ?? [])
}

export function isGateBlock(block: Block | undefined): boolean {
  return block?.role === 'Control'
}

export type StepResultLoader = (step: DeliveryStep) => Promise<Record<string, unknown> | undefined>
