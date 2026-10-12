import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { handle } from './guard'
import { store as settingsStore } from './settings'

// Where bundled resources live: packaged = process.resourcesPath, dev/compiled = <repo>/resources.
function resourceDirs(): string[] {
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [...(packaged ? [packaged] : []), path.join(__dirname, '..', '..', 'resources'), path.join(__dirname, '..', '..', '..', 'resources')]
}

export interface LicenseEntry {
  name: string
  version: string
  license: string
  repository?: string
  text: string
}

async function readLicenses(): Promise<{ generatedAt: string | null; packages: LicenseEntry[] }> {
  for (const dir of resourceDirs()) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, 'licenses.json'), 'utf-8')) as { generatedAt?: string; packages?: LicenseEntry[] }
      return { generatedAt: parsed.generatedAt ?? null, packages: Array.isArray(parsed.packages) ? parsed.packages : [] }
    } catch {
      // try the next location
    }
  }
  return { generatedAt: null, packages: [] }
}

/** D6: the Intelligence page ships static demo data, so it stays off unless explicitly enabled. */
export function getFeatureFlags(): { intelligence: boolean } {
  return { intelligence: process.env.AXON_FEATURE_INTELLIGENCE === '1' || settingsStore.get('featureIntelligence') === true }
}

export function registerSystemHandlers() {
  handle('system:getInfo', z.tuple([]), () => ({
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    appVersion: app.getVersion(),
  }))

  handle('system:getFeatures', z.tuple([]), () => getFeatureFlags())
  handle('system:getLicenses', z.tuple([]), () => readLicenses())

  handle('system:checkForUpdates', z.tuple([]), () => {
    // MVP: always return "up to date"
    return { status: 'up-to-date', message: 'You are running the latest version' }
  })
}
