import { redact } from './log'

// "Copy diagnostics" for support. Deliberately a short allow-list of facts — never emails, user names, file paths,
// tokens or keys — and the final text is also run through the logger's redaction as a second line of defence.

export interface DiagnosticsInput {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  arch: string
  osRelease: string
  /** How the Claude key is provided — never the key itself. */
  claudeKeyMode: string
  /** Registry clone commit the repo catalog was read from (hex), or '' when unknown. */
  catalogVersion: string
  registry: {
    url: string
    state: string
    lastSyncAt: string | null
    queued: number
  }
}

/** Host name only — no scheme, userinfo, port, path or query. '' when there is nothing usable. */
export function registryHost(url: string): string {
  const u = (url ?? '').trim()
  if (!u) return ''
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):[^\s]*$/.exec(u)
  if (scp) return scp[1].toLowerCase()
  try {
    const parsed = new URL(u)
    return /^[A-Za-z0-9.-]+$/.test(parsed.hostname) ? parsed.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

// Every value must match a strict shape or it is replaced — free-form text (paths, names, emails) can't get through.
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,23}$/
const WORD = /^[a-z0-9_]{1,16}$/
const STATE = /^(Unconfigured|Idle|Syncing|Offline|NeedsAttention|ReadOnly)$/
const KEY_MODE = /^(linked|entered|none)$/
const COMMIT = /^[0-9a-f]{7,40}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const only = (value: string, re: RegExp, fallback = 'unknown') => (re.test(value) ? value : fallback)

export function buildDiagnostics(i: DiagnosticsInput): string {
  const last = i.registry.lastSyncAt && ISO.test(i.registry.lastSyncAt) ? `, last sync ${i.registry.lastSyncAt}` : ', never synced'
  const queued = Number.isFinite(i.registry.queued) ? Math.max(0, Math.trunc(i.registry.queued)) : 0
  const lines = [
    'AXON diagnostics',
    `AXON: ${only(i.appVersion, VERSION)}`,
    `Electron: ${only(i.electronVersion, VERSION)}`,
    `Node: ${only(i.nodeVersion, VERSION)}`,
    `OS: ${only(i.platform, WORD)} ${only(i.arch, WORD)} (${only(i.osRelease, VERSION)})`,
    `Registry host: ${registryHost(i.registry.url) || 'not configured'}`,
    `Registry sync: ${only(i.registry.state, STATE)}${last}`,
    `Queued writes: ${queued}`,
    `Claude key: ${only(i.claudeKeyMode, KEY_MODE)}`,
    `Catalog version: ${COMMIT.test(i.catalogVersion ?? '') ? i.catalogVersion.slice(0, 12) : 'unknown'}`,
  ]
  return redact(lines.join('\n'))
}
