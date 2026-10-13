import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testGit } from '../../registry/__tests__/fixtures'
import type { CatalogRepo, GitFactory } from '../../workspace/provisioner'
import { provisionWorkspace } from '../../workspace/provisioner'
import { runNativeBlock } from '../../runners/native/registry'
import type { RunnerInput } from '../../runners/types'
import type { Block } from '../../../shared'
import { branchMentions, findPrs } from '../findPrs'
import { runPrUpdate } from '../prUpdate'
import { extractAcceptanceCriteria, fetchTicket } from '../ticketFetcher'
import { parsePrUrl } from '../github'
import { adfToMarkdown, textToAdf } from '../../jira/adf'
import { JiraClient } from '../../jira/client'
import { createMockJira } from '../../jira/__tests__/mockJira'

// ---------------------------------------------------------------- a tiny in-memory GitHub

function fakeGitHub(opts: { prs?: Record<string, { number: number; title: string; head: string; draft?: boolean }[]> } = {}) {
  const calls: string[] = []
  const labels: Record<string, string[]> = {}
  const reviewers: Record<string, string[]> = {}
  const drafts = new Set<string>()
  const comments: Record<string, { body: string }[]> = {}
  for (const [repo, list] of Object.entries(opts.prs ?? {})) for (const p of list) if (p.draft) drafts.add(`${repo}#${p.number}`)
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(`${method} ${url.pathname}${url.search}`)
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
    const list = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname)
    if (list && method === 'GET') {
      return json((opts.prs?.[list[1]] ?? []).map((p) => ({ number: p.number, title: p.title, html_url: `https://github.com/${list[1]}/pull/${p.number}`, head: { ref: p.head } })))
    }
    const one = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url.pathname)
    if (one && method === 'GET') {
      const k = `${one[1]}#${one[2]}`
      return json({ draft: drafts.has(k), node_id: `node-${k}`, labels: (labels[k] ?? []).map((name) => ({ name })), requested_reviewers: (reviewers[k] ?? []).map((login) => ({ login })) })
    }
    const lab = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/.exec(url.pathname)
    if (lab && method === 'POST') { const k = `${lab[1]}#${lab[2]}`; labels[k] = [...new Set([...(labels[k] ?? []), ...body.labels])]; return json([]) }
    const rev = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/requested_reviewers$/.exec(url.pathname)
    if (rev && method === 'POST') { const k = `${rev[1]}#${rev[2]}`; reviewers[k] = [...new Set([...(reviewers[k] ?? []), ...body.reviewers])]; return json({}) }
    const com = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname)
    if (com && method === 'GET') return json(comments[`${com[1]}#${com[2]}`] ?? [])
    if (com && method === 'POST') { (comments[`${com[1]}#${com[2]}`] ??= []).push({ body: body.body }); return json({}, 201) }
    if (url.pathname === '/graphql' && method === 'POST') { drafts.delete(String(body.variables.id).replace(/^node-/, '')); return json({ data: {} }) }
    return json({ message: 'not found' }, 404)
  }) as typeof fetch
  return { fetchFn, calls, labels, reviewers, comments, drafts, gh: { getToken: async () => 'tok', fetchFn } }
}

const catalog: CatalogRepo[] = [{ name: 'api', url: 'https://github.com/acme/api.git' }, { name: 'web', url: 'https://github.com/acme/web' }]
const prs = { 'acme/api': [{ number: 7, title: 'PAY-12 add endpoint', head: 'axon/dev/PAY-12-abc123' }, { number: 8, title: 'other', head: 'axon/dev/PAY-120-zzz' }], 'acme/web': [] }

describe('Find PRs', () => {
  it('matches the key as a whole token (PAY-12 is not PAY-120)', () => {
    expect(branchMentions('axon/dev/PAY-12-abc', 'PAY-12')).toBe(true)
    expect(branchMentions('feature/pay-12', 'PAY-12')).toBe(true)
    expect(branchMentions('axon/dev/PAY-120-abc', 'PAY-12')).toBe(false)
    expect(branchMentions('xPAY-12', 'PAY-12')).toBe(false)
  })
  it('lists open PRs in catalog repos whose branch contains the key', async () => {
    const g = fakeGitHub({ prs })
    expect(await findPrs(g.gh, catalog, 'PAY-12')).toEqual([
      { repo: 'api', branch: 'axon/dev/PAY-12-abc123', url: 'https://github.com/acme/api/pull/7', number: 7, title: 'PAY-12 add endpoint' },
    ])
  })
  it('the native block returns a WorkItemList with repo, branch and prUrl plus prUrls', async () => {
    const g = fakeGitHub({ prs })
    const r = await runNativeBlock(input('find-prs'), { getCatalog: async () => catalog, getGitToken: async () => 'tok', fetchFn: g.fetchFn } as never)
    expect(r.result).toEqual({
      workItems: { items: [{ key: 'api', task: expect.stringContaining('#7'), repo: 'api', branch: 'axon/dev/PAY-12-abc123', prUrl: 'https://github.com/acme/api/pull/7' }] },
      prUrls: [{ repo: 'api', url: 'https://github.com/acme/api/pull/7' }],
    })
    expect(r.summary).toMatch(/Found 1 open pull request/)
  })
  it('without a GitHub token it fails clearly', async () => {
    await expect(findPrs({ getToken: async () => null }, catalog, 'PAY-12')).rejects.toThrow(/No GitHub token/)
  })
})

describe('PR Update', () => {
  const data = { output: {}, prUrls: [], deliveryLink: 'axon://d', failureReason: '', ticketKey: 'PAY-12' }
  const cfg = { addLabels: ['pr-ready'], reviewers: ['bob'], readyForReview: true, comment: 'Ready: {{ticketKey}}' }
  const target = [{ repo: 'api', url: 'https://github.com/acme/api/pull/7' }]

  it('labels, requests reviewers, marks ready and comments - and a second run changes nothing', async () => {
    const g = fakeGitHub({ prs: { 'acme/api': [{ number: 7, title: 't', head: 'b', draft: true }] } })
    const env = { gh: g.gh, prs: target, data, markerBase: 'axon:PAY-12:root:n1' }
    const first = await runPrUpdate(cfg, env)
    expect(first.changes).toHaveLength(4)
    expect(g.labels['acme/api#7']).toEqual(['pr-ready'])
    expect(g.reviewers['acme/api#7']).toEqual(['bob'])
    expect(g.drafts.has('acme/api#7')).toBe(false)
    expect(g.comments['acme/api#7']).toHaveLength(1)
    expect(g.comments['acme/api#7'][0].body).toMatch(/Ready: PAY-12[\s\S]*<!-- axon:PAY-12:root:n1:/)
    const second = await runPrUpdate(cfg, env)
    expect(second.changes).toEqual([])
    expect(second.summary).toMatch(/No change needed/)
    expect(g.comments['acme/api#7']).toHaveLength(1)
  })
  it('refuses to run without PRs and never sends the token to another host', async () => {
    await expect(runPrUpdate(cfg, { gh: fakeGitHub().gh, prs: [], data, markerBase: 'm' })).rejects.toThrow(/no pull requests/)
    expect(parsePrUrl('https://evil.test/acme/api/pull/7')).toBeNull()
  })
})

describe('Ticket Fetcher', () => {
  const doc = (...lines: string[]) => ({ type: 'doc', version: 1, content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) })

  it('reads summary, description as markdown, acceptance criteria, labels, status and the last 20 comments', async () => {
    const jira = createMockJira()
    const adf = {
      type: 'doc', version: 1, content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Add an endpoint ', marks: [] }, { type: 'text', text: 'now', marks: [{ type: 'strong' }] }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'returns 200' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'is documented' }] }] },
        ] },
      ],
    }
    jira.add({ key: 'PAY-12', summary: 'Endpoint', status: 'In Progress', labels: ['a'], description: adf, comments: Array.from({ length: 25 }, (_, i) => ({ body: doc(`c${i}`), author: 'Ann', created: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() })) })
    const c = new JiraClient({ site: 'acme.atlassian.net', email: 'me@example.com', token: 't', fetchImpl: jira.fetchImpl, sleep: async () => {} })
    const r = await runNativeBlock(input('ticket-fetcher'), { jira: async () => c } as never)
    const { ticket, acceptanceCriteria } = r.result as { ticket: { description: string; summary: string; status: string; labels: string[]; comments: { text: string }[] }; acceptanceCriteria: string[] }
    expect(ticket).toMatchObject({ summary: 'Endpoint', status: 'In Progress', labels: ['a'] })
    expect(ticket.description).toContain('Add an endpoint **now**')
    expect(acceptanceCriteria).toEqual(['returns 200', 'is documented'])
    expect(ticket.comments.map((x) => x.text)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 5}`)) // the last 20, oldest first
    expect((await fetchTicket(c, 'PAY-12')).ticket.key).toBe('PAY-12')
  })
  it('extracts acceptance criteria from several shapes', () => {
    expect(extractAcceptanceCriteria('Do it\n\nAcceptance Criteria:\n- one\n- [ ] two\n\n## Notes\nx')).toEqual(['one', 'two'])
    expect(extractAcceptanceCriteria('**Acceptance criteria:** works')).toEqual(['works'])
    expect(extractAcceptanceCriteria('nothing here')).toEqual([])
  })
})

describe('ADF helpers', () => {
  it('textToAdf keeps paragraphs and line breaks; adfToMarkdown round-trips plain text', () => {
    const adf = textToAdf('first line\nsecond line\n\nnext paragraph')
    expect(adf.content).toHaveLength(2)
    expect(adfToMarkdown(adf)).toBe('first line\nsecond line\n\nnext paragraph')
  })
})

// ---------------------------------------------------------------- the review stage on a fresh machine

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'axon actions-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }) })

const ident = ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com']
const factory: GitFactory = async (dir) => testGit(dir)

async function remoteWithPrBranch(branch: string): Promise<CatalogRepo> {
  const bare = path.join(root, 'remotes', 'api.git')
  const seed = path.join(root, 'seeds', 'api')
  await fs.mkdir(bare, { recursive: true })
  await fs.mkdir(seed, { recursive: true })
  await testGit(bare).raw(['init', '--bare', '-b', 'main'])
  const g = testGit(seed)
  await g.raw(['init', '-b', 'main'])
  await fs.writeFile(path.join(seed, 'README.md'), 'base\n')
  await g.raw(['add', '-A'])
  await g.raw([...ident, 'commit', '-m', 'init'])
  await g.raw(['remote', 'add', 'origin', bare])
  await g.raw(['push', 'origin', 'main'])
  await g.raw(['checkout', '-b', branch])
  await fs.writeFile(path.join(seed, 'feature.txt'), 'from the coding stage\n')
  await g.raw(['add', '-A'])
  await g.raw([...ident, 'commit', '-m', 'feature'])
  await g.raw(['push', 'origin', branch])
  return { name: 'api', url: bare }
}

describe('Workspace Provisioner on an existing PR branch (review stage, another machine)', () => {
  it('checks out the PR branch instead of creating a delivery branch', async () => {
    const repo = await remoteWithPrBranch('axon/dev/PAY-12-abc123')
    const out = await provisionWorkspace(
      { makeGit: factory, workspaceRoot: path.join(root, 'work'), catalog: [repo] },
      { deliveryId: 'dddddddd-2222', ticketId: 'PAY-12', username: 'Reviewer', repositories: [{ url: repo.url, checkout: 'axon/dev/PAY-12-abc123' }] },
    )
    const r = out.provisionedRepos[0]
    expect(r.branch).toBe('axon/dev/PAY-12-abc123')
    expect(r.baseBranch).toBe('main')
    expect((await testGit(r.worktreePath).raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('axon/dev/PAY-12-abc123')
    expect((await fs.readFile(path.join(r.worktreePath, 'feature.txt'), 'utf8')).trim()).toBe('from the coding stage')
  })

  it('the native block honours the item "branch" field and fails clearly for a missing branch', async () => {
    const repo = await remoteWithPrBranch('axon/dev/PAY-12-abc123')
    const services = { getCatalog: async () => [repo], getWorkspaceRoot: () => path.join(root, 'work'), username: () => 'reviewer', makeGit: factory } as never
    const list = { items: [{ key: 'api', task: 'review', repo: 'api', branch: 'axon/dev/PAY-12-abc123', prUrl: 'u' }] }
    const ok = await runNativeBlock(input('workspace-provisioner', { workItemList: list }), services)
    const wt = (ok.result as { provisionedRepos: { branch: string; worktreePath: string }[] }).provisionedRepos[0]
    expect(wt.branch).toBe('axon/dev/PAY-12-abc123')
    expect(await fs.readFile(path.join(wt.worktreePath, 'feature.txt'), 'utf8')).toMatch(/coding stage/)
    const bad = { items: [{ key: 'api', task: 'review', repo: 'api', branch: 'nope' }] }
    await expect(runNativeBlock({ ...input('workspace-provisioner', { workItemList: bad }), deliveryId: 'eeeeeeee-3333' }, services)).rejects.toThrow(/Branch "nope" does not exist/)
  })
})

function input(artifactName: string, pool: Record<string, unknown> = {}): RunnerInput {
  return {
    deliveryId: 'dddddddd-2222',
    block: { artifactName, agentRuntime: 'Axon' } as unknown as Block,
    nodeLabel: 'n', instructions: '',
    deliveryContext: { ticketId: 'PAY-12', previousStepsResults: pool, currentInputs: {} },
    workspacePath: '/w', effectiveTools: [], timeoutSeconds: 5, signal: new AbortController().signal,
  }
}
