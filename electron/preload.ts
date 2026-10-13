import { contextBridge, ipcRenderer } from 'electron'

// Keep the channel name in sync with electron/ipc/delivery.ts (DELIVERY_EVENT_CHANNEL).
const DELIVERY_EVENT = 'delivery:event'
const REGISTRY_STATUS = 'registry:status'

contextBridge.exposeInMainWorld('axon', {
  secrets: {
    setGitToken: (token: string) => ipcRenderer.invoke('secrets:setGitToken', token),
    hasGitToken: () => ipcRenderer.invoke('secrets:hasGitToken'),
    setJiraToken: (token: string) => ipcRenderer.invoke('secrets:setJiraToken', token),
    hasJiraToken: () => ipcRenderer.invoke('secrets:hasJiraToken'),
    clearJiraToken: () => ipcRenderer.invoke('secrets:clearJiraToken'),
  },
  identity: {
    get: () => ipcRenderer.invoke('identity:get'),
  },
  onboarding: {
    defaults: () => ipcRenderer.invoke('onboarding:defaults'),
    testRegistry: (url: string, branch: string) => ipcRenderer.invoke('onboarding:testRegistry', url, branch),
    verifyJira: (site: string, email: string, token: string) => ipcRenderer.invoke('onboarding:verifyJira', site, email, token),
    verifyGithub: (token: string) => ipcRenderer.invoke('onboarding:verifyGithub', token),
    complete: (input: unknown) => ipcRenderer.invoke('onboarding:complete', input),
  },
  jira: {
    status: () => ipcRenderer.invoke('jira:status'),
    replaceToken: (token: string) => ipcRenderer.invoke('jira:replaceToken', token),
    test: () => ipcRenderer.invoke('jira:test'),
    stageChange: (site: string, email: string, token: string) => ipcRenderer.invoke('jira:stageChange', site, email, token),
    commitChange: () => ipcRenderer.invoke('jira:commitChange'),
    cancelChange: () => ipcRenderer.invoke('jira:cancelChange'),
  },
  registry: {
    status: () => ipcRenderer.invoke('registry:status'),
    syncNow: () => ipcRenderer.invoke('registry:syncNow'),
    catalog: () => ipcRenderer.invoke('registry:catalog'),
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: unknown) => callback(data)
      ipcRenderer.on(REGISTRY_STATUS, listener)
      return () => ipcRenderer.removeListener(REGISTRY_STATUS, listener)
    },
  },
  versions: {
    list: (kind: string, id: string) => ipcRenderer.invoke('versions:list', kind, id),
    publish: (kind: string, id: string, meta?: unknown) => ipcRenderer.invoke('versions:publish', kind, id, meta),
    deprecate: (kind: string, id: string) => ipcRenderer.invoke('versions:deprecate', kind, id),
    duplicate: (kind: string, id: string) => ipcRenderer.invoke('versions:duplicate', kind, id),
    promote: (kind: string, id: string, target: unknown, note?: string) => ipcRenderer.invoke('versions:promote', kind, id, target, note),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },
  blocks: {
    list: () => ipcRenderer.invoke('blocks:list'),
    get: (id: string) => ipcRenderer.invoke('blocks:get', id),
    create: (input: unknown) => ipcRenderer.invoke('blocks:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('blocks:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('blocks:delete', id),
  },
  pipelines: {
    list: () => ipcRenderer.invoke('pipelines:list'),
    get: (id: string) => ipcRenderer.invoke('pipelines:get', id),
    create: (input: unknown) => ipcRenderer.invoke('pipelines:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('pipelines:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('pipelines:delete', id),
  },
  deliveries: {
    list: () => ipcRenderer.invoke('deliveries:list'),
    get: (id: string) => ipcRenderer.invoke('deliveries:get', id),
    create: (input: unknown) => ipcRenderer.invoke('deliveries:create', input),
    stepData: (deliveryId: string, nodeId: string, kind: 'context' | 'output', itemKey?: string) =>
      ipcRenderer.invoke('deliveries:stepData', deliveryId, nodeId, kind, itemKey),
  },
  delivery: {
    start: (id: string) => ipcRenderer.invoke('delivery:start', id),
    resume: (id: string) => ipcRenderer.invoke('delivery:resume', id),
    cancel: (id: string) => ipcRenderer.invoke('delivery:cancel', id),
    previewResume: (id: string) => ipcRenderer.invoke('delivery:previewResume', id),
    approveGate: (id: string, comment?: string) => ipcRenderer.invoke('delivery:approveGate', id, comment),
    rejectGate: (id: string, comment: string) => ipcRenderer.invoke('delivery:rejectGate', id, comment),
    clearWorkspace: (id: string) => ipcRenderer.invoke('delivery:clearWorkspace', id),
    workspaceSize: (id: string) => ipcRenderer.invoke('delivery:workspaceSize', id),
    repos: (id: string) => ipcRenderer.invoke('delivery:repos', id),
    checkWorkspacePath: (path: string) => ipcRenderer.invoke('delivery:checkWorkspacePath', path),
  },
  events: {
    // Returns an unsubscribe function.
    onDeliveryEvent: (callback: (event: unknown) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: unknown) => callback(data)
      ipcRenderer.on(DELIVERY_EVENT, listener)
      return () => ipcRenderer.removeListener(DELIVERY_EVENT, listener)
    },
  },
  workspace: {
    readFile: (path: string) => ipcRenderer.invoke('workspace:readFile', path),
    listFilesRecursive: (path: string, maxDepth?: number) => ipcRenderer.invoke('workspace:listFilesRecursive', path, maxDepth),
  },
  claudeKey: {
    getStatus: () => ipcRenderer.invoke('claudeKey:status'),
    set: (value: string) => ipcRenderer.invoke('claudeKey:set', value),
    confirmDetected: () => ipcRenderer.invoke('claudeKey:confirmDetected'),
    rejectDetected: () => ipcRenderer.invoke('claudeKey:rejectDetected'),
  },
  dialog: {
    openDirectory: (startInWorkspaceRoot?: boolean) => ipcRenderer.invoke('dialog:openDirectory', startInWorkspaceRoot),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openInVSCode: (path: string) => ipcRenderer.invoke('shell:openInVSCode', path),
  },
  system: {
    getFeatures: () => ipcRenderer.invoke('system:getFeatures'),
    getLicenses: () => ipcRenderer.invoke('system:getLicenses'),
    copyDiagnostics: () => ipcRenderer.invoke('system:copyDiagnostics'),
    getInfo: () => ipcRenderer.invoke('system:getInfo'),
    checkForUpdates: () => ipcRenderer.invoke('system:checkForUpdates'),
  },
  window: {
    setTitle: (title: string) => ipcRenderer.send('window:setTitle', title),
  },
})
