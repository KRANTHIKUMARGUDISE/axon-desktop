import crypto from 'crypto'
import type { JiraUpdateConfig, TemplateData } from '../../shared'
import { renderTemplate, COMMENT_ATTACH_THRESHOLD } from '../../shared'
import type { JiraClient } from '../jira/client'
import { textToAdf } from '../jira/adf'

// The Jira Update action (native, no AI, the engineer's own Jira credentials). Every part is idempotent so a Resume,
// a Rerun or a retried step never double-applies it: labels and transitions check the current state first, and the
// comment carries a marker (kept in the issue property axon.comments, never as text in the comment).

export interface JiraActionEnv {
  jira: JiraClient
  ticketKey: string
  data: TemplateData
  /** Stable across Resume and Rerun, e.g. `axon:KEY:<rootDeliveryId>:<nodeId>`. */
  markerBase: string
  /** File name for an attachment when the comment is too long. */
  attachmentName?: string
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10)
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The transition to take for `target`, or the error text explaining why the ticket cannot get there from its current status. */
export async function resolveTransition(jira: JiraClient, key: string, target: string): Promise<{ id?: string; current: string; error?: string }> {
  const issue = await jira.getIssue(key, ['status'])
  const current = issue.fields.status?.name ?? ''
  if (sameName(current, target)) return { current }
  const transitions = await jira.getTransitions(key)
  const hit = transitions.find((t) => sameName(t.to?.name ?? '', target)) ?? transitions.find((t) => sameName(t.name, target))
  if (hit) return { id: hit.id, current }
  const reachable = transitions.map((t) => t.to?.name ?? t.name)
  return { current, error: `${key} cannot move to "${target}" from "${current}"${reachable.length ? ` (reachable: ${reachable.join(', ')})` : ''}` }
}

export async function runJiraUpdate(cfg: JiraUpdateConfig, env: JiraActionEnv): Promise<{ summary: string; changes: string[] }> {
  const { jira, ticketKey: key } = env
  const changes: string[] = []
  const issue = await jira.getIssue(key, ['status', 'labels', 'assignee', 'reporter'])

  if (cfg.transition) {
    const t = await resolveTransition(jira, key, cfg.transition)
    if (t.error) throw new Error(t.error)
    if (t.id) {
      await jira.transition(key, t.id)
      changes.push(`moved ${key} to ${cfg.transition}`)
    }
  }

  const have = new Set(issue.fields.labels ?? [])
  const add = cfg.addLabels.filter((l) => !have.has(l))
  const remove = cfg.removeLabels.filter((l) => have.has(l))
  if (add.length || remove.length) {
    await jira.updateLabels(key, { add, remove })
    if (add.length) changes.push(`added ${add.join(', ')}`)
    if (remove.length) changes.push(`removed ${remove.join(', ')}`)
  }

  if (cfg.assign) {
    let accountId: string | undefined
    let who: string = cfg.assign
    if (cfg.assign === 'user') {
      accountId = (await jira.myself()).accountId
      who = 'you'
    } else if (cfg.assign === 'reporter') {
      accountId = issue.fields.reporter?.accountId
      who = 'the reporter'
    } else {
      const field = cfg.assign.slice('field:'.length)
      const v = (await jira.getIssue(key, [field])).fields[field] as { accountId?: string } | null | undefined
      accountId = v?.accountId
      who = field
    }
    if (!accountId) throw new Error(`Cannot assign ${key}: no user found for "${cfg.assign}"`)
    if (issue.fields.assignee?.accountId !== accountId) {
      await jira.assign(key, accountId)
      changes.push(`assigned to ${who}`)
    }
  }

  if (cfg.comment) {
    const text = renderTemplate(cfg.comment, env.data).trim()
    if (text) {
      const marker = `${env.markerBase}:${hash(text)}`
      const long = text.length > COMMENT_ATTACH_THRESHOLD
      let body = text
      if (long) {
        const name = env.attachmentName ?? `axon-${key}.md`
        // Attach first: a retry after a crash re-attaches (harmless) rather than posting a comment that points at nothing.
        await jira.addAttachment(key, name, text)
        body = `${text.slice(0, 2000)}\n\n… (full text attached as ${name})`
      }
      if (await jira.postCommentOnce(key, marker, textToAdf(body))) changes.push(long ? 'commented (full text attached)' : 'commented')
    }
  }

  return { summary: changes.length ? capital(changes.join('; ')) : `No change needed on ${key}`, changes }
}
