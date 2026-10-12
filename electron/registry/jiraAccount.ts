import { verifyJiraIdentity } from './onboarding'

// The engineer's Jira account is their AXON identity (registry folder, approvals, audit). This class owns
// every change to it so the rules live in one tested place:
//  - the API token is replaced only after Jira confirms it belongs to the *registered* email (otherwise the
//    old token is kept);
//  - the email is never edited in place: switching accounts/sites goes through stage() -> commit(), which
//    verifies the new account first and only then persists token + identity together;
//  - nothing here returns a token to the caller.

export interface JiraIdentityRecord {
  email: string
  displayName: string
  site: string
  /** ISO time of the last successful /myself check. */
  verifiedAt: string
}

export interface JiraAccountDeps {
  getIdentity: () => JiraIdentityRecord | null
  readToken: () => Promise<string | null>
  writeToken: (token: string) => Promise<void>
  /** Persists email/displayName/site/verifiedAt (main-only settings writer). */
  saveIdentity: (record: JiraIdentityRecord) => void
  markVerified: (iso: string) => void
  fetchImpl?: typeof fetch
  now?: () => Date
}

export interface JiraStatus {
  configured: boolean
  site: string
  email: string
  displayName: string
  verifiedAt: string | null
  hasToken: boolean
}

export interface StageResult {
  ok: boolean
  error?: string
  email?: string
  displayName?: string
  site?: string
  /** True when committing would make a different email the AXON identity (a new users/{email}/ folder). */
  identityChanges?: boolean
}

export class JiraAccount {
  private staged: { record: JiraIdentityRecord; token: string } | null = null

  constructor(private readonly deps: JiraAccountDeps) {}

  private now = () => (this.deps.now ?? (() => new Date()))().toISOString()

  async status(): Promise<JiraStatus> {
    const id = this.deps.getIdentity()
    return {
      configured: !!id,
      site: id?.site ?? '',
      email: id?.email ?? '',
      displayName: id?.displayName ?? '',
      verifiedAt: id?.verifiedAt || null,
      hasToken: !!(await this.deps.readToken()),
    }
  }

  /** Replace the API token. The new token must resolve to the registered email; otherwise it is rejected and the old one kept. */
  async replaceToken(token: string): Promise<{ ok: boolean; error?: string }> {
    const id = this.deps.getIdentity()
    if (!id) return { ok: false, error: 'Jira is not set up yet — complete onboarding first.' }
    const res = await verifyJiraIdentity({ site: id.site, email: id.email, token, fetchImpl: this.deps.fetchImpl })
    if (!res.ok) {
      return { ok: false, error: `${res.error} Your existing token was kept.` }
    }
    await this.deps.writeToken(token.trim())
    this.deps.markVerified(this.now())
    return { ok: true }
  }

  /** Re-runs /myself with the stored token. */
  async test(): Promise<{ ok: boolean; error?: string; verifiedAt?: string }> {
    const id = this.deps.getIdentity()
    if (!id) return { ok: false, error: 'Jira is not set up yet — complete onboarding first.' }
    const token = await this.deps.readToken()
    if (!token) return { ok: false, error: 'No Jira API token is stored. Use "Replace API token".' }
    const res = await verifyJiraIdentity({ site: id.site, email: id.email, token, fetchImpl: this.deps.fetchImpl })
    if (!res.ok) return { ok: false, error: res.error }
    const verifiedAt = this.now()
    this.deps.markVerified(verifiedAt)
    return { ok: true, verifiedAt }
  }

  /** Verifies a (possibly different) account/site and holds it in memory; nothing is persisted until commit(). */
  async stage(site: string, email: string, token: string): Promise<StageResult> {
    this.staged = null
    const res = await verifyJiraIdentity({ site, email, token, fetchImpl: this.deps.fetchImpl })
    if (!res.ok) return { ok: false, error: res.error }
    const host = normalizeSite(site)
    const record: JiraIdentityRecord = { email: res.email as string, displayName: res.displayName ?? '', site: host, verifiedAt: this.now() }
    this.staged = { record, token: token.trim() }
    const current = this.deps.getIdentity()
    return { ok: true, email: record.email, displayName: record.displayName, site: host, identityChanges: !!current && current.email !== record.email }
  }

  hasStaged(): boolean {
    return this.staged !== null
  }

  /** Persists the staged account (token first, then identity). Returns whether the AXON identity (email) changed. */
  async commit(): Promise<{ email: string; identityChanged: boolean }> {
    if (!this.staged) throw new Error('Verify the Jira account first')
    const { record, token } = this.staged
    const previous = this.deps.getIdentity()
    await this.deps.writeToken(token)
    this.deps.saveIdentity(record)
    this.staged = null
    return { email: record.email, identityChanged: !!previous && previous.email !== record.email }
  }

  cancel(): void {
    this.staged = null
  }
}

function normalizeSite(site: string): string {
  return site.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
}
