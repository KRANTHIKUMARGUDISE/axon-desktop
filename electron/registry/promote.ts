import fs from 'fs/promises'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { latestPublishedVersion, parseGitHubRepo, shortId, slugify } from '../../shared'
import type { Block, Pipeline } from '../../shared'
import type { FileStore } from '../store/fileStore'
import type { DocKind } from '../store/types'
import type { RegistrySync } from './sync'
import { blockOps, pipelineOps } from './docs'
import { assertPromotable, scopeRoot } from './layout'
import { scanText } from './secretScan'
import { redact } from '../log'

// "Promote" = open a PR to the registry's main branch (D9: org/ and teams/ are PR-only). The change is
// pushed on a dedicated branch (never directly to main) and a pull request is opened through the GitHub
// REST API with the engineer's own token.

export type PromoteTarget = { scope: 'Org' } | { scope: 'Team'; team: string }

export interface PromoteDeps {
  sync: RegistrySync
  local: FileStore
  getToken: () => Promise<string | null>
  /** Ids shipped in the seed bundle can never be promoted (they are Axon-owned). */
  isReserved: (id: string) => boolean
  fetchImpl?: typeof fetch
  /** owner/repo of the registry URL (GitHub by default; overridable in tests). */
  repoFromUrl?: (url: string) => { owner: string; repo: string } | null
}

export interface PromoteResult {
  prUrl: string
  branch: string
  path: string
  version: number
}

interface PrArgs {
  fetchImpl: typeof fetch
  token: string
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
}

/** Find-or-create: an open PR for the same head branch is returned instead of a duplicate (422). */
export async function openRegistryPr(a: PrArgs): Promise<string> {
  const headers = {
    Authorization: `Bearer ${a.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const api = `https://api.github.com/repos/${a.owner}/${a.repo}/pulls`
  const existing = await a.fetchImpl(`${api}?head=${encodeURIComponent(`${a.owner}:${a.head}`)}&state=open`, { headers })
  if (existing.ok) {
    const list = (await existing.json()) as { html_url?: string }[]
    if (list[0]?.html_url) return list[0].html_url
  }
  const res = await a.fetchImpl(api, { method: 'POST', headers, body: JSON.stringify({ title: a.title, body: a.body, head: a.head, base: a.base }) })
  if (!res.ok) throw new Error(redact(`GitHub PR creation failed: ${res.status} — ${await res.text()}`))
  const created = (await res.json()) as { html_url?: string }
  if (!created.html_url) throw new Error('GitHub did not return a pull request URL')
  return created.html_url
}

export async function promoteDefinition(
  deps: PromoteDeps,
  args: { kind: DocKind; id: string; target: PromoteTarget; note?: string },
): Promise<PromoteResult> {
  const { kind, id, target } = args
  const { local } = deps
  if (deps.isReserved(id)) throw new Error('Built-in Axon blocks are owned by AXON and cannot be promoted')
  const current = await local.getLocal(kind, id)
  if (!current) throw new Error(`${kind === 'block' ? 'Block' : 'Pipeline'} not found among your documents`)
  if ((current as Block).immutable || current.scope !== 'Personal') throw new Error('Only your own Personal documents can be promoted')
  const version = latestPublishedVersion(current)
  if (version < 1) throw new Error(`Publish "${current.name}" first — only a Published version can be promoted`)
  const doc = (kind === 'block' ? await local.getBlockVersion(id, version) : await local.getPipelineVersion(id, version)) as Block | Pipeline | null
  if (!doc || doc.status === 'Draft') throw new Error(`Published version ${version} of "${current.name}" is not available locally`)

  if (kind === 'pipeline') {
    // Others can only resolve org/team/built-in blocks — a pipeline pointing at a personal block would be broken for them.
    const bad: string[] = []
    for (const node of (doc as Pipeline).nodes.filter((x) => x.type !== 'forEach')) {
      const b = await local.getBlock(node.blockId)
      if (!b) bad.push(node.blockId)
      else if (b.scope === 'Personal') bad.push(b.name)
    }
    if (bad.length) throw new Error(`Promote these blocks first (pipelines can only use Team/Org/built-in blocks): ${[...new Set(bad)].join(', ')}`)
  }

  const token = await deps.getToken()
  if (!token) throw new Error('A GitHub token is required to open a pull request (Settings → GitHub token)')

  return deps.sync.exclusive(async (git: SimpleGit, cfg, user) => {
    const repo = (deps.repoFromUrl ?? parseGitHubRepo)(cfg.url)
    if (!repo) throw new Error('Promotion opens pull requests through the GitHub API; the registry URL is not a GitHub repository')

    const root = scopeRoot(target.scope, { email: user.email, team: target.scope === 'Team' ? target.team : undefined })
    const promoted = { ...doc, scope: target.scope, team: target.scope === 'Team' ? target.team : undefined } as Block | Pipeline
    const ops = kind === 'block' ? blockOps(root, promoted as Block, { pruneDraft: false }) : pipelineOps(root, promoted as Pipeline, { pruneDraft: false })
    for (const op of ops) assertPromotable(op.path)

    const branch = `axon/promote/${slugify(user.email) || 'user'}-${kind}-${shortId(id)}-v${version}`
    const base = cfg.branch
    await git.fetch(['origin', '--prune'])
    const hasBase = (await git.raw(['for-each-ref', '--format=%(refname)', `refs/remotes/origin/${base}`])).trim().length > 0
    if (!hasBase) throw new Error(`The registry has no "${base}" branch yet — ask an admin to initialise it`)
    try {
      await git.raw(['checkout', '-f', '-B', branch, `origin/${base}`])
      await git.raw(['clean', '-fdq'])
      // Blocks: the v{n}/ folder (first op deletes it); pipelines: the v{n}.yaml file (first op puts it).
      if (await pathExistsInTree(git, ops[0].path)) throw new Error(`Version ${version} of this ${kind} already exists at ${root}/ in the registry (published versions are immutable)`)
      const dir = await repoRoot(git)
      for (const op of ops) {
        if (op.op === 'delete') {
          await fs.rm(path.join(dir, op.path), { recursive: true, force: true })
          continue
        }
        const rule = scanText(op.content)
        if (rule) throw new Error(`Possible secret (${rule}) in ${op.path} — not promoted`)
        await fs.mkdir(path.dirname(path.join(dir, op.path)), { recursive: true })
        await fs.writeFile(path.join(dir, op.path), op.content, 'utf-8')
      }
      await git.raw(['add', '-A'])
      await git.raw([
        '-c', `user.name=${user.name || user.email}`, '-c', `user.email=${user.email}`, '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', `promote ${kind} "${current.name}" v${version} to ${root}`,
      ])
      await git.raw(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`])
    } finally {
      // Always leave the clone on the base branch so the next sync starts from a clean tree.
      await git.raw(['checkout', '-f', '-B', base, `origin/${base}`]).catch(() => undefined)
      await git.raw(['clean', '-fdq']).catch(() => undefined)
    }

    const prUrl = await openRegistryPr({
      fetchImpl: deps.fetchImpl ?? fetch,
      token,
      owner: repo.owner,
      repo: repo.repo,
      head: branch,
      base,
      title: `Promote ${kind} "${current.name}" v${version} to ${target.scope === 'Org' ? 'org' : `team ${target.team}`}`,
      body: [
        `Promotion of a ${kind} from \`${user.email}\` (v${version}).`,
        args.note ? `\n${args.note.slice(0, 1000)}` : '',
        '\nOpened by AXON. Review the files under `' + root + '/`; merging publishes this version to everyone.',
      ].join('\n'),
    })
    return { prUrl, branch, path: root, version }
  })
}

async function repoRoot(git: SimpleGit): Promise<string> {
  return (await git.raw(['rev-parse', '--show-toplevel'])).trim()
}

async function pathExistsInTree(git: SimpleGit, relPath: string): Promise<boolean> {
  const out = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD', '--', relPath])
  return out.trim().length > 0
}
