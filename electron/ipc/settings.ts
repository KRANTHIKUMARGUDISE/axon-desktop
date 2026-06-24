import { ipcMain, app } from 'electron'
import Store from 'electron-store'
import path from 'path'

interface AxonSettings {
  backendUrl: string
  workspaceRoot: string
  defaultAutonomyLevel: string
  confidenceThreshold: number
  gitProvider: string
  theme: string
  setupComplete: boolean
  userEmail: string
  userName: string
  maxContextSnapshotSizeKb: number
}

const store = new Store<AxonSettings>({
  cwd: app.getPath('userData'),
  schema: {
    backendUrl: { type: 'string', default: 'http://localhost:3000' },
    workspaceRoot: { type: 'string', default: '' },
    defaultAutonomyLevel: { type: 'string', default: 'supervised' },
    confidenceThreshold: { type: 'number', default: 0.8 },
    gitProvider: { type: 'string', default: 'github' },
    theme: { type: 'string', default: 'dark' },
    setupComplete: { type: 'boolean', default: false },
    userEmail: { type: 'string', default: '' },
    userName: { type: 'string', default: '' },
    // DS1's inline-vs-workspace-file truncation cap, shared by both context-snapshot
    // (input) and output.result storage — same constant either side used to gate on.
    maxContextSnapshotSizeKb: { type: 'number', default: 50 },
  },
})

export { store }

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', (_event, key: keyof AxonSettings) => {
    return store.get(key)
  })

  ipcMain.handle('settings:set', (_event, key: keyof AxonSettings, value: unknown) => {
    store.set(key, value as AxonSettings[typeof key])
  })

  ipcMain.handle('settings:getAll', () => {
    return store.store
  })
}
