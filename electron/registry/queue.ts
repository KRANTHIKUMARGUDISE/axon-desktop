import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { atomicWrite } from '../store/atomic'
import { KeyedMutex } from '../store/mutex'
import { assertWritable } from './layout'
import { log } from '../log'

// Durable on-disk write queue for registry changes. One file per operation, written atomically
// (tmp + fsync + rename), so a crash can never lose or half-write an op. An op is removed only after
// the commit containing it has been pushed — a failed/offline sync leaves the queue untouched.

export type QueueOp = { id: string; seq: number; createdAt: string } & (
  | { op: 'put'; path: string; content: string }
  | { op: 'delete'; path: string } // a file or a whole directory
  | { op: 'append'; path: string; line: string }
)
export type NewQueueOp =
  | { op: 'put'; path: string; content: string }
  | { op: 'delete'; path: string }
  | { op: 'append'; path: string; line: string }

export interface RejectedOp {
  op: QueueOp
  rule: string
}

export class WriteQueue {
  private ops: QueueOp[] = []
  private rejectedOps: RejectedOp[] = []
  private nextSeq = 1
  private readonly mutex = new KeyedMutex()

  constructor(
    private readonly dir: string,
    private readonly getEmail: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private pendingDir = () => path.join(this.dir, 'pending')
  private rejectedDir = () => path.join(this.dir, 'rejected')
  private opFile = (op: Pick<QueueOp, 'seq' | 'id'>) => path.join(this.pendingDir(), `${String(op.seq).padStart(10, '0')}-${op.id}.json`)

  /** Loads whatever survived on disk (crash recovery). Unreadable files are kept, not deleted. */
  async init(): Promise<void> {
    await this.mutex.run('q', async () => {
      this.ops = await this.readDir<QueueOp>(this.pendingDir())
      this.ops.sort((a, b) => a.seq - b.seq)
      this.rejectedOps = await this.readDir<RejectedOp>(this.rejectedDir())
      this.nextSeq = ((this.ops[this.ops.length - 1]?.seq ?? 0)) + 1
    })
  }

  private async readDir<T>(dir: string): Promise<T[]> {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const out: T[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue // ignore leftover *.tmp from a crash mid-write
      try {
        out.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8')) as T)
      } catch (err) {
        log.warn(`[registry-queue] unreadable ${name}`, err)
      }
    }
    return out
  }

  /** Validates the path (never outside users/{email}/), persists, coalesces by path. */
  enqueue(input: NewQueueOp): Promise<QueueOp> {
    return this.mutex.run('q', async () => {
      const clean = assertWritable(input.path, this.getEmail())
      const op = { ...input, path: clean, id: crypto.randomBytes(6).toString('hex'), seq: this.nextSeq++, createdAt: this.now().toISOString() } as QueueOp
      await atomicWrite(this.opFile(op), JSON.stringify(op))
      // Last write wins per path: a put/delete supersedes earlier ops on the same file (or inside a
      // deleted directory). Appends are never dropped. New op is durable before the old ones go.
      if (op.op !== 'append') {
        const superseded = this.ops.filter((o) => o.path === op.path || (op.op === 'delete' && o.path.startsWith(`${op.path}/`)))
        for (const o of superseded) await fs.unlink(this.opFile(o)).catch(() => {})
        this.ops = this.ops.filter((o) => !superseded.includes(o))
      }
      this.ops.push(op)
      return op
    })
  }

  list(): QueueOp[] {
    return [...this.ops]
  }

  count(): number {
    return this.ops.length
  }

  rejected(): RejectedOp[] {
    return [...this.rejectedOps]
  }

  /** Drops ops that were committed and pushed. */
  remove(ids: string[]): Promise<void> {
    return this.mutex.run('q', async () => {
      const gone = this.ops.filter((o) => ids.includes(o.id))
      for (const o of gone) await fs.unlink(this.opFile(o)).catch(() => {})
      this.ops = this.ops.filter((o) => !ids.includes(o.id))
    })
  }

  /** Moves an op the secret scan (or the path guard) refused out of the pending queue — kept on disk. */
  reject(op: QueueOp, rule: string): Promise<void> {
    return this.mutex.run('q', async () => {
      const entry: RejectedOp = { op, rule }
      await atomicWrite(path.join(this.rejectedDir(), `${String(op.seq).padStart(10, '0')}-${op.id}.json`), JSON.stringify(entry))
      await fs.unlink(this.opFile(op)).catch(() => {})
      this.ops = this.ops.filter((o) => o.id !== op.id)
      this.rejectedOps.push(entry)
    })
  }

  /** A refused write is superseded once a newer version of the same file goes through. */
  forgetRejectedAt(paths: string[]): Promise<void> {
    return this.mutex.run('q', async () => {
      const gone = this.rejectedOps.filter((r) => paths.includes(r.op.path))
      for (const r of gone) await fs.unlink(path.join(this.rejectedDir(), `${String(r.op.seq).padStart(10, '0')}-${r.op.id}.json`)).catch(() => {})
      this.rejectedOps = this.rejectedOps.filter((r) => !gone.includes(r))
    })
  }

  clearRejected(): Promise<void> {
    return this.mutex.run('q', async () => {
      await fs.rm(this.rejectedDir(), { recursive: true, force: true })
      this.rejectedOps = []
    })
  }
}
