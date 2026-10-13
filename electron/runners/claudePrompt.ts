import type { AgentOutput, ModelPrice } from '../../shared'
import { parseAxonContract, contractPromptSection } from '../../shared'
import { normalizeAgentOutput, buildUntrustedContext } from './output'
import type { RunnerInput } from './types'

export const PROMPT_MODEL = 'claude-haiku-4-5-20251001'
const MODEL = PROMPT_MODEL
const MAX_TOKENS = 4096
const MAX_RETRIES = 3
const MAX_BACKOFF_MS = 60_000

export interface PromptDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** S5b: $ per million tokens by model id (Settings). Without an entry for the model, only tokens are reported. */
  getPrices?: () => Record<string, ModelPrice>
}

/** Estimated cost of one call from the user's price table; undefined when the model has no price. */
export function estimateCost(usage: { inputTokens: number; outputTokens: number }, price: ModelPrice | undefined): number | undefined {
  if (!price) return undefined
  return (usage.inputTokens / 1e6) * price.inputPerMTok + (usage.outputTokens / 1e6) * price.outputPerMTok
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryDelayMs(res: Response, attempt: number, random: () => number): number {
  const header = res.headers.get('retry-after')
  const seconds = header ? Number(header) : NaN
  const base = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt
  return Math.min(base, MAX_BACKOFF_MS) + Math.floor(random() * 250)
}

// POST to the Messages API with a timeout, external abort, and a bounded 429 retry that
// honours `retry-after` (D4).
export async function callClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  opts: { timeoutSeconds: number; signal?: AbortSignal; onUsage?: (u: { inputTokens: number; outputTokens: number }) => void },
  deps: PromptDeps = {},
): Promise<string> {
  if (!apiKey) throw new Error('Claude API key not configured')
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? abortableSleep
  const random = deps.random ?? Math.random

  const timeoutSignal = AbortSignal.timeout(Math.max(1, opts.timeoutSeconds) * 1000)
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body,
        signal,
      })
    } catch (err) {
      if (opts.signal?.aborted) throw new Error('Cancelled')
      if (timeoutSignal.aborted) throw new Error(`Claude request timed out after ${opts.timeoutSeconds}s`)
      throw new Error(`Network error calling Claude: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (res.status === 401) throw new Error('Invalid Claude API key')
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error('Claude API rate limit: retries exhausted')
      try {
        await sleep(retryDelayMs(res, attempt, random), signal)
      } catch {
        if (opts.signal?.aborted) throw new Error('Cancelled')
        throw new Error(`Claude request timed out after ${opts.timeoutSeconds}s`)
      }
      continue
    }
    if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`)

    const data = (await res.json()) as { content: Array<{ type: string; text: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
    if (data.usage) opts.onUsage?.({ inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 })
    const text = data.content.find((c) => c.type === 'text')
    if (!text) throw new Error('No text content in Claude response')
    return text.text
  }
}

/** D19: the output contract declared in the artifact's frontmatter, appended so authors do not describe it twice. */
export function declaredContractSection(instructions: string): string {
  const parsed = parseAxonContract(instructions)
  return parsed.declared && !parsed.errors.length ? contractPromptSection(parsed.contract) : ''
}

export function createClaudePromptRunner(getApiKey: () => string, deps: PromptDeps = {}) {
  return async (input: RunnerInput): Promise<AgentOutput> => {
    const { block, instructions, deliveryContext, timeoutSeconds, signal } = input
    const systemPrompt = `${instructions}${declaredContractSection(instructions)}

## Required Output Format
Respond ONLY with a valid JSON object. No preamble, no markdown fences.
{
  "status": "success" | "partial" | "failed",
  "confidence": 0.0-1.0,
  "summary": "Brief description of what was done",
  "result": { ...fields declared in outputSchema... },
  "errorMessage": "Optional - what went wrong"
}`
    const userMessage = buildUntrustedContext(deliveryContext, block)

    try {
      let usage: { inputTokens: number; outputTokens: number } | undefined
      const text = await callClaude(getApiKey(), systemPrompt, userMessage, { timeoutSeconds, signal, onUsage: (u) => { usage = u } }, deps)
      // Tokens come from the API response; the cost is an estimate from the price table in Settings (none is baked in).
      const costUsd = usage ? estimateCost(usage, deps.getPrices?.()[MODEL]) : undefined
      return {
        ...normalizeAgentOutput(text, block.outputMapping, block.outputSchema),
        ...(usage ? { usage: { ...usage, model: MODEL, ...(costUsd !== undefined ? { costUsd, costEstimated: true } : {}) } } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        status: 'failed',
        confidence: 0,
        summary: `Agent execution failed: ${message}`,
        result: {},
        errorMessage: message,
        timedOut: message.includes('timed out') || undefined,
      }
    }
  }
}
