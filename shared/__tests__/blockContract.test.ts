import { describe, it, expect } from 'vitest'
import {
  parseAxonContract, contractToFields, fieldsToContract, contractSummary, reconcileContract, contractPromptSection, readFrontmatter,
} from '../blockContract'

const md = (axon: string, body = '# prompt') => `---\nname: Demo Planner\ndescription: plans\n${axon}\n---\n${body}`

const PLANNER = md(`axon:
  inputs: [ticket, repoCatalog]
  outputs:
    workItems: { list: true, itemFields: [repo] }
    summary: text`)

const CODER = md(`axon:
  inputs: [task, shared, item.repo, itemKey]
  outputs:
    summary: text`)

describe('block contract in frontmatter (D19)', () => {
  it('a file without axon: is not declared', () => {
    expect(parseAxonContract('# just a prompt').declared).toBe(false)
    expect(parseAxonContract('---\nname: x\n---\nbody').declared).toBe(false)
    expect(readFrontmatter('no frontmatter')).toBeNull()
  })

  it('parses inputs and outputs', () => {
    const p = parseAxonContract(PLANNER)
    expect(p).toMatchObject({ declared: true, errors: [] })
    expect(p.contract.inputs).toEqual(['ticket', 'repoCatalog'])
    expect(p.contract.outputs).toEqual([
      { name: 'workItems', kind: 'array', list: true, itemFields: ['repo'] },
      { name: 'summary', kind: 'text' },
    ])
  })

  it('maps onto the existing block fields (item.<field> = required item field + item context)', () => {
    expect(contractToFields(parseAxonContract(PLANNER).contract)).toEqual({
      contextRequirements: ['ticket', 'repoCatalog'],
      outputSchema: [{ name: 'workItems', type: 'WorkItemList', itemFields: ['repo'] }, 'summary'],
      requiredItemFields: [],
    })
    expect(contractToFields(parseAxonContract(CODER).contract)).toEqual({
      contextRequirements: ['task', 'shared', 'item', 'itemKey'],
      outputSchema: ['summary'],
      requiredItemFields: ['repo'],
    })
  })

  it('optional inputs keep their ?', () => {
    const f = contractToFields(parseAxonContract(md('axon:\n  inputs: [ticket, acceptanceCriteria?]')).contract)
    expect(f.contextRequirements).toEqual(['ticket', 'acceptanceCriteria?'])
  })

  it('rejects bad declarations with a reason (and the declaration is then ignored)', () => {
    const two = parseAxonContract(md('axon:\n  outputs:\n    a: { list: true }\n    b: { list: true }'))
    expect(two.errors.join()).toMatch(/at most one work-item list/)
    expect(parseAxonContract(md('axon:\n  outputs:\n    a: banana')).errors.join()).toMatch(/unknown type "banana"/)
    expect(parseAxonContract(md('axon:\n  inputs: ["bad name"]')).errors.join()).toMatch(/not a valid name/)
    expect(parseAxonContract(md('axon:\n  inputs: [item.a.b]')).errors.join()).toMatch(/not a valid name/)
    expect(parseAxonContract(md('axon: nope')).errors.join()).toMatch(/must contain/)
  })

  it('round-trips stored fields <-> contract, so a block without frontmatter edits the same way', () => {
    const fields = contractToFields(parseAxonContract(CODER).contract)
    const back = fieldsToContract(fields)
    expect(back.inputs).toEqual(['task', 'shared', 'itemKey', 'item.repo'])
    expect(contractToFields(back)).toEqual({ ...fields, contextRequirements: ['task', 'shared', 'itemKey', 'item'] })
    // typed legacy entries survive
    expect(fieldsToContract({ outputSchema: [{ name: 'n', type: 'number' }, { name: 'wi', type: 'WorkItemList', itemFields: ['repo'] }, 'plain'] }).outputs).toEqual([
      { name: 'n', kind: 'number' }, { name: 'wi', kind: 'array', list: true, itemFields: ['repo'] }, { name: 'plain', kind: 'text' },
    ])
  })

  it('summarises Needs / Returns', () => {
    expect(contractSummary(parseAxonContract(PLANNER).contract)).toEqual({ needs: 'ticket, repoCatalog', returns: 'workItems (work list: repo), summary' })
    expect(contractSummary({ inputs: [], outputs: [] })).toEqual({ needs: 'nothing from earlier steps', returns: 'nothing declared' })
  })

  it('frontmatter wins over the form; a difference is reported, equal values are not', () => {
    const declared = parseAxonContract(PLANNER)
    const same = reconcileContract(declared, contractToFields(declared.contract))
    expect(same).toMatchObject({ source: 'artifact', warnings: [] })
    const differ = reconcileContract(declared, { contextRequirements: ['ticket'], outputSchema: ['x'] })
    expect(differ.source).toBe('artifact')
    expect(differ.warnings[0]).toMatch(/disagree/)
    expect(differ.fields.outputSchema).toHaveLength(2)
    // nothing in the form yet: no warning; no frontmatter: the form is used as is
    expect(reconcileContract(declared, {}).warnings).toEqual([])
    expect(reconcileContract(parseAxonContract('plain'), { contextRequirements: ['a'] })).toMatchObject({ source: 'form', fields: { contextRequirements: ['a'] } })
    // an invalid declaration is ignored
    expect(reconcileContract(parseAxonContract(md('axon:\n  outputs:\n    a: banana')), { contextRequirements: ['a'] }).source).toBe('form')
  })

  it('appends an output contract to the prompt only when declared', () => {
    const section = contractPromptSection(parseAxonContract(PLANNER).contract)
    expect(section).toMatch(/<axon_output_contract>/)
    expect(section).toMatch(/"workItems": a work-item list/)
    expect(section).toMatch(/"repo": "\.\.\."/)
    expect(section).toMatch(/"summary": text/)
    expect(contractPromptSection({ inputs: ['a'], outputs: [] })).toBe('')
  })
})
