// The SDK ships ESM-only (sdk.mjs). The Electron main process compiles to CommonJS
// (tsconfig.electron.json), so a static `import` here would become a `require()` that
// fails with ERR_REQUIRE_ESM — must dynamic-import the runtime value instead. Types are
// erased at compile time, so importing them statically is fine.
import type { query as QueryFn, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { normalizeAgentOutput } from './claude'
import type { AgentOutput, DeliveryContext } from './claude'
import path from 'path'
import fs from 'fs'

// TypeScript's CommonJS module transform rewrites `await import(...)` into
// `Promise.resolve().then(() => require(...))` — still a require() under the hood, which
// still throws ERR_REQUIRE_ESM for an ESM-only package like this SDK. Going through
// `new Function` keeps the import() call as a plain string Node evaluates directly at
// runtime, bypassing TS's rewrite entirely and getting a real native dynamic import.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ query: typeof QueryFn }>

// The SDK's own binary-path auto-detection resolves relative to where it itself was
// loaded from (effectively import.meta.url-based, since we load it via real ESM import
// above). Electron's asar→app.asar.unpacked redirection patches Node's CJS require()
// resolution and fs reads, but does NOT rewrite that literal path string for ESM-style
// resolution — so in a packaged build the SDK computes a path that still says
// "...\app.asar\node_modules\...\claude.exe", which exists virtually (asar can stat it)
// but can't actually be spawned as a process from inside the archive. Electron-builder's
// asarUnpack config (electron-builder.config.js) does put the real file on disk under
// app.asar.unpacked — we just have to point the SDK at it explicitly via
// pathToClaudeCodeExecutable rather than trust its own lookup.
function resolveClaudeBinaryPath(): string | undefined {
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'

  const candidates: string[] = []
  // Packaged build: resourcesPath is only set when running from a built app, and this is
  // exactly where electron-builder's asarUnpack put the real, spawnable file.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', ...platformPkg.split('/'), binaryName))
  }
  // Dev mode (npx electron .) — no asar at all, so the package's literal node_modules
  // location is already a real, spawnable path.
  try {
    candidates.push(require.resolve(`${platformPkg}/${binaryName}`))
  } catch {
    // Platform package not installed (e.g. running on an unsupported arch) — fall through
    // to the SDK's own default behavior rather than throwing here.
  }

  return candidates.find((p) => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
}

export interface AgenticStepInput {
  blockId: string
  blockName: string
  cachedDefinition: string
  deliveryContext: DeliveryContext
  contextRequirements?: string[]
  outputMapping?: Record<string, string>
  claudeApiKey: string
  workspacePath: string
  // Resolved by executor.ts BEFORE this function is called — the six-tool ceiling when
  // the block is exploring (Personal scope, empty allowedTools), else the block's real
  // allowedTools. This function does not do that resolution itself (see Part 4 task 3).
  effectiveTools: string[]
  timeoutSeconds: number
}

function buildUserMessage(input: AgenticStepInput): string {
  const { deliveryContext, contextRequirements } = input
  const contextFields: Record<string, unknown> = {
    ...deliveryContext.previousStepsResults,
    ...deliveryContext.currentInputs,
  }

  let inputFieldsText = ''
  if (contextRequirements && contextRequirements.length > 0) {
    const selectedFields: Record<string, unknown> = {}
    for (const key of contextRequirements) {
      if (key in contextFields) selectedFields[key] = contextFields[key]
    }
    inputFieldsText = Object.entries(selectedFields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')
  } else {
    inputFieldsText = Object.entries(contextFields)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')
  }

  const inputFieldsFallback = contextRequirements && contextRequirements.length > 0
    ? `(none of the required fields [${contextRequirements.join(', ')}] were available in the delivery context)`
    : '(no context fields required)'

  return `## Delivery Context
Ticket: ${deliveryContext.ticketId}${deliveryContext.ticketTitle ? ` — ${deliveryContext.ticketTitle}` : ''}

## Input Fields
${inputFieldsText || inputFieldsFallback}

## Required Output Format
When you are done, respond with ONLY a valid JSON object (no preamble, no markdown fences):
{
  "status": "success" | "partial" | "failed",
  "confidence": 0.0-1.0,
  "summary": "Brief description of what was done",
  "result": { ...fields declared in outputSchema... },
  "errorMessage": "Optional - what went wrong"
}`
}

export async function runAgenticBlock(input: AgenticStepInput): Promise<AgentOutput> {
  const { cachedDefinition, claudeApiKey, workspacePath, effectiveTools, timeoutSeconds, outputMapping } = input

  const toolsUsed = new Set<string>()
  const toolsDenied = new Set<string>()
  const abortController = new AbortController()
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000
  const timer = setTimeout(() => abortController.abort(), timeoutMs)

  try {
    const { query } = await importEsm('@anthropic-ai/claude-agent-sdk')
    const q = query({
      prompt: buildUserMessage(input),
      options: {
        cwd: workspacePath,
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: cachedDefinition },
        permissionMode: 'bypassPermissions',
        tools: effectiveTools,
        // Hard deny regardless of bypassPermissions and regardless of what's in `tools` —
        // disallowedTools is the only thing that survives bypassPermissions (see Part 1's
        // naming-collision note: the SDK's own `allowedTools` would NOT have restricted this).
        disallowedTools: ['AskUserQuestion'],
        env: { ...process.env, ANTHROPIC_API_KEY: claudeApiKey },
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        abortController,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput): Promise<HookJSONOutput> => {
                  const toolInput = hookInput as PreToolUseHookInput
                  // Compare against the SAME resolved effectiveTools list passed to `tools`
                  // above — not the raw block.allowedTools — so exploration mode's six-tool
                  // ceiling isn't denied by a hook that only sees an empty raw list.
                  if (!effectiveTools.includes(toolInput.tool_name)) {
                    toolsDenied.add(toolInput.tool_name)
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: `Tool "${toolInput.tool_name}" is outside this block's resolved tool list.`,
                      },
                    }
                  }
                  // Recorded as "used" only once permitted past this check — never the
                  // same array as denials, so Task 5's "restrict to these" suggestion can
                  // never accidentally prefill a tool the block was blocked from using.
                  toolsUsed.add(toolInput.tool_name)
                  return { continue: true }
                },
              ],
            },
          ],
        },
      },
    })

    let resultText: string | undefined
    let resultError: string | undefined
    for await (const message of q) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result
        } else {
          resultError = message.errors?.length ? message.errors.join('; ') : `Agentic execution ended: ${message.subtype}`
        }
      }
    }

    if (resultError) {
      return { status: 'failed', confidence: 0, summary: resultError, result: {}, errorMessage: resultError, toolsUsed: Array.from(toolsUsed), toolsDenied: Array.from(toolsDenied) }
    }
    if (resultText === undefined) {
      // When the timeout's AbortController fires mid-run, the SDK's async generator can
      // end gracefully (the `for await` loop just exits) rather than throwing — landing
      // here instead of the catch block below. Without this check, a real timeout gets
      // misreported as a generic "no result message", losing the actual cause.
      const timedOut = abortController.signal.aborted
      const message = timedOut
        ? `Agentic execution timed out after ${timeoutSeconds}s`
        : 'Agentic execution produced no result message'
      return { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message, toolsUsed: Array.from(toolsUsed), toolsDenied: Array.from(toolsDenied), timedOut: timedOut || undefined }
    }

    const normalized = normalizeAgentOutput(resultText, outputMapping)
    return { ...normalized, toolsUsed: Array.from(toolsUsed), toolsDenied: Array.from(toolsDenied) }
  } catch (err) {
    const timedOut = abortController.signal.aborted
    const message = timedOut
      ? `Agentic execution timed out after ${timeoutSeconds}s`
      : `Agentic execution failed: ${err instanceof Error ? err.message : String(err)}`
    return { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message, toolsUsed: Array.from(toolsUsed), toolsDenied: Array.from(toolsDenied), timedOut: timedOut || undefined }
  } finally {
    clearTimeout(timer)
  }
}
