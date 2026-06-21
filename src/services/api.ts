import axios from 'axios'
import type {
  Pipeline,
  Delivery,
  DeliverySummary,
  BuildingBlock,
  PagedResponse,
  ValidationResult,
  CreateDeliveryRequest,
  CreatePipelineRequest,
  CreateBlockRequest,
} from '../types'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
  headers: { 'Content-Type': 'application/json' },
})

// Pipelines
export const getPipelines = (): Promise<Pipeline[]> =>
  apiClient.get<Pipeline[]>('/pipelines').then((r) => r.data)

export const getPipeline = (id: string): Promise<Pipeline> =>
  apiClient.get<Pipeline>(`/pipelines/${id}`).then((r) => r.data)

export const createPipeline = (data: CreatePipelineRequest): Promise<Pipeline> =>
  apiClient.post<Pipeline>('/pipelines', data).then((r) => r.data)

export const updatePipeline = (
  id: string,
  data: Partial<CreatePipelineRequest>,
): Promise<Pipeline> =>
  apiClient.put<Pipeline>(`/pipelines/${id}`, data).then((r) => r.data)

export const deletePipeline = (id: string): Promise<void> =>
  apiClient.delete(`/pipelines/${id}`).then(() => undefined)

export const validatePipeline = (id: string): Promise<ValidationResult> =>
  apiClient.post<ValidationResult>(`/pipelines/${id}/validate`).then((r) => r.data)

// Deliveries
export interface GetDeliveriesParams {
  status?: string
  pipelineId?: string
  search?: string
  page?: number
  pageSize?: number
}

export const getDeliveries = (
  params?: GetDeliveriesParams,
): Promise<PagedResponse<DeliverySummary>> =>
  apiClient.get<PagedResponse<DeliverySummary>>('/deliveries', { params }).then((r) => r.data)

export const getDelivery = (id: string): Promise<Delivery> =>
  apiClient.get<Delivery>(`/deliveries/${id}`).then((r) => r.data)

export const createDelivery = (data: CreateDeliveryRequest): Promise<Delivery> =>
  apiClient.post<Delivery>('/deliveries', data).then((r) => r.data)

export const approveGate = (id: string): Promise<void> =>
  apiClient.post(`/deliveries/${id}/approve`).then(() => undefined)

export const rejectGate = (id: string): Promise<void> =>
  apiClient.post(`/deliveries/${id}/reject`).then(() => undefined)

export const pauseDelivery = (id: string): Promise<void> =>
  apiClient.post(`/deliveries/${id}/pause`).then(() => undefined)

export const cancelDelivery = (id: string): Promise<void> =>
  apiClient.post(`/deliveries/${id}/cancel`).then(() => undefined)

// Building Blocks
export interface GetBlocksParams {
  type?: string
  search?: string
  verified?: boolean
}

export const getBlocks = (params?: GetBlocksParams): Promise<BuildingBlock[]> =>
  apiClient.get<BuildingBlock[]>('/blocks', { params }).then((r) => r.data)

export const getBlock = (id: string): Promise<BuildingBlock> =>
  apiClient.get<BuildingBlock>(`/blocks/${id}`).then((r) => r.data)

export const createBlock = (data: CreateBlockRequest): Promise<BuildingBlock> =>
  apiClient.post<BuildingBlock>('/blocks', data).then((r) => r.data)

export const updateBlock = (
  id: string,
  data: Partial<CreateBlockRequest>,
): Promise<BuildingBlock> =>
  apiClient.put<BuildingBlock>(`/blocks/${id}`, data).then((r) => r.data)

export const deactivateBlock = (id: string): Promise<void> =>
  apiClient.post(`/blocks/${id}/deactivate`).then(() => undefined)
