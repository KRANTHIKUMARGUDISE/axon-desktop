import path from 'path'
import type { Scope } from '../../shared'

// Registry layout (D9) — single branch, folder = future DB collection:
//   registry.yaml                         schemaVersion, minAppVersion
//   catalog/repositories.yaml             PR only
//   org/{pipelines,blocks}/               PR only
//   teams/{team}/{pipelines,blocks}/      PR only
//   users/{email}/profile.yaml            direct commit, that user only
//   users/{email}/{pipelines,blocks,rules}/
//   users/{email}/runs/{yyyy-mm}/{deliveryId}.json
//   users/{email}/activity.log
// Pure path logic only; assertWritable() is the single guard for every direct write.

export const REGISTRY_MANIFEST = 'registry.yaml'

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/
const ID_RE = /^[A-Za-z0-9_-]+$/
const TEAM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Lowercased, validated email — safe as a directory name on every OS (no `:` `\` `/` spaces). */
export function normalizeEmail(email: string): string {
  const e = String(email ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(e) || e.length > 254 || e.includes('..')) throw new Error(`Invalid email for registry path: "${email}"`)
  return e
}

export function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid id for registry path: "${id}"`)
  return id
}

export function assertTeam(team: string): string {
  if (!TEAM_RE.test(team) || team.includes('..') || team.length > 60) throw new Error(`Invalid team name: "${team}"`)
  return team
}

export const userRoot = (email: string) => `users/${normalizeEmail(email)}`

export function scopeRoot(scope: Scope, ctx: { email: string; team?: string }): string {
  if (scope === 'Org') return 'org'
  if (scope === 'Team') return `teams/${assertTeam(ctx.team ?? '')}`
  return userRoot(ctx.email)
}

export const profilePath = (email: string) => `${userRoot(email)}/profile.yaml`
export const activityPath = (email: string) => `${userRoot(email)}/activity.log`
export const runPath = (email: string, yyyymm: string, deliveryId: string) => {
  if (!/^\d{4}-\d{2}$/.test(yyyymm)) throw new Error('Invalid run month')
  return `${userRoot(email)}/runs/${yyyymm}/${assertId(deliveryId)}.json`
}

export const pipelineDraftPath = (root: string, id: string) => `${root}/pipelines/${assertId(id)}/draft.yaml`
export const pipelineVersionPath = (root: string, id: string, version: number) =>
  `${root}/pipelines/${assertId(id)}/v${Math.trunc(version)}.yaml`
export const blockDir = (root: string, id: string, which: 'draft' | number) =>
  `${root}/blocks/${assertId(id)}/${which === 'draft' ? 'draft' : `v${Math.trunc(which)}`}`

/** Normalises a registry-relative path; null when it could escape or is malformed. */
export function cleanRelPath(p: string): string | null {
  if (typeof p !== 'string' || !p || p.includes('\\') || p.includes('\0') || p.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(p)) return null
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) return null
  return path.posix.normalize(p)
}

/** The write path refuses any direct commit outside `users/{email}/`. */
export function assertWritable(relPath: string, email: string): string {
  const clean = cleanRelPath(relPath)
  if (!clean) throw new Error(`Refusing registry write to invalid path: ${relPath}`)
  const prefix = `${userRoot(email)}/`
  if (!clean.startsWith(prefix) || clean.length === prefix.length) {
    throw new Error(`Refusing direct registry write outside ${prefix}: ${relPath}`)
  }
  return clean
}

/** Promotion targets (PR only): `org/` or `teams/{team}/` — never users/ or catalog/. */
export function assertPromotable(relPath: string): string {
  const clean = cleanRelPath(relPath)
  if (!clean || !(clean.startsWith('org/') || /^teams\/[^/]+\//.test(clean))) {
    throw new Error(`Promotion target must be under org/ or teams/{team}/: ${relPath}`)
  }
  return clean
}
