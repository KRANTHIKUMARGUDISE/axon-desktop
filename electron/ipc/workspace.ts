import fs from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import { handle } from './guard'
import { resolveInside, realpathDeepest, isWithin } from '../security/paths'
import { log } from '../log'
import type { Store } from '../store/types'

const MAX_READ_BYTES = 5 * 1024 * 1024
const MAX_LIST_ENTRIES = 5000

export interface WorkspaceAccess {
  /** workspaceRoot, {userData}, registry cache … — read/write roots. */
  getRoots(): string[]
  /** Paths the user explicitly picked in a native dialog this session — read-only. */
  isGranted(p: string): boolean
}

// Folders/files chosen through the native picker become readable (never writable) for the
// session — Create Block reads an arbitrary user-selected skill folder.
export function createGrants() {
  const granted = new Set<string>()
  return {
    grant(p: string) {
      granted.add(realpathDeepest(p))
    },
    isGranted(p: string): boolean {
      const real = realpathDeepest(p)
      for (const g of granted) if (isWithin(real, g)) return true
      return false
    },
  }
}

export function createWorkspaceFs(access: WorkspaceAccess) {
  const readable = (p: unknown): string => {
    const inRoots = resolveInside(p, access.getRoots())
    if (inRoots) return inRoots
    if (typeof p === 'string' && path.isAbsolute(p) && access.isGranted(p)) {
      const resolved = resolveInside(p, [realpathDeepest(p)])
      if (resolved) return resolved
    }
    log.warn('[workspace] path rejected', String(p))
    throw new Error('Path is outside the allowed workspace')
  }

  return {
    async readFile(filePath: string): Promise<string> {
      const resolved = readable(filePath)
      const stat = await fs.stat(resolved)
      if (stat.size > MAX_READ_BYTES) throw new Error('File is too large to read')
      return fs.readFile(resolved, 'utf-8')
    },

    async listFilesRecursive(dirPath: string, maxDepth = 2): Promise<string[]> {
      const root = readable(dirPath)
      const depthLimit = Math.min(Math.max(0, maxDepth), 6)
      const files: string[] = []
      async function walk(dir: string, depth: number): Promise<void> {
        if (depth > depthLimit || files.length >= MAX_LIST_ENTRIES) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch (err) {
          log.warn(`[workspace] cannot read directory ${dir}`, err)
          return
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isFile()) files.push(path.relative(root, full))
          // Symlinked directories are not followed (isDirectory() is false for them).
          else if (entry.isDirectory() && depth < depthLimit) await walk(full, depth + 1)
        }
      }
      await walk(root, 0)
      return files
    },
  }
}

/** A delivery's own clone: Default-type workspace that is a direct child of workspaceRoot. */
export function resolveClearableWorkspace(workspacePath: string, workspaceRoot: string): string | null {
  const inside = resolveInside(workspacePath, [workspaceRoot])
  if (!inside) return null
  const root = realpathDeepest(workspaceRoot)
  return path.dirname(inside).toLowerCase() === root.toLowerCase() || path.dirname(inside) === root ? inside : null
}

export function registerWorkspaceHandlers(deps: {
  store: Store
  getWorkspaceRoot(): string
  access: WorkspaceAccess
}) {
  const ws = createWorkspaceFs(deps.access)
  const Path = z.string().min(1).max(4096)

  handle('workspace:readFile', z.tuple([Path]), ([p]) => ws.readFile(p))
  handle('workspace:listFilesRecursive', z.tuple([Path, z.number().int().optional()]), ([p, depth]) =>
    ws.listFilesRecursive(p, depth))

  // Replaces the old arbitrary-path workspace:clear: only a delivery's own clone can be removed.
  handle('delivery:clearWorkspace', z.tuple([z.string().min(1)]), async ([deliveryId]) => {
    const delivery = await deps.store.getDelivery(deliveryId)
    if (!delivery) return { success: false, error: 'Delivery not found' }
    if (delivery.status === 'Running' || delivery.status === 'Paused') {
      return { success: false, error: 'Stop the delivery before clearing its workspace' }
    }
    if (delivery.workspaceType !== 'Default' || !delivery.workspacePath) {
      return { success: false, error: 'Only AXON-managed workspaces can be cleared from here' }
    }
    const target = resolveClearableWorkspace(delivery.workspacePath, deps.getWorkspaceRoot())
    if (!target) return { success: false, error: 'Workspace is not inside the AXON workspace root' }
    try {
      await fs.rm(target, { recursive: true, force: true })
      log.info(`[workspace] cleared ${target}`)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
