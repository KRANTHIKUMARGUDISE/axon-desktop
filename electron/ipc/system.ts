import { app, ipcMain } from 'electron'
import https from 'https'
import http from 'http'

export function registerSystemHandlers() {
  ipcMain.handle('system:getInfo', async () => {
    return {
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      appVersion: app.getVersion(),
    }
  })

  ipcMain.handle('system:checkForUpdates', async () => {
    // MVP: always return "up to date"
    return { status: 'up-to-date', message: 'You are running the latest version' }
  })

  ipcMain.handle('system:getLatency', async (_event, baseUrl: string) => {
    return new Promise((resolve) => {
      try {
        const url = new URL(`${baseUrl}/api/health`)
        const client = url.protocol === 'https:' ? https : http
        const start = Date.now()

        const req = client.get(url.toString(), { timeout: 5000 }, (res) => {
          const latency = Date.now() - start
          const isHealthy = res.statusCode === 200
          resolve({ latency, isHealthy, error: null })
        })

        req.on('error', (err) => {
          resolve({ latency: null, isHealthy: false, error: err.message })
        })

        req.on('timeout', () => {
          req.destroy()
          resolve({ latency: null, isHealthy: false, error: 'Request timeout' })
        })
      } catch (err) {
        resolve({ latency: null, isHealthy: false, error: String(err) })
      }
    })
  })
}
