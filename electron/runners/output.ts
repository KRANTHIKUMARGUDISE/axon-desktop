import type { AgentOutput } from '../../shared'

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  )
}

// Strips a markdown code fence if present, then falls back to slicing first `{` … last `}`
// since compliance with "respond with ONLY the JSON" can't be guaranteed.
function extractJsonObject(rawText: string): string {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) return cleaned
  return cleaned.slice(first, last + 1)
}

// Shared by the Prompt-mode and Agentic runners: raw final text → canonical AgentOutput.
export function normalizeAgentOutput(rawText: string, outputMapping?: Record<string, string>): AgentOutput {
  let parsed: Partial<AgentOutput>
  try {
    parsed = JSON.parse(extractJsonObject(rawText)) as Partial<AgentOutput>
  } catch {
    return {
      status: 'failed',
      confidence: 0,
      summary: 'Failed to parse agent response',
      result: { rawResponse: rawText },
    }
  }

  if (outputMapping && Object.keys(outputMapping).length > 0) {
    for (const field of ['status', 'errorMessage', 'errorCode', 'recoverable'] as const) {
      const mapPath = outputMapping[field]
      if (mapPath) (parsed as Record<string, unknown>)[field] = getByPath(parsed, mapPath)
    }
  }

  if (!parsed.status || !['success', 'partial', 'failed'].includes(parsed.status)) {
    return {
      status: 'failed',
      confidence: 0,
      summary: 'Agent response missing or invalid required field: status',
      result: parsed as Record<string, unknown>,
    }
  }

  return {
    status: parsed.status,
    confidence: parsed.confidence,
    summary: parsed.summary || '',
    result: parsed.result || {},
    errorMessage: parsed.errorMessage,
    errorCode: parsed.errorCode,
    recoverable: parsed.recoverable,
  }
}

// Field selection for what the agent's prompt receives: the block's declared
// contextRequirements (an empty list means the whole pool — existing behaviour, review B1).
export function buildInputFieldsText(
  pool: Record<string, unknown>,
  contextRequirements?: string[],
): string {
  const entries = contextRequirements && contextRequirements.length > 0
    ? contextRequirements.filter((k) => k in pool).map((k) => [k, pool[k]] as const)
    : Object.entries(pool)
  const text = entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
  if (text) return text
  return contextRequirements && contextRequirements.length > 0
    ? `(none of the required fields [${contextRequirements.join(', ')}] were available in the delivery context)`
    : '(no context fields required)'
}
