import fs from 'fs/promises'
import path from 'path'
import type { Delivery, Machine, Profile, RegistryStatus, ActivityEntry, DeliveryRule } from '../../shared'
import type { RuleStore } from '../rules/ruleStore'
import { SCHEMA_VERSION } from '../../shared'
import type { FileStore } from '../store/fileStore'
import type { DocKind } from '../store/types'
import type { WriteQueue } from './queue'
import type { RegistrySync } from './sync'
import type { RegistryReader } from './reader'
import type { IdentityProvider } from '../identity'
import { parseProfile, profileYaml, ruleYaml } from './docs'
import { activityPath, profilePath, rulePath, runPath, userRoot } from './layout'
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
  /** S5: the local rule store (hydrated from, and mirrored to, users/{email}/rules). */
  rules?: RuleStore
  /** S5 D10: this machine is the one running the Jira watcher (local flag; the profile carries the heartbeat). */
  isWatcherHere?: () => boolean
  /** Another machine holds a fresh watcher claim (it was taken over): switch the local flag off. */
  onWatcherYield?: () => void
  now?: () => Date
  fetchImpl?: typeof fetch
  repoFromUrl?: (url: string) => { owner: string; repo: string } | null
}

const MAX_MACHINES = 20
/** A watcher heartbeat older than this is shown as stale on the other machines. */
export const STALE_HEARTBEAT_MINUTES = 15

export interface WatcherRole {
  thisMachineId: string
  thisMachineName: string
  /** The local flag is set AND no other machine holds a fresh claim: this machine may poll. */
  activeHere: boolean
  /** The "Run watcher on this machine" flag. */
  claimedHere: boolean
  /** Another machine's claim (if any), with a stale-heartbeat warning flag. */
  other: { machineId: string; name: string; heartbeatAt: string; stale: boolean } | null
}

// Everything the app writes to the registry besides definitions: profile.yaml, activity.log and run
// summaries — plus hydration of the engineer's own documents on a fresh machine and PR promotion.
export class RegistryService {
  private readonly now: () => Date

  constructor(private readonly deps: RegistryServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  private heartbeatAgeMinutes(iso: string): number {
    const age = (this.now().getTime() - Date.parse(iso)) / 60_000
    return Number.isFinite(age) ? age : Infinity
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
    // Watcher rules authored on another machine arrive disabled (enabling re-checks Jira permissions here).
    if (this.deps.rules) {
      const pendingRuleDeletes = pendingDeletes.filter((p) => p.startsWith(`${userRoot(email)}/rules/`))
      for (const rule of await this.deps.reader.readOwnRules(email)) {
        if (pendingRuleDeletes.includes(rulePath(email, rule.id))) continue
        try {
          if (await this.deps.rules.importIfMissing(rule)) imported++
        } catch (err) {
          log.warn(`[registry] could not import rule ${rule.id}`, err)
        }
      }
    }
    return imported
  }

  /** Rules are the engineer's own documents: every save/delete rides the write queue like pipelines and blocks. */
  async mirrorRule(rule: DeliveryRule): Promise<void> {
    const email = this.email()
    if (!email) return
    await this.enqueue({ op: 'put', path: rulePath(email, rule.id), content: ruleYaml(rule) })
  }

  async mirrorRuleDelete(id: string): Promise<void> {
    const email = this.email()
    if (!email) return
    await this.enqueue({ op: 'delete', path: rulePath(email, id) })
  }

  /** Re-queues every local rule (idempotent: unchanged content produces no commit). Called at launch. */
  async mirrorAllRules(): Promise<void> {
    for (const rule of (await this.deps.rules?.list()) ?? []) await this.mirrorRule(rule)
  }

  /** D10: who is running the watcher, from the profile in the clone. Takeover is manual only. */
  async watcherStatus(): Promise<WatcherRole> {
    const id = this.deps.identity.get()
    const here = this.deps.isWatcherHere?.() ?? false
    const base: WatcherRole = { thisMachineId: id?.machineId ?? '', thisMachineName: id?.machineName ?? '', activeHere: false, claimedHere: here, other: null }
    if (!id) return base
    let profile: Profile | null = null
    try {
      profile = parseProfile(await fs.readFile(path.join(this.deps.registryDir, profilePath(id.email)), 'utf-8'))
    } catch {
      // not synced yet
    }
    const active = profile?.activeMachine
    if (active && active.id !== id.machineId) {
      const name = profile?.machines.find((m) => m.id === active.id)?.name ?? 'another machine'
      base.other = { machineId: active.id, name, heartbeatAt: active.heartbeatAt, stale: this.heartbeatAgeMinutes(active.heartbeatAt) > STALE_HEARTBEAT_MINUTES }
    }
    // A machine that was taken over by another one (fresh heartbeat elsewhere) must stop polling: never two watchers.
    base.activeHere = here && !(base.other && !base.other.stale)
    return base
  }

  /** profile.yaml: email, displayName, team, machines[{id,name,lastSeen}] — merged with what the registry already has. */
  async updateProfile(opts: { takeover?: boolean; pausedAll?: boolean } = {}): Promise<void> {
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
      // S5b: the master switch is preserved across heartbeats; only setPaused changes it.
      pausedAll: opts.pausedAll ?? existing?.pausedAll ?? false,
      pausedAt: opts.pausedAll !== undefined ? this.now().toISOString() : existing?.pausedAt,
    }
    // D10: this machine heartbeats while it is the watcher. Takeover is manual only: a plain heartbeat never overwrites another
    // machine's fresh claim (it yields instead), and a machine that stops watching clears only its own claim.
    const other = existing?.activeMachine && existing.activeMachine.id !== id.machineId ? existing.activeMachine : undefined
    const otherFresh = !!other && this.heartbeatAgeMinutes(other.heartbeatAt) <= STALE_HEARTBEAT_MINUTES
    if (this.deps.isWatcherHere?.()) {
      if (otherFresh && !opts.takeover) {
        this.deps.onWatcherYield?.()
        profile.activeMachine = other
      } else {
        profile.activeMachine = { id: id.machineId, heartbeatAt: this.now().toISOString() }
      }
    } else if (other) {
      profile.activeMachine = other
    }
    await this.enqueue({ op: 'put', path: profilePath(id.email), content: profileYaml(profile) })
  }

  /** S5b "Pause all": read from the synced profile (so another machine's pause arrives with the next sync). */
  async isPaused(): Promise<boolean> {
    const id = this.deps.identity.get()
    if (!id) return false
    let remote: Profile | null = null
    try {
      remote = parseProfile(await fs.readFile(path.join(this.deps.registryDir, profilePath(id.email)), 'utf-8'))
    } catch {
      // not synced yet
    }
    // This machine's own switch counts at once; the synced profile carries it to the other machines. The newer of the two wins.
    const local = await this.readLocalPause()
    if (local && (!remote?.pausedAt || local.at >= remote.pausedAt)) return local.paused
    return remote?.pausedAll === true
  }

  async setPaused(paused: boolean): Promise<void> {
    const at = this.now().toISOString()
    await fs.writeFile(this.localPausePath(), JSON.stringify({ paused, at }), 'utf-8')
    await this.updateProfile({ pausedAll: paused })
  }

  private localPausePath(): string {
    return path.join(path.dirname(this.deps.registryDir), 'pause-local.json')
  }

  private async readLocalPause(): Promise<{ paused: boolean; at: string } | null> {
    try {
      const v = JSON.parse(await fs.readFile(this.localPausePath(), 'utf-8')) as { paused?: unknown; at?: unknown }
      return typeof v.paused === 'boolean' && typeof v.at === 'string' ? { paused: v.paused, at: v.at } : null
    } catch {
      return null
    }
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
