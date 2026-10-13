import { forEachProgress } from '@shared'
import type { Delivery as StoredDelivery, DeliveryStep as StoredStep, CreateDeliveryInput, RerunReason } from '@shared'
import type { Delivery, DeliverySummary, DeliveryStatus, PagedResponse, DeliveryStep, WorkspaceType, ActionResult } from '../types'

export interface DeliveryFilter {
  status?: string
  pipelineId?: string
  search?: string
  page?: number
  pageSize?: number
}

export interface CreateDeliveryRequest {
  ticketId: string
  title: string
  pipelineId: string
  repoUrl: string
  workspaceType: WorkspaceType
  storeFullContext?: boolean
  inputs?: Record<string, unknown>
  workspacePath?: string
  retriedFromDeliveryId?: string
  rerunReason?: RerunReason
}

export interface GateRequest {
  reason?: string
}

function normalizeStep(raw: StoredStep): DeliveryStep {
  const out = raw.output
  return {
    id: raw.itemKey ? `${raw.nodeId}::${raw.itemKey}` : raw.nodeId,
    nodeId: raw.nodeId,
    itemKey: raw.itemKey,
    cwd: raw.cwd,
    name: raw.blockName,
    nodeName: raw.blockName,
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    contextSnapshot: raw.contextSnapshot,
    isContextTruncated: raw.isContextTruncated,
    contextFileRef: raw.contextFileRef,
    contextAvailability: raw.contextAvailability,
    catalogStats: raw.catalogStats,
    outputAvailability: raw.outputAvailability,
    agentOutput: out
      ? {
          summary: out.summary,
          confidence: out.confidence,
          humanGateReason: out.humanGateReason,
          result: out.result,
          errorCode: out.errorCode,
          recoverable: out.recoverable,
          approvedBy: out.approvedBy,
          approvedAt: out.approvedAt,
          rejectedBy: out.rejectedBy,
          rejectedAt: out.rejectedAt,
          reviewComment: out.reviewComment,
          toolsUsed: out.toolsUsed,
          toolsDenied: out.toolsDenied,
          timedOut: out.timedOut,
          isTruncated: out.isTruncated,
          outputFileRef: out.outputFileRef,
          usage: out.usage,
        }
      : undefined,
    errorMessage: out?.errorMessage,
  }
}

function progressOf(d: StoredDelivery): number {
  const top = d.pipelineSnapshot.nodes.filter((n) => !n.parentId)
  const total = top.length
  if (total === 0) return 0
  if (d.status === 'Completed') return 100
  const done = d.steps.filter((s) => s.status === 'Completed' && !s.itemKey).length
  return Math.round((done / total) * 100)
}

function formatDuration(startedAt: string, completedAt?: string): string | undefined {
  if (!completedAt) return undefined
  const secs = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000))
  const m = Math.floor(secs / 60)
  return m > 0 ? `${m}m ${secs % 60}s` : `${secs}s`
}

function toSummary(d: StoredDelivery): DeliverySummary {
  return {
    id: d.id,
    ticketId: d.ticketId,
    title: d.title,
    pipelineId: d.pipelineId,
    pipelineName: d.pipelineName,
    status: d.status,
    progress: progressOf(d),
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    createdByName: d.createdByName,
    duration: formatDuration(d.startedAt, d.completedAt),
    localSeq: d.localSeq,
    itemCounter: forEachProgress(d).map((p) => `${p.label}: ${p.counter}`).join(' · ') || undefined,
  }
}

function toDelivery(d: StoredDelivery): Delivery {
  return {
    ...toSummary(d),
    pipelineSnapshot: {
      name: d.pipelineSnapshot.name,
      nodes: d.pipelineSnapshot.nodes as unknown as NonNullable<Delivery['pipelineSnapshot']>['nodes'],
      edges: d.pipelineSnapshot.edges as unknown as NonNullable<Delivery['pipelineSnapshot']>['edges'],
    },
    currentNodeId: d.currentNodeId,
    repoUrl: d.repoUrl,
    workspaceType: d.workspaceType,
    storeFullContext: d.storeFullContext,
    workspacePath: d.workspacePath,
    deliveryFolder: d.deliveryFolder,
    workspaceBase: d.workspaceBase,
    workspaceNotice: d.workspaceNotice,
    steps: d.steps.map(normalizeStep),
    branch: d.branch ?? undefined,
    prUrl: d.prUrl,
    prUrls: d.prUrls,
    repositories: d.repositories,
    itemPlan: d.itemPlan,
    inputs: d.inputs,
    retriedFromDeliveryId: d.retriedFromDeliveryId,
    supersededBy: d.supersededBy,
    rerunReason: d.rerunReason,
    attemptNumber: d.attemptNumber,
    errorMessage: d.errorMessage,
  }
}

export const getDeliveries = async (filter?: DeliveryFilter): Promise<PagedResponse<DeliverySummary>> => {
  let all = (await window.axon.deliveries.list()) as StoredDelivery[]
  all = all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  if (filter?.status) all = all.filter((d) => d.status === filter.status)
  if (filter?.pipelineId) all = all.filter((d) => d.pipelineId === filter.pipelineId)
  if (filter?.search) {
    const q = filter.search.toLowerCase()
    all = all.filter((d) => d.ticketId.toLowerCase().includes(q) || d.title.toLowerCase().includes(q))
  }
  const page = filter?.page ?? 1
  const pageSize = filter?.pageSize ?? (all.length || 1)
  const items = all.slice((page - 1) * pageSize, page * pageSize).map(toSummary)
  return { items, total: all.length, page, pageSize }
}

export const getDelivery = async (id: string): Promise<Delivery> => {
  const d = (await window.axon.deliveries.get(id)) as StoredDelivery | null
  if (!d) throw new Error('Delivery not found')
  return toDelivery(d)
}

export const createDelivery = async (req: CreateDeliveryRequest): Promise<Delivery> => {
  const input: CreateDeliveryInput = { ...req }
  return toDelivery((await window.axon.deliveries.create(input)) as StoredDelivery)
}

// Full context / output for one step. The main process reads the DS1 file when the
// delivery document only holds a truncated marker, so callers always get real content.
// Step ids are the node id, or "nodeId::itemKey" for a ForEach item step (steps are keyed by nodeId + itemKey).
function stepData(deliveryId: string, stepId: string, kind: 'context' | 'output'): Promise<Record<string, unknown>> {
  const k = stepId.indexOf('::')
  return k < 0
    ? window.axon.deliveries.stepData(deliveryId, stepId, kind)
    : window.axon.deliveries.stepData(deliveryId, stepId.slice(0, k), kind, stepId.slice(k + 2))
}

export const getStepContext = (deliveryId: string, stepId: string): Promise<Record<string, unknown>> =>
  stepData(deliveryId, stepId, 'context')

export const getStepOutput = (deliveryId: string, stepId: string): Promise<Record<string, unknown>> =>
  stepData(deliveryId, stepId, 'output')

function assertOk(res: ActionResult, fallback: string): void {
  if (!res.success) throw new Error(res.error ?? fallback)
}

// Approving also resumes the delivery (handled in the main process).
export const approveGate = async (id: string, req?: GateRequest): Promise<void> =>
  assertOk(await window.axon.delivery.approveGate(id, req?.reason), 'Failed to approve gate')

export const rejectGate = async (id: string, req?: GateRequest): Promise<void> =>
  assertOk(await window.axon.delivery.rejectGate(id, req?.reason ?? ''), 'Failed to reject gate')

export type { DeliveryStatus }
