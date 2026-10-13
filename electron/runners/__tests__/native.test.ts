import { describe, it, expect } from 'vitest'
import { runNativeBlock, NATIVE_BLOCKS } from '../native/registry'
import { createRunner } from '../index'
import type { RunnerInput } from '../types'
import type { Block } from '../../../shared'

const input = (artifactName: string, pool: Record<string, unknown> = {}): RunnerInput => ({
  deliveryId: 'd1',
  block: { artifactName, agentRuntime: 'Axon' } as unknown as Block,
  nodeLabel: 'n', instructions: '',
  deliveryContext: { ticketId: 'PROJ-1', previousStepsResults: pool, currentInputs: {} },
  workspacePath: '/w', effectiveTools: [], timeoutSeconds: 5, signal: new AbortController().signal,
})

describe('native block registry', () => {
  it('registers the S4 blocks and the S5b action blocks', () => {
    expect(Object.keys(NATIVE_BLOCKS).sort()).toEqual(['find-prs', 'human-gate', 'jira-update', 'pr-creator', 'pr-update', 'ticket-fetcher', 'workspace-provisioner'])
  })
  it('human-gate returns a valid output without services', async () => {
    expect(await runNativeBlock(input('human-gate'), undefined)).toMatchObject({ status: 'success', summary: 'Awaiting human review' })
  })
  it('validates input with zod and fails the step with a clear message', async () => {
    const r = await runNativeBlock(input('pr-creator', { stepCwds: 'nope' }), {} as never)
    expect(r.status).toBe('failed')
    expect(r.errorMessage).toMatch(/pr-creator input is invalid/)
  })
  it('workspace-provisioner without a work-item list fails clearly', async () => {
    const services = { getCatalog: async () => [], getWorkspaceRoot: () => '/w', username: () => 'u', makeGit: async () => { throw new Error('unused') } } as never
    await expect(runNativeBlock(input('workspace-provisioner', {}), services)).rejects.toThrow(/needs a work-item list/)
  })
  it('unknown native blocks are errors; Jira blocks fail clearly without a Jira connection', async () => {
    await expect(runNativeBlock(input('no-such-block'), undefined)).rejects.toThrow(/No native handler/)
    await expect(runNativeBlock(input('ticket-fetcher'), { jira: async () => null } as never)).rejects.toThrow(/Jira is not connected/)
    await expect(runNativeBlock(input('jira-update'), { jira: async () => null } as never)).rejects.toThrow(/Jira is not connected/)
  })
  it('createRunner routes Axon-runtime blocks through the registry', async () => {
    const run = createRunner(() => '')
    expect((await run(input('human-gate'))).status).toBe('success')
  })
})
