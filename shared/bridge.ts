import type { ActionResult, ResumePreview } from './preview'
import type { DeliveryEvent } from './schemas'
import type { RegistryStatus } from './registry'

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

export interface AxonBridge {
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
    start(id: string): Promise<ActionResult>
    resume(id: string): Promise<ActionResult>
    cancel(id: string): Promise<ActionResult>
    previewResume(id: string): Promise<ActionResult & { preview?: ResumePreview }>
    approveGate(id: string, comment?: string): Promise<ActionResult>
    rejectGate(id: string, comment: string): Promise<ActionResult>
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
