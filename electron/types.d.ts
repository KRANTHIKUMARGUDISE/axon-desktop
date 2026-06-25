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

export interface ResumePreview {
  resumeNodeId: string
  resumeNodeLabel: string
  resumeNodeRole?: string
  lastCompletedNodeLabel?: string
  hasPriorAttempt: boolean
  reconstructedContextKeys: string[]
  workspacePath?: string
  branch?: string
  allNodesCompleted: boolean
}

export interface ClaudeKeyStatus {
  hasKey: boolean
  masked: string | null
  source: string | null
  conflict: { claudeJson: string; configJson: string } | null
}

export interface AxonBridge {
  auth: {
    storeToken(token: string): Promise<void>
    getToken(): Promise<string | null>
    clearToken(): Promise<void>
    storeSecure(key: string, value: string): Promise<void>
    getSecure(key: string): Promise<string | null>
    clearSecure(key: string): Promise<void>
  }
  settings: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    getAll(): Promise<Record<string, unknown>>
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
  git: {
    clone(repoUrl: string, targetPath: string, token: string): Promise<{ success: boolean; error?: string }>
    status(workspacePath: string): Promise<{ success: boolean; error?: string; data?: unknown }>
    createBranch(workspacePath: string, branchName: string): Promise<{ success: boolean; error?: string }>
    addAndCommit(workspacePath: string, message: string): Promise<{ success: boolean; error?: string }>
    push(workspacePath: string, branch: string, token: string): Promise<{ success: boolean; error?: string }>
  }
  executor: {
    start(deliveryId: string): Promise<{ success: boolean; error?: string }>
    resume(deliveryId: string): Promise<{ success: boolean; error?: string }>
    previewResume(deliveryId: string): Promise<{ success: boolean; error?: string; preview?: ResumePreview }>
    cancel(deliveryId: string): Promise<{ success: boolean; error?: string }>
    onProgress(callback: (event: unknown, data: ExecutionProgress) => void): void
    offProgress(callback: (event: unknown, data: ExecutionProgress) => void): void
  }
  claude: {
    call(prompt: string, apiKey: string): Promise<{ success: boolean; error?: string; data?: string }>
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
    getLatency(baseUrl: string): Promise<{ latency: number | null; isHealthy: boolean; error: string | null }>
  }
  window: {
    setTitle(title: string): void
  }
}

declare global {
  interface Window {
    axon: AxonBridge
  }
}
