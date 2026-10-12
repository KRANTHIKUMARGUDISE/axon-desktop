import { z } from 'zod'
import { parseRepoUrl } from './repoUrl'

// Canonical document schemas shared by the Electron main process and the renderer.
// Every persisted document carries id + schemaVersion + createdAt + updatedAt; the
// same schemas are the future registry file schemas (S3) and an ApiStore's wire format.

// v2 (S3): scope/owner/status on blocks + pipelines (D9, D13). The reader tolerates N-1 and
// upgrades in memory (shared/migrations.ts).
export const SCHEMA_VERSION = 2
export const MIN_READABLE_SCHEMA_VERSION = SCHEMA_VERSION - 1

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
export const ScopeSchema = z.enum(['Personal', 'Team', 'Org'])
export const DocStatusSchema = z.enum(['Draft', 'Published', 'Deprecated'])
export const DerivedFromSchema = z.object({ id: z.string(), version: z.number().int() })
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
export type Scope = z.infer<typeof ScopeSchema>
export type DocStatus = z.infer<typeof DocStatusSchema>
export type DerivedFrom = z.infer<typeof DerivedFromSchema>
export type Visibility = z.infer<typeof VisibilitySchema>
export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>
export type StepStatus = z.infer<typeof StepStatusSchema>

// Registry fields carried by every shareable definition (block / pipeline). `scope` + `owner`
// make a later folder -> DB collection import a straight load (D9). `version` is the number of
// this document: a Draft holds the version it will become when published; Published versions are
// immutable and stored one file per version (D13).
const registryFields = {
  scope: ScopeSchema.default('Personal'),
  owner: z.string().default(''),
  team: z.string().optional(),
  status: DocStatusSchema.default('Draft'),
  versionLabel: z.string().max(60).optional(),
  changeNote: z.string().max(500).optional(),
  derivedFrom: DerivedFromSchema.optional(),
}

// ---------------------------------------------------------------- block

export const CachedFileSchema = z.object({ relativePath: z.string(), content: z.string() })
export type CachedFile = z.infer<typeof CachedFileSchema>

export const BlockSchema = z.object({
  ...meta,
  ...registryFields,
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
  scope: true, owner: true, team: true, status: true, versionLabel: true, changeNote: true, derivedFrom: true,
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
  // D13: the block version this node runs. Pinned when the pipeline is published.
  blockVersion: z.number().int().optional(),
})
export type PipelineNode = z.infer<typeof PipelineNodeSchema>

export const PipelineSchema = z.object({
  ...meta,
  ...registryFields,
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
  // Optional model usage reported by runners that know it; only these numbers reach run summaries.
  usage: z.object({
    inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(),
  }).optional(),
  summary: z.string().default(''),
  result: z.record(z.string(), z.unknown()).default({}),
  errorMessage: z.string().optional(),
  errorCode: z.string().optional(),
  recoverable: z.boolean().optional(),
  toolsUsed: z.array(z.string()).optional(),
  toolsDenied: z.array(z.string()).optional(),
  // Human-readable reason per denied tool call (policy hook), e.g. "Write: path outside the delivery worktree".
  denials: z.array(z.string()).optional(),
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
  rerunReason: z.string().max(500).optional(),
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
  rerunReason: z.string().max(500).optional(),
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
  // S3 registry + identity
  registryUrl: z.string().default(''),
  registryBranch: z.string().default(''),
  syncIntervalMinutes: z.number().default(5),
  jiraSite: z.string().default(''),
  team: z.string().default(''),
  activityConsent: z.boolean().default(false),
})
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsKey = keyof Settings

// Renderer-writable settings: one validator per key (no generic "set anything" path).
// gitTokenSuffix is deliberately absent — main derives it from the token itself.
// setupComplete / userEmail / userName / jiraSite are deliberately NOT here: onboarding verifies the
// engineer's Jira identity in main and writes them itself, so the renderer cannot forge an identity.
/** Jira Cloud site host. Used by onboarding (main) — not a renderer-writable setting. */
export const JiraSiteSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i, 'must look like yourcompany.atlassian.net')
const AbsolutePath = z
  .string()
  .min(3)
  .max(1024)
  .refine((p) => /^([A-Za-z]:[\\/]|\/)/.test(p), 'must be an absolute path')
  .refine((p) => !/^[\\/]{2}/.test(p), 'UNC/device paths are not allowed')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ..')
  .refine((p) => !/^([A-Za-z]:)?[\\/]?$/.test(p), 'must not be a filesystem root')
export const SETTING_VALIDATORS = {
  workspaceRoot: z.union([z.literal(''), AbsolutePath]),
  gitProvider: z.enum(['github', 'azure', 'azuredevops']),
  theme: z.enum(['dark', 'light', 'system']),
  maxContextSnapshotSizeKb: z.number().int().min(1).max(10240),
  // '' = use the build-time default / branch 'main'.
  registryUrl: z.union([z.literal(''), z.string().refine((u) => parseRepoUrl(u) !== null, 'must be an https://, ssh:// or git@host:path URL')]),
  registryBranch: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/).refine((b) => !b.includes('..'), 'invalid branch')]),
  syncIntervalMinutes: z.number().int().min(1).max(1440),
  team: z.string().max(60).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$|^$/),
  activityConsent: z.boolean(),
} as const
export type WritableSettingKey = keyof typeof SETTING_VALIDATORS

/** https-only URL whose host is on the allow-list (or any host when `hosts` is omitted). */
export function parseHttpsUrl(value: unknown, hosts?: readonly string[]): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (hosts && !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return null
  return url
}
