import { ipcMain } from 'electron'

export interface AgentOutput {
  status: 'success' | 'partial' | 'failed'
  confidence?: number
  summary: string
  result: Record<string, unknown>
  errorMessage?: string
  errorCode?: string
  recoverable?: boolean
  // Part 3 — distinct tool names actually permitted and invoked during an Agentic run,
  // observed via the PreToolUse hook. Always undefined for Prompt-mode blocks.
  toolsUsed?: string[]
  // Distinct tool names the agent attempted but were blocked by the PreToolUse hook
  // (outside the resolved effective tools list). Kept separate from toolsUsed — a
  // denied attempt must never end up in the "restrict to these" suggestion (Task 5).
  toolsDenied?: string[]
  // Set when a Failed status is specifically caused by the block's configured
  // timeoutSeconds elapsing — lets the UI call this out explicitly instead of relying on
  // matching errorMessage text. Only ever set by claudeAgentic.ts's runAgenticBlock.
  timedOut?: boolean
  // DS1 — set by executor.ts after this output is produced, when `result` is too
  // large to store inline. Not set by runAgent() itself.
  isTruncated?: boolean
  outputFileRef?: string
}

export interface DeliveryContext {
  ticketId: string
  ticketTitle?: string
  previousStepsResults: Record<string, unknown>
  currentInputs: Record<string, unknown>
}

export interface StepInput {
  blockId: string
  blockName: string
  cachedDefinition: string
  deliveryContext: DeliveryContext
  contextRequirements?: string[]
  outputMapping?: Record<string, string>
  claudeApiKey: string
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  )
}

// Strips a markdown code fence if present, then — since compliance with "respond with
// ONLY the JSON" can't be guaranteed, especially from the Agentic path's conversational
// final message (it may prefix the JSON with explanatory prose) — falls back to slicing
// from the first `{` to the last `}` rather than requiring the whole string to be JSON.
function extractJsonObject(rawText: string): string {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return cleaned
  return cleaned.slice(firstBrace, lastBrace + 1)
}

// Shared by both the Prompt-mode path (runAgent, below) and the Agentic path
// (claudeAgentic.ts's runAgenticBlock) — takes the agent's raw final text and produces
// the canonical AgentOutput envelope. Must not be duplicated between the two paths.
export function normalizeAgentOutput(rawText: string, outputMapping?: Record<string, string>): AgentOutput {
  let agentOutput: Partial<AgentOutput>
  try {
    agentOutput = JSON.parse(extractJsonObject(rawText)) as Partial<AgentOutput>
  } catch {
    console.error(`Failed to parse agent response as JSON: ${rawText}`)
    return {
      status: 'failed',
      confidence: 0,
      summary: 'Failed to parse agent response',
      result: { rawResponse: rawText },
    }
  }

  // Apply outputMapping (if the block declares one) before validation, so a
  // non-canonical agent response shape gets resolved into the canonical fields first.
  if (outputMapping && Object.keys(outputMapping).length > 0) {
    for (const field of ['status', 'errorMessage', 'errorCode', 'recoverable'] as const) {
      const mapPath = outputMapping[field]
      if (mapPath) {
        (agentOutput as Record<string, unknown>)[field] = getByPath(agentOutput, mapPath)
      }
    }
  }

  // Validate required fields — only `status` is required, and it must resolve to
  // one of the three canonical values (no fuzzy matching).
  if (!agentOutput.status || !['success', 'partial', 'failed'].includes(agentOutput.status)) {
    return {
      status: 'failed',
      confidence: 0,
      summary: 'Agent response missing or invalid required field: status',
      result: agentOutput,
    }
  }

  return {
    status: agentOutput.status,
    confidence: agentOutput.confidence,
    summary: agentOutput.summary || '',
    result: agentOutput.result || {},
    errorMessage: agentOutput.errorMessage,
    errorCode: agentOutput.errorCode,
    recoverable: agentOutput.recoverable,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ClaudeRequestBody {
  model: string
  max_tokens: number
  system: string
  messages: ClaudeMessage[]
}

interface ClaudeResponseContent {
  type: string
  text: string
}

interface ClaudeResponse {
  content: ClaudeResponseContent[]
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

async function callClaude(apiKey: string, systemPrompt: string, userMessage: string): Promise<string> {
  if (!apiKey) {
    throw new Error('Claude API key not configured')
  }

  const body: ClaudeRequestBody = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (response.status === 401) {
      throw new Error('Invalid Claude API key')
    }

    if (response.status === 429) {
      // Rate limited — retry once after 60s
      await sleep(60000)
      return callClaude(apiKey, systemPrompt, userMessage)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Claude API error ${response.status}: ${errorText}`)
    }

    const data = (await response.json()) as ClaudeResponse
    const textContent = data.content.find((c) => c.type === 'text')
    if (!textContent) {
      throw new Error('No text content in Claude response')
    }

    if (data.usage) {
      console.log(`Claude tokens: ${data.usage.input_tokens} input, ${data.usage.output_tokens} output`)
    }

    return textContent.text
  } catch (err) {
    if (err instanceof Error && err.message.includes('Invalid Claude API key')) {
      throw err
    }
    throw new Error(`Network error calling Claude: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function runAgent(input: StepInput): Promise<AgentOutput> {
  const { blockName, cachedDefinition, deliveryContext, contextRequirements, outputMapping, claudeApiKey } = input

  // Build system prompt
  const systemPrompt = `${cachedDefinition}

## Required Output Format
Respond ONLY with a valid JSON object. No preamble, no markdown fences.
{
  "status": "success" | "partial" | "failed",
  "confidence": 0.0-1.0,
  "summary": "Brief description of what was done",
  "result": { ...fields declared in outputSchema... },
  "errorMessage": "Optional - what went wrong"
}`

  // Build user message with selective context
  const contextFields: Record<string, unknown> = {
    ...deliveryContext.previousStepsResults,
    ...deliveryContext.currentInputs,
  }

  let inputFieldsText = ''
  if (contextRequirements && contextRequirements.length > 0) {
    const selectedFields: Record<string, unknown> = {}
    for (const key of contextRequirements) {
      if (key in contextFields) {
        selectedFields[key] = contextFields[key]
      }
    }
    inputFieldsText = Object.entries(selectedFields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')
  } else {
    inputFieldsText = Object.entries(contextFields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')
  }

  // Distinguish "this block needs nothing" from "this block needs fields that
  // just weren't available" — both used to render as the same misleading
  // "(no context fields required)" placeholder, even when fields were declared
  // required but missing from the pool.
  const inputFieldsFallback = contextRequirements && contextRequirements.length > 0
    ? `(none of the required fields [${contextRequirements.join(', ')}] were available in the delivery context)`
    : '(no context fields required)'

  const userMessage = `## Delivery Context
Ticket: ${deliveryContext.ticketId}${deliveryContext.ticketTitle ? ` — ${deliveryContext.ticketTitle}` : ''}

## Input Fields
${inputFieldsText || inputFieldsFallback}`

  try {
    const response = await callClaude(claudeApiKey, systemPrompt, userMessage)
    // Some models (e.g. Haiku) wrap the JSON in a markdown code fence despite being
    // told not to — normalizeAgentOutput strips one if present before parsing.
    return normalizeAgentOutput(response, outputMapping)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: 'failed',
      confidence: 0,
      summary: `Agent execution failed: ${message}`,
      result: {},
      errorMessage: message,
    }
  }
}

export function registerClaudeHandlers() {
  ipcMain.handle('claude:call', () => ({ success: false, error: 'Not implemented' }))
}
