// An in-memory Jira Cloud stand-in for the watcher tests: just the endpoints the client calls, driven through an
// injectable fetch. Failure injection lets tests exercise 429/5xx/network retries and idempotent write-back.

export interface MockIssue {
  key: string
  summary: string
  labels: string[]
  status: string
  /** Who the ticket is assigned to; the mock "current user" is `me`. */
  assignee: string
  updated: string
  comments: { body: unknown; author?: string; created?: string }[]
  /** S5b: issue properties (axon.runs, axon.comments), status history, attachments, reporter/description. */
  properties?: Record<string, unknown>
  statusHistory?: { status: string; at: string }[]
  attachments?: { filename: string; content: string }[]
  reporter?: string
  description?: unknown
}

export interface MockOptions {
  me?: string
  permissions?: Record<string, boolean>
  /** Allowed transitions: from status -> reachable statuses (default: any status is reachable). */
  workflow?: Record<string, string[]>
}

export function createMockJira(opts: MockOptions = {}) {
  const me = opts.me ?? 'me@example.com'
  const issues = new Map<string, MockIssue>()
  const calls: { method: string; path: string; body?: unknown }[] = []
  const failures: { match: RegExp; status: number | 'network'; headers?: Record<string, string>; times: number }[] = []
  let clock = Date.now() // follows the real clock: the watcher compares these timestamps with its own now()

  const add = (i: Partial<MockIssue> & { key: string }): MockIssue => {
    const issue: MockIssue = { summary: `Summary of ${i.key}`, labels: [], status: 'To Do', assignee: me, updated: new Date(clock).toISOString(), comments: [], properties: {}, statusHistory: [], attachments: [], reporter: 'reporter@example.com', ...i }
    issues.set(issue.key, issue)
    return issue
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

  const matches = (jql: string, i: MockIssue): boolean => {
    const project = /project = "([^"]+)"/.exec(jql)?.[1]
    if (project && !i.key.startsWith(`${project}-`)) return false
    if (/assignee = currentUser\(\)/.test(jql) && i.assignee !== me) return false
    const label = /labels = "([^"]+)"/.exec(jql)?.[1]
    if (label && !i.labels.includes(label)) return false
    const status = /status = "([^"]+)"/.exec(jql)?.[1]
    if (status && i.status !== status) return false
    const notIn = /labels not in \(([^)]*)\)/.exec(jql)?.[1]
    if (notIn && notIn.split(',').map((s) => s.trim().replace(/"/g, '')).some((l) => i.labels.includes(l))) return false
    return true
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const p = `${url.pathname}${url.search}`
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: p, body })
    const fail = failures.find((f) => f.match.test(`${method} ${p}`) && f.times > 0)
    if (fail) {
      fail.times--
      if (fail.status === 'network') throw new TypeError('fetch failed')
      return json(fail.status, { errorMessages: ['injected'] }, fail.headers)
    }
    if (method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
      const found = [...issues.values()].filter((i) => matches(String(body.jql), i))
      return json(200, { issues: found.map((i) => ({ key: i.key, fields: { summary: i.summary, labels: i.labels, status: { name: i.status }, updated: i.updated } })), isLast: true })
    }
    const sub = /^\/rest\/api\/3\/issue\/([^/]+)\/(properties\/([^/]+)|transitions|assignee|changelog|attachments)$/.exec(url.pathname)
    if (sub) {
      const issue = issues.get(decodeURIComponent(sub[1]))
      if (!issue) return json(404, {})
      const props = (issue.properties ??= {})
      if (sub[3]) {
        const name = decodeURIComponent(sub[3])
        if (method === 'GET') return name in props ? json(200, { key: name, value: props[name] }) : json(404, { errorMessages: ['no such property'] })
        if (method === 'PUT') { props[name] = body; return json(200, {}) }
      }
      if (sub[2] === 'transitions') {
        const reachable = (opts.workflow ? opts.workflow[issue.status] : undefined) ?? ['To Do', 'In Progress', 'In Review', 'Done'].filter((s) => s !== issue.status)
        if (method === 'GET') return json(200, { transitions: reachable.map((s) => ({ id: `t-${s}`, name: s, to: { name: s } })) })
        if (method === 'POST') {
          const to = String(body.transition.id).replace(/^t-/, '')
          if (!reachable.includes(to)) return json(400, { errorMessages: ['transition not allowed'] })
          issue.status = to
          ;(issue.statusHistory ??= []).push({ status: to, at: new Date((clock += 60_000)).toISOString() })
          issue.updated = new Date(clock).toISOString()
          return json(204, null)
        }
      }
      if (sub[2] === 'assignee' && method === 'PUT') { issue.assignee = body.accountId ?? ''; return json(204, null) }
      if (sub[2] === 'changelog' && method === 'GET') {
        const values = (issue.statusHistory ?? []).map((h) => ({ created: h.at, items: [{ field: 'status', toString: h.status }] }))
        return json(200, { values, total: values.length, isLast: true })
      }
      if (sub[2] === 'attachments' && method === 'POST') {
        const file = (init?.body as FormData).get('file') as File
        ;(issue.attachments ??= []).push({ filename: file.name, content: await file.text() })
        return json(200, [{ filename: file.name }])
      }
    }
    if (method === 'GET' && url.pathname === '/rest/api/3/myself') return json(200, { accountId: 'me-account', emailAddress: me, displayName: 'Me' })
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)(\/comment)?$/.exec(url.pathname)
    if (issueMatch) {
      const issue = issues.get(decodeURIComponent(issueMatch[1]))
      if (!issue) return json(404, {})
      if (!issueMatch[2] && method === 'PUT') {
        for (const op of body.update.labels as { add?: string; remove?: string }[]) {
          if (op.remove) issue.labels = issue.labels.filter((l) => l !== op.remove)
          if (op.add && !issue.labels.includes(op.add)) issue.labels.push(op.add)
        }
        issue.updated = new Date((clock += 60_000)).toISOString()
        return json(204, null)
      }
      if (!issueMatch[2] && method === 'GET') {
        return json(200, {
          key: issue.key,
          fields: {
            summary: issue.summary, labels: issue.labels, status: { name: issue.status }, description: issue.description ?? null,
            assignee: { emailAddress: issue.assignee, accountId: issue.assignee }, reporter: { emailAddress: issue.reporter, accountId: issue.reporter },
          },
        })
      }
      if (issueMatch[2] && method === 'GET') return json(200, { comments: issue.comments, total: issue.comments.length })
      if (issueMatch[2] && method === 'POST') {
        issue.comments.push({ body: body.body, author: 'Me', created: new Date((clock += 1000)).toISOString() })
        return json(201, { id: String(issue.comments.length) })
      }
    }
    if (method === 'GET' && url.pathname === '/rest/api/3/mypermissions') {
      const granted = opts.permissions ?? {}
      const out: Record<string, { havePermission: boolean }> = {}
      for (const k of (url.searchParams.get('permissions') ?? '').split(',')) out[k] = { havePermission: granted[k] !== false }
      return json(200, { permissions: out })
    }
    return json(404, { errorMessages: [`mock has no route for ${method} ${p}`] })
  }) as typeof fetch

  return {
    me, issues, calls, add, fetchImpl,
    failNext: (match: RegExp, status: number | 'network', times = 1, headers?: Record<string, string>) => failures.push({ match, status, times, headers }),
    commentsOn: (key: string) => issues.get(key)?.comments ?? [],
    count: (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.path}`)).length,
    sleeps: [] as number[],
  }
}
export type MockJira = ReturnType<typeof createMockJira>
