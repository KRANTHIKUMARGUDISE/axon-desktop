import { describe, it, expect } from 'vitest'
import {
  validatePipeline, describeHandoff, effectiveItemFields, buildRepoCatalogText, capSummary, validateWorkItemList, decisionToolWarning,
} from '../index'
import type { PipelineNode, PipelineEdge } from '../index'
import type { ValidatorBlock } from '../pipelineValidator'

const pos = { x: 0, y: 0 }
const e = (s: string, t: string): PipelineEdge => ({ id: `${s}-${t}`, sourceNodeId: s, targetNodeId: t })
const planner = (itemFields?: string[]): ValidatorBlock => ({
  id: 'planner', name: 'Demo Planner', role: 'Decision', outputSchema: [{ name: 'work', type: 'WorkItemList', ...(itemFields ? { itemFields } : {}) }],
})
const prov: ValidatorBlock = { id: 'prov', name: 'Workspace Provisioner', role: 'IO', artifactName: 'workspace-provisioner', requiredItemFields: ['repo'], outputSchema: [{ name: 'work', type: 'WorkItemList', itemFields: ['repo'] }] }
const nodes: PipelineNode[] = [
  { id: 'a', label: 'Demo Planner', blockId: 'planner', position: pos },
  { id: 'b', label: 'Workspace Provisioner', blockId: 'prov', position: pos },
]

describe('handoff contracts', () => {
  it('errors when the consumer requires item fields the planner does not declare', () => {
    const v = validatePipeline(nodes, [e('a', 'b')], new Map([['planner', planner()], ['prov', prov]]))
    expect(v.valid).toBe(false)
    expect(v.errors.join('\n')).toMatch(/Demo Planner.*Workspace Provisioner.*repo/)
  })
  it('passes when itemFields covers requiredItemFields', () => {
    const v = validatePipeline(nodes, [e('a', 'b')], new Map([['planner', planner(['repo'])], ['prov', prov]]))
    expect(v.errors).toEqual([])
  })
  it('errors when nothing feeds a list at all', () => {
    const v = validatePipeline([nodes[1]], [], new Map([['prov', prov]]))
    expect(v.errors.join('\n')).toMatch(/needs a work-item list/)
  })
  it('describes the handoff', () => {
    expect(describeHandoff({ name: 'Demo Planner', block: planner(['repo']) }, 'Workspace Provisioner')).toBe('Demo Planner → Workspace Provisioner: WorkItemList (key, task, repo)')
    expect(describeHandoff({ name: 'A', block: { outputSchema: ['x', { name: 'n', type: 'number' }] } }, 'B')).toBe('A → B: x, n: number')
  })
  it('validateWorkItemList names item and field for a missing required field', () => {
    const r = validateWorkItemList({ items: [{ key: 'a', task: 't', repo: 'r' }, { key: 'b', task: 't' }] }, ['repo'])
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/key "b".*"repo"/) })
  })
})

describe('Workspace Provisioner passes item fields through', () => {
  // seed-like provisioner: no static itemFields of its own, requires repo
  const seedProv: ValidatorBlock = { id: 'prov', name: 'Workspace Provisioner', role: 'IO', artifactName: 'workspace-provisioner', requiredItemFields: ['repo'], outputSchema: [{ name: 'workItems', type: 'WorkItemList' }] }
  const body = (req: string[]): ValidatorBlock => ({ id: 'body', name: 'Coder', role: 'Execution', executionType: 'Agentic', contextRequirements: ['item'], requiredItemFields: req })
  const pn: PipelineNode[] = [
    { id: 'a', label: 'Planner', blockId: 'planner', position: pos },
    { id: 'p', label: 'Prov', blockId: 'prov', position: pos },
    { id: 'fe', type: 'forEach', blockId: '', label: 'fe', position: pos },
    { id: 'c', label: 'Coder', blockId: 'body', parentId: 'fe', position: pos },
  ]
  const pe = [e('a', 'p'), e('p', 'fe')]
  const run = (itemFields: string[] | undefined, req: string[]) =>
    validatePipeline(pn, pe, new Map([['planner', planner(itemFields)], ['prov', seedProv], ['body', body(req)]]))

  it('effective item fields = input fields + workspacePath', () => {
    const blocks = new Map([['planner', planner(['repo', 'lang'])], ['prov', seedProv]])
    const eff = effectiveItemFields(pn[1], pn, pe, blocks)
    expect(eff).toEqual(['repo', 'lang', 'workspacePath'])
    expect(describeHandoff({ name: 'Prov', block: seedProv }, 'fe', eff)).toBe('Prov → fe: WorkItemList (key, task, repo, lang, workspacePath)')
  })
  it('a ForEach body may require what the provisioner passes through or adds', () => {
    expect(run(['repo', 'lang'], ['repo', 'lang', 'workspacePath']).errors).toEqual([])
  })
  it('a ForEach body requiring a field nobody provides is an error naming it', () => {
    expect(run(['repo'], ['branch']).errors.join('\n')).toMatch(/Prov.*Coder.*branch/)
  })
  it('the provisioner still needs the planner to declare repo', () => {
    expect(run(undefined, []).errors.join('\n')).toMatch(/Planner.*Prov.*repo/)
  })
})

describe('summary cap, repoCatalog text, decision warning', () => {
  it('caps summaries at 500 chars', () => {
    expect(capSummary('x'.repeat(2000)).length).toBe(500)
    expect(capSummary('short')).toBe('short')
  })
  it('builds compact catalog lines and filters by tags', () => {
    const entries = [{ name: 'web', description: 'UI', tags: ['fe'] }, { name: 'api', tags: ['be', 'pay'] }, { name: 'bare' }]
    expect(buildRepoCatalogText(entries).text).toBe('web: UI [fe]\napi: [be, pay]\nbare:')
    expect(buildRepoCatalogText(entries, ['PAY']).text).toBe('api: [be, pay]')
    expect(buildRepoCatalogText(entries, ['pay']).repos).toBe(1)
  })
  it('warns when a Decision agentic block requests mutating tools', () => {
    expect(decisionToolWarning('Decision', 'Agentic', ['Read', 'Edit'])).toMatch(/Edit/)
    expect(decisionToolWarning('Decision', 'Agentic', ['Read'])).toBeNull()
    expect(decisionToolWarning('Execution', 'Agentic', ['Bash'])).toBeNull()
    expect(decisionToolWarning('Decision', 'Prompt', ['Bash'])).toBeNull()
  })
})
