import fs from 'fs/promises'
import path from 'path'
import type { Delivery, Machine, Profile, RegistryStatus, ActivityEntry } from '../../shared'
import { SCHEMA_VERSION } from '../../shared'
import type { FileStore } from '../store/fileStore'
import type { DocKind } from '../store/types'
import type { WriteQueue } from './queue'
import type { RegistrySync } from './sync'
import type { RegistryReader } from './reader'
import type { IdentityProvider } from '../identity'
import { parseProfile, profileYaml } from './docs'
import { activityPath, profilePath, runPath, userRoot } from './layout'
import { toRunSummary, runMonth } from './runSummary'
import { promoteDefinition } from './promote'
import type { PromoteResult, PromoteTarget } from './promote'
import { log } from '../log'

export interface RegistryServiceDeps {
  sync: RegistrySync
  queue: WriteQueue
  reader: RegistryReader
  local: FileStore
  registryDir: string
  identity: IdentityProvider
  appVersion: string
  consent: () => boolean
  getGitToken: () => Promise<string | null>
  isReserved: (id: string) => boolean
  now?: () => Date
  fetchImpl?: typeof fetch
  repoFromUrl?: (url: string) => { owner: string; repo: string } | null
}

const MAX_MACHINES = 20

// Everything the app writes to the registry besides definitions: profile.yaml, activity.log and run
// summaries — plus hydration of the engineer's own documents on a fresh machine and PR promotion.
export class RegistryService {
  private readonly now: () => Date

  constructor(private readonly deps: RegistryServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  private email(): string | null {
    return this.deps.identity.get()?.email ?? null
  }

  private async enqueue(op: Parameters<WriteQueue['enqueue']>[0]): Promise<void> {
    await this.deps.queue.enqueue(op)
    this.deps.sync.notify()
  }

  /** Called after each fetch: drop caches and pull this engineer's own documents onto a fresh machine. */
  async onSynced(): Promise<void> {
    this.deps.reader.invalidate()
    await this.hydrate()
  }

  async hydrate(): Promise<number> {
    const email = this.email()
    if (!email) return 0
    let imported = 0
    // A document you just deleted is still in the clone until the delete is pushed — don't resurrect it.
    const pendingDeletes = this.deps.queue.list().filter((o) => o.op === 'delete').map((o) => o.path)
    for (const entry of await this.deps.reader.readOwn(email)) {
      const folder = `${userRoot(email)}/${entry.kind}s/${entry.current.id}`
      if (pendingDeletes.some((p) => folder === p || folder.startsWith(`${p}/`))) continue
      try {
        if (await this.deps.local.importDoc(entry.kind, entry.current, entry.published)) imported++
      } catch (err) {
        log.warn(`[registry] could not import ${entry.kind} ${entry.current.id}`, err)
      }
    }
    return imported
  }

  /** profile.yaml: email, displayName, team, machines[{id,name,lastSeen}] — merged with what the registry already has. */
  async updateProfile(): Promise<void> {
    const id = this.deps.identity.get()
    if (!id) return
    let existing: Profile | null = null
    try {
      existing = parseProfile(await fs.readFile(path.join(this.deps.registryDir, profilePath(id.email)), 'utf-8'))
    } catch {
      // not synced yet
    }
    const machine: Machine = { id: id.machineId, name: id.machineName, lastSeen: this.now().toISOString() }
    const machines = [...(existing?.machines ?? []).filter((m) => m.id !== machine.id), machine]
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, MAX_MACHINES)
    const profile: Profile = {
      id: id.email, schemaVersion: SCHEMA_VERSION, scope: 'Personal', owner: id.email, email: id.email,
      displayName: id.displayName || existing?.displayName || '', team: id.team || existing?.team || '', machines,
    }
    await this.enqueue({ op: 'put', path: profilePath(id.email), content: profileYaml(profile) })
  }

  /** Appends to activity.log locally; it rides the next sync (no commit per launch/login). Needs consent. */
  async logActivity(event: ActivityEntry['event']): Promise<void> {
    const id = this.deps.identity.get()
    if (!id || !this.deps.consent()) return
    const entry: ActivityEntry = { at: this.now().toISOString(), event, email: id.email, machine: id.machineName, appVersion: this.deps.appVersion }
    await this.enqueue({ op: 'append', path: activityPath(id.email), line: JSON.stringify(entry) })
  }

  async onLaunch(): Promise<void> {
    await this.updateProfile().catch((err) => log.warn('[registry] profile update failed', err))
    await this.logActivity('launch').catch((err) => log.warn('[registry] activity log failed', err))
  }

  /** Whitelisted run summary (never output/context/summaries) for a finished delivery. */
  async recordRun(delivery: Delivery): Promise<void> {
    const email = this.email()
    if (!email) return
    const summary = toRunSummary(delivery, email)
    await this.enqueue({ op: 'put', path: runPath(email, runMonth(delivery.startedAt), delivery.id), content: JSON.stringify(summary, null, 2) })
  }

  promote(kind: DocKind, id: string, target: PromoteTarget, note?: string): Promise<PromoteResult> {
    return promoteDefinition(
      { sync: this.deps.sync, local: this.deps.local, getToken: this.deps.getGitToken, isReserved: this.deps.isReserved, fetchImpl: this.deps.fetchImpl, repoFromUrl: this.deps.repoFromUrl },
      { kind, id, target, note },
    )
  }

  status(): RegistryStatus {
    return this.deps.sync.getStatus()
  }

  syncNow(): Promise<RegistryStatus> {
    return this.deps.sync.syncNow()
  }
}
