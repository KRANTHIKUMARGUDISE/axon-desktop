import { z } from 'zod'
import { SCHEMA_VERSION, ScopeSchema, DeliveryStatusSchema, TriggerSchema, FailureCategorySchema } from './schemas'

// File schemas for the axon-registry repo (D9). Every document carries id, schemaVersion, scope
// and owner so a later DB import is a straight folder -> collection load.

export const RegistryManifestSchema = z.object({
  schemaVersion: z.number().int(),
  minAppVersion: z.string().default('0.0.0'),
})
export type RegistryManifest = z.infer<typeof RegistryManifestSchema>

export const MachineSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(100),
  lastSeen: z.string(),
})
export type Machine = z.infer<typeof MachineSchema>

// users/{email}/profile.yaml
export const ProfileSchema = z.object({
  id: z.string().min(1), // = email
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  scope: ScopeSchema.default('Personal'),
  owner: z.string().min(1),
  email: z.string().min(1),
  displayName: z.string().max(200).default(''),
  team: z.string().max(60).default(''),
  machines: z.array(MachineSchema).default([]),
  // D10: the one machine whose watcher polls Jira. Heartbeat rides the registry sync; takeover is manual.
  activeMachine: z.object({ id: z.string().min(1), heartbeatAt: z.string() }).optional(),
  // S5b: master switch. Paused = no rule polls on any machine; separate from which machine is active.
  pausedAll: z.boolean().default(false),
  pausedAt: z.string().optional(),
})
export type Profile = z.infer<typeof ProfileSchema>

// users/{email}/rules/{id}.yaml — a Jira watcher rule (S5).
export const DeliveryRuleSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  scope: ScopeSchema.default('Personal'),
  owner: z.string().min(1),
  name: z.string().min(1).max(100),
  // S5b: what starts the rule. Only 'jira' exists in v1; a future GitHub PR source is additive.
  source: z.literal('jira').default('jira'),
  enabled: z.boolean().default(false),
  jiraProjectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/, 'Jira project key, e.g. ABC'),
  // Ready signal: a label (default) or a status name. When readyStatus is set it wins.
  readyLabel: z.string().regex(/^[^\s]+$/, 'labels cannot contain spaces').max(255).default('axon-ready'),
  readyStatus: z.string().max(100).optional(),
  pipelineId: z.string().min(1),
  pipelineVersion: z.number().int().min(1),
  // D18: optional default Workspace path; must be inside the Workspace Root (checked in main).
  defaultWorkspacePath: z.string().max(1024).optional(),
  pollIntervalMinutes: z.number().int().min(2).max(1440).default(5),
  // S5b: one comment per outcome (completed / failed / cancelled) with links.
  postOutcomeComment: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type DeliveryRule = z.infer<typeof DeliveryRuleSchema>
export const SaveRuleInputSchema = DeliveryRuleSchema.omit({ schemaVersion: true, scope: true, owner: true, createdAt: true, updatedAt: true, id: true })
  .extend({ id: z.string().optional() })
export type SaveRuleInput = z.infer<typeof SaveRuleInputSchema>

// users/{email}/activity.log — one JSON object per line. Contains email + machine name only
// (consent is collected in onboarding).
export const ActivityEntrySchema = z.object({
  at: z.string(),
  event: z.enum(['launch', 'login']),
  email: z.string(),
  machine: z.string().max(100),
  appVersion: z.string().max(40),
})
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>

// users/{email}/runs/{yyyy-mm}/{deliveryId}.json — an explicit whitelist. `.strict()` makes a
// stray field a parse error; toRunSummary() copies fields one by one and never spreads a step
// output, context or summary (those can contain customer code and secrets).
export const RUN_TEXT_CAP = 200

const RunStepSummarySchema = z.strictObject({
  nodeId: z.string(),
  blockId: z.string().optional(),
  blockName: z.string().max(RUN_TEXT_CAP),
  status: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
})

const GateOutcomeSchema = z.strictObject({
  nodeId: z.string(),
  blockName: z.string().max(RUN_TEXT_CAP),
  outcome: z.enum(['approved', 'rejected']),
  by: z.string().max(RUN_TEXT_CAP),
  at: z.string(),
})

export const RunSummarySchema = z.strictObject({
  id: z.string(),
  schemaVersion: z.number().int(),
  scope: z.literal('Personal'),
  owner: z.string(),
  ticketId: z.string().max(RUN_TEXT_CAP),
  status: DeliveryStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  pipelineId: z.string(),
  pipelineVersion: z.number().int(),
  blockVersions: z.record(z.string(), z.number()),
  rerunOf: z.string().optional(),
  rerunReason: z.string().max(RUN_TEXT_CAP * 2).optional(),
  // Story chain: attempt N of the same ticket story; a Superseded run points to the attempt that replaced it.
  attemptNumber: z.number().int().optional(),
  supersededBy: z.string().optional(),
  gates: z.array(GateOutcomeSchema),
  steps: z.array(RunStepSummarySchema),
  prUrls: z.array(z.string().max(500)),
  repoUrls: z.array(z.string().max(500)),
  catalogVersion: z.string().max(64).optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
  // S5 (maturity Q7/Q9/Q11/Q13): counts and enums only — never free text from agents.
  trigger: TriggerSchema.optional(),
  ruleId: z.string().max(100).optional(),
  gateCount: z.number().int().optional(),
  gatesPaused: z.number().int().optional(),
  interventions: z.number().int().optional(),
  aiSteps: z.number().int().optional(),
  builtInSteps: z.number().int().optional(),
  failureCategory: FailureCategorySchema.optional(),
  totalTokens: z.number().optional(),
})
export type RunSummary = z.infer<typeof RunSummarySchema>

export type RegistryState = 'Unconfigured' | 'Idle' | 'Syncing' | 'Offline' | 'NeedsAttention' | 'ReadOnly'

export interface RegistryStatus {
  state: RegistryState
  lastSyncAt: string | null
  lastError: string | null
  queued: number
  /** Queued writes that the pre-push secret scan refused (kept on disk, never pushed). */
  rejected: { path: string; rule: string }[]
  registryUrl: string
  branch: string
  intervalMinutes: number
}
