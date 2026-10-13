import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { DeliveryRuleSchema, SaveRuleInputSchema, SCHEMA_VERSION } from '../../shared'
import type { DeliveryRule, SaveRuleInput } from '../../shared'
import { atomicWrite } from '../store/atomic'
import { log } from '../log'

// Watcher rules: one JSON file per rule in {userData}/store/rules. Rules are the engineer's own (Personal) and
// are mirrored to users/{email}/rules/{id}.yaml through the registry write queue by the `onSaved/onDeleted` hooks.

export interface RuleStoreDeps {
  dir: string
  getOwner: () => string
  onSaved?: (rule: DeliveryRule) => void | Promise<void>
  onDeleted?: (id: string) => void | Promise<void>
  now?: () => Date
}

export class RuleStore {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date

  constructor(private readonly deps: RuleStoreDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  // Single writer: every mutation runs after the previous one.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid rule id: ${id}`)
    return path.join(this.deps.dir, `${id}.json`)
  }

  async list(): Promise<DeliveryRule[]> {
    let names: string[]
    try {
      names = (await fs.readdir(this.deps.dir)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const out: DeliveryRule[] = []
    for (const n of names) {
      try {
        out.push(DeliveryRuleSchema.parse(JSON.parse(await fs.readFile(path.join(this.deps.dir, n), 'utf-8'))))
      } catch (err) {
        log.warn(`[rules] skipping unreadable rule file ${n}`, err)
      }
    }
    return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.name.localeCompare(b.name))
  }

  async get(id: string): Promise<DeliveryRule | null> {
    try {
      return DeliveryRuleSchema.parse(JSON.parse(await fs.readFile(this.file(id), 'utf-8')))
    } catch {
      return null
    }
  }

  /** Create (no id) or update. A rule is always saved disabled-by-default; enabling is a separate, checked step. */
  save(input: SaveRuleInput): Promise<DeliveryRule> {
    const parsed = SaveRuleInputSchema.parse(input)
    return this.serial(async () => {
      const existing = parsed.id ? await this.get(parsed.id) : null
      if (parsed.id && !existing) throw new Error(`Rule ${parsed.id} not found`)
      const ts = this.now().toISOString()
      const rule = DeliveryRuleSchema.parse({
        ...existing,
        ...parsed,
        id: existing?.id ?? crypto.randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        scope: 'Personal',
        owner: this.deps.getOwner(),
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      })
      await atomicWrite(this.file(rule.id), JSON.stringify(rule, null, 2))
      await this.deps.onSaved?.(rule)
      return rule
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<DeliveryRule> {
    return this.serial(async () => {
      const existing = await this.get(id)
      if (!existing) throw new Error(`Rule ${id} not found`)
      const rule = { ...existing, enabled, updatedAt: this.now().toISOString() }
      await atomicWrite(this.file(id), JSON.stringify(rule, null, 2))
      await this.deps.onSaved?.(rule)
      return rule
    })
  }

  delete(id: string): Promise<void> {
    return this.serial(async () => {
      await fs.rm(this.file(id), { force: true })
      await this.deps.onDeleted?.(id)
    })
  }

  /** Hydration on a fresh machine: import a rule from the registry when it is not here yet. It never overwrites, and arrives disabled. */
  importIfMissing(rule: DeliveryRule): Promise<boolean> {
    return this.serial(async () => {
      if (await this.get(rule.id)) return false
      await atomicWrite(this.file(rule.id), JSON.stringify({ ...rule, enabled: false }, null, 2))
      return true
    })
  }
}
