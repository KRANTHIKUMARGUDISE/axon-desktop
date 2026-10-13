import fs from 'fs/promises'
import { atomicWrite } from '../store/atomic'
import type { Delivery, DeliveryRule, CreateDeliveryInput } from '../../shared'
import type { Store } from '../store/types'
import type { EventBus } from '../engine/bus'
import { JiraClient, JiraError, buildReadyJql, adfComment, claimMarker, LABEL_RUNNING, LABEL_DONE, LABEL_FAILED } from '../jira/client'
import type { JiraIssue } from '../jira/client'
import { readRuns, writeRun, alreadyRanFromThisState } from '../jira/runs'
import type { RunStatus } from '../jira/runs'
import { redact, log } from '../log'

// The Jira watcher (S5 Part A). Runs only on the active machine (D10). For each enabled rule it polls Jira, claims ready
// tickets with ONE label update, creates the delivery through the same path as a manual New Delivery, and reports back
// with a label + one marker-guarded comment. All progress that must survive a crash lives in state.json.

export interface WatcherState {
  /** rule id -> ISO time of the last successful poll (the next JQL looks back from here, with a 1 minute overlap). */
  cursors: Record<string, string>
  lastPollAt: Record<string, string>
  lastError: Record<string, string | null>
  /** S5b: the last time a poll of the rule claimed a ticket, and which one. */
  lastMatchAt: Record<string, string>
  lastMatchKey: Record<string, string>
  /** Claims whose label update may have happened but whose delivery is not confirmed yet (crash-safe, exactly-once). */
  intents: Record<string, { key: string; ruleId: string; at: string }>
  /** Terminal write-backs not yet confirmed on Jira (retried every tick and at boot). */
  writebacks: Record<string, { deliveryId: string; event: 'completed' | 'failed' | 'cancelled' }>
  /** axon-running tickets with no local delivery (claimed elsewhere/lost): the engineer chooses Resume or Release. */
  orphans: Record<string, { key: string; summary: string; ruleId: string; foundAt: string }>
}

const emptyState = (): WatcherState => ({ cursors: {}, lastPollAt: {}, lastError: {}, lastMatchAt: {}, lastMatchKey: {}, intents: {}, writebacks: {}, orphans: {} })

export interface WatcherDeps {
  store: Store
  bus: EventBus
  statePath: string
  listRules: () => Promise<DeliveryRule[]>
  /** The active-machine gate (D10): false = never poll. */
  isActiveHere: () => Promise<boolean>
  /** S5b "Pause all" (profile master switch): true = no polling on any machine. Write-backs of running deliveries still go out. */
  isPaused?: () => Promise<boolean>
  /** null while Jira is not configured (no token). */
  makeClient: () => Promise<JiraClient | null>
  /** Start (or queue) a Pending delivery. */
  startDelivery: (deliveryId: string) => Promise<{ success: boolean; error?: string; queued?: boolean }>
  displayName: () => string
  now?: () => Date
  /** Added to every poll interval (jitter); tests pass 0. */
  jitterMs?: () => number
  tickMs?: number
}

const OVERLAP_MINUTES = 1
const FIRST_LOOKBACK_NONE = undefined
const REASON_CAP = 500

export interface WatcherStatus {
  running: boolean
  rules: {
    ruleId: string
    lastPollAt: string | null
    lastError: string | null
    lastMatchAt: string | null
    lastMatchKey: string | null
    /** lastPollAt + the rule's interval (jitter of up to 15 s ignored); null when disabled or never checked. */
    nextCheckAt: string | null
  }[]
  orphans: WatcherState['orphans'][string][]
  pendingWritebacks: number
}

export class Watcher {
  private state: WatcherState = emptyState()
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private unsub: (() => void) | null = null
  private readonly now: () => Date

  constructor(private readonly deps: WatcherDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  // ------------------------------------------------------------------ state

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      this.state = { ...emptyState(), ...(JSON.parse(await fs.readFile(this.deps.statePath, 'utf-8')) as Partial<WatcherState>) }
    } catch {
      this.state = emptyState()
    }
    this.loaded = true
  }

  private save(): Promise<void> {
    return atomicWrite(this.deps.statePath, JSON.stringify(this.state, null, 2))
  }

  async status(): Promise<WatcherStatus> {
    await this.load()
    const rules = await this.deps.listRules()
    return {
      running: this.timer !== null,
      rules: rules.map((r) => {
        const last = this.state.lastPollAt[r.id] ?? null
        return {
          ruleId: r.id,
          lastPollAt: last,
          lastError: this.state.lastError[r.id] ?? null,
          lastMatchAt: this.state.lastMatchAt[r.id] ?? null,
          lastMatchKey: this.state.lastMatchKey[r.id] ?? null,
          nextCheckAt: last && r.enabled ? new Date(Date.parse(last) + r.pollIntervalMinutes * 60_000).toISOString() : null,
        }
      }),
      orphans: Object.values(this.state.orphans),
      pendingWritebacks: Object.keys(this.state.writebacks).length,
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Terminal deliveries of watcher tickets report back to Jira. */
  listen(): void {
    if (this.unsub) return
    this.unsub = this.deps.bus.subscribe((event) => {
      if (event.type !== 'completed' && event.type !== 'failed' && event.type !== 'cancelled') return
      void this.queueWriteback(event.deliveryId, event.type).catch((err) => log.warn('[watcher] write-back failed', err))
    })
  }

  start(): void {
    if (this.timer) return
    this.listen()
    this.timer = setInterval(() => void this.tick().catch((err) => log.warn('[watcher] tick failed', err)), this.deps.tickMs ?? 30_000)
    void this.tick().catch((err) => log.warn('[watcher] first tick failed', err))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsub?.()
    this.unsub = null
  }

  /** One scheduling pass: nothing happens unless this is the active machine and at least one rule is enabled and due. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.load()
      if (!(await this.deps.isActiveHere())) return
      const client = await this.deps.makeClient()
      if (!client) return
      const rules = (await this.deps.listRules()).filter((r) => r.enabled)
      if (!rules.length) return
      await this.flushWritebacks(client)
      if (await this.deps.isPaused?.()) return
      for (const rule of rules) {
        const last = this.state.lastPollAt[rule.id]
        const dueAt = last ? Date.parse(last) + rule.pollIntervalMinutes * 60_000 + (this.deps.jitterMs?.() ?? Math.random() * 15_000) : 0
        if (this.now().getTime() < dueAt) continue
        await this.pollRule(rule, client)
      }
    } finally {
      this.ticking = false
    }
  }

  // ------------------------------------------------------------------ polling + claim

  /** "Check now" on one rule: polls only that rule's query once. Refused while paused, on another machine, or when disabled. */
  async checkRule(ruleId: string): Promise<number> {
    await this.load()
    if (!(await this.deps.isActiveHere())) throw new Error('Rules run on another machine (or on none). Make this the machine that runs rules first.')
    if (await this.deps.isPaused?.()) throw new Error('Rules are paused. Turn off "Pause all" first.')
    const rule = (await this.deps.listRules()).find((r) => r.id === ruleId)
    if (!rule) throw new Error('This rule no longer exists.')
    if (!rule.enabled) throw new Error('This rule is disabled. Enable it first.')
    const client = await this.deps.makeClient()
    if (!client) throw new Error('Jira is not configured.')
    return this.pollRule(rule, client)
  }

  /** "Retry now" for write-backs waiting for Jira. */
  async retryWritebacks(): Promise<number> {
    await this.load()
    const client = await this.deps.makeClient()
    if (!client || !(await this.deps.isActiveHere())) throw new Error('Jira is not reachable from this machine right now.')
    await this.flushWritebacks(client)
    return Object.keys(this.state.writebacks).length
  }

  /** Exposed for tests and "Check now". Records success/error per rule; a failing rule never blocks the others. */
  async pollRule(rule: DeliveryRule, client: JiraClient): Promise<number> {
    await this.load()
    const startedAt = this.now()
    const cursor = this.state.cursors[rule.id]
    const since = cursor ? (startedAt.getTime() - Date.parse(cursor)) / 60_000 + OVERLAP_MINUTES : FIRST_LOOKBACK_NONE
    let claimed = 0
    let holdBack: number | null = null
    try {
      const issues = await client.searchJql(buildReadyJql(rule, since), ['summary', 'labels', 'status', 'updated'])
      for (const issue of issues) {
        const outcome = await this.claim(rule, client, issue)
        if (outcome === 'claimed') {
          claimed++
          this.state.lastMatchAt[rule.id] = this.now().toISOString()
          this.state.lastMatchKey[rule.id] = issue.key
        }
        // A ticket we could not take yet (previous attempt still running) must be seen again: never move the cursor past it.
        if (outcome === 'deferred') {
          const t = Date.parse(issue.fields.updated ?? '')
          if (Number.isFinite(t)) holdBack = holdBack === null ? t : Math.min(holdBack, t)
        }
      }
      this.state.cursors[rule.id] = new Date(holdBack ?? startedAt.getTime()).toISOString()
      this.state.lastError[rule.id] = null
    } catch (err) {
      this.state.lastError[rule.id] = redact(err instanceof Error ? err.message : String(err)).slice(0, 300)
      log.warn(`[watcher] poll of rule "${rule.name}" failed`, err)
    }
    this.state.lastPollAt[rule.id] = startedAt.toISOString()
    await this.save()
    return claimed
  }

  /** rerunSeq = how many watcher deliveries this ticket already has under this rule. */
  private async history(key: string, ruleId: string): Promise<Delivery[]> {
    return (await this.deps.store.listDeliveries())
      .filter((d) => d.ticketId === key && d.ruleId === ruleId && d.trigger === 'Watcher')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }

  private async claim(rule: DeliveryRule, client: JiraClient, issue: JiraIssue): Promise<'claimed' | 'skipped' | 'deferred'> {
    const key = issue.key
    const past = await this.history(key, rule.id)
    const latest = past[past.length - 1]
    // A previous attempt is still in flight (or waiting for a gate): do not stack a second one on the same ticket.
    if (latest && ['Pending', 'Running', 'Paused', 'Interrupted'].includes(latest.status)) return 'deferred'
    const claimKey = `${key}:${rule.id}:${past.length}`
    // Dedupe: this exact claim already produced a delivery (e.g. the label update was repeated after a restart).
    if (past.some((d) => d.claimKey === claimKey)) return 'skipped'

    // S5b: a status-based rule must not run again from the same state. The per-rule run record in the issue property
    // axon.runs replaces the old global axon-done/axon-failed labels (so another rule's finished stage never blocks this one).
    const statusAtStart = issue.fields.status?.name ?? rule.readyStatus ?? ''
    if (rule.readyStatus) {
      const runs = await readRuns(client, key)
      const legacy = !runs[rule.id] && (issue.fields.labels ?? []).some((l) => l === LABEL_DONE || l === LABEL_FAILED)
      if (legacy || (await alreadyRanFromThisState(client, key, rule.id, rule.readyStatus, runs))) return 'skipped'
    }

    // Intent first, so a crash between the label update and the delivery is repaired at boot instead of losing the ticket.
    this.state.intents[claimKey] = { key, ruleId: rule.id, at: this.now().toISOString() }
    await this.save()

    const readyLabels = rule.readyStatus ? [] : [rule.readyLabel]
    await client.updateLabels(key, { remove: readyLabels, add: [LABEL_RUNNING] })

    try {
      const delivery = await this.createFor(rule, issue.key, issue.fields.summary ?? '', claimKey, latest)
      delete this.state.intents[claimKey]
      await this.save()
      await this.recordRun(client, key, rule.id, delivery.id, 'running', statusAtStart)
      await this.startOrFail(delivery, client)
      return 'claimed'
    } catch (err) {
      // Roll the claim back so the ticket is not stranded as "running" with nothing behind it.
      log.warn(`[watcher] could not create a delivery for ${key}; releasing the ticket`, err)
      await client.updateLabels(key, { remove: [LABEL_RUNNING], add: readyLabels }).catch((e) => log.warn('[watcher] rollback failed', e))
      delete this.state.intents[claimKey]
      await this.save()
      throw err
    }
  }

  /** Bookkeeping only: a failed property write must never fail or strand a delivery. */
  private async recordRun(client: JiraClient, key: string, ruleId: string, deliveryId: string, status: RunStatus, statusAtStart?: string): Promise<void> {
    try {
      const existing = (await readRuns(client, key))[ruleId]
      await writeRun(client, key, ruleId, {
        deliveryId, status, at: this.now().toISOString(),
        statusAtStart: statusAtStart ?? (existing?.deliveryId === deliveryId ? existing.statusAtStart : existing?.statusAtStart ?? ''),
      })
    } catch (err) {
      log.warn(`[watcher] could not update axon.runs on ${key}`, err)
    }
  }

  private createFor(rule: DeliveryRule, key: string, title: string, claimKey: string, previous?: Delivery): Promise<Delivery> {
    const input: CreateDeliveryInput = {
      ticketId: key,
      title: title.slice(0, 300),
      pipelineId: rule.pipelineId,
      pipelineVersion: rule.pipelineVersion,
      repoUrl: '',
      workspaceType: 'Default',
      ...(rule.defaultWorkspacePath ? { workspacePath: rule.defaultWorkspacePath } : {}),
      trigger: 'Watcher',
      ruleId: rule.id,
      claimKey,
      // Re-labelling a ticket that ran before is a Rerun (same path as the Live View button).
      ...(previous ? { retriedFromDeliveryId: previous.id, rerunReason: 'RequirementUpdated' as const } : {}),
    }
    return this.deps.store.createDelivery(input, this.deps.displayName())
  }

  /** Start (or queue) the delivery. A start that cannot happen (dirty workspace, invalid pipeline) is reported, not left silent. */
  private async startOrFail(delivery: Delivery, client: JiraClient): Promise<void> {
    const res = await this.deps.startDelivery(delivery.id)
    if (res.success) return
    const message = `AXON could not start this delivery: ${res.error ?? 'unknown error'}`
    await this.deps.store.updateDelivery(delivery.id, (d) => {
      d.status = 'Failed'
      d.failureCategory = 'Platform'
      d.errorMessage = message
      d.completedAt = this.now().toISOString()
    })
    await this.queueWriteback(delivery.id, 'failed', client)
  }

  // ------------------------------------------------------------------ write-back

  private async queueWriteback(deliveryId: string, event: 'completed' | 'failed' | 'cancelled', client?: JiraClient | null): Promise<void> {
    await this.load()
    const d = await this.deps.store.getDelivery(deliveryId)
    if (!d || d.trigger !== 'Watcher') return
    this.state.writebacks[deliveryId] = { deliveryId, event }
    await this.save()
    const c = client ?? (await this.deps.makeClient())
    if (c && (await this.deps.isActiveHere())) await this.writeback(c, deliveryId).catch((err) => log.warn(`[watcher] write-back for ${deliveryId} deferred`, err))
  }

  private async flushWritebacks(client: JiraClient): Promise<void> {
    for (const id of Object.keys(this.state.writebacks)) {
      await this.writeback(client, id).catch((err) => log.warn(`[watcher] write-back for ${id} deferred`, err))
    }
  }

  /** Label swap + exactly one comment (marker checked first). Safe to repeat: both steps are idempotent. */
  private async writeback(client: JiraClient, deliveryId: string): Promise<void> {
    const pending = this.state.writebacks[deliveryId]
    if (!pending) return
    const d = await this.deps.store.getDelivery(deliveryId)
    if (!d) {
      delete this.state.writebacks[deliveryId]
      await this.save()
      return
    }
    const { event } = pending
    const marker = claimMarker(deliveryId, event)
    // S5b: only the visible "AXON is working" label is bookkeeping here; the outcome lives in axon.runs (per rule). The
    // comment is the rule's "Post AXON outcome comment" option (default on), its idempotency marker lives in axon.comments.
    const rule = d.ruleId ? (await this.deps.listRules()).find((r) => r.id === d.ruleId) : undefined
    await client.updateLabels(d.ticketId, { remove: [LABEL_RUNNING] })
    if (d.ruleId) await this.recordRun(client, d.ticketId, d.ruleId, d.id, event)
    if (rule?.postOutcomeComment !== false) {
      if (event === 'completed') {
        const prs = (d.prUrls?.length ? d.prUrls.map((p) => ({ text: `${p.repo}: ${p.url}`, href: p.url })) : d.prUrl ? [{ text: d.prUrl, href: d.prUrl }] : [])
        await client.postCommentOnce(d.ticketId, marker, adfComment('AXON completed this ticket', prs.length ? prs : [{ text: 'No pull request was created by this pipeline.' }]))
      } else if (event === 'failed') {
        // A delivery that could not even start (invalid pipeline, workspace problem) did no work: say so plainly instead of pasting internals.
        const notStarted = d.errorMessage?.startsWith('AXON could not start this delivery') === true
        const reason = notStarted
          ? 'The pipeline behind this rule needs fixing in AXON before it can run. No work was done on this ticket.'
          : redact(d.errorMessage ?? 'The delivery failed.').slice(0, REASON_CAP)
        await client.postCommentOnce(d.ticketId, marker, adfComment(
          notStarted ? 'AXON could not start this ticket' : 'AXON could not complete this ticket',
          notStarted
            ? [{ text: reason }, { text: 'Add the ready label again once it is fixed.' }]
            : [{ text: `Failure category: ${d.failureCategory ?? 'Platform'}` }, { text: `Reason: ${reason}` }, { text: `Attempt ${d.attemptNumber ?? 1}` }],
        ))
      } else {
        // Cancelled by the engineer: the ticket is released without the ready label (re-label to run it again).
        await client.postCommentOnce(d.ticketId, marker, adfComment('AXON delivery was cancelled', [{ text: 'Add the ready label again to run it again.' }]))
      }
    }
    delete this.state.writebacks[deliveryId]
    await this.save()
  }

  // ------------------------------------------------------------------ boot reconcile

  /**
   * Called once at start on the active machine. (1) Finish claims that were interrupted after the label update.
   * (2) Re-send write-backs for finished deliveries whose ticket is still `axon-running`.
   * (3) Anything else still `axon-running` with no local delivery is an orphan the engineer resolves (Resume / Release).
   */
  async reconcile(): Promise<{ resumed: number; orphans: number }> {
    await this.load()
    const client = await this.deps.makeClient()
    if (!client || !(await this.deps.isActiveHere())) return { resumed: 0, orphans: 0 }
    const rules = (await this.deps.listRules()).filter((r) => r.enabled)
    if (!rules.length) return { resumed: 0, orphans: 0 }
    const byId = new Map(rules.map((r) => [r.id, r]))
    let resumed = 0

    const projects = [...new Set(rules.map((r) => r.jiraProjectKey))].map((p) => `"${p}"`).join(', ')
    const running = await client.searchJql(
      `project in (${projects}) AND assignee = currentUser() AND labels = "${LABEL_RUNNING}"`, ['summary', 'labels', 'updated'],
    )
    const runningKeys = new Map(running.map((i) => [i.key, i]))

    // (1) crash-safe claims
    for (const [claimKey, intent] of Object.entries(this.state.intents)) {
      const rule = byId.get(intent.ruleId)
      const exists = (await this.history(intent.key, intent.ruleId)).some((d) => d.claimKey === claimKey)
      const issue = runningKeys.get(intent.key)
      if (!rule || exists || !issue) {
        // The label update never happened (ticket still ready: the normal poll takes it) or the delivery exists.
        delete this.state.intents[claimKey]
        continue
      }
      const past = await this.history(intent.key, intent.ruleId)
      const delivery = await this.createFor(rule, intent.key, issue.fields.summary ?? '', claimKey, past[past.length - 1])
      delete this.state.intents[claimKey]
      await this.save()
      await this.startOrFail(delivery, client)
      resumed++
    }

    // (2)+(3) tickets still marked running
    for (const issue of running) {
      const all = (await this.deps.store.listDeliveries()).filter((d) => d.ticketId === issue.key && d.trigger === 'Watcher')
      const latest = all.sort((a, b) => a.startedAt.localeCompare(b.startedAt))[all.length - 1]
      if (!latest) {
        const rule = rules.find((r) => r.jiraProjectKey === issue.key.split('-')[0])
        if (rule) this.state.orphans[issue.key] = { key: issue.key, summary: issue.fields.summary ?? '', ruleId: rule.id, foundAt: this.now().toISOString() }
        continue
      }
      if (latest.status === 'Completed') this.state.writebacks[latest.id] ??= { deliveryId: latest.id, event: 'completed' }
      else if (latest.status === 'Failed') this.state.writebacks[latest.id] ??= { deliveryId: latest.id, event: 'failed' }
      else if (latest.status === 'Cancelled') this.state.writebacks[latest.id] ??= { deliveryId: latest.id, event: 'cancelled' }
    }
    await this.save()
    await this.flushWritebacks(client)
    return { resumed, orphans: Object.keys(this.state.orphans).length }
  }

  /** The engineer's choice for an orphan: run it here now ("resume") or hand it back to the ready label ("release"). */
  async resolveOrphan(key: string, choice: 'resume' | 'release'): Promise<void> {
    await this.load()
    const orphan = this.state.orphans[key]
    if (!orphan) throw new Error(`No orphaned ticket ${key}`)
    const client = await this.deps.makeClient()
    if (!client) throw new Error('Jira is not configured')
    const rule = (await this.deps.listRules()).find((r) => r.id === orphan.ruleId)
    if (!rule) throw new Error('The rule for this ticket no longer exists')
    if (choice === 'release') {
      await client.updateLabels(key, { remove: [LABEL_RUNNING], add: rule.readyStatus ? [] : [rule.readyLabel] })
    } else {
      const past = await this.history(key, rule.id)
      const delivery = await this.createFor(rule, key, orphan.summary, `${key}:${rule.id}:${past.length}`, past[past.length - 1])
      await this.startOrFail(delivery, client)
    }
    delete this.state.orphans[key]
    await this.save()
  }
}

export { JiraError }
