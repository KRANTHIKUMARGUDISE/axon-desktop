import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { buildGitEnv } from '../security/gitAuth'
import { log } from '../log'

// Agent standard rule 9 (safe to retry). Agents never commit, so before each agent step AXON snapshots the
// step's repo working tree — uncommitted and untracked (non-ignored) files included — as a dangling commit
// under refs/axon/<deliveryId>/<stepId>. It never touches the branch, the real index or the working tree.
// A retry/resume of that step restores the snapshot (files back, new files removed) before running again.

export type GitRun = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>

export const defaultGit: GitRun =(cwd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      'git', args,
      { cwd, env: { ...buildGitEnv(process.env, {}), ...(env ?? {}) }, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout))),
    )
  })

const IDENTITY = {
  GIT_AUTHOR_NAME: 'AXON', GIT_AUTHOR_EMAIL: 'axon@localhost', GIT_COMMITTER_NAME: 'AXON', GIT_COMMITTER_EMAIL: 'axon@localhost',
}

export type SnapshotOutcome = 'snapshotted' | 'restored' | 'skipped'

export interface SnapshotService {
  /** Snapshot before the first run of a step; restore it if one already exists (retry/resume). Non-git folders are skipped. */
  ensure(cwd: string, deliveryId: string, stepId: string): Promise<SnapshotOutcome>
  /** True when `cwd` is in a git repo that holds a snapshot ref for this step. */
  has(cwd: string, deliveryId: string, stepId: string): Promise<boolean>
  /** Put the working tree back to the step's snapshot. */
  restore(cwd: string, deliveryId: string, stepId: string): Promise<boolean>
  /** Hash of the repo's current working tree (tracked + untracked, non-ignored); null for a non-git folder. Edit detection at gates. */
  treeHash?(cwd: string): Promise<string | null>
  /** Delete every refs/axon/<deliveryId>/… in the repos behind these folders. */
  dropAll(deliveryId: string, cwds: string[]): Promise<void>
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\.+/g, '_').replace(/\.lock$/i, '_lock')
export const snapshotRef = (deliveryId: string, stepId: string): string => `refs/axon/${safe(deliveryId)}/${safe(stepId)}`

export function createSnapshotService(deps: { git?: GitRun } = {}): SnapshotService {
  const git = deps.git ?? defaultGit

  async function topLevel(cwd: string): Promise<string | null> {
    try {
      return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null
    } catch {
      return null // not a git folder (or missing)
    }
  }

  async function withIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const file = path.join(os.tmpdir(), `axon-index-${crypto.randomBytes(6).toString('hex')}`)
    try {
      return await fn({ GIT_INDEX_FILE: file })
    } finally {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  async function refCommit(top: string, ref: string): Promise<string | null> {
    try {
      return (await git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null
    } catch {
      return null
    }
  }

  async function snapshotTo(top: string, ref: string): Promise<void> {
    await withIndex(async (env) => {
      await git(top, ['add', '-A'], env)
      const tree = (await git(top, ['write-tree'], env)).trim()
      const commit = (await git(top, ['commit-tree', tree, '-m', 'axon step snapshot'], { ...IDENTITY })).trim()
      await git(top, ['update-ref', ref, commit])
    })
  }

  async function restoreFrom(top: string, commit: string): Promise<void> {
    const z = (out: string) => out.split('\0').filter(Boolean)
    await withIndex(async (env) => {
      await git(top, ['read-tree', commit], env)
      await git(top, ['checkout-index', '-a', '-f'], env)
      const wanted = new Set(z(await git(top, ['ls-tree', '-r', '--name-only', '-z', commit])))
      // Everything on disk that is not ignored and not in the snapshot was created by the failed attempt.
      const present = z(await git(top, ['ls-files', '-c', '-o', '--exclude-standard', '-z']))
      for (const f of new Set(present)) {
        if (wanted.has(f)) continue
        await fs.rm(path.join(top, f), { force: true }).catch(() => {})
      }
    })
  }

  return {
    async ensure(cwd, deliveryId, stepId) {
      const top = await topLevel(cwd)
      if (!top) return 'skipped'
      const ref = snapshotRef(deliveryId, stepId)
      const existing = await refCommit(top, ref)
      if (existing) {
        await restoreFrom(top, existing)
        return 'restored'
      }
      await snapshotTo(top, ref)
      return 'snapshotted'
    },

    async has(cwd, deliveryId, stepId) {
      const top = await topLevel(cwd)
      return !!top && !!(await refCommit(top, snapshotRef(deliveryId, stepId)))
    },

    async restore(cwd, deliveryId, stepId) {
      const top = await topLevel(cwd)
      if (!top) return false
      const commit = await refCommit(top, snapshotRef(deliveryId, stepId))
      if (!commit) return false
      await restoreFrom(top, commit)
      return true
    },

    async treeHash(cwd) {
      const top = await topLevel(cwd)
      if (!top) return null
      return withIndex(async (env) => {
        await git(top, ['add', '-A'], env)
        return (await git(top, ['write-tree'], env)).trim() || null
      })
    },

    async dropAll(deliveryId, cwds) {
      const prefix = `refs/axon/${safe(deliveryId)}/`
      const tops = new Set<string>()
      for (const c of cwds) {
        const t = await topLevel(c)
        if (t) tops.add(t)
      }
      for (const top of tops) {
        try {
          const refs = (await git(top, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').map((s) => s.trim()).filter(Boolean)
          for (const r of refs) await git(top, ['update-ref', '-d', r])
        } catch (err) {
          log.warn(`[snapshots] could not delete ${prefix}* in ${top}`, err)
        }
      }
    },
  }
}
