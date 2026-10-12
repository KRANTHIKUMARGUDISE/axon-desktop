import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { verifyJiraIdentity, verifyGithubToken } from '../onboarding'
import { testRegistryConnection } from '../sync'
import { loadRegistryDefaults, resolveSyncConfig } from '../config'
import { createRemote, makeTmp, plainFactory } from './fixtures'
import { validateRepoUrl } from '../../security/gitAuth'

const jira = (status: number, body: unknown) => {
  const calls: { url: string; auth?: string }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('Jira identity (D8: Cloud, email + API token)', () => {
  it('accepts a matching email (case-insensitive) and returns the display name', async () => {
    const j = jira(200, { emailAddress: 'Dev@Example.com', displayName: 'Dev Eloper', active: true })
    const r = await verifyJiraIdentity({ site: 'https://Acme.atlassian.net/', email: ' dev@example.COM ', token: 'tok', fetchImpl: j.fetchImpl })
    expect(r).toEqual({ ok: true, email: 'dev@example.com', displayName: 'Dev Eloper' })
    expect(j.calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/myself')
    expect(j.calls[0].auth).toBe(`Basic ${Buffer.from('dev@example.com:tok').toString('base64')}`)
  })

  it('blocks onboarding when the Jira email does not match', async () => {
    const j = jira(200, { emailAddress: 'someone.else@example.com', displayName: 'Someone', active: true })
    const r = await verifyJiraIdentity({ site: 'acme.atlassian.net', email: 'dev@example.com', token: 'tok', fetchImpl: j.fetchImpl })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/does not match/)
  })

  it('blocks when Jira hides the email, rejects bad credentials, inactive accounts, bad sites and network errors', async () => {
    const args = { site: 'acme.atlassian.net', email: 'dev@example.com', token: 'tok' }
    expect((await verifyJiraIdentity({ ...args, fetchImpl: jira(200, { displayName: 'x' }).fetchImpl })).error).toMatch(/did not return an email/)
    expect((await verifyJiraIdentity({ ...args, fetchImpl: jira(401, {}).fetchImpl })).error).toMatch(/rejected/)
    expect((await verifyJiraIdentity({ ...args, fetchImpl: jira(500, {}).fetchImpl })).error).toMatch(/HTTP 500/)
    expect((await verifyJiraIdentity({ ...args, fetchImpl: jira(200, { emailAddress: 'dev@example.com', active: false }).fetchImpl })).error).toMatch(/not active/)
    expect((await verifyJiraIdentity({ ...args, site: 'evil.example.com', fetchImpl: jira(200, {}).fetchImpl })).error).toMatch(/atlassian\.net/)
    expect((await verifyJiraIdentity({ ...args, email: 'not an email', fetchImpl: jira(200, {}).fetchImpl })).error).toMatch(/email/i)
    expect((await verifyJiraIdentity({ ...args, token: '  ', fetchImpl: jira(200, {}).fetchImpl })).error).toMatch(/token/i)
    const boom = (async () => { throw new Error('ENOTFOUND acme.atlassian.net') }) as unknown as typeof fetch
    expect((await verifyJiraIdentity({ ...args, fetchImpl: boom })).error).toMatch(/Could not reach Jira/)
  })

  it('never sends credentials to a host other than the validated Jira site', async () => {
    const j = jira(200, { emailAddress: 'dev@example.com' })
    await verifyJiraIdentity({ site: 'acme.atlassian.net@evil.com', email: 'dev@example.com', token: 'tok', fetchImpl: j.fetchImpl })
    await verifyJiraIdentity({ site: 'acme.atlassian.net/../x', email: 'dev@example.com', token: 'tok', fetchImpl: j.fetchImpl })
    expect(j.calls).toHaveLength(0)
  })
})

describe('GitHub credential check', () => {
  it('validates the token via /user', async () => {
    const ok = jira(200, { login: 'octocat' })
    expect(await verifyGithubToken('ghp_x', ok.fetchImpl)).toEqual({ ok: true, login: 'octocat' })
    expect(ok.calls[0].url).toBe('https://api.github.com/user')
    expect((await verifyGithubToken('ghp_x', jira(401, {}).fetchImpl)).ok).toBe(false)
    expect((await verifyGithubToken('  ')).ok).toBe(false)
  })
})

describe('registry connection test', () => {
  it('reports read + push access on a reachable bare repo, and the branch', async () => {
    const root = await makeTmp()
    try {
      const remote = await createRemote(root)
      expect(await testRegistryConnection(plainFactory, remote, 'main')).toEqual({ ok: true, canRead: true, canPush: true, branchExists: true })
      expect(await testRegistryConnection(plainFactory, remote, 'release')).toMatchObject({ ok: true, branchExists: false })
      // the dry-run must not have created anything on the remote
      const refs = await (await plainFactory(remote)).raw(['for-each-ref', '--format=%(refname)'])
      expect(refs.trim()).toBe('refs/heads/main')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('fails with a readable error for an unreachable repo and for a forbidden URL', async () => {
    const root = await makeTmp()
    try {
      const r = await testRegistryConnection(plainFactory, path.join(root, 'nope.git'), 'main')
      expect(r).toMatchObject({ ok: false, canRead: false })
      expect(r.error).toBeTruthy()
      const bad = await testRegistryConnection(plainFactory, 'ext::sh -c id', 'main', validateRepoUrl)
      expect(bad).toMatchObject({ ok: false, canRead: false })
      expect(bad.error).toMatch(/Repository URL/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('registry config', () => {
  it('settings override the build-time default; blanks fall back to it', async () => {
    const dir = await makeTmp()
    try {
      await fs.writeFile(path.join(dir, 'registry-default.json'), JSON.stringify({ url: 'https://github.com/acme/axon-registry.git', branch: 'trunk' }))
      const d = loadRegistryDefaults([path.join(dir, 'missing'), dir])
      expect(d).toEqual({ url: 'https://github.com/acme/axon-registry.git', branch: 'trunk' })
      expect(resolveSyncConfig({ registryUrl: '', registryBranch: '', syncIntervalMinutes: 5 }, d)).toEqual({ url: d.url, branch: 'trunk', intervalMinutes: 5 })
      expect(resolveSyncConfig({ registryUrl: 'git@github.com:me/r.git', registryBranch: 'dev', syncIntervalMinutes: 0 }, d))
        .toEqual({ url: 'git@github.com:me/r.git', branch: 'dev', intervalMinutes: 5 })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('production git client', () => {
  it('accepts the clone flags the sync uses and refuses local-file transports (S2 hardening stays on)', async () => {
    // makeGit() applies protocol.file.allow=never, so a bare-repo path must be refused by git itself — the point is
    // that simple-git accepted `-c core.autocrlf=false` and the rest of our arguments (a different error would show up otherwise).
    const { makeGit } = await import('../../ipc/git')
    const root = await makeTmp()
    try {
      const remote = await createRemote(root)
      const git = await makeGit(undefined, '')
      await expect(git.clone(remote, path.join(root, 'clone'), ['-c', 'core.autocrlf=false'])).rejects.toThrow(/transport 'file' not allowed|protocol/i)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
