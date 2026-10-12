import { z } from 'zod'

// Canonical document schemas shared by the Electron main process and the renderer.
// Every persisted document carries id + schemaVersion + createdAt + updatedAt; the
// same schemas are the future registry file schemas (S3) and an ApiStore's wire format.

export const SCHEMA_VERSION = 1

const meta = {
  id: z.string().min(1),
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  createdAt: z.string(),
  updatedAt: z.string(),
}

// ---------------------------------------------------------------- enums

export const BlockRoleSchema = z.enum(['Decision', 'Execution', 'Knowledge', 'Control', 'IO', 'Utility'])
export const SourceTypeSchema = z.enum(['Axon', 'Local', 'Marketplace', 'CDF'])
export const AgentRuntimeSchema = z.enum(['Axon', 'Claude', 'Codex'])
export const ArtifactFormatSchema = z.enum(['Native', 'Skill'])
export const ExecutionTypeSchema = z.enum(['Prompt', 'Agentic'])
export const VisibilitySchema = z.enum(['Personal', 'Team', 'Organisation'])
export const WorkspaceTypeSchema = z.enum(['Default', 'Browse'])

export const DeliveryStatusSchema = z.enum([
  'Pending', 'Running', 'Paused', 'Completed', 'Failed', 'Cancelled', 'Interrupted',
])
export const StepStatusSchema = z.enum([
  'Pending', 'Running', 'Completed', 'Failed', 'Skipped', 'AwaitingApproval',
])

export type BlockRole = z.infer<typeof BlockRoleSchema>
export type SourceType = z.infer<typeof SourceTypeSchema>
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>
export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>
export type ExecutionType = z.infer<typeof ExecutionTypeSchema>
export type Visibility = z.infer<typeof VisibilitySchema>
export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>
export type StepStatus = z.infer<typeof StepStatusSchema>

// ---------------------------------------------------------------- block

export const CachedFileSchema = z.object({ relativePath: z.string(), content: z.string() })
export type CachedFile = z.infer<typeof CachedFileSchema>

export const BlockSchema = z.object({
  ...meta,
  name: z.string().min(1),
  role: BlockRoleSchema,
  description: z.string().default(''),
  version: z.number().int().default(1),
  tags: z.array(z.string()).default([]),
  sourceType: SourceTypeSchema,
  agentRuntime: AgentRuntimeSchema,
  artifactFormat: ArtifactFormatSchema,
  artifactName: z.string().optional(),
  cachedFiles: z.array(CachedFileSchema).optional(),
  entryPointPath: z.string().optional(),
  contextRequirements: z.array(z.string()).optional(),
  outputSchema: z.array(z.string()).optional(),
  outputMapping: z.record(z.string(), z.string()).optional(),
  executionType: ExecutionTypeSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  defaultTimeoutSeconds: z.number().optional(),
  visibility: VisibilitySchema.optional(),
  verified: z.boolean().optional(),
  usageCount: z.number().optional(),
  createdByName: z.string().optional(),
  executionAgreementAcceptedAt: z.string().optional(),
  executionAgreementAcceptedBy: z.string().optional(),
  // Seeded Axon blocks are immutable — enforced in the store, not just hidden in the UI.
  immutable: z.boolean().optional(),
})
export type Block = z.infer<typeof BlockSchema>

// Input accepted when creating a block (store fills id/meta/version).
export const BlockInputSchema = BlockSchema.omit({
  id: true, schemaVersion: true, createdAt: true, updatedAt: true, version: true, immutable: true,
})
export type BlockInput = z.infer<typeof BlockInputSchema>

// ---------------------------------------------------------------- pipeline

export const BranchConditionSchema = z.object({
  expression: z.string(),
  targetNodeId: z.string(),
})

export const PipelineEdgeSchema = z.object({
  id: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  isDefault: z.boolean().optional(),
  condition: BranchConditionSchema.nullish(),
})
export type PipelineEdge = z.infer<typeof PipelineEdgeSchema>

export const PipelineNodeSchema = z.object({
  id: z.string(),
  type: BlockRoleSchema.optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  blockId: z.string(),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  config: z.record(z.string(), z.unknown()).optional(),
  timeoutSeconds: z.number().optional(),
  pinnedVersion: z.union([z.string(), z.number()]).nullish(),
})
export type PipelineNode = z.infer<typeof PipelineNodeSchema>

export const PipelineSchema = z.object({
  ...meta,
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.number().int().default(1),
  nodes: z.array(PipelineNodeSchema).default([]),
  edges: z.array(PipelineEdgeSchema).default([]),
  tags: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  createdByName: z.string().optional(),
  ownerTeam: z.string().optional(),
  visibility: z.string().optional(),
})
export type Pipeline = z.infer<typeof PipelineSchema>

export const PipelineInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  nodes: z.array(z.unknown()).default([]),
  edges: z.array(z.unknown()).default([]),
})
export type PipelineInput = z.infer<typeof PipelineInputSchema>

// ---------------------------------------------------------------- agent output / step

export const AgentOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'failed']),
  confidence: z.number().optional(),
  summary: z.string().default(''),
  result: z.record(z.string(), z.unknown()).default({}),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
  recoverable: z.boolean().optional(),
  toolsUsed: z.array(z.string()).optional(),
  toolsDenied: z.array(z.string()).optional(),
  timedOut: z.boolean().optional(),
  // DS1 — set by the engine when `result` is stored in {userData}/runs/{deliveryId}/.
  isTruncated: z.boolean().optional(),
  outputFileRef: z.string().optional(),
})
export type AgentOutput = z.infer<typeof AgentOutputSchema>

export const Availability = z.enum(['available', 'missing', 'empty'])

export const StepOutputSchema = AgentOutputSchema.extend({
  humanGateReason: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  rejectedBy: z.string().optional(),
  rejectedAt: z.string().optional(),
  reviewComment: z.string().optional(),
})
export type StepOutput = z.infer<typeof StepOutputSchema>

export const DeliveryStepSchema = z.object({
  nodeId: z.string(),
  // Reserved for ForEach items (Session 4); null for now.
  itemKey: z.string().nullable().default(null),
  blockId: z.string().optional(),
  blockName: z.string(),
  status: StepStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  contextSnapshot: z.record(z.string(), z.unknown()).optional(),
  isContextTruncated: z.boolean().optional(),
  contextFileRef: z.string().optional(),
  contextAvailability: z.record(z.string(), Availability).optional(),
  outputAvailability: z.record(z.string(), Availability).optional(),
  output: StepOutputSchema.optional(),
})
export type DeliveryStep = z.infer<typeof DeliveryStepSchema>

// ---------------------------------------------------------------- delivery

export const PipelineSnapshotSchema = z.object({
  pipelineId: z.string(),
  pipelineVersion: z.number().int(),
  name: z.string(),
  nodes: z.array(PipelineNodeSchema),
  edges: z.array(PipelineEdgeSchema),
  // Block ids + versions at creation time, so reruns don't drift.
  blockVersions: z.record(z.string(), z.number()).default({}),
})
export type PipelineSnapshot = z.infer<typeof PipelineSnapshotSchema>

export const DeliverySchema = z.object({
  ...meta,
  // Per-machine display counter only — never used in refs or paths (D1).
  localSeq: z.number().int(),
  ticketId: z.string(),
  title: z.string().default(''),
  pipelineId: z.string(),
  pipelineName: z.string(),
  pipelineVersion: z.number().int().default(1),
  pipelineSnapshot: PipelineSnapshotSchema,
  status: DeliveryStatusSchema,
  currentNodeId: z.string().optional(),
  repoUrl: z.string().default(''),
  workspaceType: WorkspaceTypeSchema.default('Default'),
  workspacePath: z.string().nullable().optional(),
  storeFullContext: z.boolean().optional(),
  steps: z.array(DeliveryStepSchema).default([]),
  branch: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  retriedFromDeliveryId: z.string().nullable().optional(),
  attemptNumber: z.number().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  createdByName: z.string().optional(),
  errorMessage: z.string().optional(),
})
export type Delivery = z.infer<typeof DeliverySchema>

export const CreateDeliveryInputSchema = z.object({
  ticketId: z.string().min(1),
  title: z.string().default(''),
  pipelineId: z.string().min(1),
  repoUrl: z.string().default(''),
  workspaceType: WorkspaceTypeSchema.default('Default'),
  storeFullContext: z.boolean().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  retriedFromDeliveryId: z.string().optional(),
})
export type CreateDeliveryInput = z.infer<typeof CreateDeliveryInputSchema>

// ---------------------------------------------------------------- events (D2)

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), deliveryId: z.string(), at: z.string(), ...shape })

export const DeliveryEventSchema = z.discriminatedUnion('type', [
  ev('workspace_provisioning', {}),
  ev('workspace_provisioned', { workspacePath: z.string() }),
  ev('git_preparing', { repoUrl: z.string() }),
  ev('git_prepared', { branch: z.string().optional() }),
  ev('step_started', { nodeId: z.string(), blockName: z.string() }),
  ev('step_completed', { nodeId: z.string(), blockName: z.string(), output: AgentOutputSchema }),
  ev('step_failed', {
    nodeId: z.string(), blockName: z.string(), message: z.string(), output: AgentOutputSchema.optional(),
  }),
  ev('gate_reached', { nodeId: z.string(), blockName: z.string(), output: AgentOutputSchema }),
  ev('gate_approved', { nodeId: z.string(), approvedBy: z.string(), comment: z.string().optional() }),
  ev('gate_rejected', { nodeId: z.string(), rejectedBy: z.string(), comment: z.string() }),
  ev('status_changed', { status: DeliveryStatusSchema }),
  ev('completed', { prUrl: z.string().optional() }),
  ev('failed', { message: z.string(), nodeId: z.string().optional() }),
  ev('cancelled', {}),
  ev('interrupted', {}),
])
export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>
export type DeliveryEventType = DeliveryEvent['type']

// ---------------------------------------------------------------- settings

export const SettingsSchema = z.object({
  workspaceRoot: z.string().default(''),
  gitProvider: z.string().default('github'),
  theme: z.string().default('dark'),
  setupComplete: z.boolean().default(false),
  userEmail: z.string().default(''),
  userName: z.string().default(''),
  maxContextSnapshotSizeKb: z.number().default(50),
})
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsKey = keyof Settings
