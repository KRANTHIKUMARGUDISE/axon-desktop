import type { AgentOutput, DeliveryContext } from './claude'

export interface CodexStepInput {
  blockId: string
  blockName: string
  cachedDefinition: string
  deliveryContext: DeliveryContext
  contextRequirements?: string[]
  outputMapping?: Record<string, string>
  codexApiKey: string
}

// Mirrors claude.ts's getByPath — kept in sync since both runAgent()s apply the
// same outputMapping/validation logic once Codex execution is actually wired up.
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  )
}

// Skeleton — Codex runtime is not wired up yet. Surfaces a clear, specific error
// instead of silently falling through or being mistaken for a Claude failure.
export async function runAgent(input: CodexStepInput): Promise<AgentOutput> {
  if (!input.codexApiKey) {
    throw new Error('Codex API key not configured — set one in Settings')
  }
  throw new Error('Codex runtime not yet implemented')
}
