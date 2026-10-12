import type { Block, Delivery, DeliveryStep, AgentOutput, ActionResult, ResumePreview, DeliveryStatus } from '../../shared'
import {
  LOCAL_USER, DS1_DEFAULT_THRESHOLD_BYTES, findStartNode, nextNode, resolvePipelineProgress,
  validatePipelineGraph,
} from '../../shared'
import type { PipelineNode } from '../../shared'
import type { Store } from '../store/types'
import { applyStep } from '../store/types'
import type { Runner } from '../runners/types'
import type { EventBus, EventInput } from './bus'
import {
  buildContextSnapshot, computeAvailability, computeContextAvailability, resolveEffectiveTools, isGateBlock,
} from './context'
import type { DeliveryContext } from './context'
import { storeIfLarge, readStored } from './runs'
import { log } from '../log'

// Workspace + git side effects, injected so the engine stays a pure state machine.
export interface WorkspacePort {
  /** Resolve/clone the workspace and create the delivery branch. Throws on failure. */
  prepare(delivery: Delivery): Promise<{ workspacePath: string; branch?: string }>
  /** End-of-pipeline tail (commit, push, PR). Throws on failure — the engine fails the delivery. */
  finalize(args: { delivery: Delivery; workspacePath: string; branch: string; stepCount: number }): Promise<{ prUrl?: string }>
}

export interface EngineDeps {
  store: Store
  runner: Runner
  workspace: WorkspacePort
  bus: EventBus
  /** {userData}/runs — DS1 large-payload files live under here, never in the worktree. */
  runsDir: string
  now?: () => Date
  ds1ThresholdBytes?: () => number
  identity?: string
}

interface ActiveRun {
  abort: AbortController
  stopped: 'cancel' | 'shutdown' | null
  done: Promise<void>
}

const TERMINAL: DeliveryStatus[] = ['Completed', 'Failed', 'Cancelled']

export interface Engine {
  start(deliveryId: string): Promise<ActionResult>
  resume(deliveryId: string): Promise<ActionResult>
  cancel(deliveryId: string): Promise<ActionResult>
  approveGate(deliveryId: string, comment?: string): Promise<ActionResult>
  rejectGate(deliveryId: string, comment: string): Promise<ActionResult>
  previewResume(deliveryId: string): Promise<ActionResult & { preview?: ResumePreview }>
  reconcileOnBoot(): Promise<number>
  shutdown(): Promise<void>
  /** Resolves when the delivery's run loop (if any) has fully unwound. */
  whenIdle(deliveryId: string): Promise<void>
  isActive(deliveryId: string): boolean
}

export function createEngine(deps: EngineDeps): Engine {
  const { store, runner, workspace, bus, runsDir } = deps
  const now = deps.now ?? (() => new Date())
  const threshold = deps.ds1ThresholdBytes ?? (() => DS1_DEFAULT_THRESHOLD_BYTES)
  const identity = deps.identity ?? LOCAL_USER

  const active = new Map<string, ActiveRun>()
  // Claimed synchronously before any await — blocks double start/resume/approve.
  const busy = new Set<string>()

  const iso = () => now().toISOString()
  const emit = (deliveryId: string, event: EventInput) =>
    bus.emit({ ...event, deliveryId, at: iso() } as Parameters<EventBus['emit']>[0])

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

  // ------------------------------------------------------------------ persistence helpers

  // Every loop write goes through here: once a run has been cancelled/shut down, its
  // remaining in-flight writes become no-ops so they can't overwrite Cancelled/Interrupted.
  function guarded(id: string, run: ActiveRun | null, mutate: (d: Delivery) => void): Promise<Delivery> {
    return store.updateDelivery(id, (d) => {
      if (run?.stopped) return
      mutate(d)
    })
  }

  async function setStatus(id: string, run: ActiveRun | null, status: DeliveryStatus, patch: (d: Delivery) => void = () => {}) {
    await guarded(id, run, (d) => {
      d.status = status
      patch(d)
    })
    if (!run?.stopped) emit(id, { type: 'status_changed', status })
  }

  async function failDelivery(id: string, run: ActiveRun | null, message: string, nodeId?: string) {
    if (run?.stopped) return
    await setStatus(id, run, 'Failed', (d) => {
      d.errorMessage = message
      d.completedAt = iso()
      if (nodeId) d.currentNodeId = nodeId
    })
    emit(id, { type: 'failed', message, nodeId })
  }

  async function loadBlocks(nodes: PipelineNode[]): Promise<{ blocks: Map<string, Block>; missing: string[] }> {
    const blocks = new Map<string, Block>()
    const missing: string[] = []
    for (const blockId of new Set(nodes.map((n) => n.blockId))) {
      const block = await store.getBlock(blockId)
      if (block) blocks.set(blockId, block)
      else missing.push(blockId)
    }
    return { blocks, missing }
  }

  // Rebuilds the cross-step result pool from persisted steps, reloading DS1 files when a
  // step's stored result is only a truncated marker.
  async function reconstructResults(d: Delivery): Promise<{ stepResults: Record<string, unknown>; flatResults: Record<string, unknown> }> {
    const stepResults: Record<string, unknown> = {}
    let flatResults: Record<string, unknown> = {}
    for (const step of d.steps) {
      if (step.status !== 'Completed' || !step.output) continue
      let result: Record<string, unknown> = step.output.result
      if (step.output.isTruncated && step.output.outputFileRef) {
        result = await readStored(runsDir, d.id, step.output.outputFileRef)
      }
      stepResults[step.nodeId] = result
      flatResults = { ...flatResults, ...result }
    }
    return { stepResults, flatResults }
  }

  // ------------------------------------------------------------------ run loop

  async function runLoop(id: string, run: ActiveRun, startNodeId: string): Promise<void> {
    const d0 = await store.getDelivery(id)
    if (!d0) throw new Error(`Delivery ${id} not found`)
    const { nodes, edges } = d0.pipelineSnapshot
    const { blocks, missing } = await loadBlocks(nodes)
    if (missing.length) {
      await failDelivery(id, run, `Missing blocks: ${missing.join(', ')}`)
      return
    }
    const workspacePath = d0.workspacePath
    if (!workspacePath) {
      await failDelivery(id, run, 'Delivery has no workspace path')
      return
    }

    let { stepResults, flatResults } = await reconstructResults(d0)
    let node: PipelineNode | undefined = nodes.find((n) => n.id === startNodeId)

    while (node) {
      if (run.stopped) return
      const current: PipelineNode = node
      const label = current.label ?? current.name ?? current.id
      const stepBase = { nodeId: current.id, itemKey: null, blockId: current.blockId, blockName: label }

      emit(id, { type: 'step_started', nodeId: current.id, blockName: label })
      await guarded(id, run, (d) => {
        applyStep(d, { ...stepBase, status: 'Running', startedAt: iso() })
        d.currentNodeId = current.id
      })
      const startedAt = iso()

      let output: AgentOutput
      let contextResult: Awaited<ReturnType<typeof storeIfLarge>> | undefined
      let contextAvailability: ReturnType<typeof computeContextAvailability> | undefined
      const block = blocks.get(current.blockId)

      try {
        if (!block) throw new Error(`Block ${current.blockId} not found`)
        let instructions = ''
        if (block.agentRuntime !== 'Axon') {
          const entry = block.cachedFiles?.find((f) => f.relativePath === block.entryPointPath)
          if (!entry) throw new Error(`Block ${label} has no entry point file matching "${block.entryPointPath}" in its cachedFiles`)
          instructions = entry.content
        }

        const deliveryContext: DeliveryContext = {
          ticketId: d0.ticketId,
          ticketTitle: d0.title,
          previousStepsResults: flatResults,
          currentInputs: d0.inputs ?? {},
        }
        contextAvailability = computeContextAvailability(deliveryContext, block.contextRequirements)
        if (d0.storeFullContext) {
          contextResult = await storeIfLarge({
            runsDir, deliveryId: id, subfolder: 'inputs', nodeId: current.id,
            data: buildContextSnapshot(deliveryContext), thresholdBytes: threshold(), now,
          })
        }

        output = await runner({
          block,
          nodeLabel: label,
          instructions,
          deliveryContext,
          workspacePath,
          effectiveTools: resolveEffectiveTools(block),
          timeoutSeconds: current.timeoutSeconds ?? block.defaultTimeoutSeconds ?? 120,
          signal: run.abort.signal,
        })
      } catch (err) {
        if (run.stopped) return
        const message = errMsg(err)
        const failedOutput = { status: 'failed' as const, confidence: 0, summary: message, result: {}, errorMessage: message }
        await guarded(id, run, (d) => {
          applyStep(d, {
            ...stepBase, status: 'Failed', startedAt, completedAt: iso(),
            contextSnapshot: contextResult?.value, isContextTruncated: contextResult?.isTruncated ?? false,
            contextFileRef: contextResult?.fileRef, contextAvailability, output: failedOutput,
          })
        })
        emit(id, { type: 'step_failed', nodeId: current.id, blockName: label, message })
        await failDelivery(id, run, message, current.id)
        return
      }

      // A cancel can surface as a normal `failed` AgentOutput (aborted SDK call) — never
      // persist that over the Cancelled status.
      if (run.stopped) return

      let outputResult: Awaited<ReturnType<typeof storeIfLarge>>
      try {
        outputResult = await storeIfLarge({
          runsDir, deliveryId: id, subfolder: 'outputs', nodeId: current.id,
          data: output.result, thresholdBytes: threshold(), now,
        })
      } catch (err) {
        const message = `Failed to store step output for "${label}": ${errMsg(err)}`
        await guarded(id, run, (d) => {
          applyStep(d, {
            ...stepBase, status: 'Failed', startedAt, completedAt: iso(),
            output: { status: 'failed', confidence: 0, summary: message, result: {}, errorMessage: message },
          })
        })
        emit(id, { type: 'step_failed', nodeId: current.id, blockName: label, message })
        await failDelivery(id, run, message, current.id)
        return
      }

      const isGate = isGateBlock(block)
      const status: DeliveryStep['status'] = isGate ? 'AwaitingApproval' : output.status === 'failed' ? 'Failed' : 'Completed'
      const persisted: DeliveryStep = {
        ...stepBase,
        status,
        startedAt,
        completedAt: isGate ? undefined : iso(),
        contextSnapshot: contextResult?.value,
        isContextTruncated: contextResult?.isTruncated ?? false,
        contextFileRef: contextResult?.fileRef,
        contextAvailability,
        outputAvailability: computeAvailability(output.result, block?.outputSchema),
        output: {
          ...output,
          summary: output.summary ?? '',
          result: outputResult.value,
          isTruncated: outputResult.isTruncated,
          outputFileRef: outputResult.fileRef,
          ...(isGate ? { humanGateReason: output.summary } : {}),
        },
      }
      await guarded(id, run, (d) => applyStep(d, persisted))

      if (output.status === 'failed') {
        const message = output.errorMessage ?? output.summary
        emit(id, { type: 'step_failed', nodeId: current.id, blockName: label, message, output })
        await failDelivery(id, run, message, current.id)
        return
      }

      stepResults[current.id] = output.result
      flatResults = { ...flatResults, ...output.result }

      if (isGate) {
        await setStatus(id, run, 'Paused', (d) => { d.currentNodeId = current.id })
        emit(id, { type: 'gate_reached', nodeId: current.id, blockName: label, output })
        return
      }

      emit(id, { type: 'step_completed', nodeId: current.id, blockName: label, output })
      await guarded(id, run, (d) => { d.currentNodeId = current.id })
      node = nextNode(current.id, nodes, edges)
    }

    if (run.stopped) return

    // End-of-pipeline git tail (removed in S4). Failure must be visible, never "Completed".
    let prUrl: string | undefined
    const dEnd = await store.getDelivery(id)
    if (dEnd?.branch) {
      try {
        const res = await workspace.finalize({
          delivery: dEnd, workspacePath, branch: dEnd.branch, stepCount: Object.keys(stepResults).length,
        })
        prUrl = res.prUrl
      } catch (err) {
        await failDelivery(id, run, `Git/PR step failed: ${errMsg(err)}`)
        return
      }
    }
    await setStatus(id, run, 'Completed', (d) => {
      d.completedAt = iso()
      d.errorMessage = undefined
      if (prUrl) d.prUrl = prUrl
    })
    if (!run.stopped) emit(id, { type: 'completed', prUrl })
  }

  function launch(id: string, startNodeId: string): void {
    const run = { abort: new AbortController(), stopped: null } as ActiveRun
    active.set(id, run)
    run.done = runLoop(id, run, startNodeId)
      .catch(async (err) => {
        await failDelivery(id, run, errMsg(err)).catch((e) => log.warn('[engine] failDelivery failed', e))
      })
      .finally(() => {
        active.delete(id)
        busy.delete(id)
      })
  }

  // Claims the delivery for the duration of fn; the claim is kept only if fn launched a loop
  // (the loop releases it when it unwinds).
  async function withClaim(id: string, fn: () => Promise<ActionResult>): Promise<ActionResult> {
    if (busy.has(id)) return { success: false, error: 'Delivery is already running or resuming' }
    busy.add(id)
    try {
      return await fn()
    } catch (err) {
      return { success: false, error: errMsg(err) }
    } finally {
      if (!active.has(id)) busy.delete(id)
    }
  }

  // ------------------------------------------------------------------ public operations

  function start(id: string): Promise<ActionResult> {
    return withClaim(id, async () => {
      const d = await store.getDelivery(id)
      if (!d) return { success: false, error: 'Delivery not found' }
      if (d.status !== 'Pending') return { success: false, error: `Delivery is ${d.status}, cannot start` }

      const { nodes, edges } = d.pipelineSnapshot
      const { blocks, missing } = await loadBlocks(nodes)
      const validation = validatePipelineGraph(nodes, edges, blocks)
      if (!validation.valid || missing.length) {
        return { success: false, error: `Invalid pipeline: ${[...validation.errors].join('; ')}` }
      }
      const startNode = findStartNode(nodes, edges)
      if (!startNode) return { success: false, error: 'No start node found in pipeline' }

      emit(id, { type: 'workspace_provisioning' })
      emit(id, { type: 'git_preparing', repoUrl: d.repoUrl })
      let prepared: { workspacePath: string; branch?: string }
      try {
        prepared = await workspace.prepare(d)
      } catch (err) {
        // Delivery stays Pending so the user can fix the cause and start again.
        return { success: false, error: `Workspace setup failed: ${errMsg(err)}` }
      }

      await store.updateDelivery(id, (x) => {
        x.status = 'Running'
        x.workspacePath = prepared.workspacePath
        x.branch = prepared.branch ?? null
        x.startedAt = iso()
        x.errorMessage = undefined
      })
      emit(id, { type: 'status_changed', status: 'Running' })
      emit(id, { type: 'workspace_provisioned', workspacePath: prepared.workspacePath })
      emit(id, { type: 'git_prepared', branch: prepared.branch })

      launch(id, startNode.id)
      return { success: true }
    })
  }

  async function resumeClaimed(id: string): Promise<ActionResult> {
    const d = await store.getDelivery(id)
    if (!d) return { success: false, error: 'Delivery not found' }
    if (d.status !== 'Paused' && d.status !== 'Cancelled' && d.status !== 'Interrupted') {
      return { success: false, error: `Delivery is ${d.status}, cannot resume` }
    }
    if (!d.workspacePath) {
      return { success: false, error: 'No workspace path recorded for this delivery — cannot resume without restarting it' }
    }

    const { nodes, edges } = d.pipelineSnapshot
    const { resumeNode } = resolvePipelineProgress(nodes, edges, d.steps)
    if (!resumeNode) {
      await store.updateDelivery(id, (x) => { x.status = 'Completed'; x.completedAt = iso() })
      emit(id, { type: 'status_changed', status: 'Completed' })
      emit(id, { type: 'completed' })
      return { success: true }
    }

    // Validate resumability up front (fail before flipping to Running).
    await reconstructResults(d)

    await store.updateDelivery(id, (x) => { x.status = 'Running'; x.errorMessage = undefined; x.completedAt = undefined })
    emit(id, { type: 'status_changed', status: 'Running' })
    launch(id, resumeNode.id)
    return { success: true }
  }

  function resume(id: string): Promise<ActionResult> {
    return withClaim(id, () => resumeClaimed(id))
  }

  function findAwaitingGate(d: Delivery): DeliveryStep | undefined {
    return d.steps.find((s) => s.nodeId === d.currentNodeId && s.status === 'AwaitingApproval')
  }

  function approveGate(id: string, comment?: string): Promise<ActionResult> {
    return withClaim(id, async () => {
      const d = await store.getDelivery(id)
      if (!d) return { success: false, error: 'Delivery not found' }
      const gate = findAwaitingGate(d)
      if (d.status !== 'Paused' || !gate) return { success: false, error: 'Delivery is not awaiting approval' }

      const trimmed = comment?.trim() || undefined
      await store.updateDelivery(id, (x) => {
        const step = findAwaitingGate(x)
        if (!step || !step.output) return
        step.status = 'Completed'
        step.completedAt = iso()
        step.output = { ...step.output, approvedBy: identity, approvedAt: iso(), reviewComment: trimmed }
      })
      emit(id, { type: 'gate_approved', nodeId: gate.nodeId, approvedBy: identity, comment: trimmed })
      return resumeClaimed(id)
    })
  }

  function rejectGate(id: string, comment: string): Promise<ActionResult> {
    return withClaim(id, async () => {
      const trimmed = comment?.trim()
      if (!trimmed) return { success: false, error: 'A comment is required to reject a gate' }
      const d = await store.getDelivery(id)
      if (!d) return { success: false, error: 'Delivery not found' }
      const gate = findAwaitingGate(d)
      if (d.status !== 'Paused' || !gate) return { success: false, error: 'Delivery is not awaiting approval' }

      const message = `Rejected at "${gate.blockName}": ${trimmed}`
      await store.updateDelivery(id, (x) => {
        const step = findAwaitingGate(x)
        if (step?.output) {
          step.status = 'Failed'
          step.completedAt = iso()
          step.output = { ...step.output, rejectedBy: identity, rejectedAt: iso(), reviewComment: trimmed }
        }
        x.status = 'Failed'
        x.errorMessage = message
        x.completedAt = iso()
      })
      emit(id, { type: 'gate_rejected', nodeId: gate.nodeId, rejectedBy: identity, comment: trimmed })
      emit(id, { type: 'status_changed', status: 'Failed' })
      emit(id, { type: 'failed', message, nodeId: gate.nodeId })
      return { success: true }
    })
  }

  async function cancel(id: string): Promise<ActionResult> {
    const run = active.get(id)
    if (run) {
      run.stopped = 'cancel'
      // Interrupts whatever is in flight right now (SDK call / fetch), not just between steps.
      run.abort.abort()
    }
    try {
      let rejected = false
      await store.updateDelivery(id, (d) => {
        if (TERMINAL.includes(d.status) && d.status !== 'Cancelled') {
          rejected = true
          return
        }
        markRunningSteps(d, 'Cancelled by user')
        d.status = 'Cancelled'
      })
      if (rejected) return { success: false, error: 'Delivery already finished' }
    } catch (err) {
      return { success: false, error: errMsg(err) }
    }
    emit(id, { type: 'status_changed', status: 'Cancelled' })
    emit(id, { type: 'cancelled' })
    return { success: true }
  }

  function markRunningSteps(d: Delivery, reason: string) {
    for (const s of d.steps) {
      if (s.status !== 'Running') continue
      s.status = 'Failed'
      s.completedAt = iso()
      s.output = { status: 'failed', confidence: 0, summary: reason, result: {}, errorMessage: reason }
    }
  }

  async function previewResume(id: string): Promise<ActionResult & { preview?: ResumePreview }> {
    const d = await store.getDelivery(id)
    if (!d) return { success: false, error: 'Delivery not found' }
    const { nodes, edges } = d.pipelineSnapshot
    const { lastCompletedNode, resumeNode } = resolvePipelineProgress(nodes, edges, d.steps)
    let keys: string[]
    try {
      keys = Object.keys((await reconstructResults(d)).flatResults)
    } catch (err) {
      return { success: false, error: `Cannot reconstruct context: ${errMsg(err)}` }
    }
    const base = {
      lastCompletedNodeLabel: lastCompletedNode?.label,
      reconstructedContextKeys: keys,
      workspacePath: d.workspacePath ?? undefined,
      branch: d.branch ?? undefined,
    }
    if (!resumeNode) {
      return {
        success: true,
        preview: { ...base, resumeNodeId: '', resumeNodeLabel: '', hasPriorAttempt: false, allNodesCompleted: true },
      }
    }
    const block = await store.getBlock(resumeNode.blockId)
    return {
      success: true,
      preview: {
        ...base,
        resumeNodeId: resumeNode.id,
        resumeNodeLabel: resumeNode.label ?? resumeNode.id,
        resumeNodeRole: block?.role,
        hasPriorAttempt: d.steps.some((s) => s.nodeId === resumeNode.id),
        allNodesCompleted: false,
      },
    }
  }

  async function reconcileOnBoot(): Promise<number> {
    let count = 0
    for (const d of await store.listDeliveries()) {
      if (d.status !== 'Running' || active.has(d.id)) continue
      await store.updateDelivery(d.id, (x) => {
        markRunningSteps(x, 'Interrupted (AXON stopped while this step was running)')
        x.status = 'Interrupted'
      })
      emit(d.id, { type: 'status_changed', status: 'Interrupted' })
      emit(d.id, { type: 'interrupted' })
      count++
    }
    return count
  }

  async function shutdown(): Promise<void> {
    const runs = [...active.entries()]
    for (const [, run] of runs) {
      run.stopped = 'shutdown'
      run.abort.abort()
    }
    await Promise.all(
      runs.map(([id]) =>
        store.updateDelivery(id, (d) => {
          if (d.status !== 'Running') return
          markRunningSteps(d, 'Interrupted (AXON was closed while this step was running)')
          d.status = 'Interrupted'
        }).catch((err) => log.warn(`[engine] shutdown persist failed for ${id}`, err)),
      ),
    )
    await Promise.race([
      Promise.allSettled(runs.map(([, run]) => run.done)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
  }

  return {
    start, resume, cancel, approveGate, rejectGate, previewResume, reconcileOnBoot, shutdown,
    whenIdle: (id) => active.get(id)?.done ?? Promise.resolve(),
    isActive: (id) => active.has(id),
  }
}
