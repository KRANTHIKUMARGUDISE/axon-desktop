import { redact } from '../log'
import { PLATFORM_RETRY_LIMIT } from '../../shared'

// Minimal Jira Cloud REST v3 client for the watcher: Basic auth (email + API token, the same as the onboarding
// identity check), injectable fetch/sleep for tests. Honours 429 + Retry-After, retries network/5xx errors twice
// with backoff (Platform failures, 15b), and never logs or returns the token.

export interface JiraClientDeps {
  site: string
  email: string
  token: string
  fetchImpl?: typeof fetch
  /** Injected in tests so backoff does not wait. */
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

export class JiraError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message)
    this.name = 'JiraError'
  }
}

export interface JiraIssue {
  key: string
  fields: {
    summary?: string
    labels?: string[]
    status?: { name?: string }
    assignee?: { emailAddress?: string; accountId?: string } | null
    reporter?: { emailAddress?: string; accountId?: string } | null
    description?: unknown
    updated?: string
    [custom: string]: unknown
  }
}

export interface JiraTransition { id: string; name: string; to?: { name?: string } }
export interface JiraComment { id?: string; author?: { displayName?: string }; created?: string; body?: unknown }

export type JiraPermissionName = 'BROWSE_PROJECTS' | 'EDIT_ISSUES' | 'ADD_COMMENTS' | 'TRANSITION_ISSUES' | 'ASSIGN_ISSUES'

/** S5b: extra permissions the pipeline's Jira Update actions need (checked at delivery start). */
export const ACTION_PERMISSIONS: Record<'TRANSITION_ISSUES' | 'ASSIGN_ISSUES', { key: JiraPermissionName; message: string }> = {
  TRANSITION_ISSUES: { key: 'TRANSITION_ISSUES', message: 'Cannot change the ticket status: you need the "Transition issues" permission on this project.' },
  ASSIGN_ISSUES: { key: 'ASSIGN_ISSUES', message: 'Cannot assign the ticket: you need the "Assign issues" permission on this project.' },
}
export const REQUIRED_PERMISSIONS: { key: JiraPermissionName; message: string }[] = [
  { key: 'BROWSE_PROJECTS', message: 'Cannot read this project: you need the "Browse projects" permission.' },
  { key: 'EDIT_ISSUES', message: 'Cannot edit labels: you need the "Edit issues" permission on this project.' },
  { key: 'ADD_COMMENTS', message: 'Cannot post comments: you need the "Add comments" permission on this project.' },
]

export interface PermissionReport {
  ok: boolean
  /** One clear message per missing permission. */
  missing: string[]
}

export type Adf = { type: string; version?: number; content?: unknown[]; [k: string]: unknown }

const MAX_429_RETRIES = 4
const MAX_WAIT_MS = 60_000

export class JiraClient {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly base: string
  private readonly auth: string

  constructor(private readonly deps: JiraClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.base = `https://${deps.site}`
    this.auth = `Basic ${Buffer.from(`${deps.email}:${deps.token}`).toString('base64')}`
  }

  private async request<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    let rateLimited = 0
    let transient = 0
    for (;;) {
      let res: Response
      try {
        res = await this.fetchImpl(`${this.base}${pathAndQuery}`, {
          method,
          headers: {
            Authorization: this.auth,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? 20_000),
        })
      } catch (err) {
        if (transient++ < PLATFORM_RETRY_LIMIT) {
          await this.sleep(1000 * 2 ** (transient - 1))
          continue
        }
        throw new JiraError(`Could not reach Jira: ${redact(err instanceof Error ? err.message : String(err))}`, null, true)
      }
      if (res.status === 429) {
        if (rateLimited++ >= MAX_429_RETRIES) throw new JiraError('Jira is rate limiting this account; try again later.', 429, true)
        const header = Number(res.headers.get('retry-after'))
        await this.sleep(Math.min(MAX_WAIT_MS, Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * 2 ** rateLimited))
        continue
      }
      if (res.status >= 500) {
        if (transient++ < PLATFORM_RETRY_LIMIT) {
          await this.sleep(1000 * 2 ** (transient - 1))
          continue
        }
        throw new JiraError(`Jira returned HTTP ${res.status}.`, res.status, true)
      }
      if (res.status === 401 || res.status === 403) {
        throw new JiraError(`Jira refused the request (HTTP ${res.status}): check the API token and the project permissions.`, res.status, false)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new JiraError(`Jira returned HTTP ${res.status}: ${redact(text).slice(0, 300)}`, res.status, false)
      }
      if (res.status === 204) return undefined as T
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    }
  }

  /** All matching issues, following `nextPageToken` (never more than `maxPages` pages per call). */
  async searchJql(jql: string, fields: string[], opts: { pageSize?: number; maxPages?: number } = {}): Promise<JiraIssue[]> {
    const out: JiraIssue[] = []
    let nextPageToken: string | undefined
    for (let page = 0; page < (opts.maxPages ?? 20); page++) {
      const res = await this.request<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>('POST', '/rest/api/3/search/jql', {
        jql, fields, maxResults: opts.pageSize ?? 50, ...(nextPageToken ? { nextPageToken } : {}),
      })
      out.push(...(res.issues ?? []))
      if (!res.nextPageToken || res.isLast) break
      nextPageToken = res.nextPageToken
    }
    return out
  }

  getIssue(key: string, fields = ['summary', 'labels', 'status', 'assignee', 'updated']): Promise<JiraIssue> {
    return this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`)
  }

  /** One PUT that removes and adds labels atomically (the claim). */
  async updateLabels(key: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const update = [...(change.remove ?? []).map((l) => ({ remove: l })), ...(change.add ?? []).map((l) => ({ add: l }))]
    if (!update.length) return
    await this.request<void>('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: update } })
  }

  /** True when a comment on the issue already carries `marker` (idempotent write-back). */
  async hasComment(key: string, marker: string): Promise<boolean> {
    let startAt = 0
    for (let page = 0; page < 20; page++) {
      const res = await this.request<{ comments?: { body?: unknown }[]; total?: number }>(
        'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100&orderBy=-created`,
      )
      const comments = res.comments ?? []
      if (comments.some((c) => adfContains(c.body, marker))) return true
      startAt += comments.length
      if (!comments.length || startAt >= (res.total ?? 0)) return false
    }
    return false
  }

  async addComment(key: string, body: Adf): Promise<void> {
    await this.request<void>('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body })
  }

  /** Post `body` unless a comment with `marker` already exists. Returns whether a comment was posted. */
  async addCommentOnce(key: string, marker: string, body: Adf): Promise<boolean> {
    if (await this.hasComment(key, marker)) return false
    await this.addComment(key, body)
    return true
  }

  // ---------------------------------------------------------------- S5b: issue properties, transitions, assignment

  /** Issue property value, or undefined when it does not exist (404). */
  async getProperty<T = unknown>(key: string, name: string): Promise<T | undefined> {
    try {
      const res = await this.request<{ value?: T }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(name)}`)
      return res?.value
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return undefined
      throw err
    }
  }

  async setProperty(key: string, name: string, value: unknown): Promise<void> {
    await this.request<void>('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(name)}`, value)
  }

  /** Read-modify-write (Jira has no compare-and-swap on properties; only the active machine writes these). */
  async updateProperty<T>(key: string, name: string, fn: (current: T | undefined) => T): Promise<T> {
    const next = fn(await this.getProperty<T>(key, name))
    await this.setProperty(key, name, next)
    return next
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions?: JiraTransition[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
    return res?.transitions ?? []
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.request<void>('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } })
  }

  async assign(key: string, accountId: string | null): Promise<void> {
    await this.request<void>('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId })
  }

  async myself(): Promise<{ accountId?: string; emailAddress?: string; displayName?: string }> {
    return this.request('GET', '/rest/api/3/myself')
  }

  /** The newest `limit` comments, oldest first. */
  async recentComments(key: string, limit = 20): Promise<JiraComment[]> {
    const res = await this.request<{ comments?: JiraComment[] }>(
      'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=0&maxResults=${limit}&orderBy=-created`,
    )
    return [...(res?.comments ?? [])].sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? ''))).slice(-limit)
  }

  /** When the issue last entered `status` (changelog), or undefined if it never changed into it. */
  async statusEnteredAt(key: string, status: string): Promise<string | undefined> {
    let latest: string | undefined
    let startAt = 0
    for (let page = 0; page < 20; page++) {
      const res = await this.request<{ values?: { created?: string; items?: { field?: string; toString?: string }[] }[]; total?: number; isLast?: boolean }>(
        'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`,
      )
      const values = res?.values ?? []
      for (const v of values) {
        if (v.created && v.items?.some((i) => i.field === 'status' && i.toString === status) && (!latest || v.created > latest)) latest = v.created
      }
      startAt += values.length
      if (!values.length || res?.isLast || startAt >= (res?.total ?? 0)) break
    }
    return latest
  }

  /** Attach a text file to the issue (long comment content). */
  async addAttachment(key: string, filename: string, content: string): Promise<void> {
    const form = new FormData()
    form.append('file', new Blob([content], { type: 'text/markdown' }), filename)
    const res = await this.fetchImpl(`${this.base}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'X-Atlassian-Token': 'no-check', Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(this.deps.timeoutMs ?? 20_000),
    })
    if (!res.ok) throw new JiraError(`Could not attach ${filename}: HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429)
  }

  /**
   * Post a comment unless `marker` is already recorded in the issue property axon.comments (S5 comments carried the marker as
   * text, so those are matched too). The marker is recorded after the post: a crash in between can duplicate one comment
   * but never loses it.
   */
  async postCommentOnce(key: string, marker: string, body: Adf): Promise<boolean> {
    const recorded = (await this.getProperty<string[]>(key, PROP_COMMENTS)) ?? []
    if (recorded.includes(marker)) return false
    if (/^axon:[^:]+:(completed|failed|cancelled)$/.test(marker) && (await this.hasComment(key, marker))) return false
    await this.addComment(key, body)
    await this.updateProperty<string[]>(key, PROP_COMMENTS, (cur) => [...new Set([...(cur ?? []), marker])].slice(-200))
    return true
  }

  async checkPermissions(projectKey: string, extra: ('TRANSITION_ISSUES' | 'ASSIGN_ISSUES')[] = []): Promise<PermissionReport> {
    const wanted = [...REQUIRED_PERMISSIONS, ...extra.map((k) => ACTION_PERMISSIONS[k])]
    const keys = wanted.map((p) => p.key).join(',')
    const res = await this.request<{ permissions?: Record<string, { havePermission?: boolean }> }>(
      'GET', `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=${keys}`,
    )
    const missing = wanted.filter((p) => res.permissions?.[p.key]?.havePermission !== true).map((p) => p.message)
    return { ok: missing.length === 0, missing }
  }
}

// ---------------------------------------------------------------- pure helpers (unit-tested)

const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`

/** The poll query. `sinceMinutes` is relative ("-Nm"), so the Jira user's time zone never matters. */
export const LABEL_RUNNING = 'axon-running'
/** Issue properties (S5b): per-rule run records and idempotency markers for AXON comments. */
export const PROP_RUNS = 'axon.runs'
export const PROP_COMMENTS = 'axon.comments'
export const LABEL_DONE = 'axon-done'
export const LABEL_FAILED = 'axon-failed'

/**
 * The poll query. `sinceMinutes` is relative ("-Nm"), so the Jira user's time zone never matters; omit it on the first
 * poll (a ready ticket is picked up whenever it was last updated). A status-based rule must skip tickets AXON already
 * labelled, otherwise a finished ticket still sitting in that status would run again every poll.
 */
export function buildReadyJql(rule: { jiraProjectKey: string; readyLabel: string; readyStatus?: string }, sinceMinutes?: number): string {
  const ready = rule.readyStatus
    ? `status = ${q(rule.readyStatus)} AND labels not in (${q(LABEL_RUNNING)})`
    : `labels = ${q(rule.readyLabel)}`
  const since = sinceMinutes === undefined ? '' : ` AND updated >= "-${Math.max(1, Math.ceil(sinceMinutes))}m"`
  return `project = ${q(rule.jiraProjectKey)} AND assignee = currentUser() AND ${ready}${since} ORDER BY updated ASC`
}

export const claimMarker = (deliveryId: string, event: string): string => `axon:${deliveryId}:${event}`

/** ADF comment: heading line, bullet lines. A legacy (S5) `marker` is still rendered as a grey footer; S5b passes none. */
export function adfComment(title: string, lines: { text: string; href?: string }[], marker?: string): Adf {
  const text = (t: string, href?: string) => ({ type: 'text', text: t, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) })
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: title, marks: [{ type: 'strong' }] }] },
      ...(lines.length
        ? [{
            type: 'bulletList',
            content: lines.map((l) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [text(l.text, l.href)] }] })),
          }]
        : []),
      ...(marker ? [{ type: 'paragraph', content: [{ type: 'text', text: marker, marks: [{ type: 'textColor', attrs: { color: '#97a0af' } }] }] }] : []),
    ],
  }
}

/** True when `marker` appears in any text node of an ADF document (or plain string body). */
export function adfContains(node: unknown, marker: string): boolean {
  if (typeof node === 'string') return node.includes(marker)
  if (!node || typeof node !== 'object') return false
  const n = node as { text?: unknown; content?: unknown[] }
  if (typeof n.text === 'string' && n.text.includes(marker)) return true
  return Array.isArray(n.content) && n.content.some((c) => adfContains(c, marker))
}
