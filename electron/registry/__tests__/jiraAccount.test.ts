import { describe, it, expect } from 'vitest'
import { JiraAccount } from '../jiraAccount'
import type { JiraIdentityRecord } from '../jiraAccount'

function setup(opts: { identity?: JiraIdentityRecord | null; token?: string | null; myself?: { status?: number; body: unknown } } = {}) {
  const state = {
    identity: opts.identity === undefined
      ? ({ email: 'dev@example.com', displayName: 'Dev', site: 'acme.atlassian.net', verifiedAt: '2026-01-01T00:00:00.000Z' } as JiraIdentityRecord | null)
      : opts.identity,
    token: opts.token === undefined ? 'old-token' : opts.token,
    calls: [] as { url: string; auth: string }[],
    myself: opts.myself ?? { body: { emailAddress: 'dev@example.com', displayName: 'Dev', active: true } },
  }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    state.calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization })
    return new Response(JSON.stringify(state.myself.body), { status: state.myself.status ?? 200 })
  }) as unknown as typeof fetch
  const account = new JiraAccount({
    getIdentity: () => state.identity,
    readToken: async () => state.token,
    writeToken: async (t) => { state.token = t },
    saveIdentity: (r) => { state.identity = r },
    markVerified: (iso) => { if (state.identity) state.identity = { ...state.identity, verifiedAt: iso } },
    fetchImpl,
    now: () => new Date('2026-10-13T10:00:00.000Z'),
  })
  return { account, state }
}
const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`

describe('Jira account: status', () => {
  it('shows site, email, last verified and whether a token exists — never the token', async () => {
    const { account } = setup()
    const s = await account.status()
    expect(s).toEqual({ configured: true, site: 'acme.atlassian.net', email: 'dev@example.com', displayName: 'Dev', verifiedAt: '2026-01-01T00:00:00.000Z', hasToken: true })
    expect(JSON.stringify(s)).not.toContain('old-token')
    expect((await setup({ identity: null, token: null }).account.status()).configured).toBe(false)
  })
})

describe('Jira account: replace API token', () => {
  it('stores the new token when /myself returns the registered email, and bumps "last verified"', async () => {
    const { account, state } = setup()
    expect(await account.replaceToken('new-token')).toEqual({ ok: true })
    expect(state.token).toBe('new-token')
    expect(state.calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/myself')
    expect(state.calls[0].auth).toBe(basic('dev@example.com', 'new-token'))
    expect(state.identity?.verifiedAt).toBe('2026-10-13T10:00:00.000Z')
  })

  it('rejects a token for a DIFFERENT email and keeps the old token and timestamp', async () => {
    const { account, state } = setup({ myself: { body: { emailAddress: 'someone.else@example.com', active: true } } })
    const r = await account.replaceToken('their-token')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/does not match/)
    expect(r.error).toMatch(/existing token was kept/)
    expect(state.token).toBe('old-token')
    expect(state.identity?.verifiedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(state.identity?.email).toBe('dev@example.com')
  })

  it('keeps the old token when Jira rejects the new one or is unreachable', async () => {
    const bad = setup({ myself: { status: 401, body: {} } })
    expect((await bad.account.replaceToken('x')).ok).toBe(false)
    expect(bad.state.token).toBe('old-token')
    const down = setup()
    const account = new JiraAccount({
      getIdentity: () => down.state.identity, readToken: async () => down.state.token, writeToken: async (t) => { down.state.token = t },
      saveIdentity: () => {}, markVerified: () => {}, fetchImpl: (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch,
    })
    expect((await account.replaceToken('x')).ok).toBe(false)
    expect(down.state.token).toBe('old-token')
  })

  it('refuses an empty token and requires onboarding first', async () => {
    const { account, state } = setup()
    expect((await account.replaceToken('   ')).ok).toBe(false)
    expect(state.token).toBe('old-token')
    expect((await setup({ identity: null }).account.replaceToken('x')).ok).toBe(false)
  })
})

describe('Jira account: test connection', () => {
  it('re-runs /myself with the stored token', async () => {
    const { account, state } = setup()
    expect(await account.test()).toEqual({ ok: true, verifiedAt: '2026-10-13T10:00:00.000Z' })
    expect(state.calls[0].auth).toBe(basic('dev@example.com', 'old-token'))
  })

  it('reports the error when the stored token no longer works, or is missing', async () => {
    const revoked = setup({ myself: { status: 401, body: {} } })
    const r = await revoked.account.test()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/rejected/)
    expect(revoked.state.identity?.verifiedAt).toBe('2026-01-01T00:00:00.000Z')
    expect((await setup({ token: null }).account.test()).error).toMatch(/No Jira API token/)
  })
})

describe('Jira account: site validation (Jira Cloud only)', () => {
  it.each(['http://acme.atlassian.net', 'evil.example.com', 'acme.atlassian.net.evil.com', 'acme.atlassian.net@evil.com', 'acme.atlassian.net/../x', 'ftp://acme.atlassian.net', 'acme.jira.com', ''])(
    'rejects %s without calling Jira',
    async (site) => {
      const { account, state } = setup()
      const r = await account.stage(site, 'dev@example.com', 'tok')
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/atlassian\.net/)
      expect(state.calls).toHaveLength(0)
      expect(account.hasStaged()).toBe(false)
    },
  )

  it('accepts https://x.atlassian.net/ and bare hosts, normalised', async () => {
    const { account } = setup()
    const r = await account.stage('https://Acme.Atlassian.net/', 'dev@example.com', 'tok')
    expect(r).toMatchObject({ ok: true, site: 'acme.atlassian.net', identityChanges: false })
  })
})

describe('Jira account: change account or site (never an in-place email edit)', () => {
  it('nothing is persisted until commit; cancel discards the staged account', async () => {
    const { account, state } = setup({ myself: { body: { emailAddress: 'new@example.com', displayName: 'New', active: true } } })
    const r = await account.stage('other.atlassian.net', 'new@example.com', 'new-token')
    expect(r).toMatchObject({ ok: true, email: 'new@example.com', identityChanges: true })
    expect(state.token).toBe('old-token')
    expect(state.identity?.email).toBe('dev@example.com')
    account.cancel()
    await expect(account.commit()).rejects.toThrow(/Verify the Jira account first/)
    expect(state.identity?.email).toBe('dev@example.com')
  })

  it('commit stores token + identity together and flags an identity (email) change', async () => {
    const { account, state } = setup({ myself: { body: { emailAddress: 'new@example.com', displayName: 'New', active: true } } })
    await account.stage('other.atlassian.net', 'new@example.com', 'new-token')
    expect(await account.commit()).toEqual({ email: 'new@example.com', identityChanged: true })
    expect(state.token).toBe('new-token')
    expect(state.identity).toMatchObject({ email: 'new@example.com', site: 'other.atlassian.net', displayName: 'New' })
  })

  it('switching only the site (same email) is not an identity change', async () => {
    const { account, state } = setup()
    const r = await account.stage('other.atlassian.net', 'dev@example.com', 'tok2')
    expect(r.identityChanges).toBe(false)
    expect(await account.commit()).toEqual({ email: 'dev@example.com', identityChanged: false })
    expect(state.identity?.site).toBe('other.atlassian.net')
  })

  it('a failed verification stages nothing and leaves the current account untouched', async () => {
    const { account, state } = setup({ myself: { body: { emailAddress: 'mismatch@example.com', active: true } } })
    const r = await account.stage('acme.atlassian.net', 'dev@example.com', 'tok')
    expect(r.ok).toBe(false)
    expect(account.hasStaged()).toBe(false)
    expect(state.token).toBe('old-token')
  })
})
