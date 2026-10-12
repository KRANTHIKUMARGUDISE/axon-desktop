import type { Block, BlockInput } from '@shared'
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

// Stored blocks carry full file contents; the UI model only lists relative paths.
function toBuildingBlock(b: Block): BuildingBlock {
  return {
    ...b,
    inputs: [],
    outputs: [],
    cachedFiles: b.cachedFiles?.map((f) => f.relativePath),
  }
}

function toInput(req: Partial<CreateBlockRequest>, acceptedBy?: string): Partial<BlockInput> {
  const { executionAgreementAccepted, ...rest } = req
  return {
    ...(rest as Partial<BlockInput>),
    ...(executionAgreementAccepted
      ? { executionAgreementAcceptedAt: new Date().toISOString(), executionAgreementAcceptedBy: acceptedBy ?? 'local-user' }
      : {}),
  }
}

export const getBlocks = async (filter?: BlockFilter): Promise<BuildingBlock[]> => {
  let blocks = (await window.axon.blocks.list()) as Block[]
  if (filter?.role) blocks = blocks.filter((b) => b.role === filter.role)
  if (filter?.sourceType) blocks = blocks.filter((b) => b.sourceType === filter.sourceType)
  if (filter?.verified !== undefined) blocks = blocks.filter((b) => !!b.verified === filter.verified)
  if (filter?.search) {
    const q = filter.search.toLowerCase()
    blocks = blocks.filter((b) => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q))
  }
  return blocks.map(toBuildingBlock)
}

export const getBlock = async (id: string): Promise<BuildingBlock> => {
  const b = (await window.axon.blocks.get(id)) as Block | null
  if (!b) throw new Error('Block not found')
  return toBuildingBlock(b)
}

export const createBlock = async (req: CreateBlockRequest): Promise<BuildingBlock> =>
  toBuildingBlock((await window.axon.blocks.create(toInput(req))) as Block)

export const updateBlock = async (id: string, req: Partial<CreateBlockRequest>): Promise<BuildingBlock> =>
  toBuildingBlock((await window.axon.blocks.update(id, toInput(req))) as Block)

export const deleteBlock = (id: string): Promise<void> => window.axon.blocks.delete(id)
