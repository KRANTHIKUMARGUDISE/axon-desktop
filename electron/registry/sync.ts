import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import YAML from 'yaml'
import type { SimpleGit } from 'simple-git'
import { RegistryManifestSchema, SCHEMA_VERSION, compareVersions } from '../../shared'
import type { RegistryStatus, RegistryState } from '../../shared'
import { WriteQueue } from './queue'
import type { QueueOp } from './queue'
import { assertWritable, userRoot, REGISTRY_MANIFEST } from './layout'
import { scanText } from './secretScan'
import { log, redact } from '../log'

// Sync = fetch -> (reset the working tree to the remote) -> replay queued ops on top -> commit ->
// push. Because each engineer only ever writes inside their own users/{email}/ folder, replaying the
// queue onto the fresh remote tree is equivalent to rebasing their commits and can never conflict.
// The queue (on disk, atomic) is the source of truth until a push succeeds, so nothing is lost on
// crash, offline, rejected push or a restart.

export type GitFactory = (baseDir?: string) => Promise<SimpleGit>

export interface SyncConfig {
  url: string
  branch: string
  intervalMinutes: number
}

export interface SyncDeps {
  registryDir: string
  getConfig: () => SyncConfig
  /** null until onboarding has produced a verified identity. */
  getUser: () => { email: string; name: string } | null
  makeGit: GitFactory
  /** Throws for URLs the app must never fetch from (file:, ext::, embedded credentials …). */
  validateUrl?: (url: string) => string
  queue: WriteQueue
  appVersion: string
  machineName?: string
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  backoffBaseMs?: number
  onStatus?: (status: RegistryStatus) => void
  /** Called after the clone has been brought up to date (hydrate own docs, drop caches). */
  onSynced?: () => Promise<void>
}

const AUTH_RE = /authentication failed|permission denied|access denied|\b40[13]\b|could not read (?:username|password)|invalid username or password|repository not found|not authorized|requested url returned error: 40/i
const NETWORK_RE = /could not resolve host|unable to access|connection (?:timed out|refused|reset|closed)|network is unreachable|could not read from remote repository|early eof|ssl|tls|timed out|failed to connect|does not appear to be a git repository|no route to host|temporary failure|unable to connect|econn|enotfound/i
const NON_FF_RE = /non-fast-forward|fetch first|\[rejected\]|failed to push some refs|cannot lock ref|stale info/i

export type FailureKind = 'auth' | 'offline' | 'rejected' | 'other'
export function classifyGitError(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err)
  if (NON_FF_RE.test(msg)) return 'rejected'
  if (AUTH_RE.test(msg)) return 'auth'
  if (NETWORK_RE.test(msg)) return 'offline'
  return 'other'
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class RegistrySync {
  private status: RegistryStatus
  private chain: Promise<unknown> = Promise.resolve()
  private pendingSync: Promise<RegistryStatus> | null = null
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? (() => new Date())
    this.sleep = deps.sleep ?? defaultSleep
    const cfg = deps.getConfig()
    this.status = {
      state: 'Unconfigured', lastSyncAt: null, lastError: null, queued: deps.queue.count(), rejected: [],
      registryUrl: cfg.url, branch: cfg.branch, intervalMinutes: cfg.intervalMinutes,
    }
  }

  getStatus(): RegistryStatus {
    const cfg = this.deps.getConfig()
    return {
      ...this.status,
      queued: this.deps.queue.count(),
      rejected: this.deps.queue.rejected().map((r) => ({ path: r.op.path, rule: r.rule })),
      registryUrl: cfg.url, branch: cfg.branch, intervalMinutes: cfg.intervalMinutes,
    }
  }

  private set(state: RegistryState, patch: Partial<RegistryStatus> = {}): void {
    this.status = { ...this.status, ...patch, state }
    this.deps.onStatus?.(this.getStatus())
  }

  /** Re-publishes the status (e.g. after a write was queued so the UI's queued count updates). */
  notify(): void {
    this.deps.onStatus?.(this.getStatus())
  }

  // ---------------------------------------------------------------- scheduling

  start(initialDelayMs = 2000): void {
    this.stopped = false
    this.schedule(initialDelayMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.syncNow()
        .catch((err) => log.warn('[registry] scheduled sync failed', err))
        .finally(() => this.schedule(Math.max(1, this.deps.getConfig().intervalMinutes) * 60_000))
    }, delayMs)
    this.timer.unref?.()
  }

  /** Best-effort final sync on quit; the queue is durable either way. */
  async flush(timeoutMs = 5000): Promise<void> {
    await Promise.race([this.syncNow().catch(() => undefined), this.sleep(timeoutMs)])
  }

  // ---------------------------------------------------------------- serialisation

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => undefined)
    return p
  }

  /** One sync at a time; concurrent callers share the next queued run. */
  syncNow(): Promise<RegistryStatus> {
    if (this.pendingSync) return this.pendingSync
    const p = this.serial(async () => {
      this.pendingSync = null
      await this.run()
      return this.getStatus()
    })
    this.pendingSync = p
    return p
  }

  /** Runs `fn` with the clone checked out and no sync in flight (promotion branches use this). */
  exclusive<T>(fn: (git: SimpleGit, cfg: SyncConfig, user: { email: string; name: string }) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const cfg = this.deps.getConfig()
      const user = this.deps.getUser()
      if (!cfg.url || !user) throw new Error('Registry is not configured')
      const git = await this.ensureClone(cfg)
      return fn(git, cfg, user)
    })
  }

  // ---------------------------------------------------------------- the sync itself

  private async ensureClone(cfg: SyncConfig): Promise<SimpleGit> {
    const dir = this.deps.registryDir
    const exists = await fs.stat(path.join(dir, '.git')).then(() => true, () => false)
    if (!exists) {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.mkdir(path.dirname(dir), { recursive: true })
      const g = await this.deps.makeGit()
      // Keep YAML byte-stable across Windows/macOS regardless of the user's global autocrlf.
      await g.clone(cfg.url, dir, ['-c', 'core.autocrlf=false'])
    }
    const git = await this.deps.makeGit(dir)
    const remotes = await git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    if (!origin) await git.addRemote('origin', cfg.url)
    else if (origin.refs.fetch !== cfg.url) await git.remote(['set-url', 'origin', cfg.url])
    return git
  }

  private async remoteHasBranch(git: SimpleGit, branch: string): Promise<boolean> {
    // (rev-parse --quiet exits 1 with no stderr, which simple-git reports as success — list refs instead.)
    const out = await git.raw(['for-each-ref', '--format=%(refname)', `refs/remotes/origin/${branch}`])
    return out.trim().length > 0
  }

  /** minAppVersion / schemaVersion gate from the remote's registry.yaml. Returns a reason when writes must stop. */
  private async readOnlyReason(git: SimpleGit, branch: string): Promise<string | null> {
    let text: string
    try {
      text = await git.show([`origin/${branch}:${REGISTRY_MANIFEST}`])
    } catch {
      return null // no manifest yet — nothing to enforce
    }
    try {
      const manifest = RegistryManifestSchema.parse(YAML.parse(text))
      if (compareVersions(manifest.minAppVersion, this.deps.appVersion) > 0) {
        return `This registry requires AXON ${manifest.minAppVersion} or newer (you have ${this.deps.appVersion}). Update AXON to sync changes.`
      }
      if (manifest.schemaVersion > SCHEMA_VERSION) {
        return `This registry uses schema version ${manifest.schemaVersion}, newer than this app supports (${SCHEMA_VERSION}). Update AXON.`
      }
    } catch (err) {
      log.warn('[registry] unreadable registry.yaml', err)
    }
    return null
  }

  private async run(): Promise<void> {
    const cfg = this.deps.getConfig()
    const user = this.deps.getUser()
    if (!cfg.url || !user) {
      this.set('Unconfigured', { lastError: null })
      return
    }
    this.set('Syncing', { lastError: null })
    try {
      this.deps.validateUrl?.(cfg.url)
      const git = await this.ensureClone(cfg)
      const maxAttempts = this.deps.maxAttempts ?? 5
      const base = this.deps.backoffBaseMs ?? 1000
      let lastErr: unknown
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const done = await this.attempt(git, cfg, user)
          await this.deps.onSynced?.().catch((err) => log.warn('[registry] post-sync hook failed', err))
          if (done.readOnly) this.set('ReadOnly', { lastError: done.readOnly, lastSyncAt: this.now().toISOString() })
          else this.set('Idle', { lastError: null, lastSyncAt: this.now().toISOString() })
          return
        } catch (err) {
          lastErr = err
          if (classifyGitError(err) !== 'rejected') throw err
          // Someone else pushed first: fetch again and replay (backoff + jitter).
          log.info(`[registry] push rejected (attempt ${attempt + 1}/${maxAttempts}); retrying`)
          await this.sleep(base * 2 ** attempt + Math.floor(Math.random() * base))
        }
      }
      throw lastErr
    } catch (err) {
      const kind = classifyGitError(err)
      const message = redact(err instanceof Error ? err.message : String(err))
      log.warn(`[registry] sync failed (${kind})`, message)
      if (kind === 'offline') this.set('Offline', { lastError: message })
      else this.set('NeedsAttention', { lastError: kind === 'rejected' ? `Push kept being rejected — ${message}` : message })
      await this.deps.onSynced?.().catch(() => undefined)
    }
  }

  private async attempt(git: SimpleGit, cfg: SyncConfig, user: { email: string; name: string }): Promise<{ readOnly: string | null }> {
    const { branch } = cfg
    await git.fetch(['origin', '--prune'])
    const hasRemote = await this.remoteHasBranch(git, branch)

    // Working tree := remote state (queued writes are replayed on top below).
    if (hasRemote) await git.raw(['checkout', '-f', '-B', branch, `origin/${branch}`])
    else await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
    await git.raw(['clean', '-fdq'])

    const readOnly = hasRemote ? await this.readOnlyReason(git, branch) : null
    if (readOnly) return { readOnly }

    const ops = this.deps.queue.list()
    if (ops.length === 0) return { readOnly: null }

    const applied: QueueOp[] = []
    for (const op of ops) {
      try {
        const rel = assertWritable(op.path, user.email) // re-checked at commit time, not just at enqueue
        const abs = path.resolve(this.deps.registryDir, rel)
        if (!abs.startsWith(path.resolve(this.deps.registryDir) + path.sep)) throw new Error('path escapes the registry clone')
        const text = op.op === 'put' ? op.content : op.op === 'append' ? op.line : ''
        const rule = text ? scanText(text) : null
        if (rule) {
          await this.deps.queue.reject(op, rule)
          log.warn(`[registry] refused to push ${rel}: possible secret (${rule})`)
          continue
        }
        if (op.op === 'put') {
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.writeFile(abs, op.content, 'utf-8')
        } else if (op.op === 'append') {
          await fs.mkdir(path.dirname(abs), { recursive: true })
          await fs.appendFile(abs, op.line.endsWith('\n') ? op.line : `${op.line}\n`, 'utf-8')
        } else {
          await fs.rm(abs, { recursive: true, force: true })
        }
        applied.push(op)
      } catch (err) {
        await this.deps.queue.reject(op, 'path-not-allowed')
        log.warn('[registry] dropped queued write (not allowed)', err)
      }
    }

    await git.raw(['add', '-A'])
    const staged = (await git.raw(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
    const prefix = `${userRoot(user.email)}/`
    const outside = staged.filter((f) => !f.startsWith(prefix))
    if (outside.length) {
      await git.raw(['reset', '-q'])
      throw new Error(`Refusing to commit files outside ${prefix}: ${outside.slice(0, 3).join(', ')}`)
    }
    if (staged.length > 0) {
      const machine = this.deps.machineName ?? os.hostname()
      await git.raw([
        '-c', `user.name=${user.name || user.email}`, '-c', `user.email=${user.email}`, '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', `axon: sync ${staged.length} file(s) from ${machine}`,
      ])
      await git.raw(['push', 'origin', `HEAD:refs/heads/${branch}`])
    }
    // Pushed (or already identical to the remote): these ops are done.
    await this.deps.queue.remove(applied.map((o) => o.id))
    await this.deps.queue.forgetRejectedAt(applied.map((o) => o.path))
    return { readOnly: null }
  }
}

// ---------------------------------------------------------------- onboarding connectivity test

export interface ConnectionResult {
  ok: boolean
  canRead: boolean
  canPush: boolean
  branchExists: boolean
  error?: string
}

/** Read access (`ls-remote`) and push access (`push --dry-run` of a throwaway ref from a scratch repo). */
export async function testRegistryConnection(
  makeGit: GitFactory, url: string, branch: string, validateUrl?: (url: string) => string,
): Promise<ConnectionResult> {
  const result: ConnectionResult = { ok: false, canRead: false, canPush: false, branchExists: false }
  try {
    validateUrl?.(url)
    const git = await makeGit()
    const out = await git.listRemote(['--heads', url])
    result.canRead = true
    result.branchExists = new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(out)
  } catch (err) {
    result.error = redact(err instanceof Error ? err.message : String(err))
    return result
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'axon-conn-'))
  try {
    const git = await makeGit(scratch)
    await git.init()
    await git.raw(['-c', 'user.name=axon', '-c', 'user.email=axon@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'connectivity check'])
    await git.raw(['push', '--dry-run', url, 'HEAD:refs/heads/axon-connectivity-check'])
    result.canPush = true
    result.ok = true
  } catch (err) {
    result.error = `Read access works, but push access failed: ${redact(err instanceof Error ? err.message : String(err))}`
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
  return result
}
