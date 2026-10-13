import { describe, it, expect } from 'vitest'
import {
  renderTemplate, templateRefs, readJiraUpdateConfig, readPrUpdateConfig, readOnFailure, validatePipeline,
  ModelPriceSchema, SETTING_VALIDATORS, DeliveryRuleSchema, ProfileSchema, PipelineSchema,
} from '../index'
import type { PipelineNode, PipelineEdge } from '../schemas'

const data = { output: { spec: 'S', nested: { a: 1 } }, prUrls: ['u1', 'u2'], deliveryLink: 'axon://d', failureReason: 'boom', ticketKey: 'PAY-1' }

describe('templates', () => {
  it('renders known variables and output fields', () => {
    expect(renderTemplate('{{ticketKey}}: {{output.spec}} {{prUrls}} {{failureReason}} {{deliveryLink}}', data)).toBe('PAY-1: S u1\nu2 boom axon://d')
    expect(renderTemplate('{{output.nested.a}}|{{output.missing}}|{{nope}}', data)).toBe('1||')
  })
  it('lists references', () => {
    expect(templateRefs('{{output.spec}} {{ticketKey}} {{bogus}}')).toEqual({ outputs: ['spec'], unknown: ['bogus'] })
  })
})

describe('config readers', () => {
  it('are lenient', () => {
    expect(readJiraUpdateConfig(undefined)).toMatchObject({ addLabels: [], removeLabels: [] })
    expect(readJiraUpdateConfig({ transition: ' In Review ', addLabels: ['a', 3, ''] })).toMatchObject({ transition: 'In Review', addLabels: ['a'] })
    expect(readPrUpdateConfig({ readyForReview: true, reviewers: ['bob'] })).toMatchObject({ readyForReview: true, reviewers: ['bob'] })
    expect(readOnFailure([{ kind: 'jira-update', addLabels: ['code-failed'] }, { kind: 'x' }])).toHaveLength(1)
  })
})

describe('schemas', () => {
  it('rules default source jira and outcome comment on', () => {
    const r = DeliveryRuleSchema.parse({ id: 'r', owner: 'a@b.c', name: 'n', jiraProjectKey: 'AB', pipelineId: 'p', pipelineVersion: 1 })
    expect(r.source).toBe('jira')
    expect(r.postOutcomeComment).toBe(true)
  })
  it('profile defaults not paused; pipeline defaults no onFailure', () => {
    expect(ProfileSchema.parse({ id: 'a', owner: 'a', email: 'a' }).pausedAll).toBe(false)
    expect(PipelineSchema.parse({ id: 'p', name: 'n', createdAt: 'x', updatedAt: 'x' } as never).onFailure).toEqual([])
  })
  it('model prices validate', () => {
    expect(ModelPriceSchema.safeParse({ inputPerMTok: 1, outputPerMTok: 5 }).success).toBe(true)
    expect(SETTING_VALIDATORS.modelPrices.safeParse({ 'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 } }).success).toBe(true)
    expect(SETTING_VALIDATORS.modelPrices.safeParse({ 'bad key!': { inputPerMTok: 1, outputPerMTok: 5 } }).success).toBe(false)
    expect(SETTING_VALIDATORS.modelPrices.safeParse({ m: { inputPerMTok: -1, outputPerMTok: 5 } }).success).toBe(false)
  })
})

const blk = (id: string, artifactName: string, outputSchema: string[] = []) =>
  [id, { id, role: 'IO' as const, artifactName, outputSchema, contextRequirements: [] }] as const
const node = (id: string, blockId: string, config?: Record<string, unknown>): PipelineNode => ({ id, blockId, label: id, position: { x: 0, y: 0 }, config } as PipelineNode)
const edge = (s: string, t: string): PipelineEdge => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t } as PipelineEdge)

describe('validator: action blocks', () => {
  const blocks = new Map([blk('plan', 'planner', ['spec']), blk('ju', 'jira-update')]) as never
  it('accepts templates using upstream outputs', () => {
    const v = validatePipeline([node('a', 'plan'), node('b', 'ju', { comment: '{{output.spec}} {{ticketKey}}' })], [edge('a', 'b')], blocks)
    expect(v.errors).toEqual([])
  })
  it('rejects undeclared outputs, unknown tokens and empty actions', () => {
    const v = validatePipeline([node('a', 'plan'), node('b', 'ju', { comment: '{{output.nope}} {{wat}}' }), node('c', 'ju', {})], [edge('a', 'b'), edge('b', 'c')], blocks)
    expect(v.errors.join('\n')).toMatch(/output\.nope/)
    expect(v.errors.join('\n')).toMatch(/unknown template field/)
    expect(v.errors.join('\n')).toMatch(/does nothing/)
  })
})

describe('rule chains (S5b)', () => {
  const eff = (over: Partial<import('../ruleChains').PipelineEffects> = {}) => ({ addLabels: [], removeLabels: [], transitions: [], hasGate: false, ...over })
  const rule = (id: string, over: Partial<import('../ruleChains').ChainRule>): import('../ruleChains').ChainRule =>
    ({ id, name: id, jiraProjectKey: 'PAY', readyLabel: `l-${id}`, effects: eff(), ...over })

  it('links spec → code → review through labels and statuses', async () => {
    const { ruleChains } = await import('../ruleChains')
    const c = ruleChains([
      rule('spec', { readyLabel: 'spec-me', effects: eff({ addLabels: ['code-me'] }) }),
      rule('code', { readyLabel: 'code-me', effects: eff({ transitions: ['In Review'] }) }),
      rule('review', { readyStatus: 'In Review' }),
    ])
    expect(c.rules.find((r) => r.ruleId === 'spec')).toMatchObject({ next: ['code'], previous: [], triggersOn: 'label spec-me' })
    expect(c.rules.find((r) => r.ruleId === 'review')).toMatchObject({ previous: ['code'], triggersOn: 'status In Review' })
    expect(c.warnings).toEqual([])
  })
  it('warns about a loop without a Human Gate and stays quiet with one', async () => {
    const { ruleChains } = await import('../ruleChains')
    const a = (gate: boolean) => [
      rule('a', { readyLabel: 'a', effects: eff({ addLabels: ['b'], hasGate: gate }) }),
      rule('b', { readyLabel: 'b', effects: eff({ addLabels: ['a'] }) }),
    ]
    expect(ruleChains(a(false)).warnings).toHaveLength(1)
    expect(ruleChains(a(true)).warnings).toEqual([])
  })
  it('summarises what a pipeline changes in Jira', async () => {
    const { pipelineEffects } = await import('../ruleChains')
    const blocks = new Map([['ju', { id: 'ju', artifactName: 'jira-update' }], ['g', { id: 'g', role: 'Control' }]])
    const nodes = [
      { id: '1', blockId: 'ju', config: { transition: 'Done', addLabels: ['x'], removeLabels: ['y'] } },
      { id: '2', blockId: 'g', config: { mode: 'NotifyOnly' } },
    ] as never
    expect(pipelineEffects(nodes, blocks)).toEqual({ addLabels: ['x'], removeLabels: ['y'], transitions: ['Done'], hasGate: false })
  })
})

describe('inputs nobody provides', () => {
  it('flags a required field no earlier block returns, ignores optional / AXON-provided / returned ones', async () => {
    const { unprovidedInputs, validatePipeline: vp } = await import('../index')
    const blocks = new Map([
      ['planner', { id: 'planner', role: 'Execution', contextRequirements: ['ticket', 'repoCatalog', 'spec?'], outputSchema: ['workItems'] }],
      ['fetch', { id: 'fetch', role: 'IO', contextRequirements: [], outputSchema: ['ticket'] }],
    ]) as never
    const n = (id: string, blockId: string) => ({ id, blockId, label: id, position: { x: 0, y: 0 } }) as never
    expect(unprovidedInputs([n('p', 'planner')], [], blocks)).toEqual([{ node: 'p', field: 'ticket' }])
    expect(unprovidedInputs([n('f', 'fetch'), n('p', 'planner')], [{ id: 'e', sourceNodeId: 'f', targetNodeId: 'p' }] as never, blocks)).toEqual([])
    expect(vp([n('p', 'planner')], [], blocks).warnings.join()).toMatch(/needs "ticket" but no earlier block returns it/)
  })
})
