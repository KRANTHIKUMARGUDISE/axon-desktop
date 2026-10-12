import { contextBridge, ipcRenderer } from 'electron'

// Keep the channel name in sync with electron/ipc/delivery.ts (DELIVERY_EVENT_CHANNEL).
const DELIVERY_EVENT = 'delivery:event'

contextBridge.exposeInMainWorld('axon', {
  secrets: {
    setGitToken: (token: string) => ipcRenderer.invoke('secrets:setGitToken', token),
    hasGitToken: () => ipcRenderer.invoke('secrets:hasGitToken'),
    clearGitToken: () => ipcRenderer.invoke('secrets:clearGitToken'),
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
    stepData: (deliveryId: string, nodeId: string, kind: 'context' | 'output') =>
      ipcRenderer.invoke('deliveries:stepData', deliveryId, nodeId, kind),
  },
  delivery: {
    start: (id: string) => ipcRenderer.invoke('delivery:start', id),
    resume: (id: string) => ipcRenderer.invoke('delivery:resume', id),
    cancel: (id: string) => ipcRenderer.invoke('delivery:cancel', id),
    previewResume: (id: string) => ipcRenderer.invoke('delivery:previewResume', id),
    approveGate: (id: string, comment?: string) => ipcRenderer.invoke('delivery:approveGate', id, comment),
    rejectGate: (id: string, comment: string) => ipcRenderer.invoke('delivery:rejectGate', id, comment),
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
    listDirs: (path: string) => ipcRenderer.invoke('workspace:listDirs', path),
    exists: (path: string) => ipcRenderer.invoke('workspace:exists', path),
    readFile: (path: string) => ipcRenderer.invoke('workspace:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('workspace:writeFile', path, content),
    createDir: (path: string) => ipcRenderer.invoke('workspace:createDir', path),
    listFilesRecursive: (path: string, maxDepth?: number) => ipcRenderer.invoke('workspace:listFilesRecursive', path, maxDepth),
    clear: (path: string) => ipcRenderer.invoke('workspace:clear', path),
  },
  claudeKey: {
    getStatus: () => ipcRenderer.invoke('claudeKey:status'),
    set: (value: string) => ipcRenderer.invoke('claudeKey:set', value),
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openInVSCode: (path: string) => ipcRenderer.invoke('shell:openInVSCode', path),
  },
  system: {
    getInfo: () => ipcRenderer.invoke('system:getInfo'),
    checkForUpdates: () => ipcRenderer.invoke('system:checkForUpdates'),
  },
  window: {
    setTitle: (title: string) => ipcRenderer.send('window:setTitle', title),
  },
})
