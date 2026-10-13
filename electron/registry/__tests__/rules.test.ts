import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import YAML from 'yaml'
import { createMachine, createRemote, makeTmp, remoteFile, remoteFiles } from './fixtures'
import { assertWritable, rulePath } from '../layout'
import { parseRule, ruleYaml } from '../docs'
import type { SaveRuleInput } from '../../../shared'

let root: string
beforeEach(async () => { root = await makeTmp() })
afterEach(() => fs.rm(root, { recursive: true, force: true }))

const input = (over: Partial<SaveRuleInput> = {}): SaveRuleInput => ({
  name: 'ABC ready', source: 'jira', postOutcomeComment: true, enabled: false, jiraProjectKey: 'ABC', readyLabel: 'axon-ready', pipelineId: 'p1', pipelineVersion: 2, pollIntervalMinutes: 5, ...over,
})

describe('watcher rules in the registry', () => {
  it('a saved rule is queued under users/{email}/rules and pushed on sync', async () => {
    const remote = await createRemote(root)
    const m = await createMachine(root, 'alice', remote)
    const rule = await m.rules.save(input())
    expect(rule).toMatchObject({ scope: 'Personal', owner: 'alice@example.com', jiraProjectKey: 'ABC' })
    await m.sync.syncNow()
    const file = await remoteFile(root, remote, rulePath('alice@example.com', rule.id))
    expect(file).not.toBeNull()
    expect(parseRule(file as string)).toMatchObject({ id: rule.id, name: 'ABC ready', pipelineVersion: 2 })
    expect((await remoteFiles(remote)).some((f) => f.startsWith('users/alice@example.com/rules/'))).toBe(true)
  })

  it('arrives disabled on a fresh machine of the same engineer and never overwrites a local rule', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'aliceA', remote, { email: 'alice@example.com' })
    const rule = await a.rules.save(input())
    await a.rules.setEnabled(rule.id, true)
    await a.sync.syncNow()

    const b = await createMachine(root, 'aliceBB', remote, { email: 'alice@example.com' })
    await b.sync.syncNow()
    const onB = await b.rules.list()
    expect(onB).toHaveLength(1)
    expect(onB[0]).toMatchObject({ id: rule.id, enabled: false })

    const local = await b.rules.save({ ...input({ name: 'renamed on B' }), id: rule.id })
    await b.service.hydrate()
    expect((await b.rules.get(rule.id))?.name).toBe(local.name)
  })

  it('deleting a rule queues a delete and a pending delete is not resurrected by hydration', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'alice', remote)
    const rule = await a.rules.save(input())
    await a.sync.syncNow()
    await a.rules.delete(rule.id)
    await a.service.hydrate() // the file is still in the clone until the delete is pushed
    expect(await a.rules.list()).toHaveLength(0)
    await a.sync.syncNow()
    expect(await remoteFile(root, remote, rulePath('alice@example.com', rule.id))).toBeNull()
  })

  it('rule files can only be written under the engineer own folder', () => {
    expect(() => assertWritable(rulePath('alice@example.com', 'r1'), 'alice@example.com')).not.toThrow()
    expect(() => assertWritable(rulePath('bob@example.com', 'r1'), 'alice@example.com')).toThrow(/outside/)
    expect(() => rulePath('alice@example.com', '../x')).toThrow()
  })

  it('round-trips through YAML and rejects a poll interval under 2 minutes', () => {
    const yaml = ruleYaml({
      id: 'r1', schemaVersion: 2, scope: 'Personal', owner: 'a@b.co', name: 'n', source: 'jira', postOutcomeComment: true, enabled: false, jiraProjectKey: 'ABC', readyLabel: 'axon-ready',
      pipelineId: 'p', pipelineVersion: 1, pollIntervalMinutes: 5,
    })
    expect(parseRule(yaml)?.pollIntervalMinutes).toBe(5)
    expect(parseRule(YAML.stringify({ ...YAML.parse(yaml), pollIntervalMinutes: 1 }))).toBeNull()
  })
})

describe('active machine (D10)', () => {
  it('the claiming machine writes activeMachine + heartbeat to profile.yaml', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'aliceA', remote, { email: 'alice@example.com', watcherHere: true })
    await a.service.updateProfile({ takeover: true })
    await a.sync.syncNow()
    const profile = YAML.parse((await remoteFile(root, remote, 'users/alice@example.com/profile.yaml')) as string)
    expect(profile.activeMachine).toMatchObject({ id: a.identity.get()?.machineId })
    expect(typeof profile.activeMachine.heartbeatAt).toBe('string')
    expect((await a.service.watcherStatus()).activeHere).toBe(true)
  })

  it('another machine sees the claim, and a plain heartbeat never takes over (it yields)', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'aliceA', remote, { email: 'alice@example.com', watcherHere: true })
    await a.service.updateProfile({ takeover: true })
    await a.sync.syncNow()

    const b = await createMachine(root, 'aliceBB', remote, { email: 'alice@example.com', watcherHere: true }) // the switch was left on here
    await b.sync.syncNow()
    const seen = await b.service.watcherStatus()
    expect(seen.other).toMatchObject({ stale: false })
    expect(seen.activeHere).toBe(false)
    await b.service.updateProfile() // a heartbeat, not a takeover
    expect(b.flags.watcherHere).toBe(false) // yielded
    await b.sync.syncNow()
    const profile = YAML.parse((await remoteFile(root, remote, 'users/alice@example.com/profile.yaml')) as string)
    expect(profile.activeMachine.id).toBe(a.identity.get()?.machineId)
  })

  it('a manual takeover moves the claim; the previous machine then yields', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'aliceA', remote, { email: 'alice@example.com', watcherHere: true })
    await a.service.updateProfile({ takeover: true })
    await a.sync.syncNow()

    const b = await createMachine(root, 'aliceBB', remote, { email: 'alice@example.com' })
    await b.sync.syncNow()
    b.flags.watcherHere = true
    await b.service.updateProfile({ takeover: true })
    await b.sync.syncNow()

    await a.sync.syncNow()
    expect((await a.service.watcherStatus()).activeHere).toBe(false) // never two watchers, even before A heartbeats again
    await a.service.updateProfile()
    expect(a.flags.watcherHere).toBe(false)
  })

  it('a stale heartbeat is flagged but never auto-taken over', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'aliceA', remote, { email: 'alice@example.com', watcherHere: true })
    await a.service.updateProfile({ takeover: true })
    await a.sync.syncNow()
    const b = await createMachine(root, 'aliceBB', remote, { email: 'alice@example.com' })
    await b.sync.syncNow()
    const RealDate = Date
    const later = RealDate.now() + 30 * 60_000
    // The service reads time through `new Date()`; freeze it 30 minutes ahead.
    globalThis.Date = class extends RealDate {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        if (args.length === 0) super(later)
        else super(...(args as [number]))
      }
      static now() { return later }
    } as DateConstructor
    try {
      const status = await b.service.watcherStatus()
      expect(status.other?.stale).toBe(true)
      expect(status.claimedHere).toBe(false)
      expect(status.activeHere).toBe(false) // takeover stays manual
    } finally {
      globalThis.Date = RealDate
    }
  })
})

describe('Pause all (S5b)', () => {
  it('takes effect at once on this machine, survives a sync in either direction, and reaches another machine', async () => {
    const remote = await createRemote(root)
    const a = await createMachine(root, 'aliceA', remote, { email: 'alice@example.com' })
    await a.service.updateProfile()
    await a.sync.syncNow()
    expect(await a.service.isPaused()).toBe(false)

    await a.service.setPaused(true)
    expect(await a.service.isPaused()).toBe(true) // before any sync
    await a.sync.syncNow()
    expect(await a.service.isPaused()).toBe(true)

    await a.service.setPaused(false)
    expect(await a.service.isPaused()).toBe(false) // immediately, while the clone still says paused
    await a.sync.syncNow()
    expect(await a.service.isPaused()).toBe(false)

    // another machine of the same engineer sees the latest switch after its next sync
    await a.service.setPaused(true)
    await a.sync.syncNow()
    const b = await createMachine(root, 'aliceBB', remote, { email: 'alice@example.com' })
    await b.sync.syncNow()
    expect(await b.service.isPaused()).toBe(true)
  })
})
