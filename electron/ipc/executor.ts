import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { Agent } from 'undici'
import { store } from './settings'
import { readSecure } from './auth'
import { getClaudeKey } from './claudeKeyStore'
import { runAgent as runClaudeAgent } from './claude'
import type { AgentOutput, DeliveryContext } from './claude'
import { runAgenticBlock } from './claudeAgentic'
import { runAgent as runCodexAgent } from './codex'
import { cloneOrOpen, createDeliveryBranch, getChangedFiles, commitChanges, pushBranch, createPullRequest } from './git'
import type { PRConfig } from './git'

// One secure-storage key per runtime. Claude is resolved from claudeKeyStore's
// in-memory key instead — it is never persisted to disk (see CLAUDE.md "BUILD —
// Claude key resolution"). Add an entry here when wiring up a new disk-backed runtime.
const CREDENTIAL_KEY_BY_RUNTIME: Record<string, string> = {
  Codex: 'axon-codex-key',
}

async function runAgentForBlock(
  runtime: string,
  credentials: Record<string, string>,
  args: {
    blockId: string
    blockName: string
    cachedDefinition: string
    deliveryContext: DeliveryContext
    contextRequirements?: string[]
    outputMapping?: Record<string, string>
    artifactName?: string
  },
  agentic?: {
    workspacePath: string
    effectiveTools: string[]
    timeoutSeconds: number
    externalSignal?: AbortSignal
  },
): Promise<AgentOutput> {
  const apiKey = credentials[runtime] ?? ''
  if (runtime === 'Claude' && agentic) {
    return runAgenticBlock({ ...args, claudeApiKey: apiKey, ...agentic })
  }
  switch (runtime) {
    case 'Claude':
      return runClaudeAgent({ ...args, claudeApiKey: apiKey })
    case 'Codex':
      return runCodexAgent({ ...args, codexApiKey: apiKey })
    case 'Axon':
      return runAxonNativeBlock(args.artifactName)
    default:
      throw new Error(`Unsupported agent runtime: ${runtime}`)
  }
}

// Native (Axon-runtime) block handlers — no external API call, no cachedDefinition needed.
// Add a case here when wiring up a new artifactName for a Native/Axon block.
function runAxonNativeBlock(artifactName: string | undefined): AgentOutput {
  switch (artifactName) {
    case 'human-gate':
      // No real work — the pause itself is driven entirely by the block's role
      // (role === 'Control', checked in runStepLoop's isGateNode). This handler
      // just needs to return a valid AgentOutput so the step completes normally.
      return { status: 'success', summary: 'Awaiting human review', result: {} }
    default:
      throw new Error(`No native handler for Axon block artifactName "${artifactName}"`)
  }
}

// Captures the *entire* accumulated context pool for persistence/display — not
// filtered to the block's declared contextRequirements. This is intentionally
// different from claude.ts's runAgent(), which keeps its own separate, filtered
// copy of this field-selection for what the agent's prompt actually receives
// (that one MUST stay scoped to contextRequirements, for token budget and to
// avoid dumping unrelated data into the prompt) — this function is the
// persisted/displayed "Full Context Snapshot", a different concern from what
// the agent sees. Field-level filtering for the "Configured Context Fields"
// chip display happens client-side instead, against this same full pool.
function buildContextSnapshot(deliveryContext: DeliveryContext): Record<string, unknown> {
  return {
    ...deliveryContext.previousStepsResults,
    ...deliveryContext.currentInputs,
  }
}

// Lightweight, always-computed counterpart to the *entire* accumulated context
// pool — deliberately NOT filtered to a block's declared contextRequirements.
// This is a distinct concept from "Configured Context Fields" (the chips UI,
// which filters this same map down to just the declared keys for display) —
// availability itself always reports on everything actually available at this
// point in the pipeline, so a block that declares few/no requirements doesn't
// end up with a near-empty map while a block downstream of it sees everything.
// Declared requirements that aren't in the pool at all are still flagged
// 'missing' even though they're not a natural key of the pool.
// Shallow check only: doesn't recurse into nested object/array contents.
function computeContextAvailability(
  deliveryContext: DeliveryContext,
  contextRequirements?: string[],
): Record<string, 'available' | 'missing' | 'empty'> {
  const contextFields: Record<string, unknown> = {
    ...deliveryContext.previousStepsResults,
    ...deliveryContext.currentInputs,
  }
  return computeAvailability(contextFields, contextRequirements)
}

// Symmetric counterpart for output.result against the full pool of keys it
// actually contains, plus any outputSchema-declared key missing from it.
function computeOutputAvailability(
  result: Record<string, unknown>,
  outputSchema?: string[],
): Record<string, 'available' | 'missing' | 'empty'> {
  return computeAvailability(result, outputSchema)
}

function computeAvailability(
  fields: Record<string, unknown>,
  declaredKeys?: string[],
): Record<string, 'available' | 'missing' | 'empty'> {
  // Always report on every key actually in the pool — declared keys only add
  // entries for ones that are missing from it (so a required-but-absent field
  // still shows up), they never narrow what's reported.
  const keysToCheck = new Set(Object.keys(fields))
  for (const key of declaredKeys ?? []) keysToCheck.add(key)

  const availability: Record<string, 'available' | 'missing' | 'empty'> = {}
  for (const key of keysToCheck) {
    if (!(key in fields)) {
      availability[key] = 'missing'
      continue
    }
    const value = fields[key]
    const isEmpty = value == null || value === '' || (Array.isArray(value) && value.length === 0)
    availability[key] = isEmpty ? 'empty' : 'available'
  }
  return availability
}

// DS1 — Large Output Storage Strategy. Anything over `threshold` bytes (serialized)
// gets written to a local workspace file instead of sent inline; the backend only
// ever receives a small marker + the file reference. Threshold is the same setting
// (Settings > Preferences > Max Inline Snapshot Size) for both context-input and
// output.result storage — see settings.ts's `maxContextSnapshotSizeKb`.
const DS1_DEFAULT_THRESHOLD_BYTES = 50_000

function getDS1ThresholdBytes(): number {
  const kb = store.get('maxContextSnapshotSizeKb') as number | undefined
  return kb && kb > 0 ? kb * 1024 : DS1_DEFAULT_THRESHOLD_BYTES
}

async function checkAndStoreIfLarge(
  workspacePath: string,
  subfolder: 'inputs' | 'outputs',
  nodeId: string,
  data: Record<string, unknown>,
  thresholdBytes: number,
): Promise<{ value: Record<string, unknown>; isTruncated: boolean; fileRef?: string }> {
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized, 'utf-8') < thresholdBytes) {
    return { value: data, isTruncated: false }
  }

  const dir = path.join(workspacePath, '.axon', subfolder)
  const fileName = `${nodeId}-${Date.now()}.json`
  const fileRef = path.join('.axon', subfolder, fileName)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, fileName), serialized, 'utf-8')
  } catch (err) {
    console.warn(`DS1: failed to write large ${subfolder} to workspace, sending inline despite size: ${err}`)
    return { value: data, isTruncated: false }
  }

  return {
    value: { truncated: true, sizeBytes: Buffer.byteLength(serialized, 'utf-8'), note: `Full content stored locally — see ${fileRef}` },
    isTruncated: true,
    fileRef,
  }
}

// Dev-only ASP.NET Core HTTPS certs (dotnet dev-certs) are trusted by the OS/Chromium but
// not by Node's bundled CA list. Scoped to localhost so a real backend's TLS is never weakened.
const insecureLocalhostDispatcher = new Agent({ connect: { rejectUnauthorized: false } })

function dispatcherFor(baseUrl: string): Agent | undefined {
  try {
    const { hostname } = new URL(baseUrl)
    return hostname === 'localhost' || hostname === '127.0.0.1' ? insecureLocalhostDispatcher : undefined
  } catch {
    return undefined
  }
}

// Minimal types for pipeline walking — the backend returns these inside the delivery snapshot
interface PipelineEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  isDefault?: boolean
}

interface PipelineNode {
  id: string
  label: string
  blockId: string
  timeoutSeconds?: number
}

interface CachedFile {
  relativePath: string
  content: string
}

interface BuildingBlock {
  id: string
  name: string
  role?: string
  agentRuntime?: string
  artifactName?: string
  cachedFiles?: CachedFile[]
  entryPointPath?: string
  contextRequirements?: string[]
  outputSchema?: string[]
  outputMapping?: Record<string, string>
  executionType?: 'Prompt' | 'Agentic'
  allowedTools?: string[]
  defaultTimeoutSeconds?: number
  visibility?: 'Personal' | 'Team' | 'Organisation'
}

// Same six tools offered in CreateBlockForm's checklist (src/types/index.ts's
// AGENTIC_TOOL_OPTIONS) — never WebSearch/WebFetch/AskUserQuestion. Duplicated here
// rather than imported since electron/ and src/ are separate compile targets.
const AGENTIC_TOOL_CEILING = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']

// Part 4 task 3 — single source of truth for "what tools can this block actually use
// right now", computed ONCE per step and handed to both the SDK's `tools` option and
// the PreToolUse hook's allow-check. Resolving it twice (once for the SDK call, once
// for the hook) risks the two disagreeing — e.g. an empty raw allowedTools in
// exploration mode would deny everything if the hook re-derived from the raw field
// instead of using this same resolved value.
function resolveEffectiveTools(block: BuildingBlock): string[] {
  const isExploring = (block.visibility ?? 'Personal') === 'Personal'
    && block.executionType === 'Agentic'
    && (!block.allowedTools || block.allowedTools.length === 0)
  return isExploring ? AGENTIC_TOOL_CEILING : (block.allowedTools ?? [])
}

interface PipelineSnapshot {
  name: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

interface DeliveryFromApi {
  id: string
  ticketId: string
  title?: string
  pipelineId: string
  status: string
  repoUrl: string
  workspaceType: 'Default' | 'Browse'
  workspacePath?: string | null
  storeFullContext?: boolean
  currentNodeId?: string
  pipelineSnapshot?: PipelineSnapshot
  steps: Array<{ nodeId: string; blockName: string; status: string; output?: { result?: Record<string, unknown> } }>
  inputs?: Record<string, unknown>
  jobNumber: number
  branch?: string | null
}

interface ExecutionContext {
  deliveryId: string
  delivery: DeliveryFromApi
  workspacePath: string
  credentials: Record<string, string>
  gitToken?: string
  branch?: string
  isCancelled: boolean
  blocks: Map<string, BuildingBlock>
  stepResults: Record<string, unknown>
  // Flattened union of every completed step's result fields, used for the next
  // block's `previousStepsResults` context. `stepResults` itself stays keyed by
  // nodeId (needed elsewhere, e.g. the PR-body step count) — contextRequirements
  // need to match field names directly (e.g. "producedTitle"), not a nodeId-nested
  // shape, since that's the contract blocks declare against each other.
  flatResults: Record<string, unknown>
  // True for the entire span runStepLoop is actively executing — set right before
  // calling it, cleared once it returns/throws by ANY path (pause for a gate, cancel,
  // failure, full completion). Guards resumeDelivery against being re-entered while a
  // resume from a PREVIOUS call is still in flight for this same delivery (e.g. a
  // double-fired Approve click) — unlike startDelivery, which creates a fresh
  // ExecutionContext each call, resume reuses this same ctx, so a naive re-entrancy
  // would have two runStepLoop invocations mutating the same ctx.flatResults/
  // stepResults concurrently and double-executing the resumed node.
  isLoopActive: boolean
  // Lives for the whole delivery (created once in startDeliveryInner, never replaced on
  // resume). cancelDelivery calls .abort() on this directly — isCancelled alone is only
  // checked at the TOP of runStepLoop's while loop, so it does nothing while a step's
  // agent call is actually in flight (the common case — a real Agentic run can take
  // minutes). This signal is threaded into runAgentForBlock so the in-flight SDK/fetch
  // call itself gets interrupted immediately instead of running to completion regardless
  // of Stop being clicked.
  abortController: AbortController
}

export interface ExecutionProgress {
  type:
    | 'workspace_provisioning' | 'workspace_provisioned'
    | 'git_preparing' | 'git_prepared'
    | 'step_started' | 'step_completed' | 'step_failed' | 'gate_reached'
    | 'completed' | 'failed' | 'cancelled'
  deliveryId: string
  nodeId: string
  blockName?: string
  output?: AgentOutput
  message?: string
  prUrl?: string
}

const activeExecutions = new Map<string, ExecutionContext>()

function sendProgress(event: ExecutionProgress) {
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('execution:progress', event)
}

async function apiGet<T>(path: string, token: string | null, baseUrl: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    dispatcher: dispatcherFor(baseUrl),
  } as RequestInit)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

async function apiPost(path: string, body: unknown, token: string | null, baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    dispatcher: dispatcherFor(baseUrl),
  } as RequestInit)
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`)
}

async function apiPatch(path: string, body: unknown, token: string | null, baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    dispatcher: dispatcherFor(baseUrl),
  } as RequestInit)
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}`)
}

function findStartNode(nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode | undefined {
  const hasIncoming = new Set(edges.map((e) => e.targetNodeId))
  return nodes.find((n) => !hasIncoming.has(n.id))
}

function nextNode(currentId: string, nodes: PipelineNode[], edges: PipelineEdge[]): PipelineNode | undefined {
  const outgoing = edges.filter((e) => e.sourceNodeId === currentId)
  const edge = outgoing.find((e) => e.isDefault) ?? outgoing[0]
  if (!edge) return undefined
  return nodes.find((n) => n.id === edge.targetNodeId)
}

// Derives the true resume point by walking the pipeline graph from the start and finding
// the first node WITHOUT a Completed step record — deliberately NOT trusting
// delivery.currentNodeId, which is only ever patched when pausing at a gate or on
// failure, never advanced during ordinary step-to-step progress. A delivery cancelled (or
// the app closed) mid-pipeline, well past the last gate, leaves currentNodeId stuck
// pointing at that old gate even though later steps completed successfully afterward —
// confirmed in practice (KVOICE-1100, job #49: currentNodeId stuck at gate1's id while
// code-implementor, two nodes downstream, shows Completed with real output).
function resolveResumeNode(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  steps: DeliveryFromApi['steps'],
): PipelineNode | undefined {
  return resolvePipelineProgress(nodes, edges, steps).resumeNode
}

// Richer version of the same walk — also reports the last node that actually completed,
// for previewResume's confirmation UI ("this will resume after X, at Y").
function resolvePipelineProgress(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  steps: DeliveryFromApi['steps'],
): { lastCompletedNode?: PipelineNode; resumeNode?: PipelineNode } {
  const completedNodeIds = new Set(steps.filter((s) => s.status === 'Completed').map((s) => s.nodeId))
  let lastCompletedNode: PipelineNode | undefined
  let node = findStartNode(nodes, edges)
  while (node && completedNodeIds.has(node.id)) {
    lastCompletedNode = node
    node = nextNode(node.id, nodes, edges)
  }
  return { lastCompletedNode, resumeNode: node }
}

// Rebuilds the cross-step result pool an in-memory ExecutionContext would normally have
// accumulated live — needed when reconstructing a context from scratch (no in-memory ctx
// survived a cancel or app restart) rather than carrying one forward across a pause.
// Pulled from each Completed step's output.result, which is ALWAYS persisted regardless
// of storeFullContext (that flag only gates the separate, debug-only input context
// snapshot — see CLAUDE.md/conversation history for why these are not the same thing).
function reconstructFlatResults(steps: DeliveryFromApi['steps']): {
  stepResults: Record<string, unknown>
  flatResults: Record<string, unknown>
} {
  const stepResults: Record<string, unknown> = {}
  let flatResults: Record<string, unknown> = {}
  for (const step of steps) {
    if (step.status !== 'Completed' || !step.output?.result) continue
    stepResults[step.nodeId] = step.output.result
    flatResults = { ...flatResults, ...step.output.result }
  }
  return { stepResults, flatResults }
}

async function runStepLoop(
  ctx: ExecutionContext,
  startNodeId: string,
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  baseUrl: string,
  token: string | null,
): Promise<void> {
  let currentNode = nodes.find((n) => n.id === startNodeId)

  while (currentNode) {
    if (ctx.isCancelled) {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'cancelled', nodeId: currentNode.id })
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Cancelled' }, token, baseUrl)
      activeExecutions.delete(ctx.deliveryId)
      return
    }

    const node = currentNode
    sendProgress({ deliveryId: ctx.deliveryId, type: 'step_started', nodeId: node.id, blockName: node.label })
    // Registers an accurate StartedAt with the backend before any work happens, so the
    // later finalize POST (.../steps) can update this same step in place instead of
    // stamping StartedAt=CompletedAt=now for both. MUST be awaited, not fire-and-forget —
    // the backend's finalize handler decides append-vs-update by reading the steps array
    // at the time it runs; for a fast/native block (e.g. human-gate, which resolves
    // synchronously) the finalize POST can otherwise reach the backend and read the steps
    // array BEFORE this start call's append has landed, causing it to wrongly append a
    // second entry instead of updating this one (observed in practice — duplicate
    // Running + AwaitingApproval entries for the same nodeId). The `.catch` still means a
    // network failure here doesn't fail the step — only the await ordering matters.
    await apiPost(`/api/deliveries/${ctx.deliveryId}/steps/start`, { nodeId: node.id, blockId: node.blockId, blockName: node.label }, token, baseUrl)
      .catch((err) => console.warn(`Failed to register step start: ${err}`))

    let output: AgentOutput
    let contextResult: { value: Record<string, unknown>; isTruncated: boolean; fileRef?: string } | undefined
    let contextAvailability: Record<string, 'available' | 'missing' | 'empty'> | undefined
    try {
      const block = ctx.blocks.get(node.blockId)
      if (!block) {
        throw new Error(`Block ${node.blockId} not found in context`)
      }
      // Native (Axon-runtime) blocks have no cachedFiles/entryPointPath — they're not
      // a skill/prompt, just a handler keyed off artifactName (see runAxonNativeBlock).
      let cachedDefinition = ''
      if (block.agentRuntime !== 'Axon') {
        const entryFile = block.cachedFiles?.find((f) => f.relativePath === block.entryPointPath)
        if (!entryFile) {
          throw new Error(`Block ${node.label} has no entry point file matching "${block.entryPointPath}" in its cachedFiles`)
        }
        cachedDefinition = entryFile.content
      }

      const deliveryContext: DeliveryContext = {
        ticketId: ctx.delivery.ticketId,
        ticketTitle: ctx.delivery.title,
        previousStepsResults: ctx.flatResults,
        currentInputs: ctx.delivery.inputs ?? {},
      }

      contextAvailability = computeContextAvailability(deliveryContext, block.contextRequirements)
      if (ctx.delivery.storeFullContext) {
        const contextSnapshot = buildContextSnapshot(deliveryContext)
        contextResult = await checkAndStoreIfLarge(ctx.workspacePath, 'inputs', node.id, contextSnapshot, getDS1ThresholdBytes())
      }

      const agentic = block.executionType === 'Agentic'
        ? {
            workspacePath: ctx.workspacePath,
            effectiveTools: resolveEffectiveTools(block),
            timeoutSeconds: node.timeoutSeconds ?? block.defaultTimeoutSeconds ?? 120,
            externalSignal: ctx.abortController.signal,
          }
        : undefined

      output = await runAgentForBlock(
        block.agentRuntime ?? 'Claude',
        ctx.credentials,
        {
          blockId: node.blockId,
          blockName: node.label,
          cachedDefinition,
          deliveryContext,
          contextRequirements: block.contextRequirements,
          outputMapping: block.outputMapping,
          artifactName: block.artifactName,
        },
        agentic,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The error thrown here can be a direct CONSEQUENCE of cancelDelivery's abort() —
      // don't let that get persisted/reported as a genuine failure and overwrite the
      // Cancelled status cancelDelivery already patched. isCancelled is checked, not the
      // error message, since different runtimes surface an abort differently (a thrown
      // AbortError, a rejected fetch, etc.) and matching text would be fragile.
      if (ctx.isCancelled) {
        sendProgress({ deliveryId: ctx.deliveryId, type: 'cancelled', nodeId: node.id })
        await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Cancelled' }, token, baseUrl)
          .catch((patchErr) => console.warn(`Failed to persist cancelled status: ${patchErr}`))
        activeExecutions.delete(ctx.deliveryId)
        return
      }
      sendProgress({ deliveryId: ctx.deliveryId, type: 'step_failed', nodeId: node.id, blockName: node.label, message })
      await apiPost(
        `/api/deliveries/${ctx.deliveryId}/steps`,
        {
          nodeId: node.id,
          blockId: node.blockId,
          blockName: node.label,
          status: 'Failed',
          contextSnapshot: contextResult?.value,
          isContextTruncated: contextResult?.isTruncated ?? false,
          contextFileRef: contextResult?.fileRef,
          contextAvailability,
          output: { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message },
        },
        token,
        baseUrl,
      )
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Failed', currentNodeId: node.id }, token, baseUrl)
      activeExecutions.delete(ctx.deliveryId)
      return
    }

    // Same reasoning as the catch block above — the agent call can return a normal
    // (non-throwing) `status: 'failed'` AgentOutput as the direct result of being
    // aborted (e.g. claudeAgentic.ts's graceful no-result-message path), which must not
    // get persisted/reported as a genuine failure and overwrite the Cancelled status
    // cancelDelivery already patched.
    if (ctx.isCancelled) {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'cancelled', nodeId: node.id })
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Cancelled' }, token, baseUrl)
        .catch((err) => console.warn(`Failed to persist cancelled status: ${err}`))
      activeExecutions.delete(ctx.deliveryId)
      return
    }

    const block = ctx.blocks.get(node.blockId)
    const outputAvailability = computeOutputAvailability(output.result, block?.outputSchema)
    const outputResult = await checkAndStoreIfLarge(ctx.workspacePath, 'outputs', node.id, output.result, getDS1ThresholdBytes())
    const persistedOutput: AgentOutput = {
      ...output,
      result: outputResult.value,
      isTruncated: outputResult.isTruncated,
      outputFileRef: outputResult.fileRef,
    }

    // isGateNode takes priority over output.status — a Control-role block always
    // pauses for approval regardless of what status the agent itself returned.
    const isGateNode = ctx.blocks.get(node.blockId)?.role === 'Control'

    await apiPost(
      `/api/deliveries/${ctx.deliveryId}/steps`,
      {
        nodeId: node.id,
        blockId: node.blockId,
        blockName: node.label,
        status: isGateNode ? 'AwaitingApproval' : output.status === 'failed' ? 'Failed' : 'Completed',
        contextSnapshot: contextResult?.value,
        isContextTruncated: contextResult?.isTruncated ?? false,
        contextFileRef: contextResult?.fileRef,
        contextAvailability,
        outputAvailability,
        output: persistedOutput,
      },
      token,
      baseUrl,
    ).catch((err) => console.warn(`Failed to persist step result: ${err}`))

    if (output.status === 'failed') {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'step_failed', nodeId: node.id, blockName: node.label, output, message: output.summary })
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Failed', currentNodeId: node.id }, token, baseUrl)
      activeExecutions.delete(ctx.deliveryId)
      return
    }

    // Store step result for next steps to access
    ctx.stepResults[node.id] = output.result
    ctx.flatResults = { ...ctx.flatResults, ...output.result }

    if (isGateNode) {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'gate_reached', nodeId: node.id, blockName: node.label, output, message: output.summary })
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Paused', currentNodeId: node.id }, token, baseUrl)
      // Keep context alive so resume can continue from here
      ctx.delivery.currentNodeId = node.id
      return
    }

    sendProgress({ deliveryId: ctx.deliveryId, type: 'step_completed', nodeId: node.id, blockName: node.label, output })
    // Advance currentNodeId on ordinary progress too, not just at a pause/failure —
    // otherwise it goes stale the moment a delivery runs past its last gate without
    // pausing again, and resolveResumeNode's doc comment becomes the only thing keeping
    // resume correct. Keep both: this field stays meaningful for anything that reads it
    // directly (display, support/debugging), resolveResumeNode stays the source of truth
    // resume itself relies on.
    await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Running', currentNodeId: node.id }, token, baseUrl)
      .catch((err) => console.warn(`Failed to advance currentNodeId: ${err}`))
    ctx.delivery.currentNodeId = node.id
    currentNode = nextNode(node.id, nodes, edges)
  }

  // All nodes done — now handle Git operations (commit, push, create PR)
  try {
    const pipelineName = ctx.delivery.pipelineSnapshot?.name ?? 'AXON Pipeline'

    // Get changed files
    const changedFiles = await getChangedFiles(ctx.workspacePath)
    if (changedFiles.length === 0) {
      console.warn('No changed files in workspace')
    }

    if (ctx.branch) {
      // Commit changes
      const commitMessage = `axon: ${ctx.delivery.title ?? ctx.delivery.ticketId} [${ctx.delivery.ticketId}]\n\nDelivered by AXON pipeline: ${pipelineName}`
      const commitSha = await commitChanges(ctx.workspacePath, commitMessage)
      console.log(`Committed: ${commitSha}`)

      // Push branch — works without a token too, trusting local git credentials
      // (SSH key, Windows/Git Credential Manager) via pushBranch's own fallback.
      await pushBranch(ctx.workspacePath, ctx.branch, ctx.delivery.repoUrl, ctx.gitToken ?? '')
      console.log(`Pushed: ${ctx.branch}`)

      // PR creation is a direct REST API call (GitHub/Azure DevOps), not a git
      // operation — local git credentials don't help here, an explicit token is
      // unavoidable for this part specifically.
      if (ctx.gitToken) {
        try {
          const provider = ctx.delivery.repoUrl.includes('github.com') ? 'github' : 'azuredevops'
          const prConfig: PRConfig = {
            provider,
            repoUrl: ctx.delivery.repoUrl,
            token: ctx.gitToken,
            branch: ctx.branch,
            baseBranch: 'main',
            title: `${ctx.delivery.ticketId}: ${ctx.delivery.title ?? 'Delivery'}`,
            body: `## AXON Delivery\n\nPipeline: ${pipelineName}\n\nTicket: ${ctx.delivery.ticketId}\n\nCompleted steps: ${Object.keys(ctx.stepResults).length}`,
            ticketId: ctx.delivery.ticketId,
          }

          const prUrl = await createPullRequest(prConfig)
          console.log(`Created PR: ${prUrl}`)

          // Update delivery with PR URL
          await apiPatch(
            `/api/deliveries/${ctx.deliveryId}/status`,
            { status: 'Completed', prUrl },
            token,
            baseUrl,
          ).catch((err) => console.warn(`Failed to update delivery with PR URL: ${err}`))

          sendProgress({ deliveryId: ctx.deliveryId, type: 'completed', nodeId: '', prUrl })
        } catch (prErr) {
          console.warn(`PR creation failed: ${prErr}`)
          sendProgress({ deliveryId: ctx.deliveryId, type: 'completed', nodeId: '' })
        }
      } else {
        sendProgress({ deliveryId: ctx.deliveryId, type: 'completed', nodeId: '' })
      }
    } else {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'completed', nodeId: '' })
    }
  } catch (gitErr) {
    console.warn(`Git operations failed: ${gitErr}`)
    sendProgress({ deliveryId: ctx.deliveryId, type: 'completed', nodeId: '' })
  }

  await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Completed' }, token, baseUrl).catch(
    () => { /* log but don't abort */ },
  )
  activeExecutions.delete(ctx.deliveryId)
}

async function fetchBlocks(
  blockIds: string[],
  token: string | null,
  baseUrl: string,
): Promise<{ blocks: Map<string, BuildingBlock>; errors: string[] }> {
  const blocks = new Map<string, BuildingBlock>()
  const errors: string[] = []
  const uniqueIds = Array.from(new Set(blockIds))

  for (const id of uniqueIds) {
    try {
      const block = await apiGet<BuildingBlock>(`/api/blocks/${id}`, token, baseUrl)
      blocks.set(id, block)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Failed to fetch block ${id}: ${message}`)
      errors.push(`${id}: ${message}`)
    }
  }

  return { blocks, errors }
}

// Claims a deliveryId for the duration of startDelivery's async setup, before
// activeExecutions.set() happens. Without this, two near-simultaneous start()
// calls for the same delivery can both pass the activeExecutions.has() guard
// and both end up running the full pipeline concurrently (duplicate everything).
const startingDeliveries = new Set<string>()

async function startDelivery(deliveryId: string): Promise<{ success: boolean; error?: string }> {
  if (activeExecutions.has(deliveryId) || startingDeliveries.has(deliveryId)) {
    return { success: false, error: 'Already running' }
  }
  startingDeliveries.add(deliveryId)
  try {
    return await startDeliveryInner(deliveryId)
  } finally {
    startingDeliveries.delete(deliveryId)
  }
}

async function startDeliveryInner(deliveryId: string): Promise<{ success: boolean; error?: string }> {
  const baseUrl = (store.get('backendUrl') as string) || 'http://localhost:3000'
  const token = await readSecure('axon-access-token')
  const credentials: Record<string, string> = { Claude: getClaudeKey() }
  for (const [runtime, secureKey] of Object.entries(CREDENTIAL_KEY_BY_RUNTIME)) {
    credentials[runtime] = (await readSecure(secureKey)) ?? ''
  }

  let delivery: DeliveryFromApi
  try {
    delivery = await apiGet<DeliveryFromApi>(`/api/deliveries/${deliveryId}`, token, baseUrl)
  } catch (err) {
    return { success: false, error: `Failed to fetch delivery: ${err}` }
  }

  if (delivery.status !== 'Pending' && delivery.status !== 'Paused') {
    return { success: false, error: `Delivery is ${delivery.status}, cannot start` }
  }

  // Resolve workspacePath before marking Running
  sendProgress({ deliveryId, type: 'workspace_provisioning', nodeId: '' })
  let workspacePath: string
  if (delivery.workspaceType === 'Browse') {
    const win = BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select workspace folder' })
      : { canceled: true, filePaths: [] as string[] }
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, error: 'No workspace folder selected' }
    }
    workspacePath = result.filePaths[0]
  } else {
    const workspaceRoot = (store.get('workspaceRoot') as string) || app.getPath('documents')
    workspacePath = path.join(workspaceRoot, delivery.ticketId)
  }

  await apiPatch(
    `/api/deliveries/${deliveryId}/status`,
    { status: 'Running', workspacePath },
    token,
    baseUrl,
  )
  sendProgress({ deliveryId, type: 'workspace_provisioned', nodeId: '', message: workspacePath })

  // Get nodes + edges from snapshot or fetch pipeline
  let nodes: PipelineNode[] = delivery.pipelineSnapshot?.nodes ?? []
  let edges: PipelineEdge[] = delivery.pipelineSnapshot?.edges ?? []

  if (!nodes.length) {
    try {
      const pipeline = await apiGet<{ nodes: PipelineNode[]; edges: PipelineEdge[] }>(
        `/api/pipelines/${delivery.pipelineId}`,
        token,
        baseUrl,
      )
      nodes = pipeline.nodes
      edges = pipeline.edges
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Could not load pipeline nodes: ${message}` }
    }
  }

  const startNode = findStartNode(nodes, edges)
  if (!startNode) return { success: false, error: 'No start node found in pipeline' }

  // Fetch all blocks referenced by the pipeline
  const blockIds = nodes.map((n) => n.blockId)
  const { blocks, errors: blockErrors } = await fetchBlocks(blockIds, token, baseUrl)
  if (blocks.size === 0) {
    return { success: false, error: `Could not load any blocks for the pipeline: ${blockErrors.join('; ')}` }
  }

  // Get Git token
  const gitToken = await readSecure('git-token')

  // Clone or open repo
  sendProgress({ deliveryId, type: 'git_preparing', nodeId: '', message: delivery.repoUrl })
  const gitResult = await cloneOrOpen(delivery.repoUrl, workspacePath, gitToken ?? '')
  if (!gitResult.success) {
    return { success: false, error: `Git setup failed: ${gitResult.error}` }
  }

  // Create delivery branch — works without a git token too, relying on whatever
  // local git credentials (SSH key, Credential Manager) are already set up.
  let branch: string | undefined
  try {
    branch = await createDeliveryBranch(workspacePath, delivery.ticketId, delivery.jobNumber)
    console.log(`Created branch: ${branch}`)
    await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Running', branch }, token, baseUrl)
      .catch((err) => console.warn(`Failed to persist branch name: ${err}`))
  } catch (branchErr) {
    console.warn(`Failed to create delivery branch: ${branchErr}`)
  }
  sendProgress({ deliveryId, type: 'git_prepared', nodeId: '', message: branch })

  const ctx: ExecutionContext = {
    deliveryId,
    delivery,
    workspacePath,
    credentials,
    gitToken: gitToken ?? undefined,
    branch,
    isCancelled: false,
    blocks,
    stepResults: {},
    flatResults: {},
    isLoopActive: false,
    abortController: new AbortController(),
  }
  activeExecutions.set(deliveryId, ctx)

  // Run async — don't await
  ctx.isLoopActive = true
  runStepLoop(ctx, startNode.id, nodes, edges, baseUrl, token)
    .catch((err) => {
      sendProgress({ deliveryId, type: 'failed', nodeId: '', message: String(err) })
      activeExecutions.delete(deliveryId)
    })
    .finally(() => { ctx.isLoopActive = false })

  return { success: true }
}

export interface ResumePreview {
  resumeNodeId: string
  resumeNodeLabel: string
  resumeNodeRole?: string
  lastCompletedNodeLabel?: string
  // True when the resume node already has a step record (Running/Failed/Cancelled, never
  // Completed — if it were Completed, resolvePipelineProgress would have walked past it).
  // Means this exact node was attempted before and didn't finish cleanly — if it's an
  // Execution/Agentic block with Write/Edit/Bash, it may have left partial, uncommitted
  // changes in the workspace that resuming will NOT roll back; it just runs again on top
  // of whatever's already there.
  hasPriorAttempt: boolean
  reconstructedContextKeys: string[]
  workspacePath?: string
  branch?: string
  allNodesCompleted: boolean
}

// Read-only — computes what resumeDelivery WOULD do without doing any of it (no
// activeExecutions entry, no status patch, no step started). Lets the UI show the user
// exactly where they're resuming from and what context it'll carry forward, and warn
// about partial workspace changes, before they commit to it.
async function previewResume(deliveryId: string): Promise<{ success: boolean; error?: string; preview?: ResumePreview }> {
  const baseUrl = (store.get('backendUrl') as string) || 'http://localhost:3000'
  const token = await readSecure('axon-access-token')

  let delivery: DeliveryFromApi
  try {
    delivery = await apiGet<DeliveryFromApi>(`/api/deliveries/${deliveryId}`, token, baseUrl)
  } catch (err) {
    return { success: false, error: `Failed to fetch delivery: ${err}` }
  }

  let nodes: PipelineNode[] = delivery.pipelineSnapshot?.nodes ?? []
  let edges: PipelineEdge[] = delivery.pipelineSnapshot?.edges ?? []
  if (!nodes.length) {
    try {
      const pipeline = await apiGet<{ nodes: PipelineNode[]; edges: PipelineEdge[] }>(
        `/api/pipelines/${delivery.pipelineId}`,
        token,
        baseUrl,
      )
      nodes = pipeline.nodes
      edges = pipeline.edges
    } catch {
      return { success: false, error: 'Could not load pipeline nodes' }
    }
  }

  const { lastCompletedNode, resumeNode } = resolvePipelineProgress(nodes, edges, delivery.steps)
  const { flatResults } = reconstructFlatResults(delivery.steps)

  if (!resumeNode) {
    return {
      success: true,
      preview: {
        resumeNodeId: '',
        resumeNodeLabel: '',
        lastCompletedNodeLabel: lastCompletedNode?.label,
        hasPriorAttempt: false,
        reconstructedContextKeys: Object.keys(flatResults),
        workspacePath: delivery.workspacePath ?? undefined,
        branch: delivery.branch ?? undefined,
        allNodesCompleted: true,
      },
    }
  }

  const { blocks } = await fetchBlocks([resumeNode.blockId], token, baseUrl)
  const hasPriorAttempt = delivery.steps.some((s) => s.nodeId === resumeNode.id)

  return {
    success: true,
    preview: {
      resumeNodeId: resumeNode.id,
      resumeNodeLabel: resumeNode.label,
      resumeNodeRole: blocks.get(resumeNode.blockId)?.role,
      lastCompletedNodeLabel: lastCompletedNode?.label,
      hasPriorAttempt,
      reconstructedContextKeys: Object.keys(flatResults),
      workspacePath: delivery.workspacePath ?? undefined,
      branch: delivery.branch ?? undefined,
      allNodesCompleted: false,
    },
  }
}

async function resumeDelivery(deliveryId: string): Promise<{ success: boolean; error?: string }> {
  const baseUrl = (store.get('backendUrl') as string) || 'http://localhost:3000'
  const token = await readSecure('axon-access-token')

  let delivery: DeliveryFromApi
  try {
    delivery = await apiGet<DeliveryFromApi>(`/api/deliveries/${deliveryId}`, token, baseUrl)
  } catch (err) {
    return { success: false, error: `Failed to fetch delivery: ${err}` }
  }

  // Cancelled is resumable too, not just Paused — continuing a delivery past wherever it
  // actually stopped (which may be well past the last gate, not just "at" one) is a real
  // workflow: a user cancels mid-step, or just closes AXON overnight while sitting at a
  // gate (which also wipes the in-memory context below, identically to a cancel).
  if (delivery.status !== 'Paused' && delivery.status !== 'Cancelled') {
    return { success: false, error: `Delivery is ${delivery.status}, cannot resume` }
  }

  let ctx = activeExecutions.get(deliveryId)
  // Guards against a double-fired resume (e.g. a double-click on Approve) re-entering
  // the loop for this same ctx while a previous resume is still actively running —
  // see ExecutionContext.isLoopActive's doc comment for why that would be unsafe.
  if (ctx?.isLoopActive) return { success: false, error: 'Delivery is already resuming/running' }

  let nodes: PipelineNode[] = delivery.pipelineSnapshot?.nodes ?? ctx?.delivery.pipelineSnapshot?.nodes ?? []
  let edges: PipelineEdge[] = delivery.pipelineSnapshot?.edges ?? ctx?.delivery.pipelineSnapshot?.edges ?? []

  if (!nodes.length) {
    try {
      const pipeline = await apiGet<{ nodes: PipelineNode[]; edges: PipelineEdge[] }>(
        `/api/pipelines/${delivery.pipelineId}`,
        token,
        baseUrl,
      )
      nodes = pipeline.nodes
      edges = pipeline.edges
    } catch {
      return { success: false, error: 'Could not load pipeline nodes' }
    }
  }

  // Deliberately NOT delivery.currentNodeId — see resolveResumeNode's doc comment for why
  // that field can't be trusted here (only patched at a pause/failure, never advanced
  // during ordinary progress, so it can point well behind the real last-completed step).
  const resumeNode = resolveResumeNode(nodes, edges, delivery.steps)
  if (!resumeNode) {
    // Every node already has a Completed record — nothing left to resume into.
    sendProgress({ deliveryId, type: 'completed', nodeId: '' })
    await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Completed' }, token, baseUrl)
    activeExecutions.delete(deliveryId)
    return { success: true }
  }

  if (!ctx) {
    // No in-memory context survived (cancelled, or AXON was closed and reopened since) —
    // rebuild one from the persisted delivery record instead of failing outright.
    if (!delivery.workspacePath) {
      return { success: false, error: 'No workspace path recorded for this delivery — cannot resume without restarting it' }
    }

    const credentials: Record<string, string> = { Claude: getClaudeKey() }
    for (const [runtime, secureKey] of Object.entries(CREDENTIAL_KEY_BY_RUNTIME)) {
      credentials[runtime] = (await readSecure(secureKey)) ?? ''
    }
    const gitToken = await readSecure('git-token')

    const blockIds = nodes.map((n) => n.blockId)
    const { blocks, errors: blockErrors } = await fetchBlocks(blockIds, token, baseUrl)
    if (blocks.size === 0) {
      return { success: false, error: `Could not load any blocks for the pipeline: ${blockErrors.join('; ')}` }
    }

    // Rebuilds the cross-step result pool a live context would have accumulated as it
    // ran — see reconstructFlatResults' doc comment for why this works regardless of
    // storeFullContext.
    const { stepResults, flatResults } = reconstructFlatResults(delivery.steps)

    ctx = {
      deliveryId,
      delivery,
      workspacePath: delivery.workspacePath,
      credentials,
      gitToken: gitToken ?? undefined,
      branch: delivery.branch ?? undefined,
      isCancelled: false,
      blocks,
      stepResults,
      flatResults,
      isLoopActive: false,
      abortController: new AbortController(),
    }
    activeExecutions.set(deliveryId, ctx)
  } else {
    ctx.isCancelled = false
  }

  await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Running' }, token, baseUrl)

  const resumedCtx = ctx
  resumedCtx.isLoopActive = true
  runStepLoop(resumedCtx, resumeNode.id, nodes, edges, baseUrl, token)
    .catch((err) => {
      sendProgress({ deliveryId, type: 'failed', nodeId: '', message: String(err) })
      activeExecutions.delete(deliveryId)
    })
    .finally(() => { resumedCtx.isLoopActive = false })

  return { success: true }
}

async function cancelDelivery(deliveryId: string): Promise<{ success: boolean; error?: string }> {
  const ctx = activeExecutions.get(deliveryId)
  if (ctx) {
    ctx.isCancelled = true
    // isCancelled alone is only checked between steps — abort() interrupts whatever's
    // actually in flight (an Agentic SDK call, a Prompt-mode fetch) right now, instead of
    // letting it run to completion regardless of Stop being clicked.
    ctx.abortController.abort()
    // Patch the backend status immediately rather than waiting for the loop to unwind
    // and notice isCancelled on its own — that could be a long wait (or never happen
    // promptly) if the in-flight call doesn't honor the abort signal for some reason.
    // Reopening the delivery should show Cancelled right away, not stale Running.
    const baseUrl = (store.get('backendUrl') as string) || 'http://localhost:3000'
    const token = await readSecure('axon-access-token')
    await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Cancelled' }, token, baseUrl)
      .catch((err) => console.warn(`Failed to persist cancelled status: ${err}`))
    return { success: true }
  }

  // No active loop — update status directly
  const baseUrl = (store.get('backendUrl') as string) || 'http://localhost:3000'
  const token = await readSecure('axon-access-token')
  try {
    await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Cancelled' }, token, baseUrl)
  } catch (err) {
    return { success: false, error: String(err) }
  }
  return { success: true }
}

export function registerExecutorHandlers() {
  ipcMain.handle('executor:start', (_event, deliveryId: string) => startDelivery(deliveryId))
  ipcMain.handle('executor:resume', (_event, deliveryId: string) => resumeDelivery(deliveryId))
  ipcMain.handle('executor:previewResume', (_event, deliveryId: string) => previewResume(deliveryId))
  ipcMain.handle('executor:cancel', (_event, deliveryId: string) => cancelDelivery(deliveryId))
}
