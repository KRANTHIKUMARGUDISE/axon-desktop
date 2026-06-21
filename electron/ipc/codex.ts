import type { AgentOutput, DeliveryContext } from './claude'

export interface CodexStepInput {
  blockId: string
  blockName: string
  cachedDefinition: string
  deliveryContext: DeliveryContext
  contextRequirements?: string[]
  codexApiKey: string
}

// Skeleton — Codex runtime is not wired up yet. Surfaces a clear, specific error
// instead of silently falling through or being mistaken for a Claude failure.
export async function runAgent(input: CodexStepInput): Promise<AgentOutput> {
  if (!input.codexApiKey) {
    throw new Error('Codex API key not configured — set one in Settings')
  }
  throw new Error('Codex runtime not yet implemented')
}
