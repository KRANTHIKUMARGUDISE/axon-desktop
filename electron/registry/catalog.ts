import fs from 'fs/promises'
import path from 'path'
import YAML from 'yaml'
import { z } from 'zod'
import { execFile } from 'child_process'
import { parseRepoUrl, CATALOG_DESCRIPTION_MAX } from '../../shared'
import type { CatalogRepo } from '../workspace/provisioner'

// catalog/repositories.yaml (PR-only registry path): the repositories a delivery may touch.
//   repositories:
//     - name: payments-api            # unique, used for the mirror + worktree folder
//       url: https://github.com/acme/payments-api.git
//       defaultBranch: main           # optional; detected from the remote when omitted
const RepoEntry = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/, 'name must be a simple folder-safe name (letters, digits, . _ -)'),
  url: z.string().refine((u) => parseRepoUrl(u) !== null, 'url must be an https://, ssh:// or git@host:path URL without credentials'),
  defaultBranch: z.string().optional(),
  // Shown to planner agents (repoCatalog): over-long descriptions are truncated on read, with a warning.
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
})

export const CATALOG_PATH = 'catalog/repositories.yaml'

export interface CatalogDropped {
  /** 1-based position in the file's repositories list. */
  index: number
  name?: string
  reason: string
}

export interface ParsedCatalog {
  entries: CatalogRepo[]
  dropped: CatalogDropped[]
  /** Entries that are used but were adjusted (e.g. description truncated). */
  warnings: CatalogDropped[]
  /** The whole file could not be used (bad YAML, no repositories list). */
  error?: string
}

/** Parses the catalog text. Entries that cannot be used are returned in `dropped` with the reason (never silently). */
export function parseCatalogDetailed(text: string): ParsedCatalog {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (err) {
    return { entries: [], dropped: [], warnings: [], error: `The file is not valid YAML: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}` }
  }
  const list = (raw as { repositories?: unknown } | null | undefined)?.repositories
  if (!Array.isArray(list)) {
    return { entries: [], dropped: [], warnings: [], error: 'Expected a top-level "repositories:" list' }
  }
  const entries: CatalogRepo[] = []
  const dropped: CatalogDropped[] = []
  const warnings: CatalogDropped[] = []
  const seen = new Set<string>()
  list.forEach((item, i) => {
    const index = i + 1
    const name = typeof (item as { name?: unknown } | null)?.name === 'string' ? (item as { name: string }).name : undefined
    const parsed = RepoEntry.safeParse(item)
    if (!parsed.success) {
      const why = parsed.error.issues.map((x) => `${x.path.join('.') || 'entry'}: ${x.message}`).join('; ')
      dropped.push({ index, name, reason: why })
      return
    }
    const key = parsed.data.name.toLowerCase()
    if (seen.has(key)) {
      dropped.push({ index, name: parsed.data.name, reason: `duplicate name "${parsed.data.name}" (the first entry with this name is used)` })
      return
    }
    seen.add(key)
    const entry = parsed.data
    if (entry.description !== undefined && entry.description.length > CATALOG_DESCRIPTION_MAX) {
      warnings.push({ index, name: entry.name, reason: `description is ${entry.description.length} characters; truncated to ${CATALOG_DESCRIPTION_MAX}` })
      entry.description = entry.description.slice(0, CATALOG_DESCRIPTION_MAX - 1) + '…'
    }
    entries.push(entry)
  })
  return { entries, dropped, warnings }
}

/** Valid entries only (see parseCatalogDetailed for what was dropped). */
export function parseCatalog(text: string): CatalogRepo[] {
  return parseCatalogDetailed(text).entries
}

export interface CatalogLoad extends ParsedCatalog {
  /** Absolute path of the file inside the local registry clone. */
  filePath: string
  /** Path inside the registry repository. */
  registryPath: string
  exists: boolean
}

/** Reads the catalog from the registry clone (which doubles as the offline cache). */
export async function loadCatalog(registryDir: string): Promise<CatalogLoad> {
  const filePath = path.join(registryDir, CATALOG_PATH)
  const base = { filePath, registryPath: CATALOG_PATH }
  try {
    return { ...base, exists: true, ...parseCatalogDetailed(await fs.readFile(filePath, 'utf8')) }
  } catch {
    return { ...base, exists: false, entries: [], dropped: [], warnings: [] }
  }
}

export async function readCatalog(registryDir: string): Promise<CatalogRepo[]> {
  return (await loadCatalog(registryDir)).entries
}

/** Commit of the registry clone the catalog was read from (recorded on the delivery). Undefined when unavailable. */
export function registryHead(registryDir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: registryDir, windowsHide: true }, (err, out) => resolve(err ? undefined : String(out).trim() || undefined))
  })
}
