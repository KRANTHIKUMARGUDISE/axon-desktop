import type { BlockRole, Visibility, DeliveryStatus, StepStatus, WorkspaceType, SourceType, AgentRuntime, ArtifactFormat, ExecutionType } from '@shared'

export type {
  DeliveryStatus, StepStatus, WorkspaceType, SourceType, AgentRuntime, ArtifactFormat, ExecutionType,
  DeliveryEvent, ResumePreview, ActionResult,
} from '@shared'
export { AGENTIC_TOOL_OPTIONS } from '@shared'
export type { AgenticTool } from '@shared'

export type NodeType = BlockRole
export type BlockType = BlockRole
export type BuildingBlockVisibility = Visibility

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
  pinnedVersion?: string | null
  /** D13: block version this node runs (pinned when the pipeline is published). */
  blockVersion?: number
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
  // Registry (S3): where it lives and its D13 lifecycle
  scope?: 'Personal' | 'Team' | 'Org'
  owner?: string
  team?: string
  status?: 'Draft' | 'Published' | 'Deprecated'
  derivedFrom?: { id: string; version: number }
  changeNote?: string
}

export interface StepAgentOutput {
  summary?: string
  confidence?: number
  missingFields?: string[]
  humanGateReason?: string
  result?: Record<string, unknown>
  errorCode?: string
  recoverable?: boolean
  // Gate resolution metadata — first-class fields (not inside `result`), since
  // `result` is excluded from the main delivery-detail response (lazy-loaded only).
  approvedBy?: string
  approvedAt?: string
  rejectedBy?: string
  rejectedAt?: string
  reviewComment?: string
  toolsUsed?: string[]
  toolsDenied?: string[]
  timedOut?: boolean
  isTruncated?: boolean
  outputFileRef?: string
}

export interface DeliveryStep {
  id: string
  nodeId?: string
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
  contextAvailability?: Record<string, 'available' | 'missing' | 'empty'>
  outputAvailability?: Record<string, 'available' | 'missing' | 'empty'>
}

export interface Delivery {
  id: string
  ticketId: string
  title: string
  pipelineId: string
  pipelineName: string
  pipelineSnapshot?: { name: string; nodes?: PipelineNode[]; edges?: PipelineEdge[] }
  status: DeliveryStatus
  currentNodeId?: string
  repoUrl: string
  workspaceType: WorkspaceType
  storeFullContext?: boolean
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
  errorMessage?: string
  localSeq?: number
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
  localSeq?: number
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

export type SyncStatus = 'Synced' | 'Stale' | 'Unavailable' | 'Missing' | 'Local' | 'NeverSynced'

export interface BuildingBlock {
  id: string
  name: string
  role: BlockType
  description: string
  version: number
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
  outputMapping?: Record<string, string>
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
  visibility?: BuildingBlockVisibility
  executionType?: ExecutionType
  allowedTools?: string[]
  defaultTimeoutSeconds?: number
  executionAgreementAcceptedAt?: string
  executionAgreementAcceptedBy?: string
  scope?: 'Personal' | 'Team' | 'Org'
  owner?: string
  team?: string
  status?: 'Draft' | 'Published' | 'Deprecated'
  versionLabel?: string
  changeNote?: string
  derivedFrom?: { id: string; version: number }
  immutable?: boolean
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

export type { ClaudeKeyStatus } from '@shared'

