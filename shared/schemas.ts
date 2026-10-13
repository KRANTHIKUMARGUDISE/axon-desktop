import { z } from 'zod'
import { parseRepoUrl } from './repoUrl'
import { OnFailureActionSchema } from './actions'

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
  // A Failed/Cancelled delivery that was re-run: the newer delivery (supersededBy) carries the story on.
  'Superseded',
])

// Why a delivery is being re-run (asked when the user chooses Rerun).
export const RERUN_REASONS = ['RequirementUpdated', 'AgentUpdated', 'PlatformRetry', 'Other'] as const
export const RerunReasonSchema = z.enum(RERUN_REASONS)
export type RerunReason = z.infer<typeof RerunReasonSchema>
export const StepStatusSchema = z.enum([
  'Pending', 'Running', 'Completed', 'Failed', 'Skipped', 'AwaitingApproval',
  // The step was running when the user cancelled / AXON stopped: not a failure of the step itself.
  'Cancelled', 'Interrupted',
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

// outputSchema entries are plain field names (untyped) or {name, type}. A field typed `WorkItemList`
// is what a ForEach node's "Iterate over" picker offers (D14/D16).
// `itemFields` (WorkItemList only): extra per-item fields the list provides beyond key/task/workspacePath (handoff contract).
export const OutputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).optional(),
  itemFields: z.array(z.string().min(1)).optional(),
})
export const OutputSchemaEntrySchema = z.union([z.string(), OutputFieldSchema])
export type OutputSchemaEntry = z.infer<typeof OutputSchemaEntrySchema>
export const ContextModeSchema = z.enum(['Selective', 'Full'])
export type ContextMode = z.infer<typeof ContextModeSchema>
export const WORK_ITEM_LIST_TYPE = 'WorkItemList'

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
  outputSchema: z.array(OutputSchemaEntrySchema).optional(),
  // B1: unset/Selective (default) = a block only sees the fields it declares; Full must be chosen explicitly.
  contextMode: ContextModeSchema.optional(),
  outputMapping: z.record(z.string(), z.string()).optional(),
  executionType: ExecutionTypeSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  // Handoff contract: item fields this block needs from the WorkItemList it consumes (e.g. ["repo"]).
  requiredItemFields: z.array(z.string().min(1)).optional(),
  // Only with `repoCatalog` in contextRequirements: inject just the catalog repos carrying one of these tags.
  catalogTags: z.array(z.string().min(1)).optional(),
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

export const ForEachOnEmptySchema = z.enum(['skip', 'fail'])

// A pipeline node is a block node (`blockId`; `type` is the legacy role value or 'block') or a ForEach
// node (`type: 'forEach'`, no block — D14). One flat list: a node with `parentId` lives inside that ForEach.
export const PipelineNodeSchema = z.object({
  id: z.string(),
  type: z.union([z.literal('forEach'), z.literal('block'), BlockRoleSchema]).optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  blockId: z.string().default(''),
  parentId: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  config: z.record(z.string(), z.unknown()).optional(),
  timeoutSeconds: z.number().optional(),
  pinnedVersion: z.union([z.string(), z.number()]).nullish(),
  // D13: the block version this node runs. Pinned when the pipeline is published.
  blockVersion: z.number().int().optional(),
  // ---- ForEach only (D16: it iterates its single direct predecessor's WorkItemList; items run in list order)
  maxItems: z.number().int().min(1).max(1000).optional(), // default 10
  onEmpty: ForEachOnEmptySchema.optional(), // default fail
  size: z.object({ width: z.number(), height: z.number() }).optional(),
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
  // S5b: ordered actions that run only when a delivery fails (and, if ticked, when it is cancelled).
  onFailure: z.array(OnFailureActionSchema).default([]),
  onFailureOnCancel: z.boolean().default(false),
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
  onFailure: z.array(OnFailureActionSchema).optional(),
  onFailureOnCancel: z.boolean().optional(),
})
export type PipelineInput = z.infer<typeof PipelineInputSchema>

// ---------------------------------------------------------------- agent output / step

export const AgentOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'failed']),
  confidence: z.number().optional(),
  // Optional model usage reported by runners that know it; only these numbers reach run summaries.
  usage: z.object({
    inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(),
    model: z.string().max(100).optional(), costEstimated: z.boolean().optional(),
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
  // S5 gate config recorded on the step: the checklist shown to the reviewer and the mode that was in effect.
  gateChecklist: z.array(z.string()).optional(),
  gateMode: z.enum(['Pause', 'NotifyOnly']).optional(),
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
  // S5: runtime of the block that ran ('Axon' = built-in, others = AI) for "AI steps vs built-in steps".
  agentRuntime: z.string().optional(),
  // 15b: automatic retries of Platform failures inside this step (git/network/HTTP), logged here.
  retries: z.array(z.object({ attempt: z.number().int(), at: z.string(), message: z.string() })).optional(),
  // The resolved working folder the block ran in (D17). PR Creator derives its repos from these.
  cwd: z.string().optional(),
  status: StepStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  contextSnapshot: z.record(z.string(), z.unknown()).optional(),
  isContextTruncated: z.boolean().optional(),
  contextFileRef: z.string().optional(),
  contextAvailability: z.record(z.string(), Availability).optional(),
  outputAvailability: z.record(z.string(), Availability).optional(),
  // The repoCatalog injected into this step (opt-in context field): how many repos, roughly how many tokens.
  catalogStats: z.object({ repos: z.number(), approxTokens: z.number() }).optional(),
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
  // S5b: pinned with the pipeline version so a delivery's on-failure actions never drift.
  onFailure: z.array(OnFailureActionSchema).default([]),
  onFailureOnCancel: z.boolean().default(false),
  // Block ids + versions at creation time, so reruns don't drift.
  blockVersions: z.record(z.string(), z.number()).default({}),
})
export type PipelineSnapshot = z.infer<typeof PipelineSnapshotSchema>

export const RepositoryRefSchema = z.object({ url: z.string().min(1), branch: z.string().optional() })
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>

export const TriggerSchema = z.enum(['Manual', 'Watcher'])
export type Trigger = z.infer<typeof TriggerSchema>

export const FAILURE_CATEGORIES = ['Requirement', 'Agent', 'Platform'] as const
export const FailureCategorySchema = z.enum(FAILURE_CATEGORIES)
export type FailureCategory = z.infer<typeof FailureCategorySchema>

export const INTERVENTION_KINDS = ['GateRejected', 'RerunAfterFailure', 'EditBeforeApproval', 'ManualStartWatcherEligible'] as const
export const InterventionSchema = z.object({
  kind: z.enum(INTERVENTION_KINDS),
  at: z.string(),
  nodeId: z.string().optional(),
})
export type Intervention = z.infer<typeof InterventionSchema>

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
  // Catalog repositories picked on the Manual Delivery screen; fed to the context as `repositories`.
  repositories: z.array(RepositoryRefSchema).optional(),
  prUrls: z.array(z.object({ repo: z.string(), url: z.string() })).optional(),
  // Registry commit of the repository catalog an agent saw (recorded when a block declared repoCatalog).
  catalogVersion: z.string().optional(),
  // ForEach item keys in run order, frozen when the ForEach first runs so resume is deterministic.
  itemPlan: z.record(z.string(), z.object({
    items: z.array(z.object({ key: z.string() })),
  })).optional(),
  // D17: {workspaceRoot}/deliveries/{id}/ — created at start; nodes without a workspace run here.
  deliveryFolder: z.string().optional(),
  // D18: set when `workspacePath` (the optional default folder) had a delivery branch created in it.
  workspaceBase: z.object({ originalBranch: z.string(), branch: z.string() }).optional(),
  // Set when ending the delivery had to stash leftovers (or could not restore the branch): shown in the Live View.
  workspaceNotice: z.object({
    kind: z.enum(['stashed', 'not-restored']),
    message: z.string(),
    folder: z.string(),
    stashName: z.string().optional(),
  }).optional(),
  retriedFromDeliveryId: z.string().nullable().optional(),
  rerunReason: z.string().max(500).optional(),
  attemptNumber: z.number().optional(),
  // Set when this delivery was re-run (status Superseded): the id of the newer attempt.
  supersededBy: z.string().optional(),
  // S5: how the delivery started, and (for the watcher) which rule/ticket claimed it.
  trigger: TriggerSchema.optional(),
  ruleId: z.string().optional(),
  claimKey: z.string().optional(),
  // S5 Part C: set on every Failed delivery (Requirement | Agent | Platform).
  failureCategory: FailureCategorySchema.optional(),
  // S5b: what the pipeline's "On failure" actions did after this delivery failed (or was cancelled). Never changes the status.
  onFailureResults: z.array(z.object({ at: z.string(), event: z.enum(['failed', 'cancelled']), ok: z.boolean(), message: z.string().max(1000) })).optional(),
  // S5 Q13: counted per the intervention definition (see shared/metrics.ts).
  interventions: z.array(InterventionSchema).optional(),
  // S5: tree hash of the repo working trees when the current gate was reached (edit detection).
  gateTreeHashes: z.record(z.string(), z.string()).optional(),
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
  // D18: optional default Workspace path (a clean git repo inside the Workspace Root).
  workspacePath: z.string().optional(),
  repositories: z.array(RepositoryRefSchema).optional(),
  retriedFromDeliveryId: z.string().optional(),
  rerunReason: RerunReasonSchema.optional(),
  trigger: TriggerSchema.optional(),
  ruleId: z.string().optional(),
  // Watcher: `${jiraKey}:${ruleId}:${rerunSeq}` — one delivery per key, across restarts.
  claimKey: z.string().max(200).optional(),
  // Run this published version of the pipeline (a watcher rule pins one); default = the current one.
  pipelineVersion: z.number().int().min(1).optional(),
  // Set by main (never trusted from the renderer): a Manual start of something an enabled watcher rule could have run.
  watcherEligible: z.boolean().optional(),
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
  ev('step_started', { nodeId: z.string(), blockName: z.string(), itemKey: z.string().optional() }),
  ev('step_completed', { nodeId: z.string(), blockName: z.string(), output: AgentOutputSchema, itemKey: z.string().optional() }),
  ev('step_failed', {
    nodeId: z.string(), blockName: z.string(), message: z.string(), output: AgentOutputSchema.optional(), itemKey: z.string().optional(),
  }),
  ev('gate_reached', { nodeId: z.string(), blockName: z.string(), output: AgentOutputSchema }),
  ev('gate_approved', { nodeId: z.string(), approvedBy: z.string(), comment: z.string().optional() }),
  ev('gate_rejected', { nodeId: z.string(), rejectedBy: z.string(), comment: z.string() }),
  // Notify-only gate: a review is due but the delivery does not pause.
  ev('gate_notified', { nodeId: z.string(), blockName: z.string(), reason: z.string().optional() }),
  ev('item_started', { nodeId: z.string(), itemKey: z.string(), index: z.number().int(), total: z.number().int() }),
  ev('item_completed', { nodeId: z.string(), itemKey: z.string(), index: z.number().int(), total: z.number().int() }),
  ev('item_failed', {
    nodeId: z.string(), itemKey: z.string(), index: z.number().int(), total: z.number().int(), message: z.string(),
  }),
  ev('workspace_notice', { message: z.string() }),
  ev('status_changed', { status: DeliveryStatusSchema }),
  ev('completed', { prUrl: z.string().optional() }),
  ev('failed', { message: z.string(), nodeId: z.string().optional(), failureCategory: FailureCategorySchema.optional() }),
  ev('cancelled', {}),
  ev('interrupted', {}),
])
export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>
export type DeliveryEventType = DeliveryEvent['type']

// ---------------------------------------------------------------- settings

export const ModelPriceSchema = z.object({
  inputPerMTok: z.number().min(0).max(100000),
  outputPerMTok: z.number().min(0).max(100000),
})
export type ModelPrice = z.infer<typeof ModelPriceSchema>

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
  jiraVerifiedAt: z.string().default(''),
  team: z.string().default(''),
  activityConsent: z.boolean().default(false),
  maxConcurrentDeliveries: z.number().default(1),
  // S5b: $ per million tokens by model id, used to price Prompt steps (Agentic steps keep SDK cost).
  modelPrices: z.record(z.string(), ModelPriceSchema).default({}),
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
  maxConcurrentDeliveries: z.number().int().min(1).max(10),
  modelPrices: z
    .record(z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/), ModelPriceSchema)
    .refine((r) => Object.keys(r).length <= 50, 'too many models'),
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
