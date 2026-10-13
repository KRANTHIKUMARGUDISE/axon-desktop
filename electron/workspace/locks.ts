import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { KeyedMutex } from '../store/mutex'

// D17/D18: a folder outside AXON's own Delivery Folders (a repo the engineer works on) is used by one
// delivery at a time. The lock is a small file under {workspaceRoot}/.axon/locks/; a lock whose owner
// delivery is no longer Running/Paused/Interrupted is stale and is taken over, so a crash never wedges a folder.

export interface LockDeps {
  /** Directory holding the lock files. */
  dir: () => string
  /** True while the delivery may still use its folders (Running, Paused, Interrupted). */
  isActive: (deliveryId: string) => Promise<boolean>
}

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

export class WorkspaceLocks {
  private readonly mutex = new KeyedMutex()

  constructor(private readonly deps: LockDeps) {}

  private file(folder: string): string {
    return path.join(this.deps.dir(), `${crypto.createHash('sha1').update(norm(folder)).digest('hex')}.json`)
  }

  /** The delivery currently holding `folder`, or null when free/stale. */
  async ownerOf(folder: string): Promise<string | null> {
    try {
      const rec = JSON.parse(await fs.readFile(this.file(folder), 'utf8')) as { deliveryId?: string }
      if (rec.deliveryId && (await this.deps.isActive(rec.deliveryId))) return rec.deliveryId
    } catch {
      // no lock file
    }
    return null
  }

  async acquire(folder: string, deliveryId: string): Promise<void> {
    await this.mutex.run(norm(folder), async () => {
      const owner = await this.ownerOf(folder)
      if (owner && owner !== deliveryId) {
        throw new Error(`Workspace folder is in use by another delivery (${owner.slice(0, 8)}): ${folder}`)
      }
      await fs.mkdir(this.deps.dir(), { recursive: true })
      await fs.writeFile(this.file(folder), JSON.stringify({ folder, deliveryId, at: new Date().toISOString() }))
    })
  }

  async holds(folder: string, deliveryId: string): Promise<boolean> {
    return (await this.ownerOf(folder)) === deliveryId
  }

  async releaseAll(deliveryId: string): Promise<void> {
    let files: string[] = []
    try {
      files = await fs.readdir(this.deps.dir())
    } catch {
      return
    }
    for (const f of files) {
      const p = path.join(this.deps.dir(), f)
      try {
        const rec = JSON.parse(await fs.readFile(p, 'utf8')) as { deliveryId?: string; folder?: string }
        if (rec.deliveryId === deliveryId) await this.mutex.run(norm(rec.folder ?? p), () => fs.rm(p, { force: true }))
      } catch {
        // unreadable lock file: ignore
      }
    }
  }
}
