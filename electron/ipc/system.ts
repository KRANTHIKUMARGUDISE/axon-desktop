import { app, ipcMain } from 'electron'

export function registerSystemHandlers() {
  ipcMain.handle('system:getInfo', async () => ({
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    appVersion: app.getVersion(),
  }))

  ipcMain.handle('system:checkForUpdates', async () => {
    // MVP: always return "up to date"
    return { status: 'up-to-date', message: 'You are running the latest version' }
  })
}
