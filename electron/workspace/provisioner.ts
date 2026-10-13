import fs from 'fs/promises'
import path from 'path'
import type { SimpleGit } from 'simple-git'
import { safeSegment, shortId, slugify } from '../../shared'
import { KeyedMutex } from '../store/mutex'
import { resolveInside } from '../security/paths'

// workspace-provisioner: per-repo bare mirror + one `git worktree` per delivery.
//   {workspaceRoot}/mirrors/{repoName}.git                  (shared by deliveries, fetched under a per-repo lock)
//   {workspaceRoot}/deliveries/{deliveryId}/{repoName}      (the delivery's own worktree on its own branch)
// Nothing here knows about Electron: git is injected, so tests run against local bare repos.

export const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/

export type GitFactory = (baseDir?: string) => Promise<SimpleGit>

export interface CatalogRepo {
  name: string
  url: string
  defaultBranch?: string
  description?: string
  tags?: string[]
}

export interface ProvisionedRepo {
  name: string
  url: string
  branch: string
  baseBranch: string
  worktreePath: string
}

export interface ProvisionDeps {
  makeGit: GitFactory
  workspaceRoot: string
  catalog: CatalogRepo[]
  /** Called with the catalog URL before any network git; throws to refuse. */
  validateUrl?: (url: string) => string
}

const mirrorLocks = new KeyedMutex()
const LONGPATHS = ['-c', 'core.longpaths=true']

export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
}

/** Matches a requested repository (url, or catalog name) against the catalog. */
export function findCatalogRepo(catalog: CatalogRepo[], ref: string): CatalogRepo | undefined {
  const n = normalizeRepoUrl(ref)
  return catalog.find((c) => normalizeRepoUrl(c.url) === n || c.name.toLowerCase() === n)
}

export function deliveryBranchName(deliveryId: string, ticketId: string, username: string): string {
  return `axon/${slugify(username) || 'unknown'}/${safeSegment(ticketId)}-${shortId(deliveryId)}`
}

export function deliveryRoot(workspaceRoot: string, deliveryId: string): string {
  return path.join(path.resolve(workspaceRoot), 'deliveries', safeSegment(deliveryId))
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function remoteDefaultBranch(git: SimpleGit, mirror: SimpleGit): Promise<string> {
  try {
    const out = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD'])
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out)
    if (m) return m[1]
  } catch {
    // fall back to the mirror's own HEAD
  }
  const head = (await mirror.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
  if (!head) throw new Error('Could not determine the default branch')
  return head
}

/** Clone (first use) or fetch (afterwards) the repo's bare mirror. Returns the mirror path + default branch. */
export async function ensureMirror(deps: ProvisionDeps, repo: CatalogRepo): Promise<{ mirrorPath: string; defaultBranch: string }> {
  const root = path.resolve(deps.workspaceRoot)
  const mirrorPath = path.join(root, 'mirrors', `${safeSegment(repo.name)}.git`)
  if (!resolveInside(mirrorPath, [root])) throw new Error('Mirror path escapes the workspace root')
  const url = deps.validateUrl ? deps.validateUrl(repo.url) : repo.url

  return mirrorLocks.run(mirrorPath, async () => {
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true })
    if (!(await exists(path.join(mirrorPath, 'HEAD')))) {
      const g = await deps.makeGit()
      await g.raw([...LONGPATHS, 'clone', '--bare', url, mirrorPath])
    }
    const mirror = await deps.makeGit(mirrorPath)
    // Branches fetch into refs/remotes/origin/* so local refs/heads/axon/* (checked out in worktrees) are never touched.
    await mirror.raw(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    await mirror.raw(['config', 'core.longpaths', 'true'])
    await mirror.raw([...LONGPATHS, 'fetch', '--prune', 'origin'])
    const defaultBranch = repo.defaultBranch || (await remoteDefaultBranch(mirror, mirror))
    return { mirrorPath, defaultBranch }
  })
}

export interface ProvisionInput {
  deliveryId: string
  ticketId: string
  username: string
  /** `branch` = base branch (default: the repo's default branch). `checkout` (S5b) = an existing branch (e.g. a PR branch found by Find PRs) to work on instead of a new delivery branch. */
  repositories: { url: string; branch?: string; checkout?: string }[]
}

export async function provisionWorkspace(deps: ProvisionDeps, input: ProvisionInput): Promise<{ workspacePath: string; provisionedRepos: ProvisionedRepo[] }> {
  if (!TICKET_KEY.test(input.ticketId)) {
    throw new Error(`Invalid ticket key "${input.ticketId}" (expected something like PROJ-123)`)
  }
  if (input.repositories.length === 0) throw new Error('No repositories to provision')

  // Validate everything against the catalog before touching the disk.
  const resolved = input.repositories.map((r) => {
    const hit = findCatalogRepo(deps.catalog, r.url)
    if (!hit) throw new Error(`Repository ${r.url} is not in the catalog (catalog/repositories.yaml)`)
    return { repo: hit, branch: r.branch, checkout: r.checkout }
  })
  const seen = new Map<string, string | undefined>()
  const unique = resolved.filter((r) => {
    if (seen.has(r.repo.name)) {
      if (seen.get(r.repo.name) !== r.checkout) throw new Error(`Repository ${r.repo.name} is requested on two different branches (${seen.get(r.repo.name) ?? 'new branch'} and ${r.checkout ?? 'new branch'}); one delivery uses one branch per repository`)
      return false
    }
    seen.set(r.repo.name, r.checkout)
    return true
  })

  const root = path.resolve(deps.workspaceRoot)
  const workspacePath = deliveryRoot(root, input.deliveryId)
  if (!resolveInside(workspacePath, [root])) throw new Error('Workspace path escapes the workspace root')
  await fs.mkdir(workspacePath, { recursive: true })

  const branch = deliveryBranchName(input.deliveryId, input.ticketId, input.username)
  const out: ProvisionedRepo[] = []
  for (const { repo, branch: wanted, checkout } of unique) {
    const { mirrorPath, defaultBranch } = await ensureMirror(deps, repo)
    const workBranch = checkout ?? branch
    const baseBranch = wanted || defaultBranch
    const worktreePath = path.join(workspacePath, safeSegment(repo.name))
    // git itself refuses a git dir longer than PATH_MAX-40 on Windows, even with core.longpaths.
    if (process.platform === 'win32' && worktreePath.length > 200) {
      throw new Error(`Workspace path is too long for git on Windows (${worktreePath.length} characters, max 200): ${worktreePath}. Choose a shorter workspace root in Settings.`)
    }
    if (!(await exists(path.join(worktreePath, '.git')))) {
      await mirrorLocks.run(mirrorPath, async () => {
        const mirror = await deps.makeGit(mirrorPath)
        const hasBranch = (await mirror.raw(['branch', '--list', workBranch])).trim().length > 0
        const base = `refs/remotes/origin/${baseBranch}`
        try {
          await mirror.raw(['rev-parse', '--verify', `${base}^{commit}`])
        } catch {
          throw new Error(`Branch "${baseBranch}" does not exist in ${repo.name}`)
        }
        // An existing branch (Find PRs) starts from its remote tip; a delivery branch starts from the base.
        let start = base
        if (checkout) {
          start = `refs/remotes/origin/${checkout}`
          try {
            await mirror.raw(['rev-parse', '--verify', `${start}^{commit}`])
          } catch {
            throw new Error(`Branch "${checkout}" does not exist in ${repo.name}`)
          }
        }
        await mirror.raw([
          ...LONGPATHS, 'worktree', 'add',
          ...(hasBranch ? [worktreePath, workBranch] : ['-b', workBranch, worktreePath, start]),
        ])
      })
      const wt = await deps.makeGit(worktreePath)
      await wt.raw(['config', 'core.longpaths', 'true'])
    }
    out.push({ name: repo.name, url: repo.url, branch: workBranch, baseBranch, worktreePath })
  }
  return { workspacePath, provisionedRepos: out }
}

/** Removes a delivery's worktrees (git bookkeeping first) and its directory. Mirrors are kept. */
export async function removeDeliveryWorkspace(deps: Pick<ProvisionDeps, 'makeGit' | 'workspaceRoot'>, deliveryId: string): Promise<void> {
  const root = path.resolve(deps.workspaceRoot)
  const dir = deliveryRoot(root, deliveryId)
  if (!resolveInside(dir, [root]) || !(await exists(dir))) return
  const mirrorsDir = path.join(root, 'mirrors')
  let mirrors: string[] = []
  try {
    mirrors = (await fs.readdir(mirrorsDir)).filter((m) => m.endsWith('.git'))
  } catch {
    // no mirrors yet
  }
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const wt = path.join(dir, entry.name)
    const mirror = path.join(mirrorsDir, `${entry.name}.git`)
    if (mirrors.includes(`${entry.name}.git`)) {
      await mirrorLocks.run(mirror, async () => {
        try {
          await (await deps.makeGit(mirror)).raw(['worktree', 'remove', '--force', wt])
        } catch {
          // fall through to the plain delete + prune below
        }
      })
    }
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  for (const m of mirrors) {
    await mirrorLocks.run(path.join(mirrorsDir, m), async () => {
      try {
        await (await deps.makeGit(path.join(mirrorsDir, m))).raw(['worktree', 'prune'])
      } catch {
        // best effort
      }
    })
  }
}

export async function directorySize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) total += await directorySize(full)
    else if (e.isFile()) {
      try {
        total += (await fs.stat(full)).size
      } catch {
        // vanished
      }
    }
  }
  return total
}
