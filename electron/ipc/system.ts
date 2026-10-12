import { app } from 'electron'
import { z } from 'zod'
import { handle } from './guard'

export function registerSystemHandlers() {
  handle('system:getInfo', z.tuple([]), () => ({
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    appVersion: app.getVersion(),
  }))

  handle('system:checkForUpdates', z.tuple([]), () => {
    // MVP: always return "up to date"
    return { status: 'up-to-date', message: 'You are running the latest version' }
  })
}
