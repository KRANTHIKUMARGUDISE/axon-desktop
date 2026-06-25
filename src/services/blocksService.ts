import client from './apiClient'
import type { BuildingBlock, SourceType, AgentRuntime, ArtifactFormat, ExecutionType, BuildingBlockVisibility } from '../types'
import type { CachedFile } from '../utils/fileHandler'

export interface BlockFilter {
  role?: string
  search?: string
  verified?: boolean
  sourceType?: SourceType
}

export interface CreateBlockRequest {
  name: string
  role: string
  description: string
  sourceType: SourceType
  agentRuntime: AgentRuntime
  artifactFormat: ArtifactFormat
  artifactName?: string
  cachedFiles?: CachedFile[]
  entryPointPath?: string
  tags: string[]
  contextRequirements?: string[]
  outputSchema?: string[]
  visibility?: BuildingBlockVisibility
  executionType?: ExecutionType
  allowedTools?: string[]
  defaultTimeoutSeconds?: number
  executionAgreementAccepted?: boolean
}

export interface MarketplaceImportRequest {
  source: string
  path: string
  version?: string
}

export const getBlocks = (filter?: BlockFilter): Promise<BuildingBlock[]> =>
  client.get<BuildingBlock[]>('/api/blocks', { params: filter }).then((r) => r.data)

export const getBlock = (id: string): Promise<BuildingBlock> =>
  client.get<BuildingBlock>(`/api/blocks/${id}`).then((r) => r.data)

export const createBlock = (req: CreateBlockRequest): Promise<BuildingBlock> =>
  client.post<BuildingBlock>('/api/blocks', req).then((r) => r.data)

export const updateBlock = (id: string, req: Partial<CreateBlockRequest>): Promise<BuildingBlock> =>
  client.put<BuildingBlock>(`/api/blocks/${id}`, req).then((r) => r.data)

export const syncBlock = (id: string): Promise<void> =>
  client.post(`/api/blocks/${id}/sync`).then(() => undefined)

export const deactivateBlock = (id: string): Promise<void> =>
  client.post(`/api/blocks/${id}/deactivate`).then(() => undefined)

export const browseMarketplace = (): Promise<BuildingBlock[]> =>
  client.get<BuildingBlock[]>('/api/marketplace/browse').then((r) => r.data)

export const importFromMarketplace = (req: MarketplaceImportRequest): Promise<BuildingBlock> =>
  client.post<BuildingBlock>('/api/marketplace/import', req).then((r) => r.data)
