import { safeStorage, app } from 'electron'
import { z } from 'zod'
import { handle } from './guard'
import { registerSecret } from '../log'
import { setGitTokenSuffix } from './settings'
import fs from 'fs/promises'
import path from 'path'
import { atomicWrite } from '../store/atomic'

// Secrets live in {userData}/{key}.enc, encrypted with the OS keychain via safeStorage.
// Keys are a closed set (SecretKey) — there is deliberately no generic get/set-by-name
// IPC, and the renderer can never read a secret value back.

export const SECRET_KEYS = {
  gitToken: 'axon-git-token',
  jiraToken: 'axon-jira-token',
} as const

const securePath = (key: string) => path.join(app.getPath('userData'), `${key}.enc`)

export async function readSecure(key: string): Promise<string | null> {
  try {
    const encrypted = await fs.readFile(securePath(key))
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export async function writeSecure(key: string, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Safe storage not available on this platform')
  }
  await atomicWrite(securePath(key), safeStorage.encryptString(value))
}

// One-time migration helper: decrypts a legacy secure-storage file (if present) and
// deletes it unconditionally — used by claudeKeyStore to retire Claude-key disk persistence.
export async function consumeSecureFile(key: string): Promise<string | null> {
  let value: string | null = null
  try {
    const encrypted = await fs.readFile(securePath(key))
    if (safeStorage.isEncryptionAvailable()) value = safeStorage.decryptString(encrypted)
  } catch {
    value = null
  }
  await fs.unlink(securePath(key)).catch(() => {})
  return value
}

// Single typed accessor for the git token (the old executor and Settings used two
// different key names, so PR creation silently never had a token).
export const getGitToken = async (): Promise<string | null> => {
  const token = await readSecure(SECRET_KEYS.gitToken)
  registerSecret(token)
  return token
}
export const getJiraToken = async (): Promise<string | null> => {
  const token = await readSecure(SECRET_KEYS.jiraToken)
  registerSecret(token)
  return token
}

// Removes secret files left behind by the retired API-auth flow.
export async function purgeLegacyAuthFiles(): Promise<void> {
  const userData = app.getPath('userData')
  for (const name of ['auth.token', 'axon-access-token.enc', 'axon-refresh-token.enc', 'git-token.enc']) {
    await fs.unlink(path.join(userData, name)).catch(() => {})
  }
}

const Token = z.string().trim().min(1).max(512)

// Named setters only; none of these ever return a secret value to the renderer.
export function registerSecretHandlers() {
  handle('secrets:setGitToken', z.tuple([Token]), async ([token]) => {
    await writeSecure(SECRET_KEYS.gitToken, token)
    registerSecret(token)
    setGitTokenSuffix(token.slice(-4))
  })
  handle('secrets:hasGitToken', z.tuple([]), async () => !!(await getGitToken()))
  handle('secrets:clearGitToken', z.tuple([]), async () => {
    await fs.unlink(securePath(SECRET_KEYS.gitToken)).catch(() => {})
    setGitTokenSuffix('')
  })

  handle('secrets:setJiraToken', z.tuple([Token]), async ([token]) => {
    await writeSecure(SECRET_KEYS.jiraToken, token)
    registerSecret(token)
  })
  handle('secrets:hasJiraToken', z.tuple([]), async () => !!(await getJiraToken()))
  handle('secrets:clearJiraToken', z.tuple([]), async () => {
    await fs.unlink(securePath(SECRET_KEYS.jiraToken)).catch(() => {})
  })
}
