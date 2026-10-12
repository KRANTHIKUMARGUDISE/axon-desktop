// https://, ssh://, or scp-like user@host:path. Rejects ext::, file:, local paths, option-looking
// strings and embedded credentials. Returns the trimmed URL or null.
export function parseRepoUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const u = url.trim()
  if (!u || u.length > 2048 || /[\0\r\n\s]/.test(u)) return null
  if (u.startsWith('-')) return null
  if (/^https:\/\/[^\s/@]+(:[^\s/@]*)?@/.test(u)) return null
  if (/^https:\/\/[^\s/]+\/.+/.test(u)) return u
  if (/^ssh:\/\/[^\s/]+\/.+/.test(u)) return u
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/.test(u)) return u
  return null
}

/** owner/repo of a GitHub https or scp-style URL, or null (used for registry PRs). */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? { owner: m[1], repo: m[2] } : null
}
