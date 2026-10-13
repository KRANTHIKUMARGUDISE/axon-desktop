import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHarness } from './harness'
import type { Harness } from './harness'
import { createSnapshotService } from '../../workspace/snapshots'
import { describeResume } from '../../../shared'
import type { BlockInput, PipelineNode, PipelineEdge } from '../../../shared'

let h: Harness
let tmp: string[] = []
afterEach(async () => {
  await h?.cleanup()
  for (const t of tmp) await fs.rm(t, { recursive: true, force: true }).catch(() => {})
  tmp = []
})

const pos = { x: 0, y: 0 }
const git = (cwd: string, ...args: string[]) =>
  new Promise<string>((res, rej) =>
    execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }, (err, out, se) => (err ? rej(new Error(se)) : res(out))))
async function mkRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-resume-'))
  tmp.push(dir)
  await git(dir, 'init', '-q')
  await fs.writeFile(path.join(dir, 'base.txt'), 'base\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// ok -> step (fails with "boom"), then returns the Resume preview
async function failedPreview(stepBlock: Partial<BlockInput>, cwd?: string) {
  h = await createHarness({ snapshots: createSnapshotService(), ...(cwd ? { workspace: { resolveCwd: async () => cwd } } : {}) })
  const first = await h.mkBlock({ name: 'first' })
  const step = await h.mkBlock({ name: 'step', ...stepBlock })
  const nodes: PipelineNode[] = [
    { id: 'first', label: 'first', blockId: first.id, position: pos },
    { id: 'step', label: 'Coder', blockId: step.id, position: pos },
  ]
  const edges: PipelineEdge[] = [{ id: 'e', sourceNodeId: 'first', targetNodeId: 'step' }]
  const p = await h.store.createPipeline({ name: 'P', description: '', nodes, edges })
  const d = await h.store.createDelivery({ ticketId: 'T-1', title: 't', pipelineId: p.id, repoUrl: '', workspaceType: 'Default' })
  h.script.Coder = () => ({ status: 'failed', summary: 'boom', errorMessage: 'boom: the build broke', result: {} })
  await h.engine.start(d.id)
  await h.engine.whenIdle(d.id)
  const res = await h.engine.previewResume(d.id)
  expect(res.success).toBe(true)
  return res.preview!
}

const AGENTIC = { executionType: 'Agentic' as const, contextRequirements: ['ticket'], allowedTools: ['Read', 'Edit'] }

describe('Resume confirmation message (three cases)', () => {
  it('1. git repo with a snapshot: says AXON restores the folder first, no warning, shows why it stopped', async () => {
    const repo = await mkRepo()
    const preview = await failedPreview(AGENTIC, repo)
    expect(preview.resumeMode).toBe('restore')
    expect(preview.folder).toBe(repo)
    expect(preview.failureReason).toBe('boom: the build broke')
    const text = describeResume(preview)
    expect(text.title).toBe('Resume delivery')
    expect(text.lines[0]).toBe(`AXON will restore ${repo} to its state before Coder, then run it again.`)
    expect(text.warning).toBeUndefined()
  })

  it('2. a block that cannot write files (Prompt, or Agentic with only Read): plain message, no warning', async () => {
    for (const block of [{}, { ...AGENTIC, allowedTools: ['Read', 'Grep'] }] as Partial<BlockInput>[]) {
      const preview = await failedPreview(block)
      expect(preview.resumeMode).toBe('plain')
      expect(preview.failureReason).toBe('boom: the build broke')
      const text = describeResume(preview)
      expect(text.lines).toEqual(['Resume from Coder?'])
      expect(text.warning).toBeUndefined()
      await h.cleanup()
    }
  })

  it('3. non-git folder and a block that can write: keeps the warning', async () => {
    const preview = await failedPreview(AGENTIC)
    expect(preview.resumeMode).toBe('warn')
    const text = describeResume(preview)
    expect(text.lines[0]).toBe('Resume from Coder?')
    expect(text.warning).toMatch(/"Coder" was already attempted once and didn't finish cleanly/)
    expect(text.warning).toMatch(/cannot roll those back/)
  })

  it('nothing left to run: says so', () => {
    const text = describeResume({ resumeNodeId: '', resumeNodeLabel: '', hasPriorAttempt: false, reconstructedContextKeys: [], allNodesCompleted: true })
    expect(text.lines[0]).toMatch(/nothing will run/)
  })
})
