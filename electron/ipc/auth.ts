import { ipcMain, safeStorage, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

const tokenPath = () => path.join(app.getPath('userData'), 'auth.token')
const securePath = (key: string) => path.join(app.getPath('userData'), `${key}.enc`)

export async function readSecure(key: string): Promise<string | null> {
  try {
    const filePath = path.join(app.getPath('userData'), `${key}.enc`)
    const encrypted = await fs.readFile(filePath)
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export function registerAuthHandlers() {
  ipcMain.handle('auth:storeToken', async (_event, token: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Safe storage not available on this platform')
    }
    const encrypted = safeStorage.encryptString(token)
    await fs.writeFile(tokenPath(), encrypted)
  })

  ipcMain.handle('auth:getToken', async () => {
    try {
      const encrypted = await fs.readFile(tokenPath())
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(encrypted)
    } catch {
      return null
    }
  })

  ipcMain.handle('auth:clearToken', async () => {
    try {
      await fs.unlink(tokenPath())
    } catch {
      // file may not exist
    }
  })

  ipcMain.handle('auth:storeSecure', async (_event, key: string, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Safe storage not available on this platform')
    }
    const encrypted = safeStorage.encryptString(value)
    await fs.writeFile(securePath(key), encrypted)
  })

  ipcMain.handle('auth:getSecure', async (_event, key: string) => {
    try {
      const encrypted = await fs.readFile(securePath(key))
      if (!safeStorage.isEncryptionAvailable()) return null
      return safeStorage.decryptString(encrypted)
    } catch {
      return null
    }
  })

  ipcMain.handle('auth:clearSecure', async (_event, key: string) => {
    try {
      await fs.unlink(securePath(key))
    } catch {
      // file may not exist
    }
  })
}
