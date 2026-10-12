import { ipcMain, app } from 'electron'
import Store from 'electron-store'
import path from 'path'
import os from 'os'
import type { Settings } from '../../shared'

interface StoredSettings extends Settings {
  gitTokenSuffix: string
}

const store = new Store<StoredSettings>({
  cwd: app.getPath('userData'),
  schema: {
    workspaceRoot: { type: 'string', default: '' },
    gitProvider: { type: 'string', default: 'github' },
    theme: { type: 'string', default: 'dark' },
    setupComplete: { type: 'boolean', default: false },
    userEmail: { type: 'string', default: '' },
    userName: { type: 'string', default: '' },
    // DS1's inline-vs-file cap, shared by context-snapshot (input) and output.result storage.
    maxContextSnapshotSizeKb: { type: 'number', default: 50 },
    gitTokenSuffix: { type: 'string', default: '' },
  },
})

// Keys from the retired axon-api / autonomy features — dropped on boot.
for (const legacy of ['backendUrl', 'defaultAutonomyLevel', 'confidenceThreshold']) {
  ;(store as unknown as { delete(key: string): void }).delete(legacy)
}

export { store }

// D7: never Documents/OneDrive. Windows %LOCALAPPDATA%\AXON\work, macOS
// ~/Library/Application Support/AXON/work, elsewhere ~/.local/share/AXON/work.
export function defaultWorkspaceRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AXON', 'work')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AXON', 'work')
  return path.join(os.homedir(), '.local', 'share', 'AXON', 'work')
}

export function getWorkspaceRoot(): string {
  return store.get('workspaceRoot') || defaultWorkspaceRoot()
}

export function getDS1ThresholdBytes(): number {
  const kb = store.get('maxContextSnapshotSizeKb')
  return kb && kb > 0 ? kb * 1024 : 50_000
}

const EDITABLE: ReadonlySet<string> = new Set([
  'workspaceRoot', 'gitProvider', 'theme', 'setupComplete', 'userEmail', 'userName',
  'maxContextSnapshotSizeKb', 'gitTokenSuffix',
])

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', (_event, key: keyof StoredSettings) => {
    if (key === 'workspaceRoot') return getWorkspaceRoot()
    return store.get(key)
  })

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    if (!EDITABLE.has(key)) throw new Error(`Unknown setting: ${key}`)
    store.set(key as keyof StoredSettings, value as never)
  })

  ipcMain.handle('settings:getAll', () => ({ ...store.store, workspaceRoot: getWorkspaceRoot() }))
}
