import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileStore } from '../fileStore'
import { declaredContractSection } from '../../runners/claudePrompt'
import type { BlockInput } from '../../../shared'

let dir: string
let store: FileStore
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-contract-'))
  store = new FileStore({ dir })
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const skill = (axon?: string) => `---\nname: Demo Planner\ndescription: plans\n${axon ?? ''}\n---\nPlan the work.`
const base = (content: string, over: Partial<BlockInput> = {}): BlockInput => ({
  name: 'Demo Planner', role: 'Execution', description: '', tags: [], sourceType: 'Local', agentRuntime: 'Claude', artifactFormat: 'Skill',
  executionType: 'Prompt', cachedFiles: [{ relativePath: 'SKILL.md', content }], entryPointPath: 'SKILL.md', ...over,
} as BlockInput)

const AXON = 'axon:\n  inputs: [ticket, item.repo]\n  outputs:\n    workItems: { list: true, itemFields: [repo] }\n    summary: text'

describe('artifact contract (D19) on create / update', () => {
  it('the frontmatter contract is stored on the block and wins over what the form sent', async () => {
    const b = await store.createBlock(base(skill(AXON), { contextRequirements: ['spec'], outputSchema: ['other'] }))
    expect(b.contextRequirements).toEqual(['ticket', 'item'])
    expect(b.requiredItemFields).toEqual(['repo'])
    expect(b.outputSchema).toEqual([{ name: 'workItems', type: 'WorkItemList', itemFields: ['repo'] }, 'summary'])
  })

  it('without frontmatter the form fields are used as before (migration: nothing changes)', async () => {
    const b = await store.createBlock(base(skill(), { contextRequirements: ['ticket'], outputSchema: ['summary'], requiredItemFields: ['repo'] }))
    expect(b).toMatchObject({ contextRequirements: ['ticket'], outputSchema: ['summary'], requiredItemFields: ['repo'] })
  })

  it('editing the artifact re-derives the contract on update; removing it keeps the last stored fields', async () => {
    const b = await store.createBlock(base(skill(AXON)))
    const u = await store.updateBlock(b.id, { cachedFiles: [{ relativePath: 'SKILL.md', content: skill('axon:\n  inputs: [task]\n  outputs:\n    summary: text') }] })
    expect(u).toMatchObject({ contextRequirements: ['task'], outputSchema: ['summary'] })
    expect(u.requiredItemFields).toBeUndefined()
    const plain = await store.updateBlock(b.id, { cachedFiles: [{ relativePath: 'SKILL.md', content: skill() }], outputSchema: ['x'] })
    expect(plain.outputSchema).toEqual(['x'])
  })

  it('an invalid axon: declaration is refused with the reason', async () => {
    await expect(store.createBlock(base(skill('axon:\n  outputs:\n    a: banana')))).rejects.toThrow(/axon: contract is invalid.*unknown type "banana"/)
  })

  it('the output contract is appended to the prompt only when the artifact declares it', () => {
    expect(declaredContractSection(skill(AXON))).toMatch(/<axon_output_contract>[\s\S]*"workItems"[\s\S]*"summary": text/)
    expect(declaredContractSection(skill())).toBe('')
    expect(declaredContractSection(skill('axon:\n  outputs:\n    a: banana'))).toBe('')
  })
})
