import { SCHEMA_VERSION } from '../../shared'
import type { Block } from '../../shared'
import type { Store } from './types'

// Built-in Axon blocks, seeded (immutable) on boot. The full versioned seed bundle arrives
// with the registry in S3; S1 only needs the human gate so Control nodes work offline.
export const HUMAN_GATE_BLOCK_ID = 'axon-human-gate'

export function builtInBlocks(now: Date = new Date()): Block[] {
  const ts = now.toISOString()
  return [
    {
      id: HUMAN_GATE_BLOCK_ID,
      schemaVersion: SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      name: 'Human Gate',
      role: 'Control',
      description: 'Pauses the delivery until a person approves or rejects it.',
      version: 1,
      tags: ['axon', 'control', 'gate'],
      sourceType: 'Axon',
      agentRuntime: 'Axon',
      artifactFormat: 'Native',
      artifactName: 'human-gate',
      verified: true,
      immutable: true,
    },
  ]
}

export async function seedBuiltIns(store: Store): Promise<void> {
  for (const block of builtInBlocks()) await store.seedBlock(block)
}
