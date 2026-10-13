import fs from 'fs/promises'
import path from 'path'
import type { Delivery } from '../../shared'
import type { WorkspacePort } from '../engine/engine'
import { resolveInside } from '../security/paths'
import { log } from '../log'
import { deliveryBranchName, deliveryRoot } from './provisioner'
import type { GitFactory } from './provisioner'
import { WorkspaceLocks } from './locks'

export { deliveryBranchName } from './provisioner'

export interface GitWorkspaceDeps {
  getWorkspaceRoot(): string
  makeGit: GitFactory
  username(): string
  /** Delivery status lookup, to tell a live lock from a stale one. */
  getDelivery(id: string): Promise<Pick<Delivery, 'status'> | null>
}

const ACTIVE = new Set(['Running', 'Paused', 'Interrupted'])
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// D17/D18: where nodes run. Delivery Folder = {root}/deliveries/{id}; an optional default Workspace path (a clean
// git repo inside the root) gets the delivery branch and is locked; item-level paths are checked the same way.
export function createWorkspaceService(deps: GitWorkspaceDeps) {
  const root = () => path.resolve(deps.getWorkspaceRoot())
  const locks = new WorkspaceLocks({
    dir: () => path.join(root(), '.axon', 'locks'),
    isActive: async (id) => {
      const d = await deps.getDelivery(id)
      return !!d && ACTIVE.has(d.status)
    },
  })

  /** Resolves `p` (relative paths against `base`) and enforces: inside the Workspace Root, exists, is a folder. */
  async function resolveInsideRoot(p: string, base: string): Promise<string> {
    const abs = path.isAbsolute(p) ? p : path.resolve(base, p)
    const ok = resolveInside(abs, [root()])
    if (!ok) throw new Error(`Workspace path must be inside the Workspace Root: ${p}`)
    let st
    try {
      st = await fs.stat(ok)
    } catch {
      throw new Error(`Workspace path does not exist: ${p}`)
    }
    if (!st.isDirectory()) throw new Error(`Workspace path is not a folder: ${p}`)
    return ok
  }

  async function repoTop(folder: string): Promise<string | null> {
    try {
      const top = (await (await deps.makeGit(folder)).raw(['rev-parse', '--show-toplevel'])).trim()
      return top ? path.resolve(top) : null
    } catch {
      return null
    }
  }

  async function assertClean(folder: string): Promise<void> {
    const out = (await (await deps.makeGit(folder)).raw(['status', '--porcelain'])).trim()
    if (out) throw new Error(`Workspace path has uncommitted changes — commit or stash them first: ${folder}`)
  }

  async function currentBranch(folder: string): Promise<string> {
    const g = await deps.makeGit(folder)
    const b = (await g.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return b === 'HEAD' ? (await g.raw(['rev-parse', 'HEAD'])).trim() : b
  }

  /**
   * D18 validation for the New Delivery workspace path: inside the root, a git repo folder, clean, not in use.
   * Throws a clear Error; with `claim` it also takes the lock for `deliveryId`.
   */
  async function inspectDefault(p: string, opts: { deliveryId?: string; claim?: boolean; skipClean?: boolean } = {}): Promise<string> {
    const folder = await resolveInsideRoot(p, root())
    const top = await repoTop(folder)
    if (!top || !same(top, folder)) throw new Error(`Workspace path is not a git repository (it must be the repository folder itself): ${p}`)
    const owner = await locks.ownerOf(folder)
    if (owner && owner !== opts.deliveryId) throw new Error(`Workspace folder is in use by another delivery (${owner.slice(0, 8)}): ${p}`)
    if (!opts.skipClean) await assertClean(folder)
    if (opts.claim && opts.deliveryId) await locks.acquire(folder, opts.deliveryId)
    return folder
  }

  /**
   * Switch the default Workspace path back to the branch it was on. If leftover changes make that fail, stash them
   * (tracked + untracked) as "axon/<deliveryId>" and retry. Never leaves the folder on the AXON branch silently:
   * whenever something was stashed or the restore failed, a notice says what happened and how to recover.
   */
  async function restoreBranch(delivery: Delivery): Promise<NonNullable<Delivery['workspaceNotice']> | undefined> {
    const folder = delivery.workspacePath as string
    const original = (delivery.workspaceBase as NonNullable<Delivery['workspaceBase']>).originalBranch
    const git = await deps.makeGit(folder)
    try {
      await git.raw(['checkout', original])
      return undefined
    } catch (firstErr) {
      const stashName = `axon/${delivery.id}`
      let stashed = false
      try {
        const out = await git.raw(['stash', 'push', '--include-untracked', '-m', stashName])
        stashed = !/No local changes/i.test(out)
        await git.raw(['checkout', original])
      } catch (err) {
        const message = `AXON could not switch ${folder} back to "${original}" and it is still on the delivery branch "${delivery.workspaceBase?.branch}". ` +
          (stashed ? `Your leftover changes were stashed as "${stashName}" (git stash list). ` : '') +
          `Run: git -C "${folder}" checkout ${original}${stashed ? ` && git -C "${folder}" stash pop` : ''}. Reason: ${err instanceof Error ? err.message : String(err)}`
        log.warn(`[workspace] could not restore the original branch in ${folder}`, firstErr)
        log.warn(message)
        return { kind: 'not-restored', message, folder, ...(stashed ? { stashName } : {}) }
      }
      const message = `Leftover changes in ${folder} were stashed as "${stashName}" so AXON could switch the folder back to "${original}". ` +
        `To get them back: git -C "${folder}" stash list, then git -C "${folder}" stash pop (pick the entry named "${stashName}").`
      log.warn(`[workspace] ${message}`)
      return { kind: 'stashed', message, folder, stashName }
    }
  }

  const port: WorkspacePort = {
    async prepare(delivery) {
      const deliveryFolder = deliveryRoot(root(), delivery.id)
      await fs.mkdir(deliveryFolder, { recursive: true })
      if (!delivery.workspacePath) return { deliveryFolder }

      const folder = await inspectDefault(delivery.workspacePath, { deliveryId: delivery.id, claim: true })
      try {
        const originalBranch = await currentBranch(folder)
        const branch = deliveryBranchName(delivery.id, delivery.ticketId, deps.username())
        await (await deps.makeGit(folder)).raw(['checkout', '-b', branch])
        return { deliveryFolder, workspacePath: folder, base: { originalBranch, branch } }
      } catch (err) {
        await locks.releaseAll(delivery.id)
        throw new Error(`Could not create the delivery branch in ${folder}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

    async resolveCwd(delivery, itemPath) {
      const deliveryFolder = delivery.deliveryFolder ?? deliveryRoot(root(), delivery.id)
      if (!itemPath) return delivery.workspacePath ?? deliveryFolder
      const folder = await resolveInsideRoot(itemPath, deliveryFolder)
      // AXON's own Delivery Folder (e.g. worktrees the provisioner made) and the default folder need no extra claim.
      if (inside(folder, deliveryFolder) || (delivery.workspacePath && inside(folder, delivery.workspacePath))) return folder
      const top = await repoTop(folder)
      if (!top) return folder // not a git repo: used as is
      if (!(await locks.holds(top, delivery.id))) {
        const owner = await locks.ownerOf(top)
        if (owner) throw new Error(`Workspace folder is in use by another delivery (${owner.slice(0, 8)}): ${itemPath}`)
        await assertClean(top)
        await locks.acquire(top, delivery.id)
      }
      return folder
    },

    async release(delivery) {
      let notice: NonNullable<Delivery['workspaceNotice']> | undefined
      try {
        if (delivery.workspaceBase && delivery.workspacePath) notice = await restoreBranch(delivery)
      } finally {
        await locks.releaseAll(delivery.id)
      }
      return notice ? { notice } : undefined
    },

    async reacquire(delivery) {
      if (!delivery.workspaceBase || !delivery.workspacePath) return
      await inspectDefault(delivery.workspacePath, { deliveryId: delivery.id, claim: true, skipClean: true })
      await (await deps.makeGit(delivery.workspacePath)).raw(['checkout', delivery.workspaceBase.branch])
    },
  }

  return {
    port,
    locks,
    /** Modal pre-check (no side effects): returns the resolved folder or throws the user-facing error. */
    async checkWorkspacePath(p: string): Promise<string> {
      return inspectDefault(p)
    },
  }
}

export const createGitWorkspace = (deps: GitWorkspaceDeps): WorkspacePort => createWorkspaceService(deps).port
