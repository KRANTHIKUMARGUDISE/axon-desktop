import type { ActionResult, ResumePreview } from './preview'
import type { DeliveryEvent } from './schemas'
import type { RegistryStatus, DeliveryRule } from './registry'
import type { RuleChainInfo, PipelineEffects } from './ruleChains'
import type { PipelineDiff } from './pipelineDiff'

export interface ClaudeKeyStatus {
  hasKey: boolean
  masked: string | null
  /** Which mode is active: 'linked' (Linked to Claude Code config) or 'entered' (Entered in AXON). */
  mode: 'linked' | 'entered' | null
  /** Human-readable active source, e.g. "Linked to Claude Code config (~/.claude.json)". */
  source: string | null
  /** Linked key missing or changed: the red status message. */
  problem: { kind: 'missing' | 'changed'; message: string } | null
  /** Linked file now holds a different key (masked): needs confirmation before use. */
  changed: { masked: string; source: string } | null
  conflict: { claudeJson: string; configJson: string } | null
  /** Key found in Claude's own config files — unused until the user confirms it (D3). */
  candidate: { masked: string; source: string } | null
}

export interface IdentityInfo {
  onboarded: boolean
  email: string
  displayName: string
  team: string
  machineName: string
}

export interface LicenseInfo {
  name: string
  version: string
  license: string
  repository?: string
  text: string
}

export interface JiraStatusInfo {
  configured: boolean
  site: string
  email: string
  displayName: string
  verifiedAt: string | null
  hasToken: boolean
}

export interface ConnectionTest {
  ok: boolean
  canRead: boolean
  canPush: boolean
  branchExists: boolean
  error?: string
}

export interface VersionEntry {
  version: number
  status: 'Draft' | 'Published' | 'Deprecated'
  versionLabel?: string
  changeNote?: string
  updatedAt: string
  scope: 'Personal' | 'Team' | 'Org'
  source: 'local' | 'registry'
}

export type PromoteTargetArg = { scope: 'Org' } | { scope: 'Team'; team: string }

// Documents cross the IPC boundary as plain JSON; the renderer services narrow them to
// the shared types (Block, Pipeline, Delivery), so the bridge keeps them as `unknown`.
export interface DeliveryRepos {
  deliveryFolder?: string
  repos: { name: string; path: string; branch: string; url?: string; prUrl?: string }[]
}

export interface CatalogView {
  entries: { name: string; url: string; defaultBranch?: string; description?: string; tags?: string[] }[]
  dropped: { index: number; name?: string; reason: string }[]
  /** Used, but adjusted (e.g. description truncated to 200 characters). */
  warnings: { index: number; name?: string; reason: string }[]
  /** The whole file is unusable (bad YAML / no repositories list). */
  error?: string
  exists: boolean
  filePath: string
  registryPath: string
  lastSyncAt: string | null
}

export interface GateReviewInfo {
  nodeId: string
  reason: string
  checklist: string[]
  mode: 'Pause' | 'NotifyOnly'
  repos: { repo: string; name: string; branch?: string; files: { status: string; path: string }[]; truncated: boolean }[]
  tests: { nodeId: string; blockName: string; summary: string; result: unknown }[]
  agents: { nodeId: string; blockName: string; itemKey: string | null; summary: string }[]
}

export interface PermissionReportInfo {
  ok: boolean
  /** One clear message per missing permission (or the connection problem). */
  missing: string[]
}

export interface WatcherInfo {
  /** D10 */
  role: {
    thisMachineName: string
    /** This machine may poll right now. */
    activeHere: boolean
    /** "Run watcher on this machine" is switched on here. */
    claimedHere: boolean
    other: { name: string; heartbeatAt: string; stale: boolean } | null
  }
  /** S5b "Pause all" (profile master switch, syncs): no polling anywhere while true. */
  paused: boolean
  rules: {
    ruleId: string
    lastPollAt: string | null
    lastError: string | null
    lastMatchAt: string | null
    lastMatchKey: string | null
    nextCheckAt: string | null
  }[]
  /** axon-running tickets with no local delivery: Resume or Release. */
  orphans: { key: string; summary: string; ruleId: string; foundAt: string }[]
  pendingWritebacks: number
  /** S5b: which rules trigger on what, and what each rule's pipeline sets in Jira (so spec → code → review chains are visible). */
  chains: { rules: RuleChainInfo[]; warnings: string[]; effects: Record<string, PipelineEffects> }
}

export interface AxonBridge {
  rules: {
    list(): Promise<DeliveryRule[]>
    save(input: unknown): Promise<DeliveryRule>
    /** Enabling re-checks Jira permissions and the pinned pipeline; it throws with the reasons. */
    setEnabled(id: string, enabled: boolean): Promise<DeliveryRule>
    delete(id: string): Promise<void>
    /** Plain-words differences between two published versions of a pipeline. */
    compareVersions(pipelineId: string, fromVersion: number, toVersion: number): Promise<PipelineDiff>
  }
  watcher: {
    status(): Promise<WatcherInfo>
    /** "Run watcher on this machine" (also the manual takeover from another machine). */
    setActiveHere(active: boolean): Promise<WatcherInfo>
    /** "Pause all": the master switch stored on the profile (syncs to other machines with the next registry sync). */
    setPaused(paused: boolean): Promise<WatcherInfo>
    /** "Check now" on one rule: runs that rule's query once. */
    checkNow(ruleId: string): Promise<WatcherInfo>
    /** "Retry now" for write-backs waiting for Jira. */
    retryWritebacks(): Promise<WatcherInfo>
    resolveOrphan(key: string, choice: 'resume' | 'release'): Promise<WatcherInfo>
  }
  secrets: {
    setGitToken(token: string): Promise<void>
    hasGitToken(): Promise<boolean>
    setJiraToken(token: string): Promise<void>
    hasJiraToken(): Promise<boolean>
    clearJiraToken(): Promise<void>
  }
  identity: {
    get(): Promise<IdentityInfo>
  }
  onboarding: {
    defaults(): Promise<{ registryUrl: string; branch: string; jiraSite: string }>
    testRegistry(url: string, branch: string): Promise<ConnectionTest>
    verifyJira(site: string, email: string, token: string): Promise<{ ok: boolean; email?: string; displayName?: string; error?: string }>
    verifyGithub(token: string): Promise<{ ok: boolean; login?: string; error?: string }>
    complete(input: { registryUrl: string; registryBranch: string; team: string; activityConsent: boolean }): Promise<{ success: boolean }>
  }
  jira: {
    status(): Promise<JiraStatusInfo>
    replaceToken(token: string): Promise<{ ok: boolean; error?: string }>
    test(): Promise<{ ok: boolean; error?: string; verifiedAt?: string }>
    /** Verifies a new account/site and holds it in main; nothing is saved until commitChange(). */
    stageChange(site: string, email: string, token: string): Promise<{ ok: boolean; error?: string; email?: string; displayName?: string; site?: string; identityChanges?: boolean }>
    commitChange(): Promise<{ success: boolean; identityChanged: boolean; email: string }>
    cancelChange(): Promise<void>
    /** Can the stored account read the project, edit labels and add comments? */
    checkPermissions(projectKey: string): Promise<PermissionReportInfo>
  }
  registry: {
    status(): Promise<RegistryStatus>
    syncNow(): Promise<RegistryStatus>
    /** The repository catalog from the local registry clone, incl. entries that were dropped and why. */
    catalog(): Promise<CatalogView>
    /** Live status (sync state, queued writes, offline) pushed from main. Returns an unsubscribe function. */
    onStatus(callback: (status: RegistryStatus) => void): () => void
  }
  versions: {
    list(kind: 'block' | 'pipeline', id: string): Promise<VersionEntry[]>
    publish(kind: 'block' | 'pipeline', id: string, meta?: { versionLabel?: string; changeNote?: string }): Promise<unknown>
    deprecate(kind: 'block' | 'pipeline', id: string): Promise<unknown>
    duplicate(kind: 'block' | 'pipeline', id: string): Promise<unknown>
    promote(kind: 'block' | 'pipeline', id: string, target: PromoteTargetArg, note?: string): Promise<{ prUrl: string; branch: string; version: number }>
  }
  settings: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    getAll(): Promise<Record<string, unknown>>
  }
  blocks: {
    list(): Promise<unknown[]>
    get(id: string): Promise<unknown | null>
    create(input: unknown): Promise<unknown>
    update(id: string, patch: unknown): Promise<unknown>
    delete(id: string): Promise<void>
  }
  pipelines: {
    list(): Promise<unknown[]>
    get(id: string): Promise<unknown | null>
    /** One published version of a pipeline (read-only history). */
    getVersion(id: string, version: number): Promise<unknown | null>
    create(input: unknown): Promise<unknown>
    update(id: string, patch: unknown): Promise<unknown>
    delete(id: string): Promise<void>
  }
  deliveries: {
    list(): Promise<unknown[]>
    get(id: string): Promise<unknown | null>
    create(input: unknown): Promise<unknown>
    stepData(deliveryId: string, nodeId: string, kind: 'context' | 'output', itemKey?: string): Promise<Record<string, unknown>>
  }
  delivery: {
    /** `queued`: the concurrency cap is reached — the delivery stays Pending and starts when a slot frees. */
    start(id: string): Promise<ActionResult & { queued?: boolean }>
    resume(id: string): Promise<ActionResult>
    cancel(id: string): Promise<ActionResult>
    previewResume(id: string): Promise<ActionResult & { preview?: ResumePreview }>
    approveGate(id: string, comment?: string): Promise<ActionResult>
    rejectGate(id: string, comment: string): Promise<ActionResult>
    /** Q7: files changed per repo, test results and agent summaries for the delivery's current gate. */
    gateReview(id: string): Promise<GateReviewInfo | null>
    clearWorkspace(id: string): Promise<{ success: boolean; error?: string }>
    workspaceSize(id: string): Promise<{ success: boolean; bytes: number }>
    /** The git repos this delivery worked in, derived from the recorded step folders (never scanned). */
    repos(id: string): Promise<DeliveryRepos>
    /** D18 pre-check for the New Delivery Workspace path: inside the root, a git repo, clean, not locked. */
    checkWorkspacePath(path: string): Promise<{ success: boolean; error?: string }>
  }
  events: {
    /** Subscribes to the single typed delivery event channel; returns an unsubscribe function. */
    onDeliveryEvent(callback: (event: DeliveryEvent) => void): () => void
    /** A desktop notification was clicked: open this delivery's Live View. Returns an unsubscribe function. */
    onOpenDelivery(callback: (deliveryId: string) => void): () => void
  }
  workspace: {
    readFile(path: string): Promise<string>
    listFilesRecursive(path: string, maxDepth?: number): Promise<string[]>
  }
  claudeKey: {
    getStatus(): Promise<ClaudeKeyStatus>
    set(value: string): Promise<ClaudeKeyStatus>
    confirmDetected(): Promise<ClaudeKeyStatus>
    rejectDetected(): Promise<ClaudeKeyStatus>
    confirmChanged(): Promise<ClaudeKeyStatus>
  }
  dialog: {
    openDirectory(startInWorkspaceRoot?: boolean): Promise<string | null>
    openFile(): Promise<string | null>
  }
  shell: {
    openExternal(url: string): Promise<{ success: boolean; error?: string }>
    openPath(path: string): Promise<{ success: boolean; error?: string }>
    openInVSCode(path: string): Promise<{ success: boolean; error?: string }>
  }
  system: {
    getFeatures(): Promise<{ intelligence: boolean }>
    getLicenses(): Promise<{ generatedAt: string | null; packages: LicenseInfo[] }>
    /** Copies an allow-listed diagnostics summary to the clipboard (main-side) and returns the text. */
    copyDiagnostics(): Promise<string>
    getInfo(): Promise<{ electronVersion: string; nodeVersion: string; platform: string; appVersion: string }>
    checkForUpdates(): Promise<{ status: string; message: string }>
  }
  window: {
    setTitle(title: string): void
  }
}
