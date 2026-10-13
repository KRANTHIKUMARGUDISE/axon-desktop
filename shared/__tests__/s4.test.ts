import { describe, it, expect } from 'vitest'
import {
  parseWorkItemList, validateWorkItemList, validatePipeline, forEachBody, findStartNode, resolvePipelineProgress,
  outputFieldNames, toPipelineNodes, forEachSourceLabel, atMostOneWorkItemListField, showConfidence,
} from '../index'
import type { PipelineNode, PipelineEdge } from '../index'
import type { ValidatorBlock } from '../pipelineValidator'

describe('WorkItemList (D16)', () => {
  const list = (items: unknown[], shared?: unknown) => ({ items, shared })
  it('accepts {key, task} items, passes extra fields through untouched, keeps shared', () => {
    const r = parseWorkItemList(list([{ key: 'a', task: 'do a', repo: 'api', extra: { deep: 1 } }, { key: 'b', task: 'do b', workspacePath: '/w/b' }], { s: 1 }))
    expect(r.ok && r.entries.map((e) => e.key)).toEqual(['a', 'b'])
    expect(r.ok && r.entries[0].item).toEqual({ key: 'a', task: 'do a', repo: 'api', extra: { deep: 1 } })
    expect(r.ok && r.shared).toEqual({ s: 1 })
  })
  it('rejects a missing key, a missing task, a duplicate key and a non-list, naming the item', () => {
    expect(validateWorkItemList(list([{ key: 'a', task: 't' }, { task: 'x' }]))).toMatchObject({ ok: false, error: expect.stringMatching(/#2 has no "key"/) })
    expect(validateWorkItemList(list([{ key: 'a' }]))).toMatchObject({ ok: false, error: expect.stringMatching(/#1 \(key "a"\) has no "task"/) })
    expect(validateWorkItemList(list([{ key: 'a', task: 't' }, { key: 'a', task: 'u' }]))).toMatchObject({ ok: false, error: expect.stringMatching(/Duplicate work item key "a"/) })
    expect(validateWorkItemList({ nope: 1 }).ok).toBe(false)
    expect(validateWorkItemList(list([{ key: 'a', task: 5 }])).ok).toBe(false)
    expect(validateWorkItemList(list([{ key: 'a', task: 't', workspacePath: 3 }])).ok).toBe(false)
  })
  it('runs items in list order (dependsOn is not interpreted)', () => {
    const r = parseWorkItemList(list([{ key: 'b', task: 'x', dependsOn: ['a'] }, { key: 'a', task: 'y' }]))
    expect(r.ok && r.entries.map((e) => e.key)).toEqual(['b', 'a'])
  })
  it('an empty list fails by default and passes with onEmpty: skip; maxItems caps (default 10)', () => {
    expect(parseWorkItemList(list([]))).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) })
    expect(parseWorkItemList(list([]), { onEmpty: 'fail' }).ok).toBe(false)
    expect(parseWorkItemList(list([]), { onEmpty: 'skip' })).toMatchObject({ ok: true, entries: [] })
    const eleven = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, task: 't' }))
    expect(parseWorkItemList(list(eleven)).ok).toBe(false)
    expect(parseWorkItemList(list(eleven), { maxItems: 11 }).ok).toBe(true)
  })
  it('a block may declare at most one WorkItemList output', () => {
    const two = { name: 'x', outputSchema: [{ name: 'a', type: 'WorkItemList' }, { name: 'b', type: 'WorkItemList' }] }
    expect(atMostOneWorkItemListField(two)).toMatch(/at most one/)
    expect(atMostOneWorkItemListField({ name: 'x', outputSchema: [{ name: 'a', type: 'WorkItemList' }, 'b'] })).toBeNull()
  })
})

const blk = (id: string, over: Partial<ValidatorBlock> = {}): [string, ValidatorBlock] => [id, { id, role: 'Execution', ...over }]
const blocks = new Map<string, ValidatorBlock>([
  blk('plan', { outputSchema: [{ name: 'work', type: 'WorkItemList' }, 'loose'] }),
  blk('plan2', { outputSchema: [{ name: 'work2', type: 'WorkItemList' }] }),
  blk('noList', { outputSchema: ['loose'] }),
  blk('prov', { role: 'IO', artifactName: 'workspace-provisioner', outputSchema: [{ name: 'workItems', type: 'WorkItemList' }, 'provisionedRepos'] }),
  blk('agent', { executionType: 'Agentic', contextRequirements: ['item', 'task'] }),
  blk('agentNoCtx', { executionType: 'Agentic' }),
  blk('plain', { executionType: 'Prompt', contextRequirements: ['x'] }),
  blk('needsTask', { executionType: 'Prompt', contextRequirements: ['task'] }),
  blk('needsItem', { executionType: 'Prompt', contextRequirements: ['item'] }),
  blk('needsKey', { executionType: 'Prompt', contextRequirements: ['itemKey'] }),
  blk('needsDone', { executionType: 'Prompt', contextRequirements: ['completedItems'] }),
  blk('pr', { artifactName: 'pr-creator' }),
  blk('gate', { role: 'Control' }),
])
const n = (id: string, blockId: string, extra: Partial<PipelineNode> = {}): PipelineNode => ({ id, blockId, label: id, position: { x: 0, y: 0 }, ...extra })
const fe = (id: string, extra: Partial<PipelineNode> = {}): PipelineNode => ({ id, type: 'forEach', blockId: '', label: id, position: { x: 0, y: 0 }, ...extra })
const e = (s: string, t: string): PipelineEdge => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t })
const errs = (nodes: PipelineNode[], edges: PipelineEdge[]) => validatePipeline(nodes, edges, blocks).errors.join('|')

describe('validatePipeline — ForEach contract (D16)', () => {
  it('accepts planner -> ForEach(agent) -> gate -> pr-creator with no provisioner', () => {
    const nodes = [n('p', 'plan'), fe('f'), n('a', 'agent', { parentId: 'f' }), n('g', 'gate'), n('r', 'pr')]
    const edges = [e('p', 'f'), e('f', 'g'), e('g', 'r')]
    expect(validatePipeline(nodes, edges, blocks)).toMatchObject({ valid: true, errors: [] })
    expect(findStartNode(nodes, edges)?.id).toBe('p')
  })
  it('accepts planner -> provisioner -> ForEach (the provisioner returns the list)', () => {
    const nodes = [n('p', 'plan'), n('v', 'prov'), fe('f'), n('a', 'plain', { parentId: 'f' })]
    expect(validatePipeline(nodes, [e('p', 'v'), e('v', 'f')], blocks).valid).toBe(true)
  })
  it('a ForEach with no predecessor fails: connect a block that returns a work-item list', () => {
    expect(errs([fe('f'), n('a', 'plain', { parentId: 'f' })], [])).toMatch(/Connect a block that returns a work-item list/)
  })
  it('a ForEach whose predecessor has no WorkItemList output fails', () => {
    expect(errs([n('p', 'noList'), fe('f'), n('a', 'plain', { parentId: 'f' })], [e('p', 'f')])).toMatch(/does not declare a work-item list output/)
  })
  it('a ForEach with two predecessors fails', () => {
    expect(errs([n('p', 'plan'), n('q', 'plan2'), fe('f'), n('a', 'plain', { parentId: 'f' })], [e('p', 'f'), e('q', 'f')])).toMatch(/exactly one incoming connection \(found 2\)/)
  })
  it('per-item fields (item, itemKey, task, completedItems) outside a ForEach are errors', () => {
    for (const b of ['needsItem', 'needsTask', 'needsKey', 'needsDone']) {
      expect(errs([n('o', b)], [])).toMatch(/is not inside a ForEach/)
    }
    expect(errs([n('p', 'plan'), fe('f'), n('a', 'needsTask', { parentId: 'f' })], [e('p', 'f')])).not.toMatch(/not inside a ForEach/)
  })
  it('Human Gate and PR Creator inside a ForEach are errors', () => {
    const v = errs([n('p', 'plan'), fe('f'), n('g', 'gate', { parentId: 'f' }), n('r', 'pr', { parentId: 'f' })], [e('p', 'f'), e('g', 'r')])
    expect(v).toMatch(/Human Gate\) must sit outside a ForEach/)
    expect(v).toMatch(/PR Creator\) must sit outside a ForEach/)
  })
  it('body needs exactly one entry/exit, a straight chain, no crossing edges', () => {
    const base = [n('p', 'plan'), fe('f')]
    expect(errs([...base, n('a', 'plain', { parentId: 'f' }), n('b', 'plain', { parentId: 'f' })], [e('p', 'f')])).toMatch(/exactly one entry node \(found 2\)/)
    expect(errs([...base, n('a', 'plain', { parentId: 'f' }), n('z', 'plain')], [e('p', 'f'), e('a', 'z')])).toMatch(/crosses the border/)
    expect(errs(base, [e('p', 'f')])).toMatch(/no nodes inside/)
    expect(errs([...base, n('a', 'plain', { parentId: 'f' }), n('b', 'plain', { parentId: 'f' })], [e('p', 'f'), e('a', 'b'), e('b', 'a')])).toMatch(/cycle|entry/i)
  })
  it('Agentic blocks must declare contextRequirements; a block with two WorkItemList outputs is flagged', () => {
    expect(errs([n('a', 'agentNoCtx')], [])).toMatch(/must declare contextRequirements/)
    const two = new Map(blocks).set('two', { id: 'two', role: 'Execution', outputSchema: [{ name: 'a', type: 'WorkItemList' }, { name: 'b', type: 'WorkItemList' }] })
    expect(validatePipeline([n('t', 'two')], [], two).errors.join()).toMatch(/at most one WorkItemList/)
  })
  it('forEachBody returns the chain in order; progress only counts the ForEach summary step', () => {
    const nodes = [n('p', 'plan'), fe('f'), n('a', 'plain', { parentId: 'f' }), n('b', 'plain', { parentId: 'f' })]
    const edges = [e('p', 'f'), e('a', 'b')]
    expect(forEachBody('f', nodes, edges).map((x) => x.id)).toEqual(['a', 'b'])
    const partial = [{ nodeId: 'p', status: 'Completed' as const }, { nodeId: 'a', status: 'Completed' as const, itemKey: 'k1' }]
    expect(resolvePipelineProgress(nodes, edges, partial).resumeNode?.id).toBe('f')
    expect(resolvePipelineProgress(nodes, edges, [...partial, { nodeId: 'f', status: 'Completed' as const }]).resumeNode).toBeUndefined()
  })
  it('the canvas header names the predecessor', () => {
    const nodes = [n('p', 'plan', { label: 'Epic Planner' }), fe('f')]
    expect(forEachSourceLabel('f', nodes, [e('p', 'f')])).toBe('Epic Planner')
    expect(forEachSourceLabel('f', nodes, [])).toBeUndefined()
  })
  it('warns (not errors) when a PR Creator has no Workspace Provisioner upstream', () => {
    const noProv = validatePipeline([n('p', 'plan'), n('r', 'pr')], [e('p', 'r')], blocks)
    expect(noProv.valid).toBe(true)
    expect(noProv.warnings.join('|')).toMatch(/PR Creator\) has no Workspace Provisioner upstream/)
    const withProv = validatePipeline([n('p', 'plan'), n('v', 'prov'), n('r', 'pr')], [e('p', 'v'), e('v', 'r')], blocks)
    expect(withProv.warnings.join('|')).not.toMatch(/Workspace Provisioner upstream/)
  })
  it('typed outputSchema entries keep working as plain names', () => {
    expect(outputFieldNames(['a', { name: 'b', type: 'WorkItemList' }])).toEqual(['a', 'b'])
  })
})

describe('Draft save (toPipelineNodes)', () => {
  const rf = (id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, position: { x: 1, y: 2 }, data, ...extra })
  it('keeps blockVersion pins, parentId and relative positions; parents come first', () => {
    const out = toPipelineNodes([
      rf('c', { label: 'Coder', nodeType: 'Execution', blockId: 'b1', blockVersion: 3 }, { parentId: 'f' }),
      rf('f', { label: 'Per item', nodeType: 'forEach', maxItems: 5 }, { width: 300, height: 200 }),
      rf('u', { label: 'Unpinned', nodeType: 'Execution', blockId: 'b2' }),
    ])
    expect(out.map((x) => x.id)).toEqual(['f', 'u', 'c'])
    expect(out.find((x) => x.id === 'c')).toMatchObject({ blockVersion: 3, parentId: 'f', blockId: 'b1' })
    expect(out.find((x) => x.id === 'u')).not.toHaveProperty('blockVersion')
    expect(out.find((x) => x.id === 'f')).toMatchObject({ type: 'forEach', maxItems: 5, onEmpty: 'fail', size: { width: 300, height: 200 } })
  })
})

describe('confidence (D5): optional, display-only, no threshold', () => {
  it('is shown for an agent that reported one, whatever its value (no 70% cut-off)', () => {
    for (const c of [0.05, 0.4, 0.69, 0.7, 0.95, 1]) expect(showConfidence(c, 'Claude')).toBe(true)
  })
  it('is hidden when absent (and not shown as 0%)', () => {
    expect(showConfidence(undefined, 'Claude')).toBe(false)
    expect(showConfidence(null, 'Claude')).toBe(false)
    expect(showConfidence(0, 'Claude')).toBe(false)
  })
  it('is hidden for native Axon blocks even when a value is present', () => {
    expect(showConfidence(0.9, 'Axon')).toBe(false)
  })
})
