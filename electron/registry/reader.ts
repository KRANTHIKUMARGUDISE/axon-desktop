import fs from 'fs/promises'
import path from 'path'
import type { Block, Pipeline, Scope, DeliveryRule } from '../../shared'
import { latestPublishedVersion } from '../../shared'
import type { DefinitionSource, DocKind, VersionInfo } from '../store/types'
import { loadDefinitions, loadRules } from './docs'
import type { LoadedDefinitions } from './docs'
import { userRoot } from './layout'

type Doc = Block | Pipeline
type Entry = { scope: Scope; team?: string; draft?: Doc; versions: Doc[] }
type Index = { blocks: Map<string, Entry>; pipelines: Map<string, Entry>; skipped: string[] }

// Read-only definitions (org/ and teams/*) from the registry clone — the offline-capable read-through
// cache is simply the clone on disk. Scope/team come from where the file lives, never from its
// contents, so a document can't claim to be Org-scoped by saying so.
export class RegistryReader implements DefinitionSource {
  private index: Index | null = null
  private loading: Promise<Index> | null = null

  constructor(
    private readonly registryDir: string,
    /** Ids that belong to the bundled seed (registry copies of these are ignored). */
    private readonly isReserved: (id: string) => boolean = () => false,
  ) {}

  invalidate(): void {
    this.index = null
  }

  skipped(): Promise<string[]> {
    return this.load().then((i) => i.skipped)
  }

  private load(): Promise<Index> {
    if (this.index) return Promise.resolve(this.index)
    this.loading ??= this.build().then((i) => {
      this.index = i
      this.loading = null
      return i
    }, (err) => {
      this.loading = null
      throw err
    })
    return this.loading
  }

  private async build(): Promise<Index> {
    const idx: Index = { blocks: new Map(), pipelines: new Map(), skipped: [] }
    const scopes: { scope: Scope; team?: string; dir: string }[] = [{ scope: 'Org', dir: path.join(this.registryDir, 'org') }]
    try {
      for (const e of await fs.readdir(path.join(this.registryDir, 'teams'), { withFileTypes: true })) {
        if (e.isDirectory()) scopes.push({ scope: 'Team', team: e.name, dir: path.join(this.registryDir, 'teams', e.name) })
      }
    } catch {
      // no teams/ yet
    }
    for (const s of scopes) {
      for (const kind of ['block', 'pipeline'] as const) {
        const loaded = await loadDefinitions(s.dir, kind)
        idx.skipped.push(...loaded.skipped.map((x) => `${s.scope === 'Org' ? 'org' : `teams/${s.team}`}/${x}`))
        this.merge(kind === 'block' ? idx.blocks : idx.pipelines, loaded, s)
      }
    }
    return idx
  }

  private merge(into: Map<string, Entry>, loaded: LoadedDefinitions<Doc>, s: { scope: Scope; team?: string }): void {
    for (const [id, e] of loaded.byId) {
      if (this.isReserved(id) || into.has(id)) continue // seeded ids and first-wins on duplicates
      const stamp = (d: Doc): Doc => ({ ...d, scope: s.scope, team: s.team, owner: d.owner || (s.scope === 'Org' ? 'org' : s.team ?? '') })
      // Drafts never appear in shared scopes — only published versions are consumable.
      into.set(id, { ...s, versions: e.versions.map(stamp) })
    }
  }

  private latest(e: Entry): Doc | null {
    return e.versions[e.versions.length - 1] ?? null
  }

  async listBlocks(): Promise<Block[]> {
    const { blocks } = await this.load()
    return [...blocks.values()].map((e) => this.latest(e)).filter((d): d is Block => !!d)
  }

  async getBlock(id: string): Promise<Block | null> {
    const e = (await this.load()).blocks.get(id)
    return e ? (this.latest(e) as Block | null) : null
  }

  async getBlockVersion(id: string, version: number): Promise<Block | null> {
    const e = (await this.load()).blocks.get(id)
    return (e?.versions.find((d) => d.version === version) as Block | undefined) ?? null
  }

  async listPipelines(): Promise<Pipeline[]> {
    const { pipelines } = await this.load()
    return [...pipelines.values()].map((e) => this.latest(e)).filter((d): d is Pipeline => !!d)
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    const e = (await this.load()).pipelines.get(id)
    return e ? (this.latest(e) as Pipeline | null) : null
  }

  async getPipelineVersion(id: string, version: number): Promise<Pipeline | null> {
    const e = (await this.load()).pipelines.get(id)
    return (e?.versions.find((d) => d.version === version) as Pipeline | undefined) ?? null
  }

  async listVersions(kind: DocKind, id: string): Promise<VersionInfo[]> {
    const idx = await this.load()
    const e = (kind === 'block' ? idx.blocks : idx.pipelines).get(id)
    return (e?.versions ?? []).map((d) => ({
      version: d.version, status: d.status, versionLabel: d.versionLabel, changeNote: d.changeNote,
      updatedAt: d.updatedAt, scope: d.scope, source: 'registry' as const,
    }))
  }

  /** The caller's own watcher rules (users/{email}/rules) — used to hydrate a fresh machine. */
  async readOwnRules(email: string): Promise<DeliveryRule[]> {
    return loadRules(path.join(this.registryDir, userRoot(email)))
  }

  /** The caller's own documents (users/{email}) — used to hydrate a fresh machine. */
  async readOwn(email: string): Promise<{ kind: DocKind; current: Doc; published: Doc[] }[]> {
    const root = path.join(this.registryDir, userRoot(email))
    const out: { kind: DocKind; current: Doc; published: Doc[] }[] = []
    for (const kind of ['block', 'pipeline'] as const) {
      const loaded = await loadDefinitions(root, kind)
      for (const e of loaded.byId.values()) {
        const current = e.draft ?? e.versions[e.versions.length - 1]
        if (!current) continue
        if (latestPublishedVersion(current) < 0) continue
        out.push({ kind, current, published: e.versions })
      }
    }
    return out
  }
}
