import { z } from 'zod'
import type { AgentOutput } from '../../../shared'
import { validateWorkItemList } from '../../../shared'
import { createPullRequests, reposFromCwds } from '../../workspace/prCreator'
import { provisionWorkspace, findCatalogRepo } from '../../workspace/provisioner'
import type { NativeBlock, NativeContext, NativeServices } from './types'
import type { RunnerInput } from '../types'

// Native block registry (S4): artifactName -> { zod input, zod output, handler }.

const ProvisionedRepoSchema = z.object({
  name: z.string(), url: z.string(), branch: z.string(), baseBranch: z.string(), worktreePath: z.string(),
})

const humanGate: NativeBlock<Record<string, unknown>, Record<string, unknown>> = {
  name: 'human-gate',
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  // The pause itself is driven by the block's role (Control) in the engine.
  run: async () => ({ summary: 'Awaiting human review', result: {} }),
}

// D16: the provisioner works on the work-item list returned by the block right before it (injected by the engine).
// Each item names a catalog repo in `repo`; the same list comes back with `workspacePath` set to that repo's worktree.
const provisionerInput = z.object({ workItemList: z.unknown().optional() })
const provisionerOutput = z.object({
  workItems: z.object({ items: z.array(z.record(z.string(), z.unknown())), shared: z.unknown().optional() }),
  provisionedRepos: z.array(ProvisionedRepoSchema),
})

const workspaceProvisioner: NativeBlock<z.infer<typeof provisionerInput>, z.infer<typeof provisionerOutput>> = {
  name: 'workspace-provisioner',
  input: provisionerInput,
  output: provisionerOutput,
  async run(inp, { input, services }) {
    if (inp.workItemList === undefined) {
      throw new Error('Workspace Provisioner needs a work-item list from the block directly before it (items with a "repo" each)')
    }
    const list = validateWorkItemList(inp.workItemList)
    if (!list.ok) throw new Error(list.error)
    const catalog = await services.getCatalog()
    const repoOf = new Map<string, string>() // item key -> catalog repo name
    const repositories: { url: string }[] = []
    for (const e of list.entries) {
      const ref = e.item.repo
      if (typeof ref !== 'string' || !ref.trim()) throw new Error(`Work item "${e.key}" has no "repo" (the catalog repository it works in)`)
      const hit = findCatalogRepo(catalog, ref)
      if (!hit) {
        const synced = services.lastCatalogSyncAt?.()
        throw new Error(`Repository "${ref}" (work item "${e.key}") is not in the catalog: ${catalog.length} repos in catalog; last synced ${synced ? new Date(synced).toLocaleString() : 'never'}; Settings → Registry to check`)
      }
      repoOf.set(e.key, hit.name)
      if (!repositories.some((r) => r.url === hit.url)) repositories.push({ url: hit.url })
    }
    const res = await provisionWorkspace(
      { makeGit: services.makeGit, workspaceRoot: services.getWorkspaceRoot(), catalog, validateUrl: services.validateUrl },
      { deliveryId: input.deliveryId, ticketId: input.deliveryContext.ticketId, username: services.username(), repositories },
    )
    const raw = inp.workItemList as { items: Record<string, unknown>[]; shared?: unknown }
    const workItems = {
      ...raw,
      items: raw.items.map((it) => {
        const wt = res.provisionedRepos.find((r) => r.name === repoOf.get(it.key as string))
        return { ...it, workspacePath: wt?.worktreePath }
      }),
    }
    return {
      summary: `Provisioned ${res.provisionedRepos.length} repositor${res.provisionedRepos.length === 1 ? 'y' : 'ies'}: ${res.provisionedRepos.map((r) => r.name).join(', ')}`,
      result: { workItems, provisionedRepos: res.provisionedRepos },
    }
  },
}

const prInput = z.object({
  // Recorded working folders of this delivery's steps (added by the engine, never taken from agent output).
  stepCwds: z.array(z.string()).optional(),
  acceptanceCriteria: z.union([z.array(z.string()), z.string()]).optional(),
})
const prOutput = z.object({ prUrls: z.array(z.object({ repo: z.string(), url: z.string() })) })

const prCreator: NativeBlock<z.infer<typeof prInput>, z.infer<typeof prOutput>> = {
  name: 'pr-creator',
  input: prInput,
  output: prOutput,
  async run(inp, { input, services }) {
    const ac = typeof inp.acceptanceCriteria === 'string' ? inp.acceptanceCriteria.split('\n').filter(Boolean) : inp.acceptanceCriteria
    // One PR per distinct git repo behind this delivery's recorded step folders (D17); repos without changes are skipped.
    const repos = await reposFromCwds(services.makeGit, inp.stepCwds ?? [])
    if (!repos.length) throw new Error('No repository to create a PR from')
    const res = await createPullRequests(
      {
        makeGit: services.makeGit, getToken: services.getGitToken, fetchFn: services.fetchFn, validateUrl: services.validateUrl,
        pushUrl: services.pushUrl, committer: services.committer?.(), redact: services.redact,
      },
      {
        ticketId: input.deliveryContext.ticketId, title: input.deliveryContext.ticketTitle ?? '',
        pipelineName: input.pipelineName, acceptanceCriteria: ac, repos,
      },
    )
    const skipped = res.skipped.length ? ` (no changes in ${res.skipped.map((s) => s.repo).join(', ')})` : ''
    return {
      summary: res.prUrls.length ? `Opened ${res.prUrls.length} pull request(s)${skipped}` : `No changes to propose${skipped}`,
      result: { prUrls: res.prUrls },
    }
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NATIVE_BLOCKS: Record<string, NativeBlock<any, any>> = {
  'human-gate': humanGate,
  'workspace-provisioner': workspaceProvisioner,
  'pr-creator': prCreator,
}

export async function runNativeBlock(input: RunnerInput, services: NativeServices | undefined): Promise<AgentOutput> {
  const def = NATIVE_BLOCKS[input.block.artifactName ?? '']
  if (!def) throw new Error(`No native handler for Axon block artifactName "${input.block.artifactName}"`)
  const pool = { ...input.deliveryContext.previousStepsResults, ...input.deliveryContext.currentInputs }
  const parsed = def.input.safeParse(pool)
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    const message = `${def.name} input is invalid — ${why}`
    return { status: 'failed', summary: message, errorMessage: message, result: {} }
  }
  if (!services && def.name !== 'human-gate') throw new Error(`${def.name} is unavailable (no native services)`)
  const ctx: NativeContext = { input, services: services as NativeServices }
  const out = await def.run(parsed.data, ctx)
  const checked = def.output.safeParse(out.result)
  if (!checked.success) throw new Error(`${def.name} produced an invalid result: ${checked.error.issues.map((i) => i.message).join('; ')}`)
  return { status: 'success', summary: out.summary, result: checked.data as Record<string, unknown> }
}
