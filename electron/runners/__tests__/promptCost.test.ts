import { describe, expect, it } from 'vitest'
import { createClaudePromptRunner, estimateCost, PROMPT_MODEL } from '../claudePrompt'
import type { RunnerInput } from '../types'
import type { Block } from '../../../shared'

const reply = (usage: { input_tokens: number; output_tokens: number }) =>
  (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"status":"success","summary":"ok","result":{}}' }], usage }), { status: 200 })) as unknown as typeof fetch

const input = (): RunnerInput => ({
  deliveryId: 'd', block: { name: 'B', role: 'Decision', outputSchema: [] } as unknown as Block, nodeLabel: 'n', instructions: 'x',
  deliveryContext: { ticketId: 'T-1', previousStepsResults: {}, currentInputs: {} }, workspacePath: '/w', effectiveTools: [], timeoutSeconds: 5,
  signal: new AbortController().signal,
})

describe('Prompt step cost (S5b price table)', () => {
  it('estimates from $ per million tokens', () => {
    expect(estimateCost({ inputTokens: 2_000_000, outputTokens: 500_000 }, { inputPerMTok: 1, outputPerMTok: 5 })).toBeCloseTo(4.5)
    expect(estimateCost({ inputTokens: 10, outputTokens: 10 }, undefined)).toBeUndefined()
  })
  it('puts an estimated cost on the step when the model has a price, tokens only otherwise', async () => {
    const priced = await createClaudePromptRunner(() => 'k', { fetchImpl: reply({ input_tokens: 1000, output_tokens: 2000 }), getPrices: () => ({ [PROMPT_MODEL]: { inputPerMTok: 1, outputPerMTok: 5 } }) })(input())
    expect(priced.usage).toMatchObject({ inputTokens: 1000, outputTokens: 2000, model: PROMPT_MODEL, costEstimated: true })
    expect(priced.usage?.costUsd).toBeCloseTo(0.011)
    const unpriced = await createClaudePromptRunner(() => 'k', { fetchImpl: reply({ input_tokens: 1000, output_tokens: 2000 }) })(input())
    expect(unpriced.usage).toEqual({ inputTokens: 1000, outputTokens: 2000, model: PROMPT_MODEL })
  })
})
