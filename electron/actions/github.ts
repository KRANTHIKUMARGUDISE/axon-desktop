import { parseGitHubRepo } from '../../shared'

// Minimal GitHub REST helper for the PR action blocks (PR Update, Find PRs). The token is the engineer's own Git token;
// it is only ever sent to api.github.com and never returned or logged.

export interface GitHubDeps {
  getToken(): Promise<string | null>
  fetchFn?: typeof fetch
  redact?(s: string): string
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GitHubError'
  }
}

export async function ghApi<T = unknown>(deps: GitHubDeps, method: string, url: string, body?: unknown): Promise<T> {
  const token = await deps.getToken()
  if (!token) throw new GitHubError('No GitHub token is configured (Settings → Accounts → GitHub).', 401)
  if (!url.startsWith('https://api.github.com/')) throw new GitHubError('Refusing to send the GitHub token to another host.', 400)
  const redact = deps.redact ?? ((s: string) => s)
  const res = await (deps.fetchFn ?? fetch)(url, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try { detail = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new GitHubError(redact(`GitHub refused ${method} ${new URL(url).pathname} (HTTP ${res.status}: ${detail}). The token needs read and write access to pull requests on this repository.`), res.status)
    }
    throw new GitHubError(redact(`GitHub ${method} ${new URL(url).pathname} failed: HTTP ${res.status} — ${detail}`), res.status)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export interface PrRef { owner: string; repo: string; number: number; url: string }

/** `https://github.com/o/r/pull/12` -> its parts, or null. */
export function parsePrUrl(url: string): PrRef | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.trim())
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url } : null
}

export { parseGitHubRepo }
