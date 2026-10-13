import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { vi } from 'vitest'
import { FileStore } from '../../store/fileStore'
import { seedBuiltIns, HUMAN_GATE_BLOCK_ID } from '../../store/seed'
import { createEngine } from '../engine'
import type { Engine, WorkspacePort, EngineDeps } from '../engine'
import { createBus } from '../bus'
import type { AgentOutput, Block, BlockInput, DeliveryEvent, Delivery } from '../../../shared'
import type { Runner, RunnerInput } from '../../runners/types'

export type Script = Record<string, (input: RunnerInput) => AgentOutput | Promise<AgentOutput>>

export interface HarnessOptions {
  script?: Script
  ds1ThresholdBytes?: number
  workspace?: Partial<WorkspacePort>
  snapshots?: EngineDeps['snapshots']
  getRepoCatalog?: EngineDeps['getRepoCatalog']
}

export function ok(label: string, result: Record<string, unknown> = {}): AgentOutput {
  return { status: 'success', summary: `${label} done`, result: { [`${label}Out`]: true, ...result } }
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export async function createHarness(opts: HarnessOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-test-'))
  const workspaceDir = path.join(dir, 'ws')
  await fs.mkdir(workspaceDir, { recursive: true })
  const runsDir = path.join(dir, 'runs')
  const store = new FileStore({ dir: path.join(dir, 'store') })
  await seedBuiltIns(store)

  const events: DeliveryEvent[] = []
  const bus = createBus()
  bus.subscribe((e) => events.push(e))

  const script: Script = { ...(opts.script ?? {}) }
  const runner = vi.fn<Runner>(async (input) => {
    const fn = script[input.nodeLabel]
    return fn ? fn(input) : ok(input.nodeLabel)
  })

  const workspace: WorkspacePort = {
    prepare: vi.fn(async () => ({ deliveryFolder: workspaceDir })),
    resolveCwd: vi.fn(async (d, item) => item ?? d.workspacePath ?? d.deliveryFolder ?? workspaceDir),
    release: vi.fn(async () => {}),
    reacquire: vi.fn(async () => {}),
    ...(opts.workspace as object),
  }

  const build = (): Engine =>
    createEngine({
      store, runner, workspace, bus, runsDir,
      ds1ThresholdBytes: () => opts.ds1ThresholdBytes ?? 50_000,
      identity: () => 'dev@example.com',
      snapshots: opts.snapshots,
      getRepoCatalog: opts.getRepoCatalog,
    })
  const engine = build()

  async function mkBlock(over: Partial<BlockInput> = {}): Promise<Block> {
    return store.createBlock({
      name: 'Block', role: 'Execution', description: '', tags: [], sourceType: 'Local',
      agentRuntime: 'Claude', artifactFormat: 'Skill', executionType: 'Prompt', contextMode: 'Full',
      cachedFiles: [{ relativePath: 'SKILL.md', content: 'do the thing' }], entryPointPath: 'SKILL.md',
      ...over,
    })
  }

  // labels: node labels in order; a label starting with "gate" becomes a human-gate node.
  async function mkPipeline(labels: string[], blockOver: Partial<BlockInput> = {}) {
    const generic = await mkBlock(blockOver)
    const nodes = labels.map((label, i) => ({
      id: `n${i + 1}`,
      label,
      blockId: label.startsWith('gate') ? HUMAN_GATE_BLOCK_ID : generic.id,
      position: { x: i * 100, y: 0 },
    }))
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i + 1}`, sourceNodeId: nodes[i].id, targetNodeId: n.id }))
    const pipeline = await store.createPipeline({ name: 'P', description: '', nodes, edges })
    return { pipeline, nodes, block: generic }
  }

  async function mkDelivery(labels: string[], over: { storeFullContext?: boolean; inputs?: Record<string, unknown>; blockOver?: Partial<BlockInput> } = {}) {
    const { pipeline, nodes } = await mkPipeline(labels, over.blockOver)
    const delivery = await store.createDelivery({
      ticketId: 'T-1', title: 'Test', pipelineId: pipeline.id, repoUrl: 'https://example.test/r.git',
      workspaceType: 'Default', storeFullContext: over.storeFullContext, inputs: over.inputs,
    })
    return { delivery, pipeline, nodes }
  }

  async function run(labels: string[], over: Parameters<typeof mkDelivery>[1] = {}) {
    const made = await mkDelivery(labels, over)
    const res = await engine.start(made.delivery.id)
    await engine.whenIdle(made.delivery.id)
    return { ...made, res, get: () => store.getDelivery(made.delivery.id) as Promise<Delivery> }
  }

  const eventTypes = (id?: string) => events.filter((e) => !id || e.deliveryId === id).map((e) => e.type)

  return {
    dir, workspaceDir, runsDir, store, engine, build, events, eventTypes, runner, script, workspace, bus,
    mkBlock, mkPipeline, mkDelivery, run,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>
