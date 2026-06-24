import { ipcMain } from 'electron'

export interface AgentOutput {
  status: 'success' | 'partial' | 'failed'
  confidence?: number
  summary: string
  result: Record<string, unknown>
  errorMessage?: string
  errorCode?: string
  recoverable?: boolean
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

    // Parse JSON response — some models (e.g. Haiku) wrap it in a markdown code
    // fence despite being told not to. Strip one if present before parsing.
    let agentOutput: Partial<AgentOutput>
    try {
      const cleaned = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      agentOutput = JSON.parse(cleaned) as Partial<AgentOutput>
    } catch {
      console.error(`Failed to parse Claude response as JSON: ${response}`)
      return {
        status: 'failed',
        confidence: 0,
        summary: 'Failed to parse agent response',
        result: { rawResponse: response },
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
