import { JiraSiteSchema } from '../../shared'
import { normalizeEmail } from './layout'
import { redact } from '../log'

// Onboarding identity checks. Pure functions over an injected fetch so they are unit-tested without a
// network. The caller (ipc/onboarding.ts) only persists anything after these return ok.

export interface JiraIdentity {
  ok: boolean
  email?: string
  displayName?: string
  error?: string
}

const TIMEOUT_MS = 15_000

/** Jira Cloud `/myself` with Basic auth (D8). The account's email must match what the engineer typed. */
export async function verifyJiraIdentity(args: {
  site: string
  email: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<JiraIdentity> {
  const site = JiraSiteSchema.safeParse(args.site.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, ''))
  if (!site.success) return { ok: false, error: 'Jira site must look like yourcompany.atlassian.net (Jira Cloud only).' }
  let email: string
  try {
    email = normalizeEmail(args.email)
  } catch {
    return { ok: false, error: 'Enter your Jira account email address.' }
  }
  if (!args.token.trim()) return { ok: false, error: 'Enter a Jira API token.' }

  const auth = Buffer.from(`${email}:${args.token.trim()}`).toString('base64')
  let res: Response
  try {
    res = await (args.fetchImpl ?? fetch)(`https://${site.data}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return { ok: false, error: redact(`Could not reach Jira: ${err instanceof Error ? err.message : String(err)}`) }
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'Jira rejected the email / API token combination.' }
  if (!res.ok) return { ok: false, error: `Jira returned HTTP ${res.status}.` }

  let me: { emailAddress?: string; displayName?: string; active?: boolean }
  try {
    me = (await res.json()) as typeof me
  } catch {
    return { ok: false, error: 'Jira returned an unreadable response.' }
  }
  if (!me.emailAddress) {
    return { ok: false, error: 'Jira did not return an email for this account (it may be hidden by privacy settings), so it cannot be verified.' }
  }
  if (me.active === false) return { ok: false, error: 'This Jira account is not active.' }
  if (me.emailAddress.trim().toLowerCase() !== email) {
    return { ok: false, error: `The email on this Jira account (${me.emailAddress}) does not match the email you entered (${email}).` }
  }
  return { ok: true, email, displayName: me.displayName ?? '' }
}

export interface GithubIdentity {
  ok: boolean
  login?: string
  error?: string
}

/** Confirms a GitHub token is valid (needed to open promotion / delivery pull requests). */
export async function verifyGithubToken(token: string, fetchImpl: typeof fetch = fetch): Promise<GithubIdentity> {
  if (!token.trim()) return { ok: false, error: 'Enter a GitHub token.' }
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'GitHub rejected this token.' }
    if (!res.ok) return { ok: false, error: `GitHub returned HTTP ${res.status}.` }
    return { ok: true, login: ((await res.json()) as { login?: string }).login }
  } catch (err) {
    return { ok: false, error: redact(`Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`) }
  }
}
