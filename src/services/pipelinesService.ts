import client from './apiClient'
import type { Pipeline, ValidationResult } from '../types'

export interface PipelineFilter {
  search?: string
  isActive?: boolean
}

export interface CreatePipelineRequest {
  name: string
  description: string
  nodes: unknown[]
  edges: unknown[]
}

export const getPipelines = (filter?: PipelineFilter): Promise<Pipeline[]> =>
  client.get<Pipeline[]>('/api/pipelines', { params: filter }).then((r) => r.data)

export const getPipeline = (id: string): Promise<Pipeline> =>
  client.get<Pipeline>(`/api/pipelines/${id}`).then((r) => r.data)

export const createPipeline = (req: CreatePipelineRequest): Promise<Pipeline> =>
  client.post<Pipeline>('/api/pipelines', req).then((r) => r.data)

export const updatePipeline = (id: string, req: Partial<CreatePipelineRequest>): Promise<Pipeline> =>
  client.put<Pipeline>(`/api/pipelines/${id}`, req).then((r) => r.data)

export const deletePipeline = (id: string): Promise<void> =>
  client.delete(`/api/pipelines/${id}`).then(() => undefined)

export const validatePipeline = (req: CreatePipelineRequest): Promise<ValidationResult> =>
  client.post<ValidationResult>(`/api/pipelines/validate`, req).then((r) => r.data)
