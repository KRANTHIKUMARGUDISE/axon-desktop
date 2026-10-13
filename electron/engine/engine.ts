import type { Block, Delivery, DeliveryStep, AgentOutput, ActionResult, ResumePreview, DeliveryStatus } from '../../shared'
import {
  LOCAL_USER, DS1_DEFAULT_THRESHOLD_BYTES, findStartNode, nextNode, resolvePipelineProgress, forEachBody,
  validatePipeline, outputFieldNames, contextKey, isOptionalContext, parseWorkItemList, validateWorkItemList, workItemListFields, forEachPredecessors, capSummary, buildRepoCatalogText, isStoppedStep,
} from '../../shared'
import type { PipelineNode, WorkItemEntry, AgentCatalogRepo } from '../../shared'
import type { Store } from '../store/types'
import { applyStep } from '../store/types'
import type { Runner } from '../runners/types'
import type { EventBus, EventInput } from './bus'
import {
  buildContextSnapshot, computeAvailability, computeContextAvailability, resolveEffectiveTools, isGateBlock,
} from './context'
import type { DeliveryContext } from './context'
import { storeIfLarge, readStored } from './runs'
import { validateAgentResult } from '../runners/output'
import type { SnapshotService } from '../workspace/snapshots'
import { log } from '../log'

// Where nodes run (D17/D18). Repos are NOT cloned here: that is the workspace-provisioner block's job,
// and PRs belong to the pr-creator block.
export interface WorkspacePort {
  /** Create the Delivery Folder; claim + branch the optional default Workspace path. Throws a user-facing error. */
  prepare(delivery: Delivery): Promise<{
    deliveryFolder: string
    workspacePath?: string
    base?: { originalBranch: string; branch: string }
  }>
  /** cwd for a node: item workspacePath -> delivery Workspace path -> Delivery Folder (validated, locked). */
  resolveCwd(delivery: Delivery, itemWorkspacePath?: string): Promise<string>
  /**
   * Restore the original branch and release locks (Completed / Failed / Cancelled). Leftover changes that block the
   * restore are stashed; a notice is returned whenever the user needs to know something about their folder.
   */
  release(delivery: Delivery): Promise<{ notice?: NonNullable<Delivery['workspaceNotice']> } | void>
  /** Re-claim the default Workspace path and its delivery branch when a delivery resumes. */
  reacquire(delivery: Delivery): Promise<void>
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
  /** Who approves/rejects gates: the verified email (a getter so it follows onboarding changes). */
  identity?: string | (() => string)
  /** Agent standard rule 9: per-step workspace snapshots (restored on retry/resume). Optional. */
  snapshots?: SnapshotService
  /** Source of the opt-in `repoCatalog` context field (entries + the registry commit they came from). */
  getRepoCatalog?: () => Promise<{ entries: AgentCatalogRepo[]; version?: string }>
}

interface ActiveRun {
  abort: AbortController
  stopped: 'cancel' | 'shutdown' | null
  done: Promise<void>
}

const TERMINAL: DeliveryStatus[] = ['Completed', 'Failed', 'Cancelled', 'Superseded']

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
  /** Delete the delivery's snapshot refs (user discarded it). */
  discardSnapshots(deliveryId: string): Promise<void>
  /** Delete snapshot refs of Failed (and Superseded) deliveries that ended more than `days` ago (default 14). Returns how many were cleaned. */
  cleanupFailedSnapshots(days?: number): Promise<number>
}

type Pools = { stepResults: Record<string, unknown>; flatResults: Record<string, unknown> }
type StoredOutput = Awaited<ReturnType<typeof storeIfLarge>>

// Everything one run loop needs; built once per (re)start.
interface RunCtx {
  id: string
  run: ActiveRun
  d0: Delivery
  nodes: PipelineNode[]
  edges: Delivery['pipelineSnapshot']['edges']
  blocks: Map<string, Block>
  deliveryFolder: string
}

type NodeOutcome =
  | { kind: 'ok'; output: AgentOutput; isGate: boolean }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }

export function createEngine(deps: EngineDeps): Engine {
  const { store, runner, workspace, bus, runsDir } = deps
  const now = deps.now ?? (() => new Date())
  const threshold = deps.ds1ThresholdBytes ?? (() => DS1_DEFAULT_THRESHOLD_BYTES)
  const actor = (): string => (typeof deps.identity === 'function' ? deps.identity() : deps.identity) || LOCAL_USER

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

  // Deletes refs/axon/<id>/… in every repo the delivery's steps ran in. Done when a delivery Completes, is
  // cancelled or discarded, and for old Failed deliveries; a Failed one keeps them so a retry can restore the pre-step state.
  async function dropSnapshotRefs(d: Delivery | null | undefined): Promise<void> {
    if (!d || !deps.snapshots) return
    const cwds = [...new Set(d.steps.map((x) => x.cwd).filter((c): c is string => !!c))]
    await deps.snapshots.dropAll(d.id, cwds).catch((e) => log.warn('[engine] snapshot cleanup failed', e))
  }

  // Restores the original branch in the default Workspace path and frees every folder lock (end of a delivery).
  async function releaseWorkspace(id: string, opts: { dropRefs?: boolean } = {}): Promise<void> {
    try {
      const d = await store.getDelivery(id)
      if (opts.dropRefs) await dropSnapshotRefs(d)
      const res = d ? await workspace.release(d) : undefined
      if (res && res.notice) {
        const notice = res.notice
        await store.updateDelivery(id, (x) => { x.workspaceNotice = notice })
        emit(id, { type: 'workspace_notice', message: notice.message })
      }
    } catch (err) {
      log.warn(`[engine] workspace release failed for ${id}`, err)
    }
  }

  async function failDelivery(id: string, run: ActiveRun | null, message: string, nodeId?: string) {
    if (run?.stopped) return
    await setStatus(id, run, 'Failed', (d) => {
      d.errorMessage = message
      d.completedAt = iso()
      if (nodeId) d.currentNodeId = nodeId
    })
    emit(id, { type: 'failed', message, nodeId })
    await releaseWorkspace(id)
  }

  // Runs the block version the delivery was created against (D13) so reruns/resumes never drift; falls
  // back to the current block only when that version predates version files (legacy local data).
  async function loadBlocks(nodes: PipelineNode[], pins: Record<string, number> = {}): Promise<{ blocks: Map<string, Block>; missing: string[] }> {
    const blocks = new Map<string, Block>()
    const missing: string[] = []
    for (const blockId of new Set(nodes.filter((n) => n.type !== 'forEach').map((n) => n.blockId))) {
      const pinned = pins[blockId]
      const block = (pinned !== undefined ? await store.getBlockVersion(blockId, pinned) : null) ?? (await store.getBlock(blockId))
      if (block) blocks.set(blockId, block)
      else missing.push(blockId)
    }
    return { blocks, missing }
  }

  async function loadResult(d: Delivery, step: DeliveryStep): Promise<Record<string, unknown>> {
    if (!step.output) return {}
    if (step.output.isTruncated && step.output.outputFileRef) return readStored(runsDir, d.id, step.output.outputFileRef)
    return step.output.result
  }

  // Rebuilds the cross-step result pool from persisted steps, reloading DS1 files when a
  // step's stored result is only a truncated marker. Per-item (ForEach) steps are NOT part of the
  // flat pool — they are rebuilt per item; the ForEach's own step contributes `itemResults`.
  async function reconstructResults(d: Delivery): Promise<Pools> {
    const stepResults: Record<string, unknown> = {}
    let flatResults: Record<string, unknown> = {}
    for (const step of d.steps) {
      if (step.status !== 'Completed' || !step.output || step.itemKey) continue
      const result = await loadResult(d, step)
      stepResults[step.nodeId] = result
      flatResults = { ...flatResults, ...result }
    }
    return { stepResults, flatResults }
  }

  // ------------------------------------------------------------------ one node

  // Runs one block node: persists the Running/final step (keyed by nodeId + itemKey), calls the runner,
  // applies DS1 storage. It never fails the delivery itself — the caller decides what a failure means.
  async function execNode(
    rc: RunCtx,
    node: PipelineNode,
    o: { itemKey: string | null; cwd: () => Promise<string>; pool: Record<string, unknown>; extraInputs?: Record<string, unknown> },
  ): Promise<NodeOutcome> {
    const { id, run, d0 } = rc
    const label = node.label ?? node.name ?? node.id
    const stepBase = { nodeId: node.id, itemKey: o.itemKey, blockId: node.blockId, blockName: label }
    const itemKeyEv = o.itemKey ? { itemKey: o.itemKey } : {}
    // The resolved working folder is recorded on the step as soon as it is known.
    let stepCwd: string | undefined
    const cwdField = () => (stepCwd ? { cwd: stepCwd } : {})

    emit(id, { type: 'step_started', nodeId: node.id, blockName: label, ...itemKeyEv })
    await guarded(id, run, (d) => {
      applyStep(d, { ...stepBase, status: 'Running', startedAt: iso() })
      d.currentNodeId = node.id
    })
    const startedAt = iso()

    let output: AgentOutput
    let contextResult: StoredOutput | undefined
    let contextAvailability: ReturnType<typeof computeContextAvailability> | undefined
    let catalogStats: DeliveryStep['catalogStats']
    const block = rc.blocks.get(node.blockId)

    // Rule 9: the step's repo is snapshotted before an agent runs. A failed attempt is left in the folder (for debugging)
    // with its snapshot ref kept; a retry/resume of the step restores the pre-step state before running again.
    const snapKey = o.itemKey ? `${node.id}@${o.itemKey}` : node.id

    const fail = async (message: string, extra: Partial<DeliveryStep> = {}): Promise<NodeOutcome> => {
      if (run.stopped) return { kind: 'stopped' }
      await guarded(id, run, (d) => {
        applyStep(d, {
          ...stepBase, ...cwdField(), status: 'Failed', startedAt, completedAt: iso(), ...extra,
          output: { status: 'failed', summary: message, result: {}, errorMessage: message },
        })
      })
      emit(id, { type: 'step_failed', nodeId: node.id, blockName: label, message, ...itemKeyEv })
      return { kind: 'failed', message }
    }

    try {
      if (!block) throw new Error(`Block ${node.blockId} not found`)
      if (block.executionType === 'Agentic' && !(block.contextRequirements && block.contextRequirements.length)) {
        throw new Error(`Agentic block "${label}" must declare contextRequirements`)
      }
      let instructions = ''
      if (block.agentRuntime !== 'Axon') {
        const entry = block.cachedFiles?.find((f) => f.relativePath === block.entryPointPath)
        if (!entry) throw new Error(`Block ${label} has no entry point file matching "${block.entryPointPath}" in its cachedFiles`)
        instructions = entry.content
      }

      // Where the step runs is resolved (and recorded on the step) first: PR Creator needs it, and path errors fail the step.
      const cwd = await o.cwd()
      stepCwd = cwd
      await guarded(id, run, (d) => applyStep(d, { ...stepBase, cwd, status: 'Running', startedAt }))
      if (deps.snapshots && block.agentRuntime !== 'Axon' && !isGateBlock(block)) {
        await deps.snapshots.ensure(cwd, id, snapKey)
      }

      const extra: Record<string, unknown> = { ...(o.extraInputs ?? {}) }
      // PR Creator works out its repositories from where this delivery steps actually ran (recorded cwds), never from agent output.
      if (block.artifactName === 'pr-creator') {
        const fresh = (await store.getDelivery(id)) as Delivery
        extra.stepCwds = [...new Set(fresh.steps.map((x) => x.cwd).filter((c): c is string => !!c && c !== rc.deliveryFolder))]
      }

      // repoCatalog is AXON-provided and strictly opt-in: only a block that declares it gets it (compact lines, no URLs).
      if ((block.contextRequirements ?? []).map(contextKey).includes('repoCatalog') && deps.getRepoCatalog) {
        const cat = await deps.getRepoCatalog()
        const built = buildRepoCatalogText(cat.entries, block.catalogTags)
        extra.repoCatalog = built.text
        catalogStats = { repos: built.repos, approxTokens: built.approxTokens }
        if (cat.version) await guarded(id, run, (d) => { d.catalogVersion = cat.version })
      }

      // A block receives only what it declares (Selective, the default) — native blocks too; Full is an explicit opt-in.
      // The recorded snapshot and the availability chips describe exactly this view, not the whole pool.
      const inputs = { ...(d0.inputs ?? {}), ...(d0.repositories?.length ? { repositories: d0.repositories } : {}), ...extra }
      const visible = (src: Record<string, unknown>): Record<string, unknown> =>
        block.contextMode === 'Full' ? src : Object.fromEntries((block.contextRequirements ?? []).map(contextKey).filter((k) => k in src).map((k) => [k, src[k]]))
      const deliveryContext: DeliveryContext = {
        ticketId: d0.ticketId,
        ticketTitle: d0.title,
        previousStepsResults: visible(o.pool),
        currentInputs: visible(inputs),
      }
      contextAvailability = computeContextAvailability(deliveryContext, (block.contextRequirements ?? []).filter((r) => !isOptionalContext(r)))
      if (d0.storeFullContext) {
        contextResult = await storeIfLarge({
          runsDir, deliveryId: id, subfolder: 'inputs', nodeId: o.itemKey ? `${node.id}-${o.itemKey}` : node.id,
          data: buildContextSnapshot(deliveryContext), thresholdBytes: threshold(), now,
        })
      }

      output = await runner({
        deliveryId: id,
        pipelineName: d0.pipelineSnapshot.name,
        block,
        nodeLabel: label,
        instructions,
        deliveryContext,
        workspacePath: cwd,
        effectiveTools: resolveEffectiveTools(block),
        timeoutSeconds: node.timeoutSeconds ?? block.defaultTimeoutSeconds ?? 120,
        signal: run.abort.signal,
      })
      // Rules 2-3: every declared outputSchema field must be present (and of its declared type), whichever runner produced it.
      if (!isGateBlock(block)) output = validateAgentResult(output, block.outputSchema)
    } catch (err) {
      if (run.stopped) return { kind: 'stopped' }
      return fail(errMsg(err), {
        contextSnapshot: contextResult?.value, isContextTruncated: contextResult?.isTruncated ?? false,
        contextFileRef: contextResult?.fileRef, contextAvailability,
      })
    }

    // A cancel can surface as a normal `failed` AgentOutput (aborted SDK call) — never
    // persist that over the Cancelled status.
    if (run.stopped) return { kind: 'stopped' }

    let outputResult: StoredOutput
    try {
      outputResult = await storeIfLarge({
        runsDir, deliveryId: id, subfolder: 'outputs', nodeId: o.itemKey ? `${node.id}-${o.itemKey}` : node.id,
        data: output.result, thresholdBytes: threshold(), now,
      })
    } catch (err) {
      return fail(`Failed to store step output for "${label}": ${errMsg(err)}`)
    }

    const isGate = isGateBlock(block)
    const status: DeliveryStep['status'] = isGate ? 'AwaitingApproval' : output.status === 'failed' ? 'Failed' : 'Completed'
    const persisted: DeliveryStep = {
      ...stepBase,
      ...cwdField(),
      status,
      startedAt,
      completedAt: isGate ? undefined : iso(),
      contextSnapshot: contextResult?.value,
      isContextTruncated: contextResult?.isTruncated ?? false,
      contextFileRef: contextResult?.fileRef,
      contextAvailability,
      catalogStats,
      outputAvailability: computeAvailability(output.result, outputFieldNames(block?.outputSchema)),
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
      emit(id, { type: 'step_failed', nodeId: node.id, blockName: label, message, output, ...itemKeyEv })
      return { kind: 'failed', message }
    }
    return { kind: 'ok', output, isGate }
  }

  // Side effects of the explicit native blocks on the delivery document.
  async function applyNativeEffects(rc: RunCtx, block: Block | undefined, output: AgentOutput): Promise<void> {
    const r = output.result
    if (block?.artifactName === 'pr-creator' && Array.isArray(r.prUrls)) {
      const prUrls = r.prUrls as { repo: string; url: string }[]
      await guarded(rc.id, rc.run, (d) => {
        d.prUrls = prUrls
        d.prUrl = prUrls[0]?.url ?? d.prUrl
      })
    }
  }

  // D16: a ForEach (and the provisioner) works on the WorkItemList returned by its single direct predecessor.
  function predecessorList(rc: RunCtx, node: PipelineNode, pools: Pools): { value?: unknown; label?: string; field?: string } {
    const preds = forEachPredecessors(node, rc.nodes, rc.edges)
    if (preds.length !== 1) return {}
    const pred = preds[0]
    const field = workItemListFields(rc.blocks.get(pred.blockId))[0]
    const result = pools.stepResults[pred.id] as Record<string, unknown> | undefined
    return { value: field ? result?.[field] : undefined, label: pred.label ?? pred.name ?? pred.id, field }
  }

  const provisionerExtras = (rc: RunCtx, node: PipelineNode, block: Block | undefined, pools: Pools): Record<string, unknown> =>
    block?.artifactName === 'workspace-provisioner' ? { workItemList: predecessorList(rc, node, pools).value } : {}

  // A block that declares a WorkItemList output must return a well-formed one; fail that step (naming the bad item) before any ForEach item runs.
  async function checkProducedLists(rc: RunCtx, node: PipelineNode, block: Block | undefined, output: AgentOutput): Promise<string | null> {
    // Handoff contract: item fields the direct consumers declare in requiredItemFields must be on every item.
    // (a ForEach consumes the list for its body blocks, so their requirements count too)
    const consumers = rc.edges.filter((e) => e.sourceNodeId === node.id).map((e) => rc.nodes.find((n) => n.id === e.targetNodeId))
      .flatMap((n) => (n?.type === 'forEach' ? rc.nodes.filter((c) => c.parentId === n.id) : n ? [n] : []))
    const required = [...new Set(consumers.flatMap((n) => rc.blocks.get(n.blockId)?.requiredItemFields ?? []))]
    for (const field of workItemListFields(block)) {
      const v = validateWorkItemList(output.result[field], required)
      if (v.ok) continue
      const message = `"${node.label ?? node.id}" returned an invalid work-item list in "${field}": ${v.error}`
      await guarded(rc.id, rc.run, (d) => {
        const step = d.steps.find((x) => x.nodeId === node.id && !x.itemKey)
        if (step) {
          step.status = 'Failed'
          step.completedAt = iso()
          step.output = { ...(step.output ?? { result: {} }), status: 'failed', summary: message, errorMessage: message } as DeliveryStep['output']
        }
      })
      emit(rc.id, { type: 'step_failed', nodeId: node.id, blockName: node.label ?? node.id, message })
      return message
    }
    return null
  }

  // ------------------------------------------------------------------ ForEach

  async function runForEach(rc: RunCtx, fe: PipelineNode, pools: Pools): Promise<{ ok: true } | { ok: false; message: string } | { ok: 'stopped' }> {
    const { id, run } = rc
    const label = fe.label ?? fe.name ?? fe.id
    const pre = predecessorList(rc, fe, pools)
    if (!pre.field) return { ok: false, message: `ForEach "${label}": connect a block that returns a work-item list.` }
    const parsed = parseWorkItemList(pre.value, { maxItems: fe.maxItems ?? 10, onEmpty: fe.onEmpty ?? 'fail' })
    if (!parsed.ok) {
      const message = `Cannot iterate "${label}": ${parsed.error}`
      const producer = forEachPredecessors(fe, rc.nodes, rc.edges)[0]
      await guarded(id, run, (d) => {
        const step = d.steps.find((s) => s.nodeId === producer.id && !s.itemKey)
        if (step) {
          step.status = 'Failed'
          step.completedAt = iso()
          step.output = { ...(step.output ?? { result: {} }), status: 'failed', summary: message, errorMessage: message } as DeliveryStep['output']
        }
      })
      emit(id, { type: 'step_failed', nodeId: producer.id, blockName: producer.label ?? producer.id, message })
      return { ok: false, message }
    }

    // Freeze the plan (item keys in list order) the first time this ForEach runs; resume reuses it.
    const dNow = (await store.getDelivery(id)) as Delivery
    let entries: WorkItemEntry[] = parsed.entries
    const planned = dNow.itemPlan?.[fe.id]
    if (planned) {
      const byKey = new Map(parsed.entries.map((e) => [e.key, e]))
      entries = []
      for (const p of planned.items) {
        const e = byKey.get(p.key)
        if (!e) return { ok: false, message: `Work item "${p.key}" from the original plan is no longer in the list` }
        entries.push(e)
      }
    } else {
      await guarded(id, run, (d) => {
        d.itemPlan = { ...(d.itemPlan ?? {}), [fe.id]: { items: parsed.entries.map((e) => ({ key: e.key })) } }
      })
    }

    const body = forEachBody(fe.id, rc.nodes, rc.edges)
    if (body.length === 0) return { ok: false, message: `ForEach "${label}" has no nodes inside it` }

    emit(id, { type: 'step_started', nodeId: fe.id, blockName: label })
    const startedAt = iso()
    const feBase = { nodeId: fe.id, itemKey: null, blockName: label }
    await guarded(id, run, (d) => {
      applyStep(d, { ...feBase, status: 'Running', startedAt })
      d.currentNodeId = fe.id
    })

    const total = entries.length
    const itemResults: { key: string; status: string; summary: string; result: unknown }[] = []
    const completedItems: { key: string; status: string; summary: string }[] = []
    const shared = parsed.shared

    for (const [index, entry] of entries.entries()) {
      if (run.stopped) return { ok: 'stopped' }
      const key = entry.key
      let itemPool: Record<string, unknown> = {}
      let lastOutput: { summary: string; result: unknown } | undefined
      let resumeAt = 0
      const cur = (await store.getDelivery(id)) as Delivery
      for (const b of body) {
        const s = cur.steps.find((x) => x.nodeId === b.id && x.itemKey === key && x.status === 'Completed')
        if (!s) break
        const result = await loadResult(cur, s)
        itemPool = { ...itemPool, ...result }
        lastOutput = { summary: s.output?.summary ?? '', result }
        resumeAt++
      }

      if (resumeAt === body.length && lastOutput) {
        // Finished before (resume): keep it.
        itemResults.push({ key, status: 'completed', summary: lastOutput.summary, result: lastOutput.result })
        completedItems.push({ key, status: 'completed', summary: capSummary(lastOutput.summary) })
        continue
      }

      emit(id, { type: 'item_started', nodeId: fe.id, itemKey: key, index, total })

      // D17: item.workspacePath -> delivery Workspace path -> Delivery Folder (validated + locked by the port).
      const itemPath = typeof entry.item.workspacePath === 'string' ? entry.item.workspacePath : undefined
      const itemInputs: Record<string, unknown> = {
        item: entry.item, itemKey: key, task: entry.item.task, shared, completedItems: [...completedItems],
      }

      for (const b of body.slice(resumeAt)) {
        const outcome = await execNode(rc, b, {
          itemKey: key,
          cwd: async () => workspace.resolveCwd((await store.getDelivery(id)) as Delivery, itemPath),
          pool: { ...pools.flatResults, ...itemPool }, extraInputs: itemInputs,
        })
        if (outcome.kind === 'stopped') return { ok: 'stopped' }
        if (outcome.kind === 'failed') {
          const message = `Item "${key}" failed at "${b.label ?? b.id}": ${outcome.message}`
          emit(id, { type: 'item_failed', nodeId: fe.id, itemKey: key, index, total, message })
          await guarded(id, run, (d) => {
            const s = d.steps.find((x) => x.nodeId === fe.id && !x.itemKey)
            if (s) { s.status = 'Failed'; s.completedAt = iso() }
          })
          return { ok: false, message }
        }
        itemPool = { ...itemPool, ...outcome.output.result }
        lastOutput = { summary: outcome.output.summary ?? '', result: outcome.output.result }
        emit(id, { type: 'step_completed', nodeId: b.id, blockName: b.label ?? b.id, output: outcome.output, itemKey: key })
      }
      itemResults.push({ key, status: 'completed', summary: lastOutput?.summary ?? '', result: lastOutput?.result ?? {} })
      completedItems.push({ key, status: 'completed', summary: capSummary(lastOutput?.summary ?? '') })
      emit(id, { type: 'item_completed', nodeId: fe.id, itemKey: key, index, total })
    }

    if (run.stopped) return { ok: 'stopped' }
    const stored = await storeIfLarge({
      runsDir, deliveryId: id, subfolder: 'outputs', nodeId: fe.id, data: { itemResults }, thresholdBytes: threshold(), now,
    })
    const output: AgentOutput = { status: 'success', summary: `${total} item(s) processed`, result: { itemResults } }
    await guarded(id, run, (d) => {
      applyStep(d, {
        ...feBase, status: 'Completed', startedAt, completedAt: iso(),
        output: { ...output, result: stored.value, isTruncated: stored.isTruncated, outputFileRef: stored.fileRef },
      })
    })
    pools.stepResults[fe.id] = output.result
    pools.flatResults = { ...pools.flatResults, ...output.result }
    emit(id, { type: 'step_completed', nodeId: fe.id, blockName: label, output })
    return { ok: true }
  }

  // ------------------------------------------------------------------ run loop

  async function runLoop(id: string, run: ActiveRun, startNodeId: string): Promise<void> {
    const d0 = await store.getDelivery(id)
    if (!d0) throw new Error(`Delivery ${id} not found`)
    const { nodes, edges } = d0.pipelineSnapshot
    const { blocks, missing } = await loadBlocks(nodes, d0.pipelineSnapshot.blockVersions)
    if (missing.length) {
      await failDelivery(id, run, `Missing blocks: ${missing.join(', ')}`)
      return
    }
    const deliveryFolder = d0.deliveryFolder ?? d0.workspacePath
    if (!deliveryFolder) {
      await failDelivery(id, run, 'Delivery has no workspace folder')
      return
    }
    const rc: RunCtx = { id, run, d0, nodes, edges, blocks, deliveryFolder }

    const pools = await reconstructResults(d0)
    let node: PipelineNode | undefined = nodes.find((n) => n.id === startNodeId)

    while (node) {
      if (run.stopped) return
      const current: PipelineNode = node
      const label = current.label ?? current.name ?? current.id

      if (current.type === 'forEach') {
        const res = await runForEach(rc, current, pools)
        if (res.ok === 'stopped') return
        if (!res.ok) {
          await failDelivery(id, run, res.message, current.id)
          return
        }
        await guarded(id, run, (d) => { d.currentNodeId = current.id })
        node = nextNode(current.id, nodes, edges)
        continue
      }

      const block = blocks.get(current.blockId)
      const outcome = await execNode(rc, current, {
        itemKey: null,
        cwd: async () => workspace.resolveCwd((await store.getDelivery(id)) as Delivery),
        pool: pools.flatResults, extraInputs: provisionerExtras(rc, current, block, pools),
      })
      if (outcome.kind === 'stopped') return
      if (outcome.kind === 'failed') {
        await failDelivery(id, run, outcome.message, current.id)
        return
      }
      const { output, isGate } = outcome
      pools.stepResults[current.id] = output.result
      pools.flatResults = { ...pools.flatResults, ...output.result }
      await applyNativeEffects(rc, block, output)
      const listError = await checkProducedLists(rc, current, block, output)
      if (listError) {
        await failDelivery(id, run, listError, current.id)
        return
      }

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

    // The delivery completes only because its terminal node succeeded — there is no hidden git tail any more.
    const dEnd = await store.getDelivery(id)
    await setStatus(id, run, 'Completed', (d) => {
      d.completedAt = iso()
      d.errorMessage = undefined
    })
    if (!run.stopped) {
      await releaseWorkspace(id, { dropRefs: true })
      emit(id, { type: 'completed', prUrl: dEnd?.prUrl ?? undefined })
    }
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
      const { blocks, missing } = await loadBlocks(nodes, d.pipelineSnapshot.blockVersions)
      const validation = validatePipeline(nodes, edges, blocks)
      if (!validation.valid || missing.length) {
        return { success: false, error: `Invalid pipeline: ${[...validation.errors, ...missing.map((m) => `missing block ${m}`)].join('; ')}` }
      }
      const startNode = findStartNode(nodes, edges)
      if (!startNode) return { success: false, error: 'No start node found in pipeline' }

      emit(id, { type: 'workspace_provisioning' })
      let prepared: Awaited<ReturnType<WorkspacePort['prepare']>>
      try {
        prepared = await workspace.prepare(d)
      } catch (err) {
        // Delivery stays Pending so the user can fix the cause and start again.
        return { success: false, error: `Workspace setup failed: ${errMsg(err)}` }
      }

      await store.updateDelivery(id, (x) => {
        x.status = 'Running'
        x.deliveryFolder = prepared.deliveryFolder
        x.workspacePath = prepared.workspacePath
        x.workspaceBase = prepared.base
        x.startedAt = iso()
        x.errorMessage = undefined
      })
      emit(id, { type: 'status_changed', status: 'Running' })
      emit(id, { type: 'workspace_provisioned', workspacePath: prepared.deliveryFolder })

      launch(id, startNode.id)
      return { success: true }
    })
  }

  async function resumeClaimed(id: string): Promise<ActionResult> {
    const d = await store.getDelivery(id)
    if (!d) return { success: false, error: 'Delivery not found' }
    // A Failed delivery is resumable from its failed step/item (same delivery, same workspace; the step's snapshot is
    // restored before it runs again). A rejected approval is a decision, not a failure to retry: that needs a Rerun.
    const failedStep = d.status === 'Failed'
      && d.steps.some((s) => s.status === 'Failed')
      && !d.steps.some((s) => s.output?.rejectedBy != null)
    if (d.status !== 'Paused' && d.status !== 'Cancelled' && d.status !== 'Interrupted' && !failedStep) {
      return { success: false, error: `Delivery is ${d.status}, cannot resume` }
    }
    if (!d.deliveryFolder && !d.workspacePath) {
      return { success: false, error: 'No workspace folder recorded for this delivery — cannot resume without restarting it' }
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
    try {
      await workspace.reacquire(d)
    } catch (err) {
      return { success: false, error: `Workspace setup failed: ${errMsg(err)}` }
    }

    await store.updateDelivery(id, (x) => { x.status = 'Running'; x.errorMessage = undefined; x.completedAt = undefined; x.workspaceNotice = undefined })
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
        step.output = { ...step.output, approvedBy: actor(), approvedAt: iso(), reviewComment: trimmed }
      })
      emit(id, { type: 'gate_approved', nodeId: gate.nodeId, approvedBy: actor(), comment: trimmed })
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
          step.output = { ...step.output, rejectedBy: actor(), rejectedAt: iso(), reviewComment: trimmed }
        }
        x.status = 'Failed'
        x.errorMessage = message
        x.completedAt = iso()
      })
      emit(id, { type: 'gate_rejected', nodeId: gate.nodeId, rejectedBy: actor(), comment: trimmed })
      emit(id, { type: 'status_changed', status: 'Failed' })
      emit(id, { type: 'failed', message, nodeId: gate.nodeId })
      await releaseWorkspace(id)
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
        markRunningSteps(d, 'Cancelled by user', 'Cancelled')
        d.status = 'Cancelled'
      })
      if (rejected) return { success: false, error: 'Delivery already finished' }
    } catch (err) {
      return { success: false, error: errMsg(err) }
    }
    emit(id, { type: 'status_changed', status: 'Cancelled' })
    emit(id, { type: 'cancelled' })
    await releaseWorkspace(id, { dropRefs: true })
    return { success: true }
  }

  function markRunningSteps(d: Delivery, reason: string, status: 'Cancelled' | 'Interrupted') {
    for (const s of d.steps) {
      if (s.status !== 'Running') continue
      s.status = status
      s.completedAt = iso()
      s.output = { status: 'failed', summary: reason, result: {}, errorMessage: reason }
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
      workspacePath: d.deliveryFolder ?? d.workspacePath ?? undefined,
      branch: d.workspaceBase?.branch ?? d.branch ?? undefined,
    }
    if (!resumeNode) {
      return {
        success: true,
        preview: { ...base, resumeNodeId: '', resumeNodeLabel: '', hasPriorAttempt: false, allNodesCompleted: true },
      }
    }
    // The step that will actually run again: the one that failed/stopped (inside a ForEach, the failing body step), else the next node.
    const failed = [...d.steps].reverse().find(isStoppedStep)
    const stepNode = (failed && nodes.find((n) => n.id === failed.nodeId && n.type !== 'forEach')) || (resumeNode.type !== 'forEach' ? resumeNode : undefined)
    const block = stepNode ? await store.getBlock(stepNode.blockId) : null
    const resumeStep = stepNode ? d.steps.find((s) => s.nodeId === stepNode.id && (failed?.nodeId === stepNode.id ? s.itemKey === failed.itemKey : true) && isStoppedStep(s)) ?? failed : undefined
    const hasPriorAttempt = d.steps.some((s) => s.nodeId === (stepNode ?? resumeNode).id)
    const canWrite = !!block && block.agentRuntime !== 'Axon' && block.executionType === 'Agentic'
      && resolveEffectiveTools(block).some((t) => t === 'Write' || t === 'Edit' || t === 'Bash')
    const folder = resumeStep?.cwd
    const stepKey = stepNode ? (resumeStep?.itemKey ? `${stepNode.id}@${resumeStep.itemKey}` : stepNode.id) : ''
    const restorable = !!(deps.snapshots && folder && stepNode && await deps.snapshots.has(folder, id, stepKey).catch(() => false))
    const resumeMode: NonNullable<ResumePreview['resumeMode']> = restorable ? 'restore' : (canWrite && hasPriorAttempt ? 'warn' : 'plain')
    return {
      success: true,
      preview: {
        ...base,
        stepLabel: (stepNode ?? resumeNode).label ?? (stepNode ?? resumeNode).id,
        failureReason: resumeStep?.output?.errorMessage ?? resumeStep?.output?.summary,
        folder,
        resumeMode,
        resumeNodeId: resumeNode.id,
        resumeNodeLabel: resumeNode.label ?? resumeNode.id,
        resumeNodeRole: block?.role,
        hasPriorAttempt,
        allNodesCompleted: false,
      },
    }
  }

  async function reconcileOnBoot(): Promise<number> {
    let count = 0
    for (const d of await store.listDeliveries()) {
      if (d.status !== 'Running' || active.has(d.id)) continue
      await store.updateDelivery(d.id, (x) => {
        markRunningSteps(x, 'Interrupted (AXON stopped while this step was running)', 'Interrupted')
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
          markRunningSteps(d, 'Interrupted (AXON was closed while this step was running)', 'Interrupted')
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
    discardSnapshots: async (id) => { await dropSnapshotRefs(await store.getDelivery(id)) },
    async cleanupFailedSnapshots(days = 14) {
      const cutoff = now().getTime() - days * 86_400_000
      let n = 0
      for (const d of await store.listDeliveries()) {
        if ((d.status !== 'Failed' && d.status !== 'Superseded') || !d.completedAt || Date.parse(d.completedAt) > cutoff) continue
        if (!d.steps.some((x) => x.cwd)) continue
        await dropSnapshotRefs(d)
        n++
      }
      return n
    },
    start, resume, cancel, approveGate, rejectGate, previewResume, reconcileOnBoot, shutdown,
    whenIdle: (id) => active.get(id)?.done ?? Promise.resolve(),
    isActive: (id) => active.has(id),
  }
}
