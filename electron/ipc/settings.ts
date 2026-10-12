import { app } from 'electron'
import Store from 'electron-store'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { SETTING_VALIDATORS } from '../../shared'
import type { Settings, WritableSettingKey } from '../../shared'
import { handle } from './guard'

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
    registryUrl: { type: 'string', default: '' },
    registryBranch: { type: 'string', default: '' },
    syncIntervalMinutes: { type: 'number', default: 5 },
    jiraSite: { type: 'string', default: '' },
    team: { type: 'string', default: '' },
    activityConsent: { type: 'boolean', default: false },
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

/** Main-side only: written by onboarding after the Jira identity check — never from the renderer. */
export function setVerifiedIdentity(v: { userEmail: string; userName: string; jiraSite: string; setupComplete: boolean }): void {
  store.set('userEmail', v.userEmail.trim().toLowerCase())
  store.set('userName', v.userName.slice(0, 200))
  store.set('jiraSite', v.jiraSite)
  store.set('setupComplete', v.setupComplete)
}

export function readIdentitySettings(): { userEmail: string; userName: string; team: string } {
  return { userEmail: store.get('userEmail') || '', userName: store.get('userName') || '', team: store.get('team') || '' }
}

/** Main-side only (derived from the stored git token) — never writable from the renderer. */
export function setGitTokenSuffix(suffix: string): void {
  store.set('gitTokenSuffix', suffix)
}

const READABLE = new Set<string>([...Object.keys(SETTING_VALIDATORS), 'gitTokenSuffix', 'setupComplete', 'userEmail', 'userName', 'jiraSite'])

// Typed per-key setter: dispatches to the key's own validator, so a value of the wrong
// type/shape (e.g. a non-path workspaceRoot) is rejected here rather than persisted.
export function applySetting(key: unknown, value: unknown): void {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key)) {
    throw new Error(`Setting is not writable: ${String(key)}`)
  }
  const parsed = SETTING_VALIDATORS[key as WritableSettingKey].parse(value)
  store.set(key as keyof StoredSettings, parsed as never)
}

export function registerSettingsHandlers() {
  handle('settings:get', z.tuple([z.string()]), ([key]) => {
    if (!READABLE.has(key)) throw new Error(`Unknown setting: ${key}`)
    if (key === 'workspaceRoot') return getWorkspaceRoot()
    return store.get(key as keyof StoredSettings)
  })

  handle('settings:set', z.tuple([z.string(), z.unknown()]), ([key, value]) => applySetting(key, value))

  handle('settings:getAll', z.tuple([]), () => ({ ...store.store, workspaceRoot: getWorkspaceRoot() }))
}
