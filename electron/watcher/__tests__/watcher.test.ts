import fs from 'fs/promises'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness } from '../../engine/__tests__/harness'
import type { Harness } from '../../engine/__tests__/harness'
import { createScheduler } from '../../engine/scheduler'
import { createMockJira } from '../../jira/__tests__/mockJira'
import type { MockJira } from '../../jira/__tests__/mockJira'
import { JiraClient, JiraError, buildReadyJql, adfComment, adfContains, claimMarker } from '../../jira/client'
import { Watcher } from '../watcher'
import type { DeliveryRule } from '../../../shared'

let h: Harness
let jira: MockJira
afterEach(async () => { await h?.cleanup() })

const sleeps: number[] = []
const client = () => new JiraClient({ site: 'acme.atlassian.net', email: 'me@example.com', token: 'tok', fetchImpl: jira.fetchImpl, sleep: async (ms) => { sleeps.push(ms) } })

async function setup(over: { active?: () => boolean; ruleOver?: Partial<DeliveryRule>; scriptFail?: boolean } = {}) {
  h = await createHarness(over.scriptFail ? { script: { a: () => ({ status: 'failed', summary: 'tests red', result: {}, errorMessage: 'tests red' }) } } : {})
  jira = createMockJira()
  const { pipeline } = await h.mkPipeline(['a'])
  const rule: DeliveryRule = {
    id: 'rule1', schemaVersion: 2, scope: 'Personal', owner: 'me@example.com', name: 'ABC ready', source: 'jira', postOutcomeComment: true, enabled: true, jiraProjectKey: 'ABC',
    readyLabel: 'axon-ready', pipelineId: pipeline.id, pipelineVersion: pipeline.version, pollIntervalMinutes: 5, ...over.ruleOver,
  }
  const scheduler = createScheduler({ engine: h.engine, bus: h.bus, getCap: () => 3 })
  const statePath = path.join(h.dir, 'watcher', 'state.json')
  const make = () => new Watcher({
    store: h.store, bus: h.bus, statePath, listRules: async () => [rule], isActiveHere: async () => (over.active ? over.active() : true),
    makeClient: async () => client(), startDelivery: (id) => scheduler.start(id), displayName: () => 'Dev', jitterMs: () => 0,
  })
  return { rule, pipeline, make, statePath, watcher: make() }
}
const settle = async (s: { watcher: Watcher }) => {
  await idle()
  await new Promise((r) => setTimeout(r, 30))
  for (let i = 0; i < 400 && (await s.watcher.status()).pendingWritebacks > 0; i++) await new Promise((r) => setTimeout(r, 30))
}
const deliveries = async () => (await h.store.listDeliveries()).filter((d) => d.trigger === 'Watcher')
const idle = async () => { for (const d of await h.store.listDeliveries()) await h.engine.whenIdle(d.id) }

describe('Jira watcher — claim', () => {
  it('a ready ticket becomes exactly one delivery, also across a restart', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-1', labels: ['axon-ready'] })
    await s.watcher.pollRule(s.rule, client())
    await idle()
    expect(await deliveries()).toHaveLength(1)
    expect(jira.issues.get('ABC-1')!.labels).toEqual(expect.arrayContaining(['axon-running']))
    expect(jira.issues.get('ABC-1')!.labels).not.toContain('axon-ready')
    // "restart": a fresh Watcher over the same state file + store polls again
    await s.make().pollRule(s.rule, client())
    await idle()
    expect(await deliveries()).toHaveLength(1)
  })

  it('claims with a single PUT and creates the delivery from the pinned pipeline, trigger Watcher', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-2', labels: ['axon-ready'] })
    await s.watcher.pollRule(s.rule, client())
    expect(jira.count(/^PUT \/rest\/api\/3\/issue\/ABC-2$/)).toBe(1)
    const [d] = await deliveries()
    expect(d).toMatchObject({ ticketId: 'ABC-2', trigger: 'Watcher', ruleId: 'rule1', pipelineVersion: s.pipeline.version, claimKey: 'ABC-2:rule1:0' })
  })

  it('ignores tickets assigned to someone else and tickets in other projects', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-3', labels: ['axon-ready'], assignee: 'other@example.com' })
    jira.add({ key: 'XYZ-1', labels: ['axon-ready'] })
    await s.watcher.pollRule(s.rule, client())
    expect(await deliveries()).toHaveLength(0)
    expect(jira.count(/^PUT/)).toBe(0)
  })

  it('does not poll when the watcher is not the active machine or the rule is disabled', async () => {
    const s = await setup({ active: () => false })
    jira.add({ key: 'ABC-4', labels: ['axon-ready'] })
    await s.watcher.tick()
    expect(jira.calls).toHaveLength(0)
    const t = await setup({ ruleOver: { enabled: false } })
    jira.add({ key: 'ABC-4', labels: ['axon-ready'] })
    await t.watcher.tick()
    expect(jira.calls).toHaveLength(0)
  })

  it('rolls the claim back when the delivery cannot be created', async () => {
    const s = await setup({ ruleOver: { pipelineVersion: 99 } })
    jira.add({ key: 'ABC-5', labels: ['axon-ready'] })
    await s.watcher.pollRule(s.rule, client())
    expect(jira.issues.get('ABC-5')!.labels).toEqual(['axon-ready'])
    expect(await deliveries()).toHaveLength(0)
  })

  it('repairs a claim interrupted after the label update (intent, no delivery) without a second delivery', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-6', labels: ['axon-running'] }) // label swapped, then "the app died"
    await fs.mkdir(path.dirname(s.statePath), { recursive: true })
    await fs.writeFile(s.statePath, JSON.stringify({ intents: { 'ABC-6:rule1:0': { key: 'ABC-6', ruleId: 'rule1', at: 'x' } } }))
    const w = s.make()
    expect(await w.reconcile()).toMatchObject({ resumed: 1 })
    await w.reconcile()
    await idle()
    expect(await deliveries()).toHaveLength(1)
  })

  it('an axon-running ticket with no local delivery is an orphan; Release hands it back to the ready label', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-7', labels: ['axon-running'] })
    expect(await s.watcher.reconcile()).toMatchObject({ orphans: 1 })
    await s.watcher.resolveOrphan('ABC-7', 'release')
    expect(jira.issues.get('ABC-7')!.labels).toEqual(['axon-ready'])
  })
})

describe('Jira watcher — write-back', () => {
  it('completed: axon-done + exactly one comment, even when the event is delivered twice', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-10', labels: ['axon-ready'] })
    s.watcher.listen()
    await s.watcher.pollRule(s.rule, client())
    await idle()
    await settle(s)
    const [d] = await deliveries()
    expect(d.status).toBe('Completed')
    expect(jira.issues.get('ABC-10')!.labels).toEqual([])
    expect((jira.issues.get('ABC-10')!.properties!['axon.runs'] as Record<string, { status: string }>).rule1.status).toBe('completed')
    h.bus.emit({ type: 'completed', deliveryId: d.id, at: 'x' })
    await settle(s)
    expect(jira.commentsOn('ABC-10')).toHaveLength(1)
    expect(adfContains(jira.commentsOn('ABC-10')[0].body, claimMarker(d.id, 'completed'))).toBe(false) // no marker text in the comment
    expect(jira.issues.get('ABC-10')!.properties!['axon.comments']).toEqual([claimMarker(d.id, 'completed')])
    s.watcher.stop()
  })

  it('failed: axon-failed + one comment naming the category; a failed comment POST is retried without duplicating', async () => {
    const s = await setup({ scriptFail: true })
    jira.add({ key: 'ABC-11', labels: ['axon-ready'] })
    jira.failNext(/^POST .*\/comment$/, 'network', 3) // initial attempt + both client retries fail
    s.watcher.listen()
    await s.watcher.pollRule(s.rule, client())
    await idle()
    await settle(s)
    const [d] = await deliveries()
    expect(d.status).toBe('Failed')
    expect(jira.commentsOn('ABC-11')).toHaveLength(0) // still pending
    expect((await s.watcher.status()).pendingWritebacks).toBe(1)
    await s.watcher.tick() // next tick flushes the pending write-back
    expect(jira.commentsOn('ABC-11')).toHaveLength(1)
    expect(JSON.stringify(jira.commentsOn('ABC-11')[0].body)).toMatch(/Failure category: Agent/)
    await s.watcher.tick()
    expect(jira.commentsOn('ABC-11')).toHaveLength(1)
    expect(jira.issues.get('ABC-11')!.labels).toEqual([])
    s.watcher.stop()
  })

  it('re-adding the ready label after a finished run creates a rerun linked to the previous delivery', async () => {
    const s = await setup({ scriptFail: true })
    jira.add({ key: 'ABC-12', labels: ['axon-ready'] })
    await s.watcher.pollRule(s.rule, client())
    await idle()
    const [first] = await deliveries()
    expect(first.status).toBe('Failed')
    jira.issues.get('ABC-12')!.labels.push('axon-ready')
    await s.watcher.pollRule(s.rule, client())
    await idle()
    const all = await deliveries()
    expect(all).toHaveLength(2)
    const second = all.find((d) => d.id !== first.id)!
    expect(second).toMatchObject({ retriedFromDeliveryId: first.id, rerunReason: 'RequirementUpdated', attemptNumber: 2, claimKey: 'ABC-12:rule1:1' })
    expect((await h.store.getDelivery(first.id))!.status).toBe('Superseded')
    expect(second.interventions?.map((i) => i.kind)).toEqual(['RerunAfterFailure'])
  })
})

describe('Jira client', () => {
  it('builds the JQL (label mode, status mode, relative since)', () => {
    expect(buildReadyJql({ jiraProjectKey: 'ABC', readyLabel: 'axon-ready' })).toBe('project = "ABC" AND assignee = currentUser() AND labels = "axon-ready" ORDER BY updated ASC')
    expect(buildReadyJql({ jiraProjectKey: 'ABC', readyLabel: 'x' }, 6.2)).toContain('updated >= "-7m"')
    expect(buildReadyJql({ jiraProjectKey: 'ABC', readyLabel: 'x', readyStatus: 'Ready for AXON' })).toContain('status = "Ready for AXON" AND labels not in ("axon-running")')
  })

  it('honours 429 Retry-After, then succeeds', async () => {
    jira = createMockJira()
    jira.add({ key: 'ABC-1', labels: ['l'] })
    jira.failNext(/search\/jql/, 429, 1, { 'retry-after': '7' })
    sleeps.length = 0
    const issues = await client().searchJql('project = "ABC"', ['summary'])
    expect(issues).toHaveLength(1)
    expect(sleeps).toEqual([7000])
  })

  it('retries network errors twice, then reports a retryable error', async () => {
    jira = createMockJira()
    jira.failNext(/search\/jql/, 'network', 5)
    sleeps.length = 0
    await expect(client().searchJql('x', [])).rejects.toBeInstanceOf(JiraError)
    expect(jira.count(/search\/jql/)).toBe(3)
  })

  it('reports one clear message per missing permission', async () => {
    jira = createMockJira({ permissions: { EDIT_ISSUES: false, ADD_COMMENTS: false } })
    const report = await client().checkPermissions('ABC')
    expect(report.ok).toBe(false)
    expect(report.missing).toHaveLength(2)
    expect(report.missing.join(' ')).toMatch(/Edit issues/)
    expect(report.missing.join(' ')).toMatch(/Add comments/)
    jira = createMockJira()
    expect((await client().checkPermissions('ABC')).ok).toBe(true)
  })

  it('the comment marker is found inside ADF and plain bodies', () => {
    const body = adfComment('t', [{ text: 'a' }], 'axon:d1:completed')
    expect(adfContains(body, 'axon:d1:completed')).toBe(true)
    expect(adfContains(body, 'axon:d2:completed')).toBe(false)
    expect(adfContains('plain axon:d1:failed', 'axon:d1:failed')).toBe(true)
  })
})

describe('S5b — system markers per rule, pause, check now', () => {
  const runs = (key: string) => jira.issues.get(key)!.properties!['axon.runs'] as Record<string, { status: string; statusAtStart: string; deliveryId: string }>

  it('writes axon.runs at claim and on completion; never adds axon-done / axon-failed', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-20', labels: ['axon-ready'], status: 'To Do' })
    s.watcher.listen()
    await s.watcher.pollRule(s.rule, client())
    expect(runs('ABC-20').rule1).toMatchObject({ status: 'running', statusAtStart: 'To Do' })
    await idle()
    await settle(s)
    expect(runs('ABC-20').rule1.status).toBe('completed')
    expect(jira.issues.get('ABC-20')!.labels).toEqual([])
    s.watcher.stop()
  })

  it('a status rule does not re-run on the same state, but runs again after the ticket re-enters the status', async () => {
    const s = await setup({ ruleOver: { readyStatus: 'In Review' } })
    jira.add({ key: 'ABC-21', status: 'In Review' })
    s.watcher.listen()
    await s.watcher.pollRule(s.rule, client())
    await idle()
    await settle(s)
    expect(await deliveries()).toHaveLength(1)
    await s.watcher.pollRule(s.rule, client())
    await idle()
    expect(await deliveries()).toHaveLength(1)
    // the ticket leaves the status and comes back: a new request (wait until the first run is really finished, or the claim is deferred)
    for (let i = 0; i < 400 && (await deliveries()).some((d) => d.status !== 'Completed'); i++) await new Promise((r) => setTimeout(r, 30))
    await settle(s)
    const c = client()
    await c.transition('ABC-21', 't-In Progress')
    await c.transition('ABC-21', 't-In Review')
    await s.watcher.pollRule(s.rule, client())
    await idle()
    expect(await deliveries()).toHaveLength(2)
    s.watcher.stop()
  })

  it("another rule's finished run does not block this rule on the same ticket", async () => {
    const s = await setup({ ruleOver: { readyStatus: 'In Review' } })
    jira.add({ key: 'ABC-22', status: 'In Review', properties: { 'axon.runs': { otherRule: { deliveryId: 'x', status: 'completed', at: '2026-10-13T09:00:00.000Z', statusAtStart: 'In Review' } } } })
    await s.watcher.pollRule(s.rule, client())
    expect(await deliveries()).toHaveLength(1)
    expect(Object.keys(runs('ABC-22')).sort()).toEqual(['otherRule', 'rule1'])
  })

  it('leaves tickets that already carry a legacy axon-done label alone (status rule, no run record)', async () => {
    const s = await setup({ ruleOver: { readyStatus: 'In Review' } })
    jira.add({ key: 'ABC-23', status: 'In Review', labels: ['axon-done'] })
    await s.watcher.pollRule(s.rule, client())
    expect(await deliveries()).toHaveLength(0)
  })

  it('"Post AXON outcome comment" off: no comment, run record still updated', async () => {
    const s = await setup({ ruleOver: { postOutcomeComment: false } })
    jira.add({ key: 'ABC-24', labels: ['axon-ready'] })
    s.watcher.listen()
    await s.watcher.pollRule(s.rule, client())
    await idle()
    await settle(s)
    expect(jira.commentsOn('ABC-24')).toHaveLength(0)
    expect(runs('ABC-24').rule1.status).toBe('completed')
    s.watcher.stop()
  })

  it('cancel: removes axon-running, records cancelled, does not re-add the ready label', async () => {
    const s = await setup()
    jira.add({ key: 'ABC-25', labels: ['axon-ready'] })
    s.watcher.listen()
    await s.watcher.pollRule(s.rule, client())
    await idle()
    const [d] = await deliveries()
    h.bus.emit({ type: 'cancelled', deliveryId: d.id, at: 'x' } as never)
    await settle(s)
    expect(jira.issues.get('ABC-25')!.labels).not.toContain('axon-ready')
    expect(jira.issues.get('ABC-25')!.labels).not.toContain('axon-running')
    expect(runs('ABC-25').rule1.status).toBe('cancelled')
    s.watcher.stop()
  })

  it('Pause all: tick polls nothing; Check now polls only that rule and refuses while paused', async () => {
    let paused = true
    const s = await setup()
    jira.add({ key: 'ABC-26', labels: ['axon-ready'] })
    const w = new Watcher({
      store: h.store, bus: h.bus, statePath: s.statePath, listRules: async () => [s.rule, { ...s.rule, id: 'rule2', jiraProjectKey: 'XYZ' }],
      isActiveHere: async () => true, isPaused: async () => paused, makeClient: async () => client(),
      startDelivery: async () => ({ success: true }), displayName: () => 'Dev', jitterMs: () => 0,
    })
    await w.tick()
    expect(jira.count(/search\/jql/)).toBe(0)
    await expect(w.checkRule('rule1')).rejects.toThrow(/paused/i)
    paused = false
    expect(await w.checkRule('rule1')).toBe(1)
    expect(jira.count(/search\/jql/)).toBe(1)
    const st = await w.status()
    expect(st.rules.find((r) => r.ruleId === 'rule1')).toMatchObject({ lastMatchKey: 'ABC-26' })
    expect(st.rules.find((r) => r.ruleId === 'rule2')!.lastPollAt).toBeNull()
  })
})
