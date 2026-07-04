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

// Directly callable from main-process code (executor.ts's token refresh) — mirrors the
// 'auth:storeSecure' IPC handler below so a token refreshed mid-delivery lands in the
// SAME encrypted file the renderer's own axios interceptor reads from, keeping both in
// sync rather than drifting into two different "current token" values.
export async function writeSecure(key: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Safe storage not available on this platform')
  }
  const encrypted = safeStorage.encryptString(value)
  await fs.writeFile(securePath(key), encrypted)
}

// One-time migration helper: decrypts a legacy secure-storage file (if present)
// and deletes it unconditionally, regardless of whether the value is used —
// callers retiring disk persistence for a key call this once on launch.
export async function consumeSecureFile(key: string): Promise<string | null> {
  const filePath = path.join(app.getPath('userData'), `${key}.enc`)
  let value: string | null = null
  try {
    const encrypted = await fs.readFile(filePath)
    if (safeStorage.isEncryptionAvailable()) {
      value = safeStorage.decryptString(encrypted)
    }
  } catch {
    value = null
  }
  await fs.unlink(filePath).catch(() => {})
  return value
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
