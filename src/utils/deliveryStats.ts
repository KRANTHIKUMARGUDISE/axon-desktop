import type { Delivery } from '../types'

export interface DeliveryStats {
  aiSteps: number
  builtInSteps: number
  totalTokens: number | null
  costUsd: number | null
  /** Part of the cost is estimated from the price table in Settings (Prompt steps). */
  costEstimated: boolean
}

/** "AI steps vs built-in steps" and total tokens/cost for the Live View (S5 item 18). */
export function deliveryStats(delivery: Pick<Delivery, 'steps'>): DeliveryStats {
  let ai = 0
  let builtIn = 0
  let tokens = 0
  let sawTokens = false
  let cost = 0
  let sawCost = false
  let estimated = false
  for (const s of delivery.steps) {
    if (s.agentRuntime === 'Axon') builtIn++
    else if (s.agentRuntime) ai++
    const u = s.agentOutput?.usage
    if (u?.inputTokens !== undefined || u?.outputTokens !== undefined) {
      tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      sawTokens = true
    }
    if (u?.costUsd !== undefined) {
      cost += u.costUsd
      sawCost = true
      if (u.costEstimated) estimated = true
    }
  }
  return { aiSteps: ai, builtInSteps: builtIn, totalTokens: sawTokens ? tokens : null, costUsd: sawCost ? cost : null, costEstimated: estimated }
}

export const formatCost = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`)
