import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { atomicWrite } from './store/atomic'

// Who is using this machine. The email is verified against Jira during onboarding (it must match
// `/myself`), then lowercased; it is the registry folder name and the approver/author recorded on
// gates and definitions (replacing the S1 "local-user" placeholder).

export interface Identity {
  /** Lowercased, Jira-verified. */
  email: string
  displayName: string
  team: string
  machineId: string
  machineName: string
}

/** Stable random UUID for this install, kept in {userData}/machine.json. */
export async function loadMachineId(userDataDir: string): Promise<string> {
  const file = path.join(userDataDir, 'machine.json')
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { id?: string }
    if (typeof parsed.id === 'string' && /^[0-9a-f-]{36}$/i.test(parsed.id)) return parsed.id
  } catch {
    // first run
  }
  const id = crypto.randomUUID()
  await atomicWrite(file, JSON.stringify({ id }))
  return id
}

export interface IdentityProvider {
  /** null until onboarding stored a verified email. */
  get(): Identity | null
  /** Email when onboarded, else the OS account name — never a hard-coded placeholder. */
  actor(): string
  /** Display name for `createdByName` fields. */
  displayName(): string
}

export function createIdentityProvider(opts: {
  readSettings: () => { userEmail: string; userName: string; team: string }
  machineId: string
  machineName?: string
}): IdentityProvider {
  const machineName = opts.machineName ?? os.hostname()
  const osUser = () => {
    try {
      return os.userInfo().username
    } catch {
      return 'unknown'
    }
  }
  const get = (): Identity | null => {
    const s = opts.readSettings()
    const email = s.userEmail.trim().toLowerCase()
    if (!email) return null
    return { email, displayName: s.userName.trim(), team: s.team.trim(), machineId: opts.machineId, machineName }
  }
  return {
    get,
    actor: () => get()?.email ?? osUser(),
    displayName: () => get()?.displayName || get()?.email || osUser(),
  }
}
