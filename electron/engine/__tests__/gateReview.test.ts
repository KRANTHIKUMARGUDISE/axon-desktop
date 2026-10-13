import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness } from './harness'
import type { Harness } from './harness'
import { buildGateReview } from '../gateReview'
import { changedFiles } from '../../workspace/changes'
import { describeNotification } from '../../notificationText'
import type { DeliveryEvent } from '../../../shared'

let h: Harness
afterEach(async () => { await h?.cleanup() })

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()

describe('gate review (Q7)', () => {
  it('shows files changed per repo, test results and each agent summary at the active gate', async () => {
    h = await createHarness({
      script: {
        coder: () => ({ status: 'success', summary: 'Added the refund endpoint', result: { done: true } }),
        tester: () => ({ status: 'success', summary: '12 passed', result: { testResults: { passed: 12, failed: 0 } } }),
      },
      workspace: { resolveCwd: async () => '/repo/refunds' },
    })
    const r = await h.run(['coder', 'tester', 'gate1'])
    const d = await r.get()
    expect(d.status).toBe('Paused')

    const asked: string[] = []
    const review = await buildGateReview(d, {
      changedFiles: async (cwd) => {
        asked.push(cwd)
        return { repo: cwd, name: 'refunds', branch: 'axon/dev/T-1-abc123', files: [{ status: 'modified', path: 'src/refunds.ts' }, { status: 'added', path: 'src/refunds.test.ts' }], truncated: false }
      },
    })
    expect(asked).toEqual(['/repo/refunds']) // each repo once, however many steps ran there
    expect(review).toMatchObject({ nodeId: 'n3', reason: 'A human decides here', mode: 'Pause' })
    expect(review!.repos[0].files.map((f) => f.path)).toEqual(['src/refunds.ts', 'src/refunds.test.ts'])
    expect(review!.tests).toEqual([{ nodeId: 'n2', blockName: 'tester', summary: '12 passed', result: { passed: 12, failed: 0 } }])
    expect(review!.agents.map((a) => `${a.blockName}: ${a.summary}`)).toEqual(['coder: Added the refund endpoint', 'tester: 12 passed'])
  })

  it('returns null when the delivery is not at a gate, and tolerates a repo that cannot be read', async () => {
    h = await createHarness()
    const r = await h.run(['a'])
    expect(await buildGateReview(await r.get(), { changedFiles: async () => null })).toBeNull()
    const g = await h.run(['a', 'gate1'])
    const review = await buildGateReview(await g.get(), { changedFiles: async () => { throw new Error('git missing') } })
    expect(review?.repos).toEqual([])
  })

  it('changedFiles lists modified, added and deleted files of a real repo (tracked and untracked)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-chg-'))
    try {
      git(dir, 'init', '-q', '-b', 'main')
      git(dir, 'config', 'user.email', 't@example.com')
      git(dir, 'config', 'user.name', 't')
      await fs.writeFile(path.join(dir, 'keep.txt'), 'one')
      await fs.writeFile(path.join(dir, 'gone.txt'), 'two')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      await fs.writeFile(path.join(dir, 'keep.txt'), 'changed')
      await fs.rm(path.join(dir, 'gone.txt'))
      await fs.mkdir(path.join(dir, 'sub'))
      await fs.writeFile(path.join(dir, 'sub', 'new.txt'), 'new')

      const res = await changedFiles(dir)
      expect(res?.name).toBe(path.basename(dir))
      expect(res?.branch).toBe('main')
      expect(Object.fromEntries(res!.files.map((f) => [f.path, f.status]))).toEqual({ 'keep.txt': 'modified', 'gone.txt': 'deleted', 'sub/new.txt': 'added' })
      expect(await changedFiles(os.tmpdir() + path.sep + 'axon-not-a-repo-' + Date.now())).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('notification text (item 10)', () => {
  const delivery = { ticketId: 'ABC-12', title: 'Refund API', pipelineName: 'P', prUrl: 'https://github.com/a/b/pull/9', errorMessage: undefined, failureCategory: undefined }
  const ev = (e: Record<string, unknown>) => ({ deliveryId: 'd1', at: 'x', ...e }) as DeliveryEvent

  it('describes gate, review-due, completed and failed; ignores the rest', () => {
    expect(describeNotification(ev({ type: 'gate_reached', nodeId: 'n', blockName: 'Human Gate', output: {} }), delivery)).toMatchObject({ title: 'Review needed: ABC-12' })
    expect(describeNotification(ev({ type: 'gate_notified', nodeId: 'n', blockName: 'Review', reason: 'Billing change' }), delivery)?.body).toMatch(/keeps running/)
    expect(describeNotification(ev({ type: 'completed' }), delivery)?.body).toMatch(/pull\/9/)
    expect(describeNotification(ev({ type: 'failed', message: 'tests red', failureCategory: 'Agent' }), delivery)).toMatchObject({ title: 'Failed: ABC-12', body: 'Agent failure. tests red' })
    expect(describeNotification(ev({ type: 'step_started', nodeId: 'n', blockName: 'x' }), delivery)).toBeNull()
  })
})
