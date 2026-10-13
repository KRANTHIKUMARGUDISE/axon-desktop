import { z } from 'zod'
import type { AgentOutput } from '../../../shared'
import { validateWorkItemList, readJiraUpdateConfig, readPrUpdateConfig } from '../../../shared'
import type { TemplateData } from '../../../shared'
import { runJiraUpdate } from '../../actions/jiraUpdate'
import { runPrUpdate } from '../../actions/prUpdate'
import { findPrs } from '../../actions/findPrs'
import { fetchTicket } from '../../actions/ticketFetcher'
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
    const repositories: { url: string; checkout?: string }[] = []
    for (const e of list.entries) {
      const ref = e.item.repo
      if (typeof ref !== 'string' || !ref.trim()) throw new Error(`Work item "${e.key}" has no "repo" (the catalog repository it works in)`)
      const hit = findCatalogRepo(catalog, ref)
      if (!hit) {
        const synced = services.lastCatalogSyncAt?.()
        throw new Error(`Repository "${ref}" (work item "${e.key}") is not in the catalog: ${catalog.length} repos in catalog; last synced ${synced ? new Date(synced).toLocaleString() : 'never'}; Settings → Registry to check`)
      }
      repoOf.set(e.key, hit.name)
      // S5b: an item that names a `branch` (Find PRs) works on that existing branch instead of a new delivery branch.
      const checkout = typeof e.item.branch === 'string' && e.item.branch.trim() ? e.item.branch.trim() : undefined
      if (!repositories.some((r) => r.url === hit.url)) repositories.push({ url: hit.url, ...(checkout ? { checkout } : {}) })
      else if (checkout) {
        const existing = repositories.find((r) => r.url === hit.url)!
        if (existing.checkout && existing.checkout !== checkout) throw new Error(`Work items "${e.key}" and another item ask for different branches of ${hit.name}`)
        existing.checkout = checkout
      }
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

// ---------------------------------------------------------------- S5b action blocks (no AI; the engineer's own credentials)

const pool = z.record(z.string(), z.unknown())
type Pool = z.infer<typeof pool>

export function prUrlsOf(p: Pool): { repo: string; url: string }[] {
  const raw = p.prUrls
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    if (typeof x === 'string') return [{ repo: '', url: x }]
    const o = x as { repo?: unknown; url?: unknown }
    return typeof o?.url === 'string' ? [{ repo: typeof o.repo === 'string' ? o.repo : '', url: o.url }] : []
  })
}

/** The values a comment template can use. `output` is exactly what this block was allowed to see. */
export function templateDataFor(input: RunnerInput, p: Pool, services: NativeServices, failureReason = ''): TemplateData {
  return {
    output: p,
    prUrls: prUrlsOf(p).map((x) => x.url),
    deliveryLink: services.deliveryLink?.(input.deliveryId) ?? `axon://delivery/${input.deliveryId}`,
    failureReason,
    ticketKey: input.deliveryContext.ticketId,
  }
}

/** Stable across Resume and Rerun (root = the first attempt), so an action is never applied twice for one story. */
export function markerBaseFor(input: RunnerInput): string {
  return `axon:${input.deliveryContext.ticketId}:${input.rootDeliveryId ?? input.deliveryId}:${input.nodeId ?? 'node'}${input.itemKey ? `:${input.itemKey}` : ''}`
}

const NOT_CONNECTED_JIRA = 'Jira is not connected: add your Jira API token in Settings → Accounts → Jira.'

const jiraUpdateOutput = z.object({ jiraUpdate: z.object({ ticket: z.string(), changes: z.array(z.string()) }) })
const jiraUpdate: NativeBlock<Pool, z.infer<typeof jiraUpdateOutput>> = {
  name: 'jira-update',
  input: pool,
  output: jiraUpdateOutput,
  async run(p, { input, services }) {
    const jira = await services.jira?.()
    if (!jira) throw new Error(NOT_CONNECTED_JIRA)
    const ticket = input.deliveryContext.ticketId
    const r = await runJiraUpdate(readJiraUpdateConfig(input.nodeConfig), {
      jira, ticketKey: ticket, data: templateDataFor(input, p, services), markerBase: markerBaseFor(input),
      attachmentName: `axon-${ticket}-${input.nodeId ?? 'update'}.md`,
    })
    return { summary: r.summary, result: { jiraUpdate: { ticket, changes: r.changes } } }
  },
}

const prUpdateOutput = z.object({ prUpdate: z.object({ prs: z.array(z.string()), changes: z.array(z.string()) }) })
const prUpdate: NativeBlock<Pool, z.infer<typeof prUpdateOutput>> = {
  name: 'pr-update',
  input: pool,
  output: prUpdateOutput,
  async run(p, { input, services }) {
    const prs = prUrlsOf(p)
    const r = await runPrUpdate(readPrUpdateConfig(input.nodeConfig), {
      gh: { getToken: services.getGitToken, fetchFn: services.fetchFn, redact: services.redact },
      prs, data: templateDataFor(input, p, services), markerBase: markerBaseFor(input),
    })
    return { summary: r.summary, result: { prUpdate: { prs: prs.map((x) => x.url), changes: r.changes } } }
  },
}

const findPrsOutput = z.object({
  workItems: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
  prUrls: z.array(z.object({ repo: z.string(), url: z.string() })),
})
const findPrsBlock: NativeBlock<Pool, z.infer<typeof findPrsOutput>> = {
  name: 'find-prs',
  input: pool,
  output: findPrsOutput,
  async run(_p, { input, services }) {
    const ticket = input.deliveryContext.ticketId
    const found = await findPrs(
      { getToken: services.getGitToken, fetchFn: services.fetchFn, redact: services.redact }, await services.getCatalog(), ticket,
    )
    const items = found.map((f) => ({ key: `${f.repo}`, task: `Work on pull request #${f.number} "${f.title}" (branch ${f.branch}) for ${ticket}`, repo: f.repo, branch: f.branch, prUrl: f.url }))
    return {
      summary: found.length ? `Found ${found.length} open pull request(s) for ${ticket}: ${found.map((f) => f.url).join(', ')}` : `No open pull request mentions ${ticket}`,
      result: { workItems: { items }, prUrls: found.map((f) => ({ repo: f.repo, url: f.url })) },
    }
  },
}

const ticketFetcherOutput = z.object({
  ticket: z.object({
    key: z.string(), summary: z.string(), description: z.string(), labels: z.array(z.string()), status: z.string(),
    comments: z.array(z.object({ author: z.string(), date: z.string(), text: z.string() })),
  }),
  acceptanceCriteria: z.array(z.string()).optional(),
})
const ticketFetcher: NativeBlock<Pool, z.infer<typeof ticketFetcherOutput>> = {
  name: 'ticket-fetcher',
  input: pool,
  output: ticketFetcherOutput,
  async run(_p, { input, services }) {
    const jira = await services.jira?.()
    if (!jira) throw new Error(NOT_CONNECTED_JIRA)
    const { ticket, acceptanceCriteria } = await fetchTicket(jira, input.deliveryContext.ticketId)
    return {
      summary: `Fetched ${ticket.key}: ${ticket.comments.length} comment(s)${acceptanceCriteria.length ? `, ${acceptanceCriteria.length} acceptance criteria` : ''}`,
      result: { ticket, ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}) },
    }
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NATIVE_BLOCKS: Record<string, NativeBlock<any, any>> = {
  'human-gate': humanGate,
  'workspace-provisioner': workspaceProvisioner,
  'pr-creator': prCreator,
  'jira-update': jiraUpdate,
  'pr-update': prUpdate,
  'find-prs': findPrsBlock,
  'ticket-fetcher': ticketFetcher,
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
