import type { SimpleGit } from 'simple-git'
import { parseGitHubRepo } from '../../shared'
import type { GitFactory, ProvisionedRepo } from './provisioner'

// pr-creator: for every provisioned repo that has changes — stage explicit paths, commit, push, then
// find-or-create the PR. GitHub only in v1; the provider comes from the repo URL host.

export interface PrDeps {
  makeGit: GitFactory
  getToken(): Promise<string | null>
  fetchFn?: typeof fetch
  /** Refuses non-https/ssh URLs before a push (production); tests inject an identity function. */
  validateUrl?: (url: string) => string
  committer?: { name: string; email: string }
  redact?: (s: string) => string
  /** Where to push (default: the repo URL). Tests point this at a local bare repo. */
  pushUrl?: (repo: ProvisionedRepo) => string
}

export interface PrRequest {
  ticketId: string
  title: string
  pipelineName?: string
  acceptanceCriteria?: string[]
  repos: ProvisionedRepo[]
}

export interface PrResult {
  prUrls: { repo: string; url: string }[]
  skipped: { repo: string; reason: string }[]
}

// Files AXON itself may leave in a worktree — never part of a delivery commit.
export const AXON_FILE = /^(\.axon\/|\.axon$|\.claude\/settings\.local\.json$)/

const CHUNK = 100

export async function changedPaths(git: SimpleGit): Promise<string[]> {
  const out = await git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const paths: string[] = []
  const parts = out.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    const code = entry.slice(0, 2)
    const p = entry.slice(3)
    if (code[0] === 'R' || code[0] === 'C') i++ // rename/copy: the next token is the origin path
    if (!AXON_FILE.test(p)) paths.push(p)
  }
  return paths
}

function prBody(req: PrRequest, repo: ProvisionedRepo, siblings: { repo: string; url: string }[]): string {
  const lines = [`## ${req.ticketId}: ${req.title || 'Delivery'}`, '']
  if (req.acceptanceCriteria?.length) {
    lines.push('### Acceptance criteria', ...req.acceptanceCriteria.map((c) => `- ${c}`), '')
  }
  const others = siblings.filter((s) => s.repo !== repo.name)
  if (others.length) lines.push('### Related pull requests', ...others.map((s) => `- ${s.repo}: ${s.url}`), '')
  lines.push(`_Opened by AXON${req.pipelineName ? ` (pipeline: ${req.pipelineName})` : ''}._`)
  return lines.join('\n')
}

export async function createPullRequests(deps: PrDeps, req: PrRequest): Promise<PrResult> {
  const doFetch = deps.fetchFn ?? fetch
  const redact = deps.redact ?? ((s: string) => s)
  const token = (await deps.getToken()) ?? ''
  const prUrls: { repo: string; url: string }[] = []
  const numbers = new Map<string, { number: number; gh: { owner: string; repo: string } }>()
  const skipped: PrResult['skipped'] = []

  const api = async (method: string, url: string, body: unknown, ctx: { repo: string; branch: string }): Promise<unknown> => {
    const res = await doFetch(url, {
      method,
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      let detail = text
      try { detail = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* not JSON */ }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new Error(redact(
          `GitHub refused access to ${ctx.repo} (HTTP ${res.status}: ${detail}). Your GitHub token must be able to read and write pull requests on this repository ` +
          `(fine-grained token: select the repository and set "Pull requests: Read and write"; classic token: "repo" scope; for an organisation repo the token may need SSO authorisation). ` +
          `Branch "${ctx.branch}" was already pushed, so you can fix the token in Settings → Accounts and run the delivery again or open the pull request yourself.`,
        ))
      }
      throw new Error(redact(`GitHub ${method} ${new URL(url).pathname} failed: HTTP ${res.status} — ${detail}`))
    }
    return res.json()
  }

  for (const repo of req.repos) {
    // Provider check first so an unsupported host fails before anything is pushed.
    const gh = parseGitHubRepo(repo.url)
    if (!gh) {
      let host = repo.url
      try { host = new URL(repo.url).host } catch { /* scp-style */ }
      throw new Error(`Pull requests are only supported for GitHub repositories in v1 (${repo.name}: ${host})`)
    }
    const git = await deps.makeGit(repo.worktreePath)
    const dirty = await changedPaths(git)
    if (dirty.length) {
      for (let i = 0; i < dirty.length; i += CHUNK) await git.raw(['add', '--', ...dirty.slice(i, i + CHUNK)])
      const cfg = deps.committer ? ['-c', `user.name=${deps.committer.name}`, '-c', `user.email=${deps.committer.email}`] : []
      await git.raw([...cfg, 'commit', '-m', `${req.ticketId}: ${req.title || 'AXON delivery'}\n\nDelivered by AXON${req.pipelineName ? ` pipeline: ${req.pipelineName}` : ''}`])
    }
    const ahead = parseInt((await git.raw(['rev-list', '--count', `refs/remotes/origin/${repo.baseBranch}..HEAD`]).catch(() => '1')).trim(), 10)
    if (!(ahead > 0)) {
      skipped.push({ repo: repo.name, reason: 'no changes' })
      continue
    }
    const url = deps.pushUrl ? deps.pushUrl(repo) : deps.validateUrl ? deps.validateUrl(repo.url) : repo.url
    try {
      await git.raw(['push', '-u', url, `HEAD:refs/heads/${repo.branch}`])
    } catch (err) {
      throw new Error(redact(`Push failed for ${repo.name}: ${err instanceof Error ? err.message : String(err)}`))
    }
    if (!token) throw new Error(`Pushed ${repo.name}, but no Git token is configured, so the pull request cannot be created (Settings → Accounts → GitHub)`)

    const base = `https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`
    const existing = (await api('GET', `${base}?head=${encodeURIComponent(`${gh.owner}:${repo.branch}`)}&state=open`, undefined, { repo: `${gh.owner}/${gh.repo}`, branch: repo.branch })) as { html_url: string; number: number }[]
    let pr = existing[0]
    if (!pr) {
      pr = (await api('POST', base, {
        title: `${req.ticketId}: ${req.title || 'Delivery'}`,
        head: repo.branch,
        base: repo.baseBranch,
        body: prBody(req, repo, []),
      }, { repo: `${gh.owner}/${gh.repo}`, branch: repo.branch })) as { html_url: string; number: number }
    }
    prUrls.push({ repo: repo.name, url: pr.html_url })
    numbers.set(repo.name, { number: pr.number, gh })
  }

  // Second pass: now that every PR exists, link siblings in each body.
  if (prUrls.length > 1) {
    for (const repo of req.repos) {
      const n = numbers.get(repo.name)
      if (!n) continue
      await api('PATCH', `https://api.github.com/repos/${n.gh.owner}/${n.gh.repo}/pulls/${n.number}`, { body: prBody(req, repo, prUrls) }, { repo: `${n.gh.owner}/${n.gh.repo}`, branch: repo.branch })
    }
  }
  return { prUrls, skipped }
}

/** Describes the git repository in `folder` (origin url, current branch, base branch) or null when it is not one with an origin. */
export async function detectRepo(makeGit: GitFactory, folder: string): Promise<ProvisionedRepo | null> {
  try {
    const git = await makeGit(folder)
    const url = (await git.raw(['remote', 'get-url', 'origin'])).trim()
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    let baseBranch = ''
    try {
      baseBranch = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '')
    } catch {
      // origin/HEAD is not set in worktrees of a bare mirror: ask the remote, then probe the usual names
      try {
        baseBranch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']))?.[1] ?? ''
      } catch {
        // offline
      }
      for (const b of baseBranch ? [] : ['main', 'master', 'trunk', 'develop']) {
        if ((await git.raw(['branch', '-r', '--list', `origin/${b}`]).catch(() => '')).trim()) { baseBranch = b; break }
      }
    }
    baseBranch ||= 'main'
    const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? 'repo'
    return url ? { name, url, branch, baseBranch, worktreePath: folder } : null
  } catch {
    return null
  }
}

/**
 * The distinct git repositories behind the folders this delivery's steps ran in (their recorded cwds).
 * Nothing is scanned and agent output is never consulted; folders that are not git repos with an origin are ignored.
 */
export async function reposFromCwds(makeGit: GitFactory, cwds: string[]): Promise<ProvisionedRepo[]> {
  const seen = new Set<string>()
  const out: ProvisionedRepo[] = []
  for (const cwd of cwds) {
    let top: string
    try {
      top = (await (await makeGit(cwd)).raw(['rev-parse', '--show-toplevel'])).trim()
    } catch {
      continue
    }
    const key = process.platform === 'win32' ? top.toLowerCase() : top
    if (!top || seen.has(key)) continue
    seen.add(key)
    const repo = await detectRepo(makeGit, top)
    if (repo) out.push(repo)
  }
  return out
}
