import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('axon', {
  auth: {
    storeToken: (token: string) => ipcRenderer.invoke('auth:storeToken', token),
    getToken: () => ipcRenderer.invoke('auth:getToken'),
    clearToken: () => ipcRenderer.invoke('auth:clearToken'),
    storeSecure: (key: string, value: string) => ipcRenderer.invoke('auth:storeSecure', key, value),
    getSecure: (key: string) => ipcRenderer.invoke('auth:getSecure', key),
    clearSecure: (key: string) => ipcRenderer.invoke('auth:clearSecure', key),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
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
  git: {
    clone: (repoUrl: string, targetPath: string, token: string) =>
      ipcRenderer.invoke('git:clone', repoUrl, targetPath, token),
    status: (workspacePath: string) => ipcRenderer.invoke('git:status', workspacePath),
    createBranch: (workspacePath: string, branchName: string) =>
      ipcRenderer.invoke('git:createBranch', workspacePath, branchName),
    addAndCommit: (workspacePath: string, message: string) =>
      ipcRenderer.invoke('git:addAndCommit', workspacePath, message),
    push: (workspacePath: string, branch: string, token: string) =>
      ipcRenderer.invoke('git:push', workspacePath, branch, token),
  },
  executor: {
    start: (deliveryId: string) => ipcRenderer.invoke('executor:start', deliveryId),
    resume: (deliveryId: string) => ipcRenderer.invoke('executor:resume', deliveryId),
    cancel: (deliveryId: string) => ipcRenderer.invoke('executor:cancel', deliveryId),
    onProgress: (callback: (event: Electron.IpcRendererEvent, data: unknown) => void) =>
      ipcRenderer.on('execution:progress', callback),
    offProgress: (callback: (event: Electron.IpcRendererEvent, data: unknown) => void) =>
      ipcRenderer.removeListener('execution:progress', callback),
  },
  claude: {
    call: (prompt: string, apiKey: string) => ipcRenderer.invoke('claude:call', prompt, apiKey),
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
    getLatency: (baseUrl: string) => ipcRenderer.invoke('system:getLatency', baseUrl),
  },
  window: {
    setTitle: (title: string) => ipcRenderer.send('window:setTitle', title),
  },
})
