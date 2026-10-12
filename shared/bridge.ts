import type { ActionResult, ResumePreview } from './preview'
import type { DeliveryEvent } from './schemas'

export interface ClaudeKeyStatus {
  hasKey: boolean
  masked: string | null
  source: string | null
  conflict: { claudeJson: string; configJson: string } | null
}

// Documents cross the IPC boundary as plain JSON; the renderer services narrow them to
// the shared types (Block, Pipeline, Delivery), so the bridge keeps them as `unknown`.
export interface AxonBridge {
  secrets: {
    setGitToken(token: string): Promise<void>
    hasGitToken(): Promise<boolean>
    clearGitToken(): Promise<void>
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
  }
  events: {
    /** Subscribes to the single typed delivery event channel; returns an unsubscribe function. */
    onDeliveryEvent(callback: (event: DeliveryEvent) => void): () => void
  }
  workspace: {
    listDirs(path: string): Promise<string[]>
    exists(path: string): Promise<boolean>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    createDir(path: string): Promise<void>
    listFilesRecursive(path: string, maxDepth?: number): Promise<string[]>
    clear(path: string): Promise<{ success: boolean; error?: string }>
  }
  claudeKey: {
    getStatus(): Promise<ClaudeKeyStatus>
    set(value: string): Promise<ClaudeKeyStatus>
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
