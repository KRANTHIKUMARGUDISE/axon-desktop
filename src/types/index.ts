export type DeliveryStatus = 'Pending' | 'Running' | 'Paused' | 'Completed' | 'Failed' | 'Cancelled'
export type StepStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Skipped' | 'AwaitingHuman'
export type WorkspaceType = 'Default' | 'Browse'
export type NodeType = 'Decision' | 'Execution' | 'Knowledge' | 'Control' | 'IO' | 'Utility'
export type BlockType = 'Decision' | 'Execution' | 'Knowledge' | 'Control' | 'IO' | 'Utility'
export type SourceType = 'Axon' | 'Local' | 'Marketplace' | 'CDF'
export type AgentRuntime = 'Axon' | 'Claude' | 'Codex'
export type ArtifactFormat = 'Native' | 'Skill'

export interface BranchCondition {
  expression: string
  targetNodeId: string
}

export interface PipelineEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  isDefault?: boolean
  condition?: BranchCondition | null
}

export interface PipelineNode {
  id: string
  type?: NodeType
  name?: string
  label?: string
  blockId: string
  positionX?: number
  positionY?: number
  position: { x: number; y: number }
  config?: Record<string, unknown>
  timeoutSeconds?: number
  confidenceThreshold?: number
  pinnedVersion?: string | null
}

export interface Pipeline {
  id: string
  name: string
  description: string
  nodes?: PipelineNode[]
  edges?: PipelineEdge[]
  createdAt: string
  updatedAt?: string
  tags?: string[]
  isActive?: boolean
  version?: string | number | null
  versionLabel?: string | null
  createdByName?: string
  createdBy?: string
  nodeCount?: number
  ownerTeam?: string
  teamId?: string
  visibility?: string
}

export interface StepAgentOutput {
  summary?: string
  confidence?: number
  missingFields?: string[]
  humanGateReason?: string
  result?: Record<string, unknown>
  isTruncated?: boolean
  outputFileRef?: string
}

export interface DeliveryStep {
  id: string
  name: string
  status: StepStatus
  nodeName?: string
  nodeType?: string
  startedAt?: string
  completedAt?: string
  duration?: string
  tokenCount?: number
  agentOutput?: StepAgentOutput
  errorMessage?: string
  output?: string
  error?: string
  contextSnapshot?: Record<string, unknown>
  isContextTruncated?: boolean
  contextFileRef?: string
}

export interface Delivery {
  id: string
  ticketId: string
  title: string
  pipelineId: string
  pipelineName: string
  pipelineSnapshot?: { name: string; nodes?: Array<{ id: string; label: string; blockId: string }> }
  status: DeliveryStatus
  repoUrl: string
  workspaceType: WorkspaceType
  workspacePath?: string | null
  steps: DeliveryStep[]
  progress: number
  startedAt: string
  completedAt?: string
  createdByName?: string
  ownerTeam?: string
  repository?: string
  branch?: string
  prUrl?: string | null
  inputs?: Record<string, unknown>
  retriedFromDeliveryId?: string | null
  attemptNumber?: number
  jobNumber?: number
}

export interface DeliverySummary {
  id: string
  ticketId: string
  title: string
  pipelineId: string
  pipelineName: string
  status: DeliveryStatus
  progress: number
  startedAt: string
  completedAt?: string
  createdByName?: string
  ownerTeam?: string
  duration?: string
  jobNumber?: number
}

export interface PagedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface BlockPort {
  name: string
  type: BlockType
  required: boolean
  description?: string
}

export type AdapterType = 'claude-skill' | 'mock' | 'native' | 'legacy-json'
export type SyncStatus = 'Synced' | 'Stale' | 'Unavailable' | 'Missing' | 'Local' | 'NeverSynced'

export interface BuildingBlock {
  id: string
  name: string
  role: BlockType
  description: string
  version: string
  inputs: BlockPort[]
  outputs: BlockPort[]
  tags: string[]
  verified?: boolean
  usageCount?: number
  createdAt: string
  updatedAt: string
  createdByName?: string
  usedInPipelineIds?: string[]
  contextRequirements?: string[]
  outputSchema?: string[]
  sourceType: SourceType
  agentRuntime: AgentRuntime
  artifactFormat: ArtifactFormat
  artifactName?: string
  cachedFiles?: string[]
  entryPointPath?: string
  syncStatus?: SyncStatus
  marketplaceSource?: string
  marketplacePath?: string
  marketplaceVersion?: string
  cachedAt?: string
  // Legacy fields for backward compatibility (to be removed)
  type?: BlockType
  adapterType?: AdapterType
  executorType?: string
}

export interface AgentInput {
  name: string
  value: unknown
}

export interface AgentOutput {
  name: string
  value: unknown
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface CreateDeliveryRequest {
  ticketId: string
  title: string
  pipelineId: string
  repoUrl: string
  workspaceType: WorkspaceType
  branch?: string
}

export interface UpdateDeliveryRequest {
  repoUrl?: string
  workspaceType?: WorkspaceType
  workspacePath?: string
}

export interface CreatePipelineRequest {
  name: string
  description: string
  nodes: Omit<PipelineNode, 'id'>[]
  edges: Omit<PipelineEdge, 'id'>[]
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
  output?: { status: string; confidence: number; summary: string; result: Record<string, unknown> }
  message?: string
  prUrl?: string
}

export interface CreateBlockRequest {
  name: string
  type: BlockType
  description: string
  inputs: BlockPort[]
  outputs: BlockPort[]
  tags: string[]
}
