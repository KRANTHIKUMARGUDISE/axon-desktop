import fs from 'fs'
import path from 'path'
import type { SyncConfig } from './sync'

// Registry URL/branch: the build-time default ships in resources/registry-default.json (edited per
// release / org) and may be overridden by the AXON_REGISTRY_URL / AXON_REGISTRY_BRANCH environment
// variables or by the engineer in Settings (a non-empty setting always wins).

export interface RegistryDefaults {
  url: string
  branch: string
}

export function loadRegistryDefaults(resourceDirs: string[]): RegistryDefaults {
  let file: { url?: unknown; branch?: unknown } = {}
  for (const dir of resourceDirs) {
    try {
      file = JSON.parse(fs.readFileSync(path.join(dir, 'registry-default.json'), 'utf-8'))
      break
    } catch {
      // try the next location
    }
  }
  const url = (process.env.AXON_REGISTRY_URL || (typeof file.url === 'string' ? file.url : '')).trim()
  const branch = (process.env.AXON_REGISTRY_BRANCH || (typeof file.branch === 'string' ? file.branch : '') || 'main').trim()
  return { url, branch }
}

export function resolveSyncConfig(
  settings: { registryUrl: string; registryBranch: string; syncIntervalMinutes: number },
  defaults: RegistryDefaults,
): SyncConfig {
  return {
    url: settings.registryUrl.trim() || defaults.url,
    branch: settings.registryBranch.trim() || defaults.branch || 'main',
    intervalMinutes: settings.syncIntervalMinutes > 0 ? settings.syncIntervalMinutes : 5,
  }
}
