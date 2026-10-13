import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, ok } from './harness'
import type { Harness } from './harness'
import { createEngine } from '../engine'
import { runNativeBlock } from '../../runners/native/registry'
import { createActionRuntime } from '../../actions/runtime'
import { createMockJira } from '../../jira/__tests__/mockJira'
import type { MockJira } from '../../jira/__tests__/mockJira'
import { JiraClient } from '../../jira/client'
import type { AgentOutput, OnFailureAction } from '../../../shared'
import type { RunnerInput } from '../../runners/types'

let h: Harness
let jira: MockJira
afterEach(async () => { await h?.cleanup() })

const client = () => new JiraClient({ site: 'acme.atlassian.net', email: 'me@example.com', token: 't', fetchImpl: jira.fetchImpl, sleep: async () => {} })

interface Opts { jiraOpts?: Parameters<typeof createMockJira>[0]; agentFails?: boolean; failedBlocks?: boolean }

async function setup(opts: Opts = {}) {
  h = await createHarness()
  jira = createMockJira(opts.jiraOpts)
  jira.add({ key: 'PAY-12', status: 'In Progress', labels: [] })
  const agentCalls: string[] = []
  const services = { jira: async () => client(), getGitToken: async () => 'tok', getCatalog: async () => [], username: () => 'dev' } as never
  const runner = vi.fn(async (input: RunnerInput): Promise<AgentOutput> => {
    if (input.block.agentRuntime === 'Axon') return runNativeBlock(input, services)
    agentCalls.push(input.nodeLabel)
    if (opts.agentFails) return { status: 'failed', summary: 'tests red', result: {}, errorMessage: 'tests red' }
    return ok(input.nodeLabel, { spec: 'THE SPEC' })
  })
  const rt = createActionRuntime({ store: h.store, makeJiraClient: async () => client(), gh: { getToken: async () => 'tok' } })
  const engine = createEngine({
    store: h.store, runner, workspace: h.workspace, bus: h.bus, runsDir: h.runsDir, identity: () => 'dev@example.com', retryDelayMs: () => 0,
    preflight: rt.preflight, onTerminal: rt.onTerminal,
  })
  const agent = await h.mkBlock({ name: 'Spec', outputSchema: ['spec'], contextMode: 'Full' })

  async function pipeline(nodes: { label: string; kind: 'agent' | 'jira' | 'gate'; config?: Record<string, unknown> }[], extra: { onFailure?: OnFailureAction[]; onFailureOnCancel?: boolean } = {}) {
    const ns = nodes.map((n, i) => ({
      id: `n${i + 1}`, label: n.label, position: { x: i * 100, y: 0 },
      blockId: n.kind === 'agent' ? agent.id : n.kind === 'jira' ? 'axon-jira-update' : 'axon-human-gate',
      ...(n.config ? { config: n.config } : {}),
    }))
    const edges = ns.slice(1).map((n, i) => ({ id: `e${i}`, sourceNodeId: ns[i].id, targetNodeId: n.id }))
    return h.store.createPipeline({ name: 'Staged', description: '', nodes: ns, edges, ...extra })
  }
  const delivery = async (p: { id: string }, over: { retriedFromDeliveryId?: string } = {}) =>
    h.store.createDelivery({ ticketId: 'PAY-12', title: 'T', pipelineId: p.id, repoUrl: '', workspaceType: 'Default', ...over })
  const issue = () => jira.issues.get('PAY-12')!
  return { engine, agentCalls, pipeline, delivery, issue, runner }
}

const gateCfg = { reason: 'A human decides here', checklist: [], mode: 'Pause' }
const specComment = { comment: '{{output.spec}}', addLabels: ['spec-ready'] }

describe('S5b action blocks in a pipeline', () => {
  it('Jira Update posts the template, adds the label, counts as a built-in step', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }, { label: 'Update Jira', kind: 'jira', config: specComment }])
    const d = await s.delivery(p)
    expect((await s.engine.start(d.id)).success).toBe(true)
    await s.engine.whenIdle(d.id)
    const done = (await h.store.getDelivery(d.id))!
    expect(done.status).toBe('Completed')
    expect(s.issue().labels).toContain('spec-ready')
    expect(JSON.stringify(s.issue().comments[0].body)).toContain('THE SPEC')
    expect(JSON.stringify(s.issue().comments[0].body)).not.toMatch(/axon:/) // no marker text in the comment
    const step = done.steps.find((x) => x.nodeId === 'n2')!
    expect(step.agentRuntime).toBe('Axon')
    expect(step.output?.summary).toMatch(/Added spec-ready; commented/)
  })

  it('a Rerun (new delivery of the same story) never double-applies the action', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }, { label: 'Update Jira', kind: 'jira', config: specComment }])
    const d1 = await s.delivery(p)
    await s.engine.start(d1.id); await s.engine.whenIdle(d1.id)
    const d2 = await s.delivery(p, { retriedFromDeliveryId: d1.id })
    await s.engine.start(d2.id); await s.engine.whenIdle(d2.id)
    expect((await h.store.getDelivery(d2.id))!.status).toBe('Completed')
    expect(s.issue().comments).toHaveLength(1)
    expect(s.issue().labels.filter((l) => l === 'spec-ready')).toHaveLength(1)
    expect((await h.store.getDelivery(d2.id))!.steps.find((x) => x.nodeId === 'n2')!.output?.summary).toMatch(/No change needed/)
  })

  it('Jira Update after a Human Gate runs only after approval', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }, { label: 'gate', kind: 'gate', config: gateCfg }, { label: 'Update Jira', kind: 'jira', config: specComment }])
    const d = await s.delivery(p)
    await s.engine.start(d.id); await s.engine.whenIdle(d.id)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Paused')
    expect(s.issue().comments).toHaveLength(0)
    await s.engine.approveGate(d.id); await s.engine.whenIdle(d.id)
    expect(s.issue().comments).toHaveLength(1)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Completed')
  })

  it('moves the ticket to a status reachable from its current one', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }, { label: 'Move', kind: 'jira', config: { transition: 'In Review' } }])
    const d = await s.delivery(p)
    await s.engine.start(d.id); await s.engine.whenIdle(d.id)
    expect(s.issue().status).toBe('In Review')
    expect((await h.store.getDelivery(d.id))!.steps[1].output?.summary).toBe('Moved PAY-12 to In Review')
  })
})

describe('S5b pre-flight', () => {
  it('an unreachable transition stops the delivery before any agent runs', async () => {
    const s = await setup({ jiraOpts: { workflow: { 'In Progress': ['Done'] } } })
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }, { label: 'Move', kind: 'jira', config: { transition: 'In Review' } }])
    const d = await s.delivery(p)
    const res = await s.engine.start(d.id)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cannot move to "In Review" from "In Progress"/)
    expect(s.agentCalls).toEqual([])
    expect(s.runner).not.toHaveBeenCalled()
    expect((await h.store.getDelivery(d.id))!.status).toBe('Pending')
  })

  it('missing Jira permissions are reported with a clear message', async () => {
    const s = await setup({ jiraOpts: { permissions: { TRANSITION_ISSUES: false } } })
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }, { label: 'Move', kind: 'jira', config: { transition: 'Done' } }])
    const res = await s.engine.start((await s.delivery(p)).id)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Transition issues/)
    expect(s.agentCalls).toEqual([])
  })

  it('a pipeline without actions needs no Jira at all', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }])
    const d = await s.delivery(p)
    expect((await s.engine.start(d.id)).success).toBe(true)
    await s.engine.whenIdle(d.id)
    expect(jira.calls).toHaveLength(0)
  })
})

describe('S5b on-failure actions', () => {
  const onFailure: OnFailureAction[] = [{ kind: 'jira-update', addLabels: ['code-failed'], removeLabels: [], comment: 'AXON failed: {{failureReason}}' }]

  it('run after a failure, in order, and record what they did', async () => {
    const s = await setup({ agentFails: true })
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }], { onFailure })
    const d = await s.delivery(p)
    await s.engine.start(d.id); await s.engine.whenIdle(d.id)
    const done = (await h.store.getDelivery(d.id))!
    expect(done.status).toBe('Failed')
    expect(s.issue().labels).toContain('code-failed')
    expect(JSON.stringify(s.issue().comments[0].body)).toContain('tests red')
    expect(done.onFailureResults?.[0]).toMatchObject({ ok: true, event: 'failed' })
  })

  it('do not run when the delivery succeeds', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'Spec', kind: 'agent' }], { onFailure })
    const d = await s.delivery(p)
    await s.engine.start(d.id); await s.engine.whenIdle(d.id)
    expect((await h.store.getDelivery(d.id))!.status).toBe('Completed')
    expect(s.issue().labels).toEqual([])
    expect(s.issue().comments).toHaveLength(0)
  })

  it('run on cancel only when the pipeline says so', async () => {
    for (const onCancel of [false, true]) {
      const s = await setup()
      const p = await s.pipeline([{ label: 'gate', kind: 'gate', config: gateCfg }], { onFailure, onFailureOnCancel: onCancel })
      const d = await s.delivery(p)
      await s.engine.start(d.id); await s.engine.whenIdle(d.id)
      await s.engine.cancel(d.id)
      expect(s.issue().labels.includes('code-failed')).toBe(onCancel)
      await h.cleanup()
    }
  })

  it('a rejected gate counts as a failure', async () => {
    const s = await setup()
    const p = await s.pipeline([{ label: 'gate', kind: 'gate', config: gateCfg }], { onFailure })
    const d = await s.delivery(p)
    await s.engine.start(d.id); await s.engine.whenIdle(d.id)
    await s.engine.rejectGate(d.id, 'not good')
    expect(s.issue().labels).toContain('code-failed')
  })
})
