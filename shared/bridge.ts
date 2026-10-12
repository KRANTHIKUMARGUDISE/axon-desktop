import type { ActionResult, ResumePreview } from './preview'
import type { DeliveryEvent } from './schemas'
import type { RegistryStatus } from './registry'

export interface ClaudeKeyStatus {
  hasKey: boolean
  masked: string | null
  source: string | null
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
  registry: {
    status(): Promise<RegistryStatus>
    syncNow(): Promise<RegistryStatus>
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
    stepData(deliveryId: string, nodeId: string, kind: 'context' | 'output'): Promise<Record<string, unknown>>
  }
  delivery: {
    start(id: string): Promise<ActionResult>
    resume(id: string): Promise<ActionResult>
    cancel(id: string): Promise<ActionResult>
    previewResume(id: string): Promise<ActionResult & { preview?: ResumePreview }>
    approveGate(id: string, comment?: string): Promise<ActionResult>
    rejectGate(id: string, comment: string): Promise<ActionResult>
    clearWorkspace(id: string): Promise<{ success: boolean; error?: string }>
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
  }
  dialog: {
    openDirectory(): Promise<string | null>
    openFile(): Promise<string | null>
  }
  shell: {
    openExternal(url: string): Promise<{ success: boolean; error?: string }>
    openPath(path: string): Promise<{ success: boolean; error?: string }>
    openInVSCode(path: string): Promise<{ success: boolean; error?: string }>
  }
  system: {
    getInfo(): Promise<{ electronVersion: string; nodeVersion: string; platform: string; appVersion: string }>
    checkForUpdates(): Promise<{ status: string; message: string }>
  }
  window: {
    setTitle(title: string): void
  }
}
