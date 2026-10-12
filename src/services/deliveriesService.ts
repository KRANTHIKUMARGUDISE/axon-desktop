import type { Delivery as StoredDelivery, DeliveryStep as StoredStep, CreateDeliveryInput } from '@shared'
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
  retriedFromDeliveryId?: string
}

export interface GateRequest {
  reason?: string
}

function normalizeStep(raw: StoredStep): DeliveryStep {
  const out = raw.output
  return {
    id: raw.nodeId,
    nodeId: raw.nodeId,
    name: raw.blockName,
    nodeName: raw.blockName,
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    contextSnapshot: raw.contextSnapshot,
    isContextTruncated: raw.isContextTruncated,
    contextFileRef: raw.contextFileRef,
    contextAvailability: raw.contextAvailability,
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
        }
      : undefined,
    errorMessage: out?.errorMessage,
  }
}

function progressOf(d: StoredDelivery): number {
  const total = d.pipelineSnapshot.nodes.length
  if (total === 0) return 0
  if (d.status === 'Completed') return 100
  const done = d.steps.filter((s) => s.status === 'Completed').length
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
    steps: d.steps.map(normalizeStep),
    branch: d.branch ?? undefined,
    prUrl: d.prUrl,
    inputs: d.inputs,
    retriedFromDeliveryId: d.retriedFromDeliveryId,
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
export const getStepContext = (deliveryId: string, stepId: string): Promise<Record<string, unknown>> =>
  window.axon.deliveries.stepData(deliveryId, stepId, 'context')

export const getStepOutput = (deliveryId: string, stepId: string): Promise<Record<string, unknown>> =>
  window.axon.deliveries.stepData(deliveryId, stepId, 'output')

function assertOk(res: ActionResult, fallback: string): void {
  if (!res.success) throw new Error(res.error ?? fallback)
}

// Approving also resumes the delivery (handled in the main process).
export const approveGate = async (id: string, req?: GateRequest): Promise<void> =>
  assertOk(await window.axon.delivery.approveGate(id, req?.reason), 'Failed to approve gate')

export const rejectGate = async (id: string, req?: GateRequest): Promise<void> =>
  assertOk(await window.axon.delivery.rejectGate(id, req?.reason ?? ''), 'Failed to reject gate')

export type { DeliveryStatus }
