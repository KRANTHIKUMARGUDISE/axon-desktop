import client from './apiClient'
import type { Delivery, DeliverySummary, DeliveryStatus, PagedResponse, DeliveryStep, WorkspaceType } from '../types'

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
  branch?: string
  inputs?: Record<string, unknown>
  retriedFromDeliveryId?: string
}

export interface UpdateDeliveryRequest {
  repoUrl?: string
  workspaceType?: WorkspaceType
  workspacePath?: string
}

export interface GateRequest {
  reason?: string
  comment?: string
}

export const getDeliveries = (filter?: DeliveryFilter): Promise<PagedResponse<DeliverySummary>> =>
  client.get('/api/deliveries', { params: filter }).then((r) => {
    const d = r.data
    if (Array.isArray(d)) {
      return { items: d as DeliverySummary[], total: d.length, page: filter?.page ?? 1, pageSize: filter?.pageSize ?? d.length }
    }
    // Support { data, total } shapes alongside { items, total }
    if (d && !d.items && d.data) {
      return { items: d.data as DeliverySummary[], total: d.total ?? d.count ?? d.data.length, page: d.page ?? filter?.page ?? 1, pageSize: d.pageSize ?? filter?.pageSize ?? d.data.length }
    }
    return d as PagedResponse<DeliverySummary>
  })

// Backend's DeliveryStep has no `id`/`name` — only nodeId/blockId/blockName/output.
// Normalize to the shape the rest of the UI (DeliveryLiveView's pipeline graph) expects.
interface RawDeliveryStep {
  nodeId: string
  blockId?: string
  blockName: string
  status: DeliveryStep['status']
  contextSnapshot?: Record<string, unknown>
  isContextTruncated?: boolean
  contextFileRef?: string
  output?: {
    summary?: string
    confidence?: number
    humanGateReason?: string
    result?: Record<string, unknown>
    errorMessage?: string
    isTruncated?: boolean
    outputFileRef?: string
  }
  startedAt?: string
  completedAt?: string
}

function normalizeStep(raw: RawDeliveryStep): DeliveryStep {
  return {
    id: raw.nodeId,
    name: raw.blockName,
    nodeName: raw.blockName,
    status: raw.status,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    contextSnapshot: raw.contextSnapshot,
    isContextTruncated: raw.isContextTruncated,
    contextFileRef: raw.contextFileRef,
    agentOutput: raw.output
      ? {
          summary: raw.output.summary,
          confidence: raw.output.confidence,
          humanGateReason: raw.output.humanGateReason,
          result: raw.output.result,
          isTruncated: raw.output.isTruncated,
          outputFileRef: raw.output.outputFileRef,
        }
      : undefined,
    errorMessage: raw.output?.errorMessage,
  }
}

export const getDelivery = (id: string): Promise<Delivery> =>
  client.get<Delivery>(`/api/deliveries/${id}`).then((r) => ({
    ...r.data,
    steps: ((r.data.steps as unknown as RawDeliveryStep[]) ?? []).map(normalizeStep),
  }))

export const createDelivery = (req: CreateDeliveryRequest): Promise<Delivery> =>
  client.post<Delivery>('/api/deliveries', req).then((r) => r.data)

export const updateDelivery = (id: string, req: UpdateDeliveryRequest): Promise<Delivery> =>
  client.patch<Delivery>(`/api/deliveries/${id}`, req).then((r) => r.data)

export const updateStatus = (
  id: string,
  status: DeliveryStatus,
  opts?: { nodeId?: string; workspacePath?: string },
): Promise<void> =>
  client.patch(`/api/deliveries/${id}/status`, { status, ...opts }).then(() => undefined)

export const appendStep = (id: string, step: Partial<DeliveryStep>): Promise<void> =>
  client.post(`/api/deliveries/${id}/steps`, step).then(() => undefined)

export const approveGate = (id: string, req?: GateRequest): Promise<void> =>
  client.post(`/api/deliveries/${id}/gate/approve`, req ?? {}).then(() => undefined)

export const rejectGate = (id: string, req?: GateRequest): Promise<void> =>
  client.post(`/api/deliveries/${id}/gate/reject`, req ?? {}).then(() => undefined)
