// The SDK ships ESM-only (sdk.mjs). The Electron main process compiles to CommonJS
// (tsconfig.electron.json), so a static `import` here would become a `require()` that
// fails with ERR_REQUIRE_ESM — must dynamic-import the runtime value instead. Types are
// erased at compile time, so importing them statically is fine.
import type { query as QueryFn, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import type { AgentOutput } from '../../shared'
import { normalizeAgentOutput, buildUntrustedContext } from './output'
import { declaredContractSection } from './claudePrompt'
import { decideToolUse, buildAgentEnv, MANAGED_DENY_RULES } from '../security/agentPolicy'
import { log } from '../log'
import type { RunnerInput } from './types'
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

export function buildUserMessage(input: RunnerInput): string {
  return `${buildUntrustedContext(input.deliveryContext, input.block)}

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

export interface ToolPolicyState {
  worktree: string
  effectiveTools: readonly string[]
  toolsUsed: Set<string>
  toolsDenied: Set<string>
  denials: string[]
}

// PreToolUse hook: tool-list ceiling, worktree path scope and Bash network/git-remote rules all
// live in decideToolUse — compared against the SAME resolved effectiveTools list passed to
// `tools`, not the raw block.allowedTools. Every denial is recorded in toolsDenied/denials.
export function createToolPolicyHook(state: ToolPolicyState) {
  return async (hookInput: unknown): Promise<HookJSONOutput> => {
    const toolInput = hookInput as PreToolUseHookInput
    const decision = decideToolUse({
      toolName: toolInput.tool_name,
      toolInput: toolInput.tool_input,
      worktree: state.worktree,
      effectiveTools: state.effectiveTools,
    })
    if (!decision.allow) {
      state.toolsDenied.add(toolInput.tool_name)
      state.denials.push(`${toolInput.tool_name}: ${decision.reason}`)
      log.warn(`[agent] denied ${toolInput.tool_name}: ${decision.reason}`)
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `AXON policy: ${decision.reason}.`,
        },
      }
    }
    // Recorded as "used" only once permitted — never the same set as denials, so the
    // "restrict to these" suggestion can never prefill a tool the block was blocked from using.
    state.toolsUsed.add(toolInput.tool_name)
    return { continue: true }
  }
}

export async function runAgenticBlock(input: RunnerInput, claudeApiKey: string): Promise<AgentOutput> {
  const { instructions, workspacePath, effectiveTools, timeoutSeconds, signal: externalSignal } = input
  const outputMapping = input.block.outputMapping

  const toolsUsed = new Set<string>()
  const toolsDenied = new Set<string>()
  const denials: string[] = []
  const deniedList = () => Array.from(toolsDenied)
  const abortController = new AbortController()
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000
  const timer = setTimeout(() => abortController.abort(), timeoutMs)
  // The SDK call below needs a LOCAL AbortController (it calls .abort() on it for the
  // timeout) — relay the delivery-lifetime externalSignal into it too, so a user-clicked
  // Stop interrupts this call exactly like a timeout would, instead of only taking effect
  // once this step finishes naturally.
  const onExternalAbort = () => abortController.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)

  try {
    const { query } = await importEsm('@anthropic-ai/claude-agent-sdk')
    const q = query({
      prompt: buildUserMessage(input),
      options: {
        cwd: workspacePath,
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: `${instructions}${declaredContractSection(instructions)}` },
        permissionMode: 'bypassPermissions',
        tools: effectiveTools,
        // Hard deny regardless of bypassPermissions and regardless of what's in `tools` —
        // disallowedTools is the only thing that survives bypassPermissions (see Part 1's
        // naming-collision note: the SDK's own `allowedTools` would NOT have restricted this).
        disallowedTools: ['AskUserQuestion'],
        // Allow-list only: no Git/Jira tokens, nothing else from process.env.
        env: buildAgentEnv(process.env, claudeApiKey),
        // Policy-tier deny rules: a repo's .claude/settings.json (settingSources: ['project'], D11)
        // can add permissions but cannot remove or override managed denies.
        managedSettings: { permissions: { deny: [...MANAGED_DENY_RULES] } },
        pathToClaudeCodeExecutable: resolveClaudeBinaryPath(),
        abortController,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                createToolPolicyHook({ worktree: workspacePath, effectiveTools, toolsUsed, toolsDenied, denials }),
              ],
            },
          ],
        },
      },
    })

    let resultText: string | undefined
    let resultError: string | undefined
    let usage: AgentOutput['usage']
    for await (const message of q) {
      if (message.type === 'result') {
        // Real numbers reported by the SDK (tokens and total cost of this step).
        const m = message as { usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number }
        usage = { inputTokens: m.usage?.input_tokens, outputTokens: m.usage?.output_tokens, costUsd: m.total_cost_usd }
        if (message.subtype === 'success') {
          resultText = message.result
        } else {
          resultError = message.errors?.length ? message.errors.join('; ') : `Agentic execution ended: ${message.subtype}`
        }
      }
    }

    if (resultError) {
      return { status: 'failed', confidence: 0, summary: resultError, result: {}, errorMessage: resultError, toolsUsed: Array.from(toolsUsed), toolsDenied: deniedList(), denials, usage }
    }
    if (resultText === undefined) {
      // When the timeout's (or an externally-relayed Stop's) AbortController fires
      // mid-run, the SDK's async generator can end gracefully (the `for await` loop just
      // exits) rather than throwing — landing here instead of the catch block below.
      // Without this check, a real timeout/cancel gets misreported as a generic
      // "no result message", losing the actual cause.
      const cancelled = externalSignal?.aborted === true
      const timedOut = !cancelled && abortController.signal.aborted
      const message = cancelled
        ? 'Agentic execution cancelled'
        : timedOut
          ? `Agentic execution timed out after ${timeoutSeconds}s`
          : 'Agentic execution produced no result message'
      return { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message, toolsUsed: Array.from(toolsUsed), toolsDenied: deniedList(), denials, timedOut: timedOut || undefined }
    }

    const normalized = normalizeAgentOutput(resultText, outputMapping, input.block.outputSchema)
    return { ...normalized, toolsUsed: Array.from(toolsUsed), toolsDenied: deniedList(), denials, ...(usage ? { usage } : {}) }
  } catch (err) {
    const cancelled = externalSignal?.aborted === true
    const timedOut = !cancelled && abortController.signal.aborted
    const message = cancelled
      ? 'Agentic execution cancelled'
      : timedOut
        ? `Agentic execution timed out after ${timeoutSeconds}s`
        : `Agentic execution failed: ${err instanceof Error ? err.message : String(err)}`
    return { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message, toolsUsed: Array.from(toolsUsed), toolsDenied: deniedList(), denials, timedOut: timedOut || undefined }
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}
