import type { Block, Delivery, OnFailureAction, PipelineNode } from '../../shared'
import {
  JIRA_UPDATE_ARTIFACT, PR_UPDATE_ARTIFACT, FIND_PRS_ARTIFACT, TICKET_FETCHER_ARTIFACT,
  readJiraUpdateConfig, readOnFailure,
} from '../../shared'
import type { Store } from '../store/types'
import type { JiraClient } from '../jira/client'
import { JiraError } from '../jira/client'
import { redact } from '../log'
import { ghApi } from './github'
import type { GitHubDeps } from './github'
import { resolveTransition, runJiraUpdate } from './jiraUpdate'
import { runPrUpdate } from './prUpdate'

// The pieces of the action blocks that run outside a pipeline node: the pre-flight at delivery start and the pipeline's
// "On failure" actions. Both reuse the same executors as the nodes (jira-update / pr-update).

export interface ActionRuntimeDeps {
  store: Pick<Store, 'getDelivery'>
  makeJiraClient: () => Promise<JiraClient | null>
  gh: GitHubDeps
  deliveryLink?: (deliveryId: string) => string
}

interface Needs {
  jira: boolean
  github: boolean
  transition: boolean
  assign: boolean
  firstTransition?: string
}

/** Which outside systems a delivery's actions (nodes in pipeline order + on-failure) will touch. */
export function actionNeeds(nodes: PipelineNode[], blocks: Map<string, Block>, onFailure: OnFailureAction[]): Needs {
  const needs: Needs = { jira: false, github: false, transition: false, assign: false }
  for (const n of nodes) {
    if (n.type === 'forEach') continue
    const art = blocks.get(n.blockId)?.artifactName
    if (art === TICKET_FETCHER_ARTIFACT) needs.jira = true
    if (art === PR_UPDATE_ARTIFACT || art === FIND_PRS_ARTIFACT) needs.github = true
    if (art === JIRA_UPDATE_ARTIFACT) {
      needs.jira = true
      const c = readJiraUpdateConfig(n.config)
      if (c.transition) { needs.transition = true; needs.firstTransition ??= c.transition }
      if (c.assign) needs.assign = true
    }
  }
  for (const a of onFailure) {
    if (a.kind === 'pr-update') needs.github = true
    else {
      needs.jira = true
      if (a.transition) needs.transition = true
      if (a.assign) needs.assign = true
    }
  }
  return needs
}

export function createActionRuntime(deps: ActionRuntimeDeps) {
  const linkOf = (id: string) => deps.deliveryLink?.(id) ?? `axon://delivery/${id}`

  async function rootOf(d: Delivery): Promise<string> {
    let cur = d
    for (let i = 0; i < 25 && cur.retriedFromDeliveryId; i++) {
      const prev = await deps.store.getDelivery(cur.retriedFromDeliveryId)
      if (!prev) break
      cur = prev
    }
    return cur.id
  }

  /** Returns the problem to show (nothing has run yet), or null when every configured action can work. */
  async function preflight(d: Delivery, blocks: Map<string, Block>): Promise<string | null> {
    const onFailure = readOnFailure(d.pipelineSnapshot.onFailure)
    const needs = actionNeeds(d.pipelineSnapshot.nodes, blocks, onFailure)
    const problems: string[] = []

    if (needs.jira) {
      const jira = await deps.makeJiraClient()
      if (!jira) problems.push('Jira is not connected: add your Jira API token in Settings → Accounts → Jira.')
      else {
        try {
          const project = d.ticketId.split('-')[0]
          const extra = [...(needs.transition ? (['TRANSITION_ISSUES'] as const) : []), ...(needs.assign ? (['ASSIGN_ISSUES'] as const) : [])]
          const report = await jira.checkPermissions(project, [...extra])
          problems.push(...report.missing)
          // Reachability can only be known for the first status change (later ones depend on where the ticket will be then).
          if (needs.firstTransition && !report.missing.length) {
            const t = await resolveTransition(jira, d.ticketId, needs.firstTransition)
            if (t.error) problems.push(t.error)
          }
        } catch (err) {
          problems.push(err instanceof JiraError && err.status === 404 ? `Ticket ${d.ticketId} was not found in Jira (or you cannot see it).` : `Could not check Jira: ${redact(err instanceof Error ? err.message : String(err))}`)
        }
      }
    }
    if (needs.github) {
      try {
        await ghApi(deps.gh, 'GET', 'https://api.github.com/user')
      } catch (err) {
        problems.push(`GitHub: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return problems.length ? `Pre-flight check failed, nothing was started: ${problems.join(' ')}` : null
  }

  /** The pipeline's "On failure" actions, in order. Throws (after trying every action) when any of them failed. */
  async function onTerminal(d: Delivery, event: 'failed' | 'cancelled', failureReason: string): Promise<string> {
    const actions = readOnFailure(d.pipelineSnapshot.onFailure)
    const root = await rootOf(d)
    const prs = (d.prUrls?.length ? d.prUrls : d.prUrl ? [{ repo: '', url: d.prUrl }] : [])
    const data = {
      output: {} as Record<string, unknown>, prUrls: prs.map((p) => p.url), deliveryLink: linkOf(d.id),
      failureReason: redact(failureReason).slice(0, 1000), ticketKey: d.ticketId,
    }
    const done: string[] = []
    const failed: string[] = []
    for (const [i, a] of actions.entries()) {
      const markerBase = `axon:${d.ticketId}:${root}:onfailure:${i}:${event}`
      try {
        if (a.kind === 'jira-update') {
          const jira = await deps.makeJiraClient()
          if (!jira) throw new Error('Jira is not connected')
          const r = await runJiraUpdate(a, { jira, ticketKey: d.ticketId, data, markerBase, attachmentName: `axon-${d.ticketId}-failure.md` })
          done.push(r.summary)
        } else {
          const r = await runPrUpdate(a, { gh: deps.gh, prs, data, markerBase })
          done.push(r.summary)
        }
      } catch (err) {
        failed.push(`${a.kind === 'jira-update' ? 'Jira Update' : 'PR Update'} #${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const message = [...done, ...failed].join('; ') || 'No on-failure actions ran'
    if (failed.length) throw new Error(message)
    return message
  }

  return { preflight, onTerminal }
}
