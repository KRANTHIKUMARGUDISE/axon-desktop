import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { Agent } from 'undici'
import { store } from './settings'
import { readSecure } from './auth'
import { runAgent as runClaudeAgent } from './claude'
import type { AgentOutput, DeliveryContext } from './claude'
import { runAgent as runCodexAgent } from './codex'
import { cloneOrOpen, createDeliveryBranch, getChangedFiles, commitChanges, pushBranch, createPullRequest } from './git'
import type { PRConfig } from './git'

// One secure-storage key per runtime. Add an entry here when wiring up a new runtime.
const CREDENTIAL_KEY_BY_RUNTIME: Record<string, string> = {
  Claude: 'axon-claude-key',
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
  },
): Promise<AgentOutput> {
  const apiKey = credentials[runtime] ?? ''
  switch (runtime) {
    case 'Claude':
      return runClaudeAgent({ ...args, claudeApiKey: apiKey })
    case 'Codex':
      return runCodexAgent({ ...args, codexApiKey: apiKey })
    default:
      throw new Error(`Unsupported agent runtime: ${runtime}`)
  }
}

// Mirrors the exact field-selection logic in claude.ts's runAgent() "Input Fields"
// section, so the captured snapshot reflects exactly what the block actually saw.
function buildContextSnapshot(deliveryContext: DeliveryContext, contextRequirements?: string[]): Record<string, unknown> {
  const contextFields: Record<string, unknown> = {
    ...deliveryContext.previousStepsResults,
    ...deliveryContext.currentInputs,
  }
  if (!contextRequirements || contextRequirements.length === 0) {
    return contextFields
  }
  const selected: Record<string, unknown> = {}
  for (const key of contextRequirements) {
    if (key in contextFields) selected[key] = contextFields[key]
  }
  return selected
}

// DS1 — Large Output Storage Strategy. Anything over `threshold` bytes (serialized)
// gets written to a local workspace file instead of sent inline; the backend only
// ever receives a small marker + the file reference.
const DS1_THRESHOLD_BYTES = 50_000

async function checkAndStoreIfLarge(
  workspacePath: string,
  subfolder: 'inputs' | 'outputs',
  nodeId: string,
  data: Record<string, unknown>,
): Promise<{ value: Record<string, unknown>; isTruncated: boolean; fileRef?: string }> {
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized, 'utf-8') < DS1_THRESHOLD_BYTES) {
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
  cachedFiles?: CachedFile[]
  entryPointPath?: string
  contextRequirements?: string[]
  outputSchema?: string[]
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
  currentNodeId?: string
  pipelineSnapshot?: PipelineSnapshot
  steps: Array<{ nodeId: string; blockName: string }>
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

    let output: AgentOutput
    let contextResult: { value: Record<string, unknown>; isTruncated: boolean; fileRef?: string } | undefined
    try {
      const block = ctx.blocks.get(node.blockId)
      if (!block) {
        throw new Error(`Block ${node.blockId} not found in context`)
      }
      const entryFile = block.cachedFiles?.find((f) => f.relativePath === block.entryPointPath)
      if (!entryFile) {
        throw new Error(`Block ${node.label} has no entry point file matching "${block.entryPointPath}" in its cachedFiles`)
      }

      const deliveryContext: DeliveryContext = {
        ticketId: ctx.delivery.ticketId,
        ticketTitle: ctx.delivery.title,
        previousStepsResults: ctx.flatResults,
        currentInputs: ctx.delivery.inputs ?? {},
      }

      const contextSnapshot = buildContextSnapshot(deliveryContext, block.contextRequirements)
      contextResult = await checkAndStoreIfLarge(ctx.workspacePath, 'inputs', node.id, contextSnapshot)

      output = await runAgentForBlock(block.agentRuntime ?? 'Claude', ctx.credentials, {
        blockId: node.blockId,
        blockName: node.label,
        cachedDefinition: entryFile.content,
        deliveryContext,
        contextRequirements: block.contextRequirements,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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
          output: { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message },
        },
        token,
        baseUrl,
      )
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Failed', nodeId: node.id }, token, baseUrl)
      activeExecutions.delete(ctx.deliveryId)
      return
    }

    const outputResult = await checkAndStoreIfLarge(ctx.workspacePath, 'outputs', node.id, output.result)
    const persistedOutput: AgentOutput = {
      ...output,
      result: outputResult.value,
      isTruncated: outputResult.isTruncated,
      outputFileRef: outputResult.fileRef,
    }

    await apiPost(
      `/api/deliveries/${ctx.deliveryId}/steps`,
      {
        nodeId: node.id,
        blockId: node.blockId,
        blockName: node.label,
        status: output.status === 'failed' ? 'Failed' : output.status === 'needs_human' ? 'AwaitingHuman' : 'Completed',
        contextSnapshot: contextResult?.value,
        isContextTruncated: contextResult?.isTruncated ?? false,
        contextFileRef: contextResult?.fileRef,
        output: persistedOutput,
      },
      token,
      baseUrl,
    ).catch((err) => console.warn(`Failed to persist step result: ${err}`))

    if (output.status === 'failed') {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'step_failed', nodeId: node.id, blockName: node.label, output, message: output.summary })
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Failed', nodeId: node.id }, token, baseUrl)
      activeExecutions.delete(ctx.deliveryId)
      return
    }

    // Store step result for next steps to access
    ctx.stepResults[node.id] = output.result
    ctx.flatResults = { ...ctx.flatResults, ...output.result }

    const isGateNode = ctx.blocks.get(node.blockId)?.role === 'Control'
    if (output.status === 'needs_human' || isGateNode) {
      sendProgress({ deliveryId: ctx.deliveryId, type: 'gate_reached', nodeId: node.id, blockName: node.label, output, message: output.summary })
      await apiPatch(`/api/deliveries/${ctx.deliveryId}/status`, { status: 'Paused', nodeId: node.id }, token, baseUrl)
      // Keep context alive so resume can continue from here
      ctx.delivery.currentNodeId = node.id
      return
    }

    sendProgress({ deliveryId: ctx.deliveryId, type: 'step_completed', nodeId: node.id, blockName: node.label, output })
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
  const credentials: Record<string, string> = {}
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
  }
  activeExecutions.set(deliveryId, ctx)

  // Run async — don't await
  runStepLoop(ctx, startNode.id, nodes, edges, baseUrl, token).catch((err) => {
    sendProgress({ deliveryId, type: 'failed', nodeId: '', message: String(err) })
    activeExecutions.delete(deliveryId)
  })

  return { success: true }
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

  if (delivery.status !== 'Paused') {
    return { success: false, error: `Delivery is ${delivery.status}, not paused` }
  }

  const ctx = activeExecutions.get(deliveryId)
  if (!ctx) return { success: false, error: 'No active execution context — restart delivery' }

  let nodes: PipelineNode[] = delivery.pipelineSnapshot?.nodes ?? ctx.delivery.pipelineSnapshot?.nodes ?? []
  let edges: PipelineEdge[] = delivery.pipelineSnapshot?.edges ?? ctx.delivery.pipelineSnapshot?.edges ?? []

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

  const pausedNodeId = ctx.delivery.currentNodeId
  if (!pausedNodeId) return { success: false, error: 'No paused node id in context' }

  const resumeNode = nextNode(pausedNodeId, nodes, edges)
  if (!resumeNode) {
    // Was the last node — mark complete
    sendProgress({ deliveryId, type: 'completed', nodeId: pausedNodeId })
    await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Completed' }, token, baseUrl)
    activeExecutions.delete(deliveryId)
    return { success: true }
  }

  ctx.isCancelled = false
  await apiPatch(`/api/deliveries/${deliveryId}/status`, { status: 'Running' }, token, baseUrl)

  runStepLoop(ctx, resumeNode.id, nodes, edges, baseUrl, token).catch((err) => {
    sendProgress({ deliveryId, type: 'failed', nodeId: '', message: String(err) })
    activeExecutions.delete(deliveryId)
  })

  return { success: true }
}

async function cancelDelivery(deliveryId: string): Promise<{ success: boolean; error?: string }> {
  const ctx = activeExecutions.get(deliveryId)
  if (ctx) {
    ctx.isCancelled = true
    // The running loop will pick this up and update status
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
  ipcMain.handle('executor:cancel', (_event, deliveryId: string) => cancelDelivery(deliveryId))
}
